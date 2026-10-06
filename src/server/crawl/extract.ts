import * as cheerio from 'cheerio/slim';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, ChildNode, Element, ParentNode } from 'domhandler';
import { DomHandler, Parser } from 'htmlparser2';
import type { Heading, PageMetrics } from '../../shared/schemas';
import { stripInvisible } from '../../shared/text';
import type { ExtractedPage } from '../jev/questions';
import { containsKeyword, coverage, looksLikeQuestion, slugMatchesKeyword, startsWithKeyword } from '../nlp/bg';
import { domainOf } from '../providers/serp/types';

// Turns raw HTML into measured on-page facts plus the few text slices Jev needs.
// Everything numeric lives here, in code — Jev is not a calculator (docs.typesafe.ai/model-jaggedness/jev-1.13).

const MAX_FULL_TEXT = 60_000;

// A competitor's page is untrusted input. The production server runs this in a worker thread with a hard deadline
// (extract-pool.ts); in tests and `npm run dev` it runs on the thread that also serves the web UI. Either way every step
// below is linear in the size of the page, and these limits keep that size (and the shape of the tree) bounded.
/** Markup past this many characters is ignored (CRAWL_MAX_BYTES already caps what is downloaded). */
const MAX_HTML_CHARS = 1_500_000;
/** Elements nested deeper than this are flattened into their parent: real pages stay far below, browsers cap near 512. */
const MAX_DEPTH = 256;
/** Chunk size and time budget of the parser (see parseBounded); a page nesting more than this many levels past MAX_DEPTH is cut off. */
const PARSE_CHUNK = 32_768;
const PARSE_BUDGET_MS = 2_500;
const MAX_OVERFLOW = 2_000;
/** Parsing stops after this many elements: whatever the shape of a page, every later step works on a bounded tree. */
const MAX_PARSED_ELEMENTS = 120_000;
/** Strings that a page controls and that end up in the report are cut to these lengths. */
const MAX_TITLE = 300;
const MAX_META = 500;
const MAX_CANONICAL = 2_048;
const MAX_LANG = 35;
const MAX_SCHEMA_TYPE = 100;
/** Text scanned with regular expressions. */
const MAX_SCAN_TEXT = 400_000;
/** How many elements of one kind are examined (links, buttons, forms, articles, schema blocks). */
const MAX_ELEMENTS = 5_000;
/** One extraction may not hold its thread longer than this (checked between steps); a page that needs more is reported as not analysable. */
const TIME_BUDGET_MS = 4_000;

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

const BLOCK_ELEMENTS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'section', 'article', 'header', 'footer',
  'blockquote', 'dt', 'dd', 'figcaption', 'main', 'aside', 'nav', 'form', 'table',
]);

const CTA_RE =
  /(поръч|заяви|заявка|свържи|свържете|запитване|оферт|консултаци|безплатн|започн|разбер|виж\s+цен|изпрат|обади|звънни|купи|регистр|пробв|демо|contact|get\s+(?:a\s+)?(?:quote|started)|request|order|buy|book|free\s+(?:quote|consult)|call\s+us|start\s+now)/iu;
const PRICE_CURRENCY_RE = /(?:от\s+)?\d[\d\s.,]{0,8}\s?(?:лв\.?|лева|bgn|eur|евро|€|usd|\$)(?:\s?(?:\/|на)\s?(?:месец|мес\.?|година|час))?/giu;
const PRICE_WORD_RE = /(?<![\p{L}])(?:ценова\s+листа|ценообразуване|цени|цената|цена|pricing|price)(?![\p{L}])/giu;
// A phone number starts with +, 00 or a national trunk 0 — this keeps company IDs (ЕИК 123456789) and years out.
const PHONE_RE = /(?<![\w.])(?:\+|00|0)\d[\d\s().-]{6,16}\d/g;
// Bounded quantifiers: an unbounded `[a-z0-9._%+-]+` makes every long run of those characters (no "@" needed) quadratic.
const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}/gi;
const SOCIAL_PROOF_RE = /(доволн[иа]|клиент|отзив|препоръ|проект|портфолио|референци|рейтинг|оценк|testimonial|case\s+study|★|⭐)/iu;
const WORK_HEADING_RE = /(портфолио|проекти|референци|клиент|отзив|case|работи|примери|portfolio|testimonial)/iu;
const ABOUT_RE = /(за\s+нас|кои\s+сме|екип|about|team|компания)/iu;
const FAQ_HEADING_RE = /(често\s+задавани|въпроси|faq|f\.a\.q)/iu;
const ADDRESS_RE = /(?<![\p{L}\p{N}])(?:ул|бул|гр|пл|ж\.к|жк)\.\s?[\p{L}\d]/iu;
const REGISTRATION_RE = /(?<![\p{L}])(?:ЕИК|булстат|ддс\s*(?:номер|№)|vat\s*(?:number|no)?)(?![\p{L}])/iu;
const ENTITY_RE = /(?<![\p{L}])(?:ЕООД|ООД|АД|ЕТ)(?![\p{L}])/u;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i;

const NOISE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'link', 'meta', 'textarea', 'option', 'datalist']);
// Hidden by inline style. "font-size:0" and "opacity:0" must not match "0.9em" or "0.5", hence the exact forms.
// Text that a style SHEET or a CSS class hides (".sr-only", "visually-hidden") cannot be seen from the markup alone.
const HIDDEN_STYLE_RE = new RegExp(
  [
    'display\\s*:\\s*none',
    'visibility\\s*:\\s*hidden',
    'font-size\\s*:\\s*0(?:px|em|rem|%|pt)?\\s*(?:;|!|$)',
    'font-size\\s*:\\s*[12](?:\\.\\d+)?px',
    'opacity\\s*:\\s*0?\\.?0\\d*\\s*(?:;|!|$)',
    '(?:left|right|top|bottom|text-indent)\\s*:\\s*-\\d{4,}',
    'color\\s*:\\s*transparent',
    'clip\\s*:\\s*rect\\(\\s*0',
  ].join('|'),
  'i',
);
const COLLAPSED_BOX_RE = /(?:height|width|max-height|max-width)\s*:\s*0(?:px|em|rem|%)?\s*(?:;|!|$)/i;
const CLIPPED_RE = /overflow\s*:\s*hidden/i;
const COOKIE_TAGS = new Set(['div', 'section', 'aside']);
const COOKIE_RE = /cookie/i;
const CONSENT_RE = /consent|gdpr/i;
const CHROME_ROLES = new Set(['navigation', 'contentinfo', 'complementary']);

/** Elements that are not page content: scripts, hidden text (a trick to show crawlers something else), cookie banners. */
function isNoise(el: Element): boolean {
  if (NOISE_TAGS.has(el.name)) return true;
  const a = el.attribs;
  if ('hidden' in a || a['aria-hidden'] === 'true') return true;
  if (a.style && (HIDDEN_STYLE_RE.test(a.style) || (COLLAPSED_BOX_RE.test(a.style) && CLIPPED_RE.test(a.style)))) return true;
  // A class mentioning "cookie" marks a banner only if the element is small and holds no page content: a page wrapper
  // with a class such as "has-cookie-banner" must not take the whole page with it.
  if (COOKIE_TAGS.has(el.name) && (COOKIE_RE.test(a.id ?? '') || COOKIE_RE.test(a.class ?? '')) && looksLikeBanner(el)) return true;
  if (el.name === 'div' && (CONSENT_RE.test(a.id ?? '') || CONSENT_RE.test(a.class ?? '')) && looksLikeBanner(el)) return true;
  return false;
}

/** Small (a few sentences), without headings or main content, and cheap to decide: the walk is bounded. */
function looksLikeBanner(el: Element): boolean {
  let chars = 0;
  let steps = 0;
  const stack: AnyNode[] = [el];
  while (stack.length > 0) {
    const n = stack.pop() as AnyNode;
    if (++steps > 5_000) return false;
    if (n.type === 'text') {
      chars += n.data.trim().length;
      if (chars > 800) return false;
      continue;
    }
    if (isElement(n) && n !== el && (n.name === 'main' || n.name === 'article' || n.name === 'h1')) return false;
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as ChildNode);
  }
  return true;
}

/** A form with a textarea, or three or more free-text fields; a search box (or role=search) makes it a search form. */
function isContactForm(form: Element): boolean {
  if (form.attribs.role === 'search') return false;
  let textareas = 0;
  let textInputs = 0;
  const stack: AnyNode[] = [...form.children];
  while (stack.length > 0) {
    const n = stack.pop() as AnyNode;
    if (!isElement(n)) continue;
    if (n.name === 'textarea') textareas++;
    else if (n.name === 'input') {
      const type = (n.attribs.type ?? 'text').toLowerCase();
      if (type === 'search') return false;
      if (type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'checkbox' && type !== 'radio') textInputs++;
    }
    for (const kid of n.children) stack.push(kid);
  }
  return textareas > 0 || textInputs >= 3;
}

/** Navigation, footers and sidebars: what surrounds the content. */
function isChrome(el: Element): boolean {
  return el.name === 'nav' || el.name === 'footer' || el.name === 'aside' || CHROME_ROLES.has(el.attribs.role ?? '');
}

const squash = (s: string): string => stripInvisible(s).replace(/\s+/g, ' ').trim();

function jsonLdTypes($: CheerioAPI): string[] {
  const found = new Set<string>();
  // Only page-level entities count (top level and @graph members). Nested objects such as the Question/Answer
  // pairs inside a FAQPage or a PostalAddress describe parts of an entity, not what kind of page this is.
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') found.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && found.add(x));
    if (obj['@graph']) visit(obj['@graph']);
  };
  $('script[type="application/ld+json"]')
    .slice(0, 20)
    .each((_, el) => {
    const raw = plainText(el).trim();
    if (!raw || raw.length > 200_000) return;
    try {
      visit(JSON.parse(raw));
    } catch {
      // Many sites ship slightly broken JSON-LD; the types are simply unknown then.
    }
    });
  $('[itemtype]')
    .slice(0, 200)
    .each((_, el) => {
    const t = ($(el).attr('itemtype') ?? '').split('/').pop();
    if (t) found.add(t);
    });
  return [...found].map((t) => t.slice(0, MAX_SCHEMA_TYPE)).slice(0, 20);
}

const isElement = (n: AnyNode): n is Element => n.type === 'tag' || n.type === 'script' || n.type === 'style';
const childrenOf = (n: AnyNode): readonly ChildNode[] => ('children' in n ? (n.children as ChildNode[]) : []);

/** Concatenated text nodes of a subtree (what jQuery's .text() returns), without recursion. */
function plainText(root: AnyNode): string {
  const out: string[] = [];
  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as AnyNode;
    if (n.type === 'text') out.push(n.data);
    else if (n.type !== 'comment') {
      const kids = childrenOf(n);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as ChildNode);
    }
  }
  return out.join('');
}

const END_OF_BLOCK = Symbol('end of block');

/**
 * Text of a subtree with block boundaries and <br> kept as newlines (so words never glue together), one trimmed line
 * per block. `skip` prunes whole subtrees. One pass, no cloning: the previous clone + find + append version was
 * quadratic in cheerio.
 */
function blockText(root: AnyNode, skip?: (el: Element) => boolean): string {
  const out: string[] = [];
  const stack: Array<AnyNode | typeof END_OF_BLOCK> = [root];
  while (stack.length > 0) {
    const n = stack.pop() as AnyNode | typeof END_OF_BLOCK;
    if (n === END_OF_BLOCK) {
      out.push('\n');
      continue;
    }
    if (n.type === 'text') {
      out.push(n.data);
      continue;
    }
    if (n.type === 'comment') continue;
    if (isElement(n)) {
      if (n.name === 'br') {
        out.push('\n');
        continue;
      }
      if (skip?.(n)) continue;
      if (BLOCK_ELEMENTS.has(n.name)) stack.push(END_OF_BLOCK);
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as ChildNode);
  }
  return out
    .join('')
    .split('\n')
    .map(squash)
    .filter(Boolean)
    .join('\n');
}

/** h1–h4 elements in document order, not looking inside navigation chrome; stops after `limit`. */
function collectHeadings(root: AnyNode, limit: number): Array<{ level: number; el: Element }> {
  const found: Array<{ level: number; el: Element }> = [];
  const stack: AnyNode[] = [root];
  while (stack.length > 0 && found.length < limit) {
    const n = stack.pop() as AnyNode;
    if (isElement(n)) {
      if (isChrome(n)) continue;
      if (/^h[1-4]$/.test(n.name)) found.push({ level: Number(n.name[1]), el: n });
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as ChildNode);
  }
  return found;
}

/**
 * Removes noise elements in one pass: each parent's child list is filtered once. cheerio's .remove() splices the
 * parent's array per element, which is quadratic for a parent with many removable children (e.g. 100 000 <script>).
 */
function stripNoise(root: ParentNode): void {
  const stack: ParentNode[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop() as ParentNode;
    const kids = parent.children;
    const kept: ChildNode[] = [];
    for (const child of kids) {
      if (isElement(child) && child.name !== 'html' && child.name !== 'body' && isNoise(child)) continue;
      kept.push(child);
      if ('children' in child) stack.push(child as ParentNode);
    }
    if (kept.length === kids.length) continue;
    parent.children = kept;
    kept.forEach((c, i) => {
      c.parent = parent;
      c.prev = kept[i - 1] ?? null;
      c.next = kept[i + 1] ?? null;
    });
  }
}

/** htmlparser2 with a depth limit: deeper elements are not created, their text lands in the deepest allowed parent. */
class BoundedHandler extends DomHandler {
  private open = 0;
  private overflow = 0;
  private elements = 0;
  /** True once the page nests absurdly deep or has far too many elements: the rest of it is not worth reading. */
  tooDeep = false;

  override onopentag(name: string, attribs: { [key: string]: string }): void {
    if (++this.elements > MAX_PARSED_ELEMENTS) this.tooDeep = true;
    if (this.open >= MAX_DEPTH) {
      if (++this.overflow > MAX_OVERFLOW) this.tooDeep = true;
      return;
    }
    this.open++;
    super.onopentag(name, attribs);
  }

  /**
   * Text inside elements that were not created is dropped, not moved into the deepest parent: its own attributes
   * (hidden, style) were never seen, so it could be anything a stripper would have removed.
   */
  override ontext(data: string): void {
    if (this.overflow > 0) return;
    super.ontext(data);
  }

  override onclosetag(): void {
    if (this.overflow > 0) {
      this.overflow--;
      return;
    }
    this.open--;
    super.onclosetag();
  }
}

/**
 * The parser keeps its own stack of open tags and that stack costs more per tag the deeper the page nests, which the
 * handler cannot prevent. So the page is fed in chunks and parsing stops as soon as it gets absurdly deep, or fails
 * if it eats its time budget: whatever the shape of the input, the thread is held for a bounded time.
 */
function parseBounded(html: string): ParentNode {
  const handler = new BoundedHandler();
  const parser = new Parser(handler, { decodeEntities: true });
  const startedAt = performance.now();
  for (let i = 0; i < html.length; i += PARSE_CHUNK) {
    parser.write(html.slice(i, i + PARSE_CHUNK));
    if (handler.tooDeep) break;
    if (performance.now() - startedAt > PARSE_BUDGET_MS) throw new ExtractError('Страницата е твърде сложна за разбор (стъпка „разбор“)');
  }
  parser.end();
  return handler.root as unknown as ParentNode;
}

const wordCountOf = (text: string): number => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;

function normalizeUrlForCompare(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function uniqueLimited(values: Iterable<string>, limit: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = squash(v);
    if (!s || s.length > maxLen) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** Short snippets around each regex match: non-overlapping and cut on word boundaries so they read cleanly. */
function contextsAround(text: string, re: RegExp, radius: number, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let coveredUntil = -1;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i < coveredUntil) continue; // already inside the previous snippet
    let from = Math.max(0, i - radius);
    let to = Math.min(text.length, i + m[0].length + radius);
    // Look for a word boundary inside the snippet only (bounded windows: a text without spaces must not be rescanned)
    if (from > 0 && /\S/.test(text[from - 1] ?? '')) {
      const space = text.slice(from, i).indexOf(' ');
      if (space !== -1) from = from + space + 1;
    }
    if (to < text.length && /\S/.test(text[to] ?? '')) {
      const start = i + m[0].length;
      const space = text.slice(start, to).lastIndexOf(' ');
      if (space > 0) to = start + space;
    }
    coveredUntil = to;
    const ctx = squash(text.slice(from, to));
    const key = ctx.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ctx);
    if (out.length >= limit) break;
  }
  return out;
}

// ── page facts: dates, tables, lists, cited sources, author, FAQ ────────────────────────────────
// Each step is one pass over the (already bounded) tree or a bounded probe: nothing revisits a subtree, nothing nests a
// scan inside a scan, and every count stops at MAX_ELEMENTS, so a page of 100 000 lists, tables or links costs what one
// of 5 000 does. JSON-LD is walked with an explicit stack and a node budget (JSON.parse accepts nesting that would
// overflow the call stack of a recursive walk).

const DAY_MS = 86_400_000;
const MIN_PAGE_DATE_MS = Date.UTC(1995, 0, 1);
const MAX_DATE_ATTR = 64;
const MAX_JSON_LD_NODES = 20_000;
const MAX_FAQ_QUESTIONS = 50;
const MAX_EXTERNAL_DOMAINS = 200;
const MAX_HREF = 2_048;
/** Text examined around an element to decide what it is (a date label, a byline): enough for a label, never a subtree. */
const MAX_PROBE_CHARS = 400;
const MAX_PROBE_STEPS = 200;
/** All such probes on one page together; past it, no more are made. */
const PROBE_BUDGET = 60_000;

// Anchored, fixed-width groups: no backtracking whatever the input (which is cut to MAX_DATE_ATTR characters first).
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
// "Последна актуализация" (the usual Bulgarian label) and "обновяване" are nouns, so the adjective forms alone would miss them
const MODIFIED_RE = /updated|modified|обновен|обновяван|актуализиран|актуализаци|последна промяна/iu;
const PUBLISHED_CLASS_RE = /date|publish|posted|byline|meta/iu;
const PUBLISHED_OWN_RE = /publish/iu;
const AUTHOR_CLASS_RE = /(^|[-_ ])(author|byline|autor)([-_ ]|$)/iu;
/** Sites that are linked for sharing and profiles, not as sources: they say nothing about whether a page cites anything. */
const SOCIAL_DOMAINS: ReadonlySet<string> = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'pinterest.com', 't.me', 'wa.me', 'whatsapp.com',
]);

/** A date a page claims, as an ISO string — or null when it is not a real calendar date between 1995-01-01 and tomorrow. */
function parsePageDate(raw: string | undefined, now: Date): string | null {
  if (raw === undefined || raw.length > MAX_DATE_ATTR) return null;
  const m = ISO_DATE_RE.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  if (year < 1995 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (new Date(local).getUTCDate() !== day) return null; // "31 February" would silently become March
  let offsetMinutes = 0; // a date without a zone is read as UTC, so the result does not depend on the server's time zone
  const zone = m[8];
  if (zone !== undefined && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const zoneHours = Number(digits.slice(0, 2));
    const zoneMinutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (zoneHours > 23 || zoneMinutes > 59) return null;
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (zoneHours * 60 + zoneMinutes);
  }
  const at = local - offsetMinutes * 60_000;
  if (at < MIN_PAGE_DATE_MS || at > now.getTime() + DAY_MS) return null;
  return new Date(at).toISOString();
}

/** The first of `candidates` that is a usable date. */
function firstDate(candidates: readonly string[], now: Date): string | null {
  for (const candidate of candidates) {
    const iso = parsePageDate(candidate, now);
    if (iso !== null) return iso;
  }
  return null;
}

/** The text of a subtree, read only as far as `maxChars` / `maxSteps` allow; `complete` says the whole subtree was read. */
function probeText(root: AnyNode, maxChars: number, maxSteps: number): { text: string; complete: boolean; steps: number } {
  const parts: string[] = [];
  let chars = 0;
  let steps = 0;
  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as AnyNode;
    if (++steps > maxSteps) return { text: parts.join(''), complete: false, steps };
    if (n.type === 'text') {
      parts.push(n.data.slice(0, maxChars + 1));
      chars += n.data.length;
      if (chars > maxChars) return { text: parts.join(''), complete: false, steps };
      continue;
    }
    if (n.type === 'comment') continue;
    const kids = childrenOf(n);
    // only the children that could still be reached within the step limit are queued
    for (let i = Math.min(kids.length, maxSteps - steps + 1) - 1; i >= 0; i--) stack.push(kids[i] as ChildNode);
  }
  return { text: parts.join(''), complete: true, steps };
}

/** What is written in front of `el` inside its parent: the previous siblings' text, nearest first, up to `max` characters; a previous <time> ends it. */
function textBefore(el: Element, max: number): { text: string; steps: number } {
  const parts: string[] = [];
  let chars = 0;
  let steps = 0;
  for (let sibling = el.prev, seen = 0; sibling && seen < 20 && chars < max; sibling = sibling.prev, seen++) {
    if (isElement(sibling) && sibling.name === 'time') break;
    const probe = probeText(sibling, max, 50);
    steps += probe.steps;
    parts.push(probe.text);
    chars += probe.text.length;
  }
  return { text: parts.join(' '), steps };
}

const hasToken = (value: string | undefined, token: string): boolean => value !== undefined && value.length <= 200 && value.toLowerCase().split(/\s+/).includes(token);
const attrText = (el: Element): string => `${el.attribs.class ?? ''} ${el.attribs.id ?? ''}`.slice(0, 400);

const asStrings = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').slice(0, 5) : []);
const hasSchemaType = (node: Record<string, unknown>, name: string): boolean => asStrings(node['@type']).some((t) => t.slice(0, 100).toLowerCase().endsWith(name));

function hasAuthorValue(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.trim().length >= 2;
  if (Array.isArray(value)) return depth < 2 && value.slice(0, 10).some((x) => hasAuthorValue(x, depth + 1));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return (typeof o.name === 'string' && o.name.trim().length >= 2) || (typeof o['@id'] === 'string' && o['@id'].length > 0);
  }
  return false;
}

interface JsonLdFacts {
  modified: string[];
  published: string[];
  hasAuthor: boolean;
  faqQuestions: number;
}

/**
 * dateModified, datePublished, author and the FAQ questions of the page-level JSON-LD entities (top level and @graph
 * members; nested objects such as a Review's own datePublished describe other things). Scripts that are not valid JSON are skipped.
 */
function readJsonLd(scripts: readonly string[], now: Date): JsonLdFacts {
  const facts: JsonLdFacts = { modified: [], published: [], hasAuthor: false, faqQuestions: 0 };
  let budget = MAX_JSON_LD_NODES;
  for (const raw of scripts) {
    const text = raw.trim();
    if (!text || text.length > 200_000) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const stack: unknown[] = [parsed];
    while (stack.length > 0 && budget > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      budget--;
      const obj = node as Record<string, unknown>;
      for (const value of asStrings(obj.dateModified)) {
        const iso = parsePageDate(value, now);
        if (iso !== null) facts.modified.push(iso);
      }
      for (const value of asStrings(obj.datePublished)) {
        const iso = parsePageDate(value, now);
        if (iso !== null) facts.published.push(iso);
      }
      if (!facts.hasAuthor && hasAuthorValue(obj.author)) facts.hasAuthor = true;
      if (hasSchemaType(obj, 'faqpage')) {
        const entities = Array.isArray(obj.mainEntity) ? obj.mainEntity.slice(0, 1_000) : [obj.mainEntity];
        for (const entity of entities) {
          if (entity && typeof entity === 'object' && hasSchemaType(entity as Record<string, unknown>, 'question')) facts.faqQuestions++;
        }
      }
      if (obj['@graph'] !== undefined) stack.push(obj['@graph']);
    }
  }
  return facts;
}

interface DocumentFacts {
  /** Dates from JSON-LD and <meta> tags, in order of preference; null = none of them is a usable date. */
  modifiedAt: string | null;
  publishedAt: string | null;
  /** JSON-LD author, <meta itemprop="author">, <link rel="author">. */
  hasAuthor: boolean;
  faqQuestions: number;
}

/**
 * What only exists before stripNoise: <script type="application/ld+json"> and <meta>/<link> are noise elements and are
 * gone afterwards. One pass over the tree; JSON-LD is read from the first 20 scripts, <meta> from the first MAX_ELEMENTS.
 */
function readDocumentFacts(root: ParentNode, now: Date): DocumentFacts {
  const scripts: string[] = [];
  const articleModified: string[] = [];
  const ogUpdated: string[] = [];
  const itemModified: string[] = [];
  const articlePublished: string[] = [];
  const itemPublished: string[] = [];
  let hasAuthor = false;
  let metas = 0;
  const keep = (list: string[], value: string | undefined): void => {
    if (value !== undefined && value.length <= MAX_DATE_ATTR && list.length < 5) list.push(value);
  };

  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as AnyNode;
    if (isElement(n)) {
      const a = n.attribs;
      if (n.name === 'script') {
        if (scripts.length < 20 && (a.type ?? '').trim().toLowerCase().startsWith('application/ld+json')) scripts.push(plainText(n));
        continue; // a script holds text only
      }
      if (n.name === 'meta') {
        if (++metas <= MAX_ELEMENTS) {
          const names = [a.property, a.name].map((v) => (v ?? '').trim().toLowerCase());
          const item = (a.itemprop ?? '').trim().toLowerCase();
          if (names.includes('article:modified_time')) keep(articleModified, a.content);
          if (names.includes('og:updated_time')) keep(ogUpdated, a.content);
          if (names.includes('article:published_time')) keep(articlePublished, a.content);
          if (item === 'datemodified') keep(itemModified, a.content);
          if (item === 'datepublished') keep(itemPublished, a.content);
          if (item === 'author' && (a.content ?? '').trim().length >= 2) hasAuthor = true;
        }
        continue;
      }
      if (n.name === 'link') {
        if (hasToken(a.rel, 'author')) hasAuthor = true;
        continue;
      }
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as ChildNode);
  }

  const ld = readJsonLd(scripts, now);
  // JSON-LD may describe several entities (WebPage, Article): the latest modification and the earliest publication win
  const latest = ld.modified.length > 0 ? ld.modified.reduce((a, b) => (b > a ? b : a)) : null;
  const earliest = ld.published.length > 0 ? ld.published.reduce((a, b) => (b < a ? b : a)) : null;
  return {
    modifiedAt: latest ?? firstDate(articleModified, now) ?? firstDate(ogUpdated, now) ?? firstDate(itemModified, now),
    publishedAt: earliest ?? firstDate(articlePublished, now) ?? firstDate(itemPublished, now),
    hasAuthor: hasAuthor || ld.hasAuthor,
    faqQuestions: Math.min(ld.faqQuestions, MAX_FAQ_QUESTIONS),
  };
}

const isNavOrAside = (el: Element): boolean => el.name === 'nav' || el.name === 'aside' || el.attribs.role === 'navigation' || el.attribs.role === 'complementary';

interface MarkupFacts {
  hasAuthor: boolean;
  modifiedItemprop: string | null;
  modified: string | null;
  publishedItemprop: string | null;
  published: string | null;
}

/**
 * Facts that need the visible markup (hidden elements are already gone): author markup and <time> elements.
 * A <time datetime> counts as the modification date when it, or what surrounds it, is labelled "updated", and as the
 * publication date when it sits in an <article> / <header> or something classed date/publish/posted/byline/meta;
 * times in menus and sidebars (other posts' dates) never count.
 */
function readMarkupFacts(root: AnyNode, now: Date): MarkupFacts {
  const facts: MarkupFacts = { hasAuthor: false, modifiedItemprop: null, modified: null, publishedItemprop: null, published: null };
  let budget = PROBE_BUDGET;
  let times = 0;

  /** How many <time> elements an element has as direct children (cached: a parent with thousands of them is asked about once). */
  const timesIn = new WeakMap<Element, number>();
  const timeChildren = (parent: Element): number => {
    let n = timesIn.get(parent);
    if (n === undefined) {
      n = 0;
      for (const c of parent.children) if (isElement(c) && c.name === 'time') n++;
      timesIn.set(parent, n);
    }
    return n;
  };
  /** Does the <time>, or what labels it, call itself "updated"? Its own class, id or text; the label written in front of it; the class of the few elements above it. */
  const looksModified = (el: Element): boolean => {
    if (MODIFIED_RE.test(attrText(el))) return true;
    const own = probeText(el, 200, 50);
    budget -= own.steps;
    if (MODIFIED_RE.test(own.text)) return true;
    let node: Element = el;
    for (let level = 0; level < 3; level++) {
      const parent = node.parent;
      if (!parent || !isElement(parent)) break;
      if (MODIFIED_RE.test(attrText(parent))) return true;
      // "Published: <time> | Updated: <time>": a label belongs to the date that follows it, so only the text in front counts …
      const before = textBefore(node, 80);
      budget -= before.steps;
      if (MODIFIED_RE.test(before.text)) return true;
      // … unless the date is the only one in its parent, when the parent's whole text (label before or after) describes it
      if (level === 0 && timeChildren(parent) === 1) {
        const around = probeText(parent, MAX_PROBE_CHARS, MAX_PROBE_STEPS);
        budget -= around.steps;
        if (MODIFIED_RE.test(around.text)) return true;
      }
      node = parent;
    }
    return false;
  };
  const looksPublished = (el: Element): boolean => {
    if (PUBLISHED_CLASS_RE.test(attrText(el))) return true;
    let depth = 0;
    for (let up = el.parent; up && isElement(up) && depth < MAX_DEPTH; up = up.parent, depth++) {
      if (up.name === 'article' || up.name === 'header') return true;
      if (depth < 3 && PUBLISHED_CLASS_RE.test(attrText(up))) return true;
    }
    return false;
  };
  const inMenuOrSidebar = (el: Element): boolean => {
    let depth = 0;
    for (let up = el.parent; up && isElement(up) && depth < MAX_DEPTH; up = up.parent, depth++) if (isNavOrAside(up)) return true;
    return false;
  };

  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as AnyNode;
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as ChildNode);
    if (!isElement(n)) continue;
    const a = n.attribs;

    if (!facts.hasAuthor) {
      if (hasToken(a.itemprop, 'author') || hasToken(a.rel, 'author')) facts.hasAuthor = true;
      else if (budget > 0 && (a.class !== undefined || a.id !== undefined)) {
        const label = `${a.class ?? ''}`.slice(0, 1_000);
        const id = `${a.id ?? ''}`.slice(0, 1_000);
        if (AUTHOR_CLASS_RE.test(label) || AUTHOR_CLASS_RE.test(id)) {
          // a byline is a name, not a biography: 2–80 characters of text, read in full
          const probe = probeText(n, MAX_PROBE_CHARS, MAX_PROBE_STEPS);
          budget -= probe.steps;
          const length = squash(probe.text).length;
          if (probe.complete && length >= 2 && length <= 80) facts.hasAuthor = true;
        }
      }
    }

    const allFound = facts.modified !== null && facts.published !== null && facts.modifiedItemprop !== null && facts.publishedItemprop !== null;
    if (n.name === 'time' && a.datetime !== undefined && !allFound && budget > 0 && ++times <= MAX_ELEMENTS) {
      const iso = parsePageDate(a.datetime, now);
      if (iso === null || inMenuOrSidebar(n)) continue;
      const item = (a.itemprop ?? '').toLowerCase();
      if (item.includes('datemodified')) facts.modifiedItemprop ??= iso;
      if (item.includes('datepublished')) facts.publishedItemprop ??= iso;
      const modified = looksModified(n);
      if (modified && facts.modified === null) facts.modified = iso;
      // a time labelled "updated" is not the publication date, unless it says so itself (WordPress: class="published updated")
      if (facts.published === null && (!modified || PUBLISHED_OWN_RE.test(attrText(n))) && looksPublished(n)) facts.published = iso;
    }
  }
  return facts;
}

interface StructureFacts {
  tables: number;
  lists: number;
  externalDomains: number;
}

/**
 * Tables, lists and the sites a page links to, in one pass that does not enter navigation, footers or sidebars (and,
 * for lists, headers). A table counts with at least 2 rows and 2 cells in its first row; a list with at least 3 direct
 * <li>; a link counts as a source when it leads to another site than the page's, is not a social/share link and is not
 * marked sponsored or ugc.
 */
function readStructureFacts(root: AnyNode, pageUrl: string): StructureFacts {
  let base: URL | null = null;
  try {
    base = new URL(pageUrl);
  } catch {
    base = null; // only absolute links can be told apart then
  }
  const ownDomain = domainOf(pageUrl);
  const domainOfHost = new Map<string, string>();
  const domains = new Set<string>();
  const openTables: Array<{ rows: number; firstRowCells: number; counted: boolean }> = [];
  let tables = 0;
  let lists = 0;
  let tablesSeen = 0;
  let listsSeen = 0;
  let linksSeen = 0;
  let headerDepth = 0;
  const LEAVE_TABLE = Symbol('leave table');
  const LEAVE_HEADER = Symbol('leave header');

  const cellsOf = (row: Element): number => {
    let cells = 0;
    for (const c of row.children) if (isElement(c) && (c.name === 'td' || c.name === 'th')) cells++;
    return cells;
  };
  const hasItems = (list: Element, wanted: number): boolean => {
    let items = 0;
    for (const c of list.children) if (isElement(c) && c.name === 'li' && ++items >= wanted) return true;
    return false;
  };
  const sourceOf = (el: Element): string | null => {
    const href = (el.attribs.href ?? '').trim();
    if (href === '' || href.length > MAX_HREF || href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'))) return null;
    const rel = (el.attribs.rel ?? '').slice(0, 200).toLowerCase();
    if (rel.includes('sponsored') || rel.includes('ugc')) return null;
    let url: URL;
    try {
      url = base ? new URL(href, base) : new URL(href);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let domain = domainOfHost.get(url.hostname);
    if (domain === undefined) {
      domain = domainOf(url.hostname);
      if (domainOfHost.size < 2_000) domainOfHost.set(url.hostname, domain);
    }
    return domain === '' || domain === ownDomain || SOCIAL_DOMAINS.has(domain) ? null : domain;
  };

  const stack: Array<AnyNode | typeof LEAVE_TABLE | typeof LEAVE_HEADER> = [root];
  while (stack.length > 0) {
    const n = stack.pop() as AnyNode | typeof LEAVE_TABLE | typeof LEAVE_HEADER;
    if (n === LEAVE_TABLE) {
      const t = openTables.pop();
      if (t?.counted && t.rows >= 2 && t.firstRowCells >= 2) tables++;
      continue;
    }
    if (n === LEAVE_HEADER) {
      headerDepth--;
      continue;
    }
    if (isElement(n)) {
      if (isChrome(n)) continue;
      if (n.name === 'table') {
        openTables.push({ rows: 0, firstRowCells: -1, counted: ++tablesSeen <= MAX_ELEMENTS });
        stack.push(LEAVE_TABLE);
      } else if (n.name === 'tr') {
        const t = openTables[openTables.length - 1];
        if (t) {
          t.rows++;
          if (t.firstRowCells < 0) t.firstRowCells = cellsOf(n);
        }
      } else if (n.name === 'ul' || n.name === 'ol') {
        if (headerDepth === 0 && ++listsSeen <= MAX_ELEMENTS && hasItems(n, 3)) lists++;
      } else if (n.name === 'a') {
        if (domains.size < MAX_EXTERNAL_DOMAINS && ++linksSeen <= MAX_ELEMENTS) {
          const domain = sourceOf(n);
          if (domain !== null) domains.add(domain);
        }
      } else if (n.name === 'header' || n.attribs.role === 'banner') {
        headerDepth++;
        stack.push(LEAVE_HEADER);
      }
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as ChildNode);
  }
  return { tables, lists, externalDomains: domains.size };
}

/**
 * Question-like headings (h2–h4) in an FAQ section: from a heading that names one ("Често задавани въпроси", "FAQ")
 * until a heading of the same or a higher rank that is not itself a question. Questions that are headings of the same
 * rank as the FAQ heading (a flat page) count too. Without such a heading the answer is 0.
 */
function countFaqHeadings(body: AnyNode): number {
  let count = 0;
  let sectionLevel = 0; // 0 = not inside an FAQ section
  for (const { level, el } of collectHeadings(body, 400)) {
    const probe = probeText(el, 300, 300);
    const text = squash(probe.text);
    if (!probe.complete || !text || text.length > 200) continue;
    const question = level >= 2 && looksLikeQuestion(text);
    if (!question && FAQ_HEADING_RE.test(text)) {
      sectionLevel = level;
      continue;
    }
    if (sectionLevel === 0) continue;
    if (question) {
      if (++count >= MAX_FAQ_QUESTIONS) break;
    } else if (level <= sectionLevel) sectionLevel = 0;
  }
  return count;
}

export interface ExtractContext {
  /** The URL the HTML was fetched from (final URL after redirects). */
  url: string;
  keyword: string;
  now?: Date;
}

export function extractPage(html: string, ctx: ExtractContext): ExtractedPage {
  const startedAt = performance.now();
  const checkBudget = (step: string): void => {
    if (performance.now() - startedAt > TIME_BUDGET_MS) throw new ExtractError(`Страницата е твърде сложна за разбор (стъпка „${step}“)`);
  };
  const $ = cheerio.load(parseBounded(html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html) as never);
  checkBudget('разбор');
  const now = ctx.now ?? new Date();
  const pageHost = (() => {
    try {
      return new URL(ctx.url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  })();

  // ── head-level facts (before any removal) ──────────────────────────────────────────────────
  const title = squash($('head > title').first().text() || $('title').first().text() || $('meta[property="og:title"]').attr('content') || '').slice(0, MAX_TITLE);
  const metaDescription = squash($('meta[name="description" i]').attr('content') ?? '').slice(0, MAX_META);
  const canonicalHref = $('link[rel="canonical" i]').attr('href')?.slice(0, MAX_CANONICAL);
  let canonical: string | null = null;
  if (canonicalHref) {
    try {
      canonical = new URL(canonicalHref, ctx.url).toString();
    } catch {
      canonical = null;
    }
  }
  const robotsMeta = ($('meta[name="robots" i]').attr('content') ?? '').toLowerCase();
  const lang = ($('html').attr('lang') ?? '').trim().slice(0, MAX_LANG) || null;
  const hasViewport = $('meta[name="viewport" i]').length > 0;
  const schemaTypes = jsonLdTypes($);
  // scripts and <meta> tags are removed with the other noise below, so what they say is read first
  const documentFacts = readDocumentFacts($.root().get(0) as unknown as ParentNode, now);

  const navLabels = uniqueLimited(
    $('nav a, header a, [role="navigation"] a')
      .slice(0, 300)
      .map((_, el) => plainText(el))
      .get(),
    12,
    40,
  );

  // ── strip noise, then measure the visible page ──────────────────────────────────────────────
  stripNoise($.root().get(0) as unknown as ParentNode);
  checkBudget('почистване');

  // Contact signals live in footers/headers too, so measure them on the whole visible body.
  const bodyNode = ($('body').get(0) ?? $.root().get(0)) as AnyNode;
  const wholeText = blockText(bodyNode);
  const allText = wholeText.length > MAX_SCAN_TEXT ? wholeText.slice(0, MAX_SCAN_TEXT) : wholeText;
  checkBudget('текст');
  const telLinks = new Set(
    $('a[href^="tel:" i]')
      .toArray()
      .slice(0, MAX_ELEMENTS)
      .map((el) => (isElement(el) ? (el.attribs.href ?? '') : '').replace(/\D/g, ''))
      .filter((d) => d.length >= 7),
  );
  for (const m of allText.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 13) telLinks.add(digits);
  }
  const emails = new Set(
    $('a[href^="mailto:" i]')
      .toArray()
      .slice(0, MAX_ELEMENTS)
      .map((el) => (isElement(el) ? (el.attribs.href ?? '') : '').replace(/^mailto:/i, '').split('?')[0]?.trim().toLowerCase().slice(0, 254) ?? '')
      .filter(Boolean),
  );
  for (const m of allText.matchAll(EMAIL_RE)) if (!IMAGE_EXT.test(m[0])) emails.add(m[0].toLowerCase());

  const hasContactForm = $('form')
    .toArray()
    .slice(0, 50)
    .some((form) => isElement(form) && isContactForm(form));

  const ctaTexts = uniqueLimited(
    $('a, button, input[type="submit"], input[type="button"]')
      .toArray()
      .slice(0, MAX_ELEMENTS)
      .map((el) => (isElement(el) && el.name === 'input' ? (el.attribs.value ?? '') : plainText(el)))
      .filter((t) => CTA_RE.test(t)),
    10,
    60,
  );

  const author =
    $('[rel="author"], [itemprop="author"], .author, .byline, .post-author').length > 0 || /(?<![\p{L}])автор\s*:/iu.test(allText);

  // ── dates, tables, lists, cited sources, author, FAQ (see "page facts") ───────────────────────
  const markupFacts = readMarkupFacts(bodyNode, now);
  const structureFacts = readStructureFacts(bodyNode, ctx.url);
  const faqQuestions = documentFacts.faqQuestions > 0 ? documentFacts.faqQuestions : countFaqHeadings(bodyNode);
  checkBudget('факти');

  // ── main content ────────────────────────────────────────────────────────────────────────────
  let contentRoot: AnyNode | null = null;
  let withoutChrome = false;
  const mainEl = $('main, [role="main"]').first().get(0);
  if (mainEl && plainText(mainEl).trim().length >= 300) contentRoot = mainEl;
  if (!contentRoot) {
    let best: AnyNode | null = null;
    let bestLen = 0;
    $('article')
      .slice(0, MAX_ELEMENTS)
      .each((_, el) => {
        const len = plainText(el).trim().length;
        if (len > bestLen) {
          best = el;
          bestLen = len;
        }
      });
    if (best && bestLen >= 600) contentRoot = best;
  }
  if (!contentRoot) {
    contentRoot = bodyNode; // no <main>/<article>: the body without navigation, footers and sidebars
    withoutChrome = true;
  }
  const mainText = blockText(contentRoot, withoutChrome ? isChrome : undefined);
  const full = mainText.slice(0, MAX_FULL_TEXT);
  const wordCount = wordCountOf(mainText.length > MAX_SCAN_TEXT ? mainText.slice(0, MAX_SCAN_TEXT) : mainText);
  checkBudget('съдържание');

  // ── headings (whole visible body minus navigation chrome, so the hero H1 is included) ───────
  const headings: Heading[] = [];
  for (const { level, el } of collectHeadings(bodyNode, 400)) {
    const text = squash(plainText(el));
    if (!text || text.length > 200) continue;
    const prev = headings[headings.length - 1];
    if (prev && prev.level === level && prev.text === text) continue;
    headings.push({ level, text });
    if (headings.length >= 60) break;
  }
  const cappedHeadings = headings;
  const h1 = cappedHeadings.filter((h) => h.level === 1).map((h) => h.text);
  const outline = cappedHeadings.slice(0, 80).map((h) => `H${h.level}: ${h.text}`);

  // ── links and images ────────────────────────────────────────────────────────────────────────
  let internal = 0;
  let external = 0;
  $('a[href]')
    .slice(0, MAX_ELEMENTS)
    .each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel|sms):/i.test(href)) return;
    try {
      const host = new URL(href, ctx.url).hostname.replace(/^www\./, '').toLowerCase();
      if (host === pageHost) internal++;
      else external++;
    } catch {
      // unparsable href: ignore
    }
    });
  const images = $('img');
  const imagesWithAlt = images
    .toArray()
    .slice(0, MAX_ELEMENTS)
    .filter((el) => isElement(el) && squash(el.attribs.alt ?? '').length > 0).length;

  // ── conversion / trust evidence ─────────────────────────────────────────────────────────────
  const priceMentions = contextsAround(allText, PRICE_CURRENCY_RE, 30, 8);
  if (priceMentions.length < 3) priceMentions.push(...contextsAround(allText, PRICE_WORD_RE, 40, 3 - priceMentions.length));
  const socialProof = uniqueLimited(allText.split('\n').filter((l) => SOCIAL_PROOF_RE.test(l)), 8, 200);
  const workHeadings = cappedHeadings.map((h) => h.text).filter((t) => WORK_HEADING_RE.test(t)).slice(0, 8);

  // ── misc facts ──────────────────────────────────────────────────────────────────────────────
  let latestYear: number | null = null;
  for (const m of full.matchAll(/(?<!\d)(20[0-3]\d)(?!\d)/g)) {
    const y = Number(m[1]);
    if (y <= now.getFullYear() + 1 && (latestYear === null || y > latestYear)) latestYear = y;
  }
  const questionHeadings = cappedHeadings.filter((h) => h.level >= 2 && looksLikeQuestion(h.text)).length;
  const hasFaqSection = cappedHeadings.some((h) => FAQ_HEADING_RE.test(h.text)) || questionHeadings >= 3;

  let canonicalIsSelf: boolean | null = null;
  if (canonical) canonicalIsSelf = normalizeUrlForCompare(canonical) === normalizeUrlForCompare(ctx.url);

  const kwTitle = title;
  const metrics: PageMetrics = {
    title: title || null,
    titleLength: [...title].length,
    metaDescription: metaDescription || null,
    metaDescriptionLength: [...metaDescription].length,
    h1,
    headings: cappedHeadings,
    h2Count: cappedHeadings.filter((h) => h.level === 2).length,
    h3Count: cappedHeadings.filter((h) => h.level === 3).length,
    wordCount,
    lang,
    canonical,
    canonicalIsSelf,
    noindex: /noindex/.test(robotsMeta),
    hasViewport,
    https: /^https:/i.test(ctx.url),
    schemaTypes,
    hasFaqSchema: schemaTypes.some((t) => /faqpage/i.test(t)),
    hasFaqSection,
    images: { total: images.length, withAlt: imagesWithAlt },
    links: { internal, external },
    hasContactForm,
    phones: telLinks.size,
    emails: emails.size,
    ctaTexts,
    priceMentions: priceMentions.slice(0, 8),
    socialProof,
    navLabels,
    latestYear,
    modifiedAt: documentFacts.modifiedAt ?? markupFacts.modifiedItemprop ?? markupFacts.modified,
    publishedAt: documentFacts.publishedAt ?? markupFacts.publishedItemprop ?? markupFacts.published,
    tables: structureFacts.tables,
    lists: structureFacts.lists,
    externalDomains: structureFacts.externalDomains,
    hasAuthor: author || documentFacts.hasAuthor || markupFacts.hasAuthor,
    faqQuestions,
    keyword: {
      inTitle: containsKeyword(ctx.keyword, kwTitle),
      inH1: h1.some((h) => containsKeyword(ctx.keyword, h)),
      inUrl: slugMatchesKeyword(ctx.url, ctx.keyword),
      inMeta: containsKeyword(ctx.keyword, metaDescription),
      titleCoverage: coverage(ctx.keyword, kwTitle),
      bodyCoverage: coverage(ctx.keyword, full),
      startsTitleWithKeyword: startsWithKeyword(kwTitle, ctx.keyword),
    },
  };

  const middleStart = Math.max(0, Math.floor(full.length / 2) - 500);
  return {
    metrics,
    outline,
    text: {
      intro: full.slice(0, 1500),
      middle: full.length > 3000 ? full.slice(middleStart, middleStart + 1000) : '',
      full,
    },
    hints: {
      aboutLink: navLabels.some((l) => ABOUT_RE.test(l)),
      companyRegistration: REGISTRATION_RE.test(allText) || ENTITY_RE.test(allText),
      address: ADDRESS_RE.test(allText),
      author,
      workHeadings,
    },
  };
}
