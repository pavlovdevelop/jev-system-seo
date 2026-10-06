// Reading sitemaps for the whole-site audit. A sitemap is a file written by whoever runs the site we were asked to
// audit, so it is hostile input: it can be enormous, nest without end, lie about its structure or stuff text with
// ampersands. The scanner below is hand-written and linear in the size of the text: it moves forward with indexOf,
// never re-reads a stretch it has passed, uses no regular expression on the text, and looks at most a few characters
// ahead for an entity. Whatever the shape of the input, the work and the result are bounded by the caps below.

export interface ParsedSitemap {
  /** What the file is: a list of pages, an index of other sitemaps, or not a sitemap at all. */
  kind: 'urlset' | 'index' | 'unknown';
  urls: Array<{ loc: string; lastmod: string | null }>;
  /** Locations of the child sitemaps (kind 'index'). */
  sitemaps: string[];
}

/** A sitemap file may list 50 000 pages by the protocol; an index may list 50 000 files, but nobody reads that many. */
export const MAX_SITEMAP_URLS = 50_000;
export const MAX_SITEMAP_CHILDREN = 1_000;
export const MAX_LOC_LENGTH = 2_048;
export const MAX_ROBOTS_SITEMAPS = 20;
/** Tags looked at in one file (a legitimate 5 MB sitemap has far fewer; `<a>` repeated 20 MB would have 6 million). */
const MAX_TAGS = 3_000_000;
/** Raw text kept for one <loc> or <lastmod>: entities only shrink it, so anything longer cannot end up under MAX_LOC_LENGTH. */
const MAX_RAW_CAPTURE = MAX_LOC_LENGTH * 6;
const MAX_NAME = 64;
const MAX_LASTMOD = 40;

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** The XML entities and numeric references; the look-ahead for the ';' is a fixed window, so a text full of '&' stays linear. */
function decodeEntities(text: string): string {
  let amp = text.indexOf('&');
  if (amp === -1) return text;
  let out = '';
  let last = 0;
  while (amp !== -1) {
    const semi = text.slice(amp + 1, amp + 12).indexOf(';');
    let replacement: string | null = null;
    if (semi > 0) {
      const name = text.slice(amp + 1, amp + 1 + semi);
      if (name === 'amp') replacement = '&';
      else if (name === 'lt') replacement = '<';
      else if (name === 'gt') replacement = '>';
      else if (name === 'quot') replacement = '"';
      else if (name === 'apos') replacement = "'";
      else if (name.charCodeAt(0) === 35 /* # */) {
        const hex = name.charCodeAt(1) === 120 || name.charCodeAt(1) === 88;
        const digits = name.slice(hex ? 2 : 1);
        const code = digits.length > 0 && digits.length <= 7 && (hex ? /^[0-9a-f]+$/i : /^[0-9]+$/).test(digits) ? parseInt(digits, hex ? 16 : 10) : NaN;
        if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) replacement = String.fromCodePoint(code);
      }
    }
    if (replacement === null) {
      // not an entity (an unescaped '&' in a URL is common): keep it as it is
      amp = text.indexOf('&', amp + 1);
      continue;
    }
    out += text.slice(last, amp) + replacement;
    last = amp + 1 + semi + 1;
    amp = text.indexOf('&', last);
  }
  return out + text.slice(last);
}

/** W3C datetime as sitemaps write it ("2024-05-01", "2024-05-01T10:00:00+03:00"); anything else is not a date we can use. */
function cleanLastmod(raw: string | null): string | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s.length < 10 || s.length > MAX_LASTMOD) return null;
  for (let i = 0; i < 10; i++) {
    const c = s.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    if (i === 4 || i === 7 ? c !== 45 : !digit) return null;
  }
  return s;
}

/** Plain-text sitemap: one absolute URL per line, nothing else. */
function parseTextSitemap(text: string, from: number): ParsedSitemap {
  const urls: ParsedSitemap['urls'] = [];
  let lineStart = from;
  while (lineStart < text.length && urls.length < MAX_SITEMAP_URLS) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - lineStart <= MAX_LOC_LENGTH * 2) {
      const line = text.slice(lineStart, lineEnd).trim();
      if (line.length <= MAX_LOC_LENGTH && /^https?:\/\/\S+$/i.test(line)) urls.push({ loc: line, lastmod: null });
    }
    lineStart = lineEnd + 1;
  }
  return { kind: urls.length > 0 ? 'urlset' : 'unknown', urls, sitemaps: [] };
}

/**
 * Reads a sitemap or a sitemap index. Tolerant of what generators really produce: namespace prefixes, upper-case tags,
 * CDATA, whitespace around values, entities in <loc>, an unescaped '&', a missing closing tag, the BOM, and the
 * plain-text format. Extension elements (<image:loc>, <video:content_loc>, <xhtml:link>) are not pages and are ignored.
 */
export function parseSitemap(xml: string): ParsedSitemap {
  const text = xml;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos < text.length && isSpace(text.charCodeAt(pos))) pos++;
  if (pos >= text.length) return { kind: 'unknown', urls: [], sitemaps: [] };
  if (text.charCodeAt(pos) !== 60 /* < */) return parseTextSitemap(text, pos);

  const urls: ParsedSitemap['urls'] = [];
  const sitemaps: string[] = [];
  let root: 'urlset' | 'index' | null = null;
  let rootName = '';
  /** The <url> / <sitemap> being read. A missing close tag is repaired when the next one opens. */
  let entry: { prefix: string; loc: string | null; lastmod: string | null } | null = null;
  let capture: 'loc' | 'lastmod' | null = null;
  let captured = '';
  let capturedTooLong = false;
  let full = false;
  let tags = 0;

  const addText = (piece: string, decode: boolean): void => {
    if (capturedTooLong) return;
    // checked before decoding: a value this long cannot become a usable address, so it is not worth reading
    if (captured.length + piece.length > MAX_RAW_CAPTURE) {
      capturedTooLong = true;
      captured = '';
      return;
    }
    captured += decode ? decodeEntities(piece) : piece;
  };
  const endCapture = (): void => {
    if (capture !== null && entry !== null && !capturedTooLong) {
      const value = captured.trim();
      if (value.length > 0 && value.length <= MAX_LOC_LENGTH) entry[capture] = value;
    }
    capture = null;
    captured = '';
    capturedTooLong = false;
  };
  const endEntry = (): void => {
    if (entry === null) return;
    if (entry.loc !== null) {
      if (root === 'index') {
        sitemaps.push(entry.loc);
        if (sitemaps.length >= MAX_SITEMAP_CHILDREN) full = true;
      } else {
        urls.push({ loc: entry.loc, lastmod: cleanLastmod(entry.lastmod) });
        if (urls.length >= MAX_SITEMAP_URLS) full = true;
      }
    }
    entry = null;
  };

  while (!full) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) break;
    if (capture !== null && lt > pos) addText(text.slice(pos, lt), true);
    if (++tags > MAX_TAGS) break;
    const next = text.charCodeAt(lt + 1);

    if (next === 33 /* ! */) {
      if (text.startsWith('<!--', lt)) {
        const end = text.indexOf('-->', lt + 4);
        if (end === -1) break; // an unterminated comment swallows the rest of the file
        pos = end + 3;
      } else if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt + 9);
        if (end === -1) break;
        if (capture !== null) addText(text.slice(lt + 9, end), false);
        pos = end + 3;
      } else {
        const end = text.indexOf('>', lt + 2); // <!DOCTYPE …>
        if (end === -1) break;
        pos = end + 1;
      }
      continue;
    }
    if (next === 63 /* ? */) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) break;
      pos = end + 2;
      continue;
    }

    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) break;
    pos = gt + 1;

    const closing = next === 47; /* / */
    let nameStart = lt + (closing ? 2 : 1);
    while (nameStart < gt && isSpace(text.charCodeAt(nameStart))) nameStart++;
    let nameEnd = nameStart;
    while (nameEnd < gt) {
      const c = text.charCodeAt(nameEnd);
      if (isSpace(c) || c === 47) break;
      nameEnd++;
    }
    if (nameEnd === nameStart || nameEnd - nameStart > MAX_NAME) {
      // not a name (a stray '<'): a start tag ends whatever was being read; a close tag of an unknown name is ignored
      if (!closing && capture !== null) endCapture();
      continue;
    }
    const name = text.slice(nameStart, nameEnd);
    const colon = name.indexOf(':');
    const prefix = colon === -1 ? '' : name.slice(0, colon);
    const local = (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();

    if (closing) {
      if (capture !== null) {
        const matches = local === capture && entry !== null && prefix === entry.prefix;
        if (matches) endCapture();
        else {
          // something else closed while a value was open: the value is not trustworthy
          capture = null;
          captured = '';
          capturedTooLong = false;
        }
      }
      if (entry !== null && prefix === entry.prefix && local === (root === 'index' ? 'sitemap' : 'url')) endEntry();
      else if (root !== null && local === rootName) {
        endEntry();
        break; // the document is over; whatever follows is not part of it
      }
      continue;
    }

    // a start tag. Values are plain text: an element inside <loc> means the file is broken, so the value is dropped
    if (capture !== null) {
      capture = null;
      captured = '';
      capturedTooLong = false;
    }
    const selfClosing = text.charCodeAt(gt - 1) === 47;
    if (root === null) {
      if (local === 'urlset') root = 'urlset';
      else if (local === 'sitemapindex') root = 'index';
      // anything before the root (a PHP warning printed above the XML, an HTML comment wrapper) is skipped
      if (root !== null) rootName = local;
      continue;
    }
    if (local === (root === 'index' ? 'sitemap' : 'url')) {
      endEntry();
      if (!selfClosing) entry = { prefix, loc: null, lastmod: null };
      continue;
    }
    if (entry !== null && !selfClosing && prefix === entry.prefix && (local === 'loc' || local === 'lastmod') && entry[local] === null) {
      capture = local;
      captured = '';
      capturedTooLong = false;
    }
  }
  endEntry();

  return { kind: root === 'urlset' ? 'urlset' : root === 'index' ? 'index' : 'unknown', urls: root === 'index' ? [] : urls, sitemaps: root === 'index' ? sitemaps : [] };
}

/** "Sitemap:" in robots.txt, spelled any way the case allows. */
const SITEMAP_KEY = 'sitemap';

function isSitemapKey(line: string, from: number, to: number): boolean {
  if (to - from !== SITEMAP_KEY.length) return false;
  for (let i = 0; i < SITEMAP_KEY.length; i++) {
    if ((line.charCodeAt(from + i) | 32) !== SITEMAP_KEY.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The `Sitemap:` lines of a robots.txt: http(s) addresses only, each once, at most 20. A root-relative value
 * ("Sitemap: /sitemap.xml", which the standard does not allow but some sites write) is resolved against `base`
 * (the address of the robots.txt) when one is given. Linear: lines are found by one pass over the characters.
 */
export function sitemapsFromRobots(robotsText: string, base?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const n = robotsText.length;
  let i = robotsText.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < n && out.length < MAX_ROBOTS_SITEMAPS) {
    let end = i;
    while (end < n) {
      const c = robotsText.charCodeAt(end);
      if (c === 10 || c === 13) break;
      end++;
    }
    let keyStart = i;
    while (keyStart < end && isSpace(robotsText.charCodeAt(keyStart))) keyStart++;
    let keyEnd = keyStart;
    while (keyEnd < end && robotsText.charCodeAt(keyEnd) !== 58 /* : */ && !isSpace(robotsText.charCodeAt(keyEnd))) keyEnd++;
    let colon = keyEnd;
    while (colon < end && isSpace(robotsText.charCodeAt(colon))) colon++;
    if (colon < end && robotsText.charCodeAt(colon) === 58 && isSitemapKey(robotsText, keyStart, keyEnd) && end - colon <= MAX_LOC_LENGTH * 2) {
      let value = robotsText.slice(colon + 1, end);
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
      if (value.length > 0 && value.length <= MAX_LOC_LENGTH) {
        let href: string | null = null;
        try {
          const url = value.startsWith('/') && !value.startsWith('//') && base ? new URL(value, base) : new URL(value);
          if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
        } catch {
          // not an address: ignored
        }
        if (href !== null && !seen.has(href)) {
          seen.add(href);
          out.push(href);
        }
      }
    }
    i = end + 1;
  }
  return out;
}
