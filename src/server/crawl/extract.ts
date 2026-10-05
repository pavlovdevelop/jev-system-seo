import * as cheerio from 'cheerio/slim';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, ChildNode, Element, ParentNode } from 'domhandler';
import { DomHandler, Parser } from 'htmlparser2';
import type { Heading, PageMetrics } from '../../shared/schemas';
import { stripInvisible } from '../../shared/text';
import type { ExtractedPage } from '../jev/questions';
import { containsKeyword, coverage, looksLikeQuestion, slugMatchesKeyword, startsWithKeyword } from '../nlp/bg';

// Turns raw HTML into measured on-page facts plus the few text slices Jev needs.
// Everything numeric lives here, in code — Jev is not a calculator (docs.typesafe.ai/model-jaggedness/jev-1.13).

const MAX_FULL_TEXT = 60_000;

// A competitor's page is untrusted input and this runs on the thread that also serves the web UI. Every step below is
// linear in the size of the page, and these limits keep that size (and the shape of the tree) bounded.
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
/** One extraction may not hold the thread longer than this; a page that needs more is reported as not analysable. */
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
