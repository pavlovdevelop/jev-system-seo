import { Parser } from 'htmlparser2';
import type { FetchedPage, PageFetcher, TextResult } from '../crawl/fetcher';
import { domainOf } from '../providers/serp/types';
import { MAX_LOC_LENGTH, MAX_SITEMAP_URLS, parseSitemap, sitemapsFromRobots } from './sitemap';

// Finding the pages of the user's own site for the whole-site audit: the sitemap first (robots.txt, then the usual
// places), the links of the homepage when there is none. The site's owner (or whoever controls the domain we were asked
// to audit) writes every file read here, so everything is bounded: files, pages, requests, depth and time.

export interface DiscoverOptions {
  domain: string;
  fetcher: PageFetcher;
  maxPages: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface Discovery {
  /** Absolute URLs to audit, the homepage first, at most maxPages. */
  urls: string[];
  /** How many distinct pages were found before capping. */
  found: number;
  source: 'sitemap' | 'links' | 'single';
  /** There are more pages than `urls` lists (maxPages, or one of the limits of the discovery itself). */
  truncated: boolean;
  /** Bulgarian, for the report's warnings. */
  notes: string[];
}

/** Child sitemap files read in total (an index may name thousands). */
const MAX_CHILD_SITEMAPS = 20;
/** index → index → urlset: files at depth 0, 1 and 2 are read; an index at depth 2 is not followed. */
const MAX_SITEMAP_DEPTH = 2;
/** Distinct pages kept while reading sitemaps (several files of 50 000 would otherwise grow without bound). */
const MAX_FOUND = 100_000;
const SITEMAP_MAX_BYTES = 5 * 1024 * 1024;
const ROBOTS_MAX_BYTES = 512 * 1024;
/** The link crawl: every page fetched counts, the homepage included. */
const CRAWL_MAX_FETCHES = 60;
const CRAWL_CONCURRENCY = 4;
/** Pages whose links are read: the homepage (depth 0) and the pages it links to (depth 1) → pages up to depth 2 are found. */
const CRAWL_MAX_DEPTH = 2;
/** What one page may cost the link crawl. */
const MAX_HTML_CHARS = 1_500_000;
const HTML_CHUNK = 32_768;
const HTML_BUDGET_MS = 750;
const MAX_PARSED_ELEMENTS = 120_000;
const MAX_NESTING = 1_000;
const MAX_LINKS_PER_PAGE = 20_000;
const MAX_QUERY_PARAMS = 2;

// ───────────────────────────── addresses ─────────────────────────────

/** Parameters that only say where a visitor came from: the same page with or without them. */
function isTrackingParam(name: string): boolean {
  return (
    name.startsWith('utm_') ||
    name === 'gclid' ||
    name === 'gclsrc' ||
    name === 'dclid' ||
    name === 'fbclid' ||
    name === 'msclkid' ||
    name === 'yclid' ||
    name === 'mc_cid' ||
    name === 'mc_eid' ||
    name === 'igshid' ||
    name === 'ref'
  );
}

/** Parameters of addresses that are actions or feeds, never pages worth auditing. */
const isActionParam = (name: string): boolean => name === 'replytocom' || name === 'add-to-cart' || name === 'feed';

const SKIPPED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp', 'tif', 'tiff', 'heic',
  'pdf', 'zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'css', 'js', 'mjs', 'map', 'json', 'xml', 'rss', 'atom', 'txt', 'csv',
  'mp3', 'mp4', 'm4v', 'm4a', 'webm', 'avi', 'mov', 'wmv', 'mkv', 'ogg', 'wav', 'flac',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'exe', 'dmg', 'apk', 'msi', 'iso',
]);
/** A path segment that marks an address as system, shop-flow or feed rather than a page. */
const SKIPPED_SEGMENTS = new Set(['wp-json', 'wp-admin', 'wp-content', 'wp-includes', 'feed', 'cart', 'checkout', 'my-account']);
const SKIPPED_FILES = new Set(['wp-login.php', 'xmlrpc.php']);

function isNonPage(segments: readonly string[]): boolean {
  for (const segment of segments) {
    if (SKIPPED_SEGMENTS.has(segment.toLowerCase())) return true;
  }
  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  const lower = last.toLowerCase();
  if (SKIPPED_FILES.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  return dot !== -1 && SKIPPED_EXTENSIONS.has(lower.slice(dot + 1));
}

const stripWww = (host: string): string => (host.startsWith('www.') ? host.slice(4) : host);

/** 50000 → "50 000" (Intl is left out: the text must not depend on the locale data this Node was built with). */
const spaced = (n: number): string => String(n).replace(/\B(?=(?:\d{3})+$)/g, ' ');

export interface NormalizedPage {
  /** The address to audit: no fragment, no tracking parameters, lower-case host, no default port. */
  url: string;
  /** What makes two addresses the same page: www/non-www, http/https and a trailing slash do not count. */
  key: string;
  /** Number of path segments (0 for the homepage). */
  depth: number;
}

/**
 * The page behind an address, or null when it is not one of the site's pages: another site, not http(s), an obvious
 * non-page (image, document, feed, admin, shop flow), or a query string that looks like a filter or session (more than
 * two parameters). `force` keeps the address even when the last two rules would drop it (the homepage itself).
 */
export function normalizePageUrl(raw: string, isSiteHost: (hostname: string) => boolean, base?: string, force = false): NormalizedPage | null {
  if (raw.length > MAX_LOC_LENGTH) return null;
  let u: URL;
  try {
    u = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '' || !isSiteHost(u.hostname)) return null;

  const segments = u.pathname.split('/').filter(Boolean);
  if (!force && isNonPage(segments)) return null;

  // the query: tracking parameters go, the rest is kept exactly as written
  const kept: string[] = [];
  if (u.search.length > 1) {
    for (const part of u.search.slice(1).split('&')) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      const name = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
      if (isTrackingParam(name)) continue;
      if (!force && isActionParam(name)) return null;
      kept.push(part);
    }
  }
  if (!force && kept.length > MAX_QUERY_PARAMS) return null;
  u.hash = '';
  u.search = kept.length > 0 ? `?${kept.join('&')}` : '';
  if (u.href.length > MAX_LOC_LENGTH) return null;

  const path = u.pathname;
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end--;
  return { url: u.href, key: `${stripWww(u.host)}${path.slice(0, end)}${u.search}`, depth: segments.length };
}

/** The host of the domain a caller names, whatever else came with it ("https://Example.com/path" → "example.com"). */
function hostnameOf(domain: string): string {
  const text = domain.trim().slice(0, 300);
  if (text === '') return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return '';
  }
}

/** "example.com/blog/post" — an address as short as a warning can carry. */
function shortUrl(url: string): string {
  let text = url;
  try {
    const u = new URL(url);
    text = `${u.host}${u.pathname}${u.search}`;
  } catch {
    // not an address: shown as it is, shortened
  }
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

// ───────────────────────────── the set of pages ─────────────────────────────

/** The distinct pages found so far, in the order they were found. */
class PageSet {
  private readonly entries = new Map<string, { url: string; depth: number }>();
  private readonly hosts = new Map<string, boolean>();
  /** True once pages were refused because the set was full. */
  full = false;

  constructor(readonly site: string) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Is this host part of the site? The registrable domain decides, so www and other subdomains count. */
  readonly isSiteHost = (hostname: string): boolean => {
    let known = this.hosts.get(hostname);
    if (known === undefined) {
      known = domainOf(hostname) === this.site;
      if (this.hosts.size < 5_000) this.hosts.set(hostname, known);
    }
    return known;
  };

  isSiteUrl(url: string): boolean {
    try {
      return this.isSiteHost(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  /** The address that was stored when `raw` is a new page of the site, else null. */
  add(raw: string, base?: string, force = false): string | null {
    if (this.entries.size >= MAX_FOUND) {
      this.full = true;
      return null;
    }
    const page = normalizePageUrl(raw, this.isSiteHost, base, force);
    if (!page || this.entries.has(page.key)) return null;
    this.entries.set(page.key, { url: page.url, depth: page.depth });
    return page.url;
  }

  /** The homepage first, then the shallower pages, then the order they were found in. */
  ordered(homeKey: string): string[] {
    const list = [...this.entries].map(([key, entry], order) => ({ home: key === homeKey, depth: entry.depth, order, url: entry.url }));
    list.sort((a, b) => Number(b.home) - Number(a.home) || a.depth - b.depth || a.order - b.order);
    return list.map((p) => p.url);
  }
}

// ───────────────────────────── links of a page ─────────────────────────────

/**
 * The `href` of every <a> in a page (and the page's own <base href>), read with an event parser that builds no tree.
 * The page is untrusted, so reading is bounded: the markup is cut, the parser is fed in chunks and stops when the page
 * nests absurdly deep, has absurdly many elements or takes too long (its own stack of open tags costs more the deeper a
 * page nests, which only stopping early prevents).
 */
function extractLinks(html: string, pageUrl: string): string[] {
  const hrefs: string[] = [];
  let baseHref: string | null = null;
  let depth = 0;
  let elements = 0;
  let templates = 0;
  let stop = false;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        depth++;
        if (++elements > MAX_PARSED_ELEMENTS || depth > MAX_NESTING) stop = true;
        if (name === 'a') {
          const href = attribs.href;
          // <template> holds markup for scripts to stamp out, not links the page has
          if (href !== undefined && templates === 0 && hrefs.length < MAX_LINKS_PER_PAGE) hrefs.push(href);
        } else if (name === 'base') {
          if (baseHref === null && attribs.href) baseHref = attribs.href;
        } else if (name === 'template') templates++;
      },
      onclosetag(name) {
        depth--;
        if (name === 'template' && templates > 0) templates--;
      },
    },
    { decodeEntities: true },
  );
  const text = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const startedAt = performance.now();
  for (let i = 0; i < text.length && !stop; i += HTML_CHUNK) {
    parser.write(text.slice(i, i + HTML_CHUNK));
    if (performance.now() - startedAt > HTML_BUDGET_MS) stop = true;
  }
  if (!stop) parser.end();

  // links are resolved against <base href> when the page has one (a browser would), else against the page's own address
  let base = pageUrl;
  if (baseHref !== null) {
    try {
      const resolved = new URL(baseHref, pageUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') base = resolved.href;
    } catch {
      // an unusable <base>: ignored
    }
  }
  const out: string[] = [];
  for (const href of hrefs) {
    const trimmed = href.trim();
    if (trimmed === '' || trimmed.length > MAX_LOC_LENGTH || trimmed.startsWith('#')) continue;
    try {
      out.push(new URL(trimmed, base).href);
    } catch {
      // not an address: skipped
    }
  }
  return out;
}

// ───────────────────────────── discovery ─────────────────────────────

/** What a fetcher that threw (instead of returning a failed result) is reported as: a problem with the site, not a crash of the audit. */
const unexpected = (err: unknown): string => `неочаквана грешка: ${err instanceof Error ? err.message.slice(0, 100) : 'неизвестна'}`;

export async function discoverSite(options: DiscoverOptions): Promise<Discovery> {
  const { fetcher, signal } = options;
  const maxPages = Number.isFinite(options.maxPages) ? Math.max(1, Math.floor(options.maxPages)) : 1;
  const progress = (message: string): void => options.onProgress?.(message);
  const aborted = (): void => signal?.throwIfAborted();
  const notes: string[] = [];
  const note = (message: string): void => {
    if (!notes.includes(message)) notes.push(message);
  };
  aborted();

  const host = hostnameOf(options.domain);
  if (host === '') return { urls: [], found: 0, source: 'single', truncated: false, notes: ['Невалиден домейн — няма какво да се обходи.'] };
  const pages = new PageSet(domainOf(`https://${host}/`));
  /** The scheme the site answers on; https until a request shows otherwise. */
  let origin = `https://${host}`;
  /** The discovery stopped at one of its own limits, so the site may have more pages than it found. */
  let capped = false;

  const homeKeyOf = (url: string): string => normalizePageUrl(url, () => true, undefined, true)?.key ?? '';

  // ── 1. sitemaps ──────────────────────────────────────────────────────────────────────────
  const rawFetchText = fetcher.fetchText?.bind(fetcher);
  const fetchText = rawFetchText
    ? async (url: string, maxBytes: number): Promise<TextResult> => {
        try {
          return await rawFetchText(url, signal ? { signal, maxBytes } : { maxBytes });
        } catch (err) {
          aborted(); // an abort is an abort, whatever it made the fetcher throw
          return { status: 'error', httpStatus: null, text: null, finalUrl: null, error: unexpected(err) };
        }
      }
    : null;
  if (fetchText) {
    const visited = new Set<string>();
    let childrenRead = 0;

    const readSitemap = async (url: string, depth: number, mustExist: boolean): Promise<void> => {
      if (visited.has(url)) return;
      visited.add(url);
      progress(`Чета sitemap: ${shortUrl(url)}`);
      const result = await fetchText(url, SITEMAP_MAX_BYTES);
      aborted();
      if (result.finalUrl) visited.add(result.finalUrl);
      // a file nobody promised (the usual places) is allowed to be missing; one the site named is not
      const complain = (message: string): void => {
        if (mustExist) note(message);
      };
      if (result.status !== 'ok' || result.text === null) {
        complain(`Sitemap „${shortUrl(url)}“ не може да се прочете (${result.error ?? 'грешка'}) — пропуснат.`);
        return;
      }
      const sitemap = parseSitemap(result.text);
      if (sitemap.kind === 'unknown') {
        complain(`„${shortUrl(url)}“ не изглежда като sitemap — пропуснат.`);
        return;
      }
      if (sitemap.kind === 'urlset') {
        for (const entry of sitemap.urls) pages.add(entry.loc);
        if (sitemap.urls.length >= MAX_SITEMAP_URLS) {
          capped = true;
          note(`Sitemap „${shortUrl(url)}“ има ${spaced(MAX_SITEMAP_URLS)} или повече адреса — прочетени са първите ${spaced(MAX_SITEMAP_URLS)}.`);
        }
        if (pages.full) {
          capped = true;
          note(`Намерени са над ${spaced(MAX_FOUND)} страници — списъкът е съкратен.`);
        }
        progress(`Намерени страници: ${pages.size}`);
        return;
      }
      // an index: its files are read one after the other, a limited number of them, a limited number of levels down
      if (depth >= MAX_SITEMAP_DEPTH) {
        capped = true;
        note(`Sitemap индексът е вложен твърде дълбоко (над ${MAX_SITEMAP_DEPTH} нива) — вътрешните файлове са пропуснати.`);
        return;
      }
      for (const child of sitemap.sitemaps) {
        let childUrl: string;
        try {
          const parsed = new URL(child);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
          childUrl = parsed.href;
        } catch {
          continue;
        }
        if (visited.has(childUrl)) continue;
        if (!pages.isSiteUrl(childUrl)) {
          note(`Sitemap „${shortUrl(childUrl)}“ е извън сайта — пропуснат.`);
          continue;
        }
        if (pages.full) break; // the set of pages is full: the note about it was already made
        if (childrenRead >= MAX_CHILD_SITEMAPS) {
          capped = true;
          note(`Индексът на sitemap е голям — прочетени са само първите ${MAX_CHILD_SITEMAPS} файла.`);
          break;
        }
        childrenRead++;
        await readSitemap(childUrl, depth + 1, true);
      }
    };

    // robots.txt names the sitemaps the site wants read; the scheme it answers on is learnt here too
    progress('Чета robots.txt…');
    let declared: string[] = [];
    for (const scheme of ['https', 'http']) {
      const robotsUrl = `${scheme}://${host}/robots.txt`;
      const robots = await fetchText(robotsUrl, ROBOTS_MAX_BYTES);
      aborted();
      // no answer at all (a network error) → try the other scheme; any answer, even a 404, shows the server speaks this one
      if (robots.status === 'error' && robots.httpStatus === null) continue;
      origin = `${scheme}://${host}`;
      if (robots.status === 'ok' && robots.text !== null) declared = sitemapsFromRobots(robots.text, robots.finalUrl ?? robotsUrl);
      break;
    }

    // the first source that yields pages wins: what robots.txt names, else the usual places
    const sources: Array<() => Promise<void>> = [
      async () => {
        for (const url of declared) {
          if (pages.full) break;
          if (pages.isSiteUrl(url)) await readSitemap(url, 0, true);
          else note(`Sitemap „${shortUrl(url)}“ е извън сайта — пропуснат.`);
        }
      },
      () => readSitemap(`${origin}/sitemap.xml`, 0, false),
      () => readSitemap(`${origin}/sitemap_index.xml`, 0, false),
      () => readSitemap(`${origin}/wp-sitemap.xml`, 0, false),
    ];
    for (const read of sources) {
      await read();
      if (pages.size > 0) break;
    }
  }

  if (pages.size > 0) {
    // the homepage is always audited, whether or not the sitemap lists it
    const homeKey = homeKeyOf(`${origin}/`);
    if (!pages.has(homeKey)) pages.add(`${origin}/`, undefined, true);
    const urls = pages.ordered(homeKey).slice(0, maxPages);
    progress(`Намерени страници: ${pages.size}`);
    return { urls, found: pages.size, source: 'sitemap', truncated: capped || pages.size > urls.length, notes };
  }

  // ── 2. no sitemap: the links of the homepage ─────────────────────────────────────────────
  progress('Обхождам връзките от началната страница…');
  const fetchOne = async (url: string): Promise<FetchedPage> => {
    aborted();
    let page: FetchedPage;
    try {
      page = await fetcher.fetchPage(url, signal ? { signal } : undefined);
    } catch (err) {
      aborted();
      page = { status: 'error', httpStatus: null, finalUrl: null, html: null, error: unexpected(err), ttfbMs: null, bytes: null, fromCache: false };
    }
    aborted();
    return page;
  };

  let home = await fetchOne(`${origin}/`);
  if (home.status === 'error' && origin.startsWith('https:')) {
    const retry = await fetchOne(`http://${host}/`);
    if (retry.status !== 'error') {
      home = retry;
      origin = `http://${host}`;
    }
  }
  if (home.status !== 'ok' || home.html === null) {
    note(`Не е намерен sitemap, а началната страница ${origin}/ не може да се изтегли: ${home.error ?? 'неизвестна грешка'}. Няма страници за одит.`);
    return { urls: [], found: 0, source: 'single', truncated: false, notes };
  }
  const homeUrl = home.finalUrl ?? `${origin}/`;
  if (!pages.isSiteUrl(homeUrl)) {
    note(`Не е намерен sitemap, а началната страница пренасочва към друг сайт (${shortUrl(homeUrl)}) — въведи неговия домейн, за да се обходи.`);
    return { urls: [], found: 0, source: 'single', truncated: false, notes };
  }
  note('Не е намерен sitemap — страниците са открити чрез връзките от началната страница, затова списъкът може да е непълен.');

  pages.add(homeUrl, undefined, true);
  const homeKey = homeKeyOf(homeUrl);
  const frontier: string[] = [];
  for (const href of extractLinks(home.html, homeUrl)) {
    const added = pages.add(href);
    if (added !== null) frontier.push(added);
  }
  progress(`Намерени страници: ${pages.size}`);

  // The pages the homepage links to (depth 1) are read for their links too, which finds the pages at depth 2 (CRAWL_MAX_DEPTH);
  // those are listed but not read. A fixed number of requests is all this may cost, and it stops as soon as there are enough pages.
  let fetches = 1;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      aborted();
      if (pages.size >= maxPages || fetches >= CRAWL_MAX_FETCHES) return;
      const target = frontier[next++];
      if (target === undefined) return;
      fetches++;
      const page = await fetchOne(target);
      if (page.status === 'ok' && page.html !== null) {
        const base = page.finalUrl ?? target;
        for (const href of extractLinks(page.html, base)) pages.add(href);
        progress(`Прочетени страници: ${fetches}, намерени: ${pages.size}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, worker));
  const unexplored = next < frontier.length;
  if (unexplored) {
    capped = true;
    if (fetches >= CRAWL_MAX_FETCHES && pages.size < maxPages) {
      note(`Обходът по връзките е ограничен (най-много ${CRAWL_MAX_FETCHES} страници и ${CRAWL_MAX_DEPTH} нива) — добави sitemap.xml, за да се виждат всички страници.`);
    }
  }
  if (pages.full) capped = true;

  const urls = pages.ordered(homeKey).slice(0, maxPages);
  if (pages.size <= 1) note('Не са намерени вътрешни връзки — одитира се само началната страница.');
  progress(`Намерени страници: ${pages.size}`);
  return { urls, found: pages.size, source: pages.size > 1 ? 'links' : 'single', truncated: capped || pages.size > urls.length, notes };
}
