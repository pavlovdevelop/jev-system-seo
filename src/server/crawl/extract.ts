import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Heading, PageMetrics } from '../../shared/schemas';
import type { ExtractedPage } from '../jev/questions';
import { containsKeyword, coverage, looksLikeQuestion, slugMatchesKeyword, startsWithKeyword } from '../nlp/bg';

// Turns raw HTML into measured on-page facts plus the few text slices Jev needs.
// Everything numeric lives here, in code — Jev is not a calculator (docs.typesafe.ai/model-jaggedness/jev-1.13).

const MAX_FULL_TEXT = 60_000;
const BLOCK_ELEMENTS = 'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,td,th,section,article,header,footer,blockquote,dt,dd,figcaption,main,aside,nav,form,table';

const CTA_RE =
  /(поръч|заяви|заявка|свържи|свържете|запитване|оферт|консултаци|безплатн|започн|разбер|виж\s+цен|изпрат|обади|звънни|купи|регистр|пробв|демо|contact|get\s+(?:a\s+)?(?:quote|started)|request|order|buy|book|free\s+(?:quote|consult)|call\s+us|start\s+now)/iu;
const PRICE_CURRENCY_RE = /(?:от\s+)?\d[\d\s.,]{0,8}\s?(?:лв\.?|лева|bgn|eur|евро|€|usd|\$)(?:\s?(?:\/|на)\s?(?:месец|мес\.?|година|час))?/giu;
const PRICE_WORD_RE = /(?<![\p{L}])(?:ценова\s+листа|ценообразуване|цени|цената|цена|pricing|price)(?![\p{L}])/giu;
// A phone number starts with +, 00 or a national trunk 0 — this keeps company IDs (ЕИК 123456789) and years out.
const PHONE_RE = /(?<![\w.])(?:\+|00|0)\d[\d\s().-]{6,16}\d/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const SOCIAL_PROOF_RE = /(доволн[иа]|клиент|отзив|препоръ|проект|портфолио|референци|рейтинг|оценк|testimonial|case\s+study|★|⭐)/iu;
const WORK_HEADING_RE = /(портфолио|проекти|референци|клиент|отзив|case|работи|примери|portfolio|testimonial)/iu;
const ABOUT_RE = /(за\s+нас|кои\s+сме|екип|about|team|компания)/iu;
const FAQ_HEADING_RE = /(често\s+задавани|въпроси|faq|f\.a\.q)/iu;
const ADDRESS_RE = /(?<![\p{L}\p{N}])(?:ул|бул|гр|пл|ж\.к|жк)\.\s?[\p{L}\d]/iu;
const REGISTRATION_RE = /(?<![\p{L}])(?:ЕИК|булстат|ддс\s*(?:номер|№)|vat\s*(?:number|no)?)(?![\p{L}])/iu;
const ENTITY_RE = /(?<![\p{L}])(?:ЕООД|ООД|АД|ЕТ)(?![\p{L}])/u;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i;

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'link', 'meta',
  '[hidden]', '[aria-hidden="true"]',
  '[style*="display:none"]', '[style*="display: none"]', '[style*="visibility:hidden"]', '[style*="visibility: hidden"]',
  '[style*="font-size:0"]', '[style*="opacity:0"]', '[style*="left:-9999"]',
  'div[id*="cookie" i], div[class*="cookie" i], section[class*="cookie" i], aside[class*="cookie" i]',
  'div[id*="consent" i], div[class*="consent" i], div[id*="gdpr" i], div[class*="gdpr" i]',
].join(',');

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

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
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      visit(JSON.parse(raw));
    } catch {
      // Many sites ship slightly broken JSON-LD; the types are simply unknown then.
    }
  });
  $('[itemtype]').each((_, el) => {
    const t = ($(el).attr('itemtype') ?? '').split('/').pop();
    if (t) found.add(t);
  });
  return [...found].slice(0, 20);
}

/** Text of an element with block boundaries preserved as newlines (so words never glue together). */
function blockText($: CheerioAPI, root: Cheerio<AnyNode>): string {
  const clone = root.clone();
  clone.find('br').replaceWith('\n');
  clone.find(BLOCK_ELEMENTS).each((_, el) => {
    $(el).append('\n');
  });
  return clone
    .text()
    .split('\n')
    .map(squash)
    .filter(Boolean)
    .join('\n');
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
    if (from > 0 && /\S/.test(text[from - 1] ?? '')) {
      const space = text.indexOf(' ', from);
      if (space !== -1 && space < i) from = space + 1;
    }
    if (to < text.length && /\S/.test(text[to] ?? '')) {
      const space = text.lastIndexOf(' ', to);
      if (space > i + m[0].length) to = space;
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
  const $ = cheerio.load(html);
  const now = ctx.now ?? new Date();
  const pageHost = (() => {
    try {
      return new URL(ctx.url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  })();

  // ── head-level facts (before any removal) ──────────────────────────────────────────────────
  const title = squash($('head > title').first().text() || $('title').first().text() || $('meta[property="og:title"]').attr('content') || '');
  const metaDescription = squash($('meta[name="description" i]').attr('content') ?? '');
  const canonicalHref = $('link[rel="canonical" i]').attr('href');
  let canonical: string | null = null;
  if (canonicalHref) {
    try {
      canonical = new URL(canonicalHref, ctx.url).toString();
    } catch {
      canonical = null;
    }
  }
  const robotsMeta = ($('meta[name="robots" i]').attr('content') ?? '').toLowerCase();
  const lang = ($('html').attr('lang') ?? '').trim() || null;
  const hasViewport = $('meta[name="viewport" i]').length > 0;
  const schemaTypes = jsonLdTypes($);

  const navLabels = uniqueLimited(
    $('nav a, header a, [role="navigation"] a')
      .map((_, el) => $(el).text())
      .get(),
    12,
    40,
  );

  // ── strip noise, then measure the visible page ──────────────────────────────────────────────
  $(NOISE_SELECTORS).not('html, body').remove();
  $('*').contents().filter((_, n) => n.type === 'comment').remove();

  // Contact signals live in footers/headers too, so measure them on the whole visible body.
  const bodyAll = $('body').length ? $('body') : $.root();
  const allText = blockText($, bodyAll as Cheerio<AnyNode>);
  const telLinks = new Set(
    $('a[href^="tel:" i]')
      .map((_, el) => ($(el).attr('href') ?? '').replace(/\D/g, ''))
      .get()
      .filter((d) => d.length >= 7),
  );
  for (const m of allText.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 13) telLinks.add(digits);
  }
  const emails = new Set(
    $('a[href^="mailto:" i]')
      .map((_, el) => ($(el).attr('href') ?? '').replace(/^mailto:/i, '').split('?')[0]?.trim().toLowerCase() ?? '')
      .get()
      .filter(Boolean),
  );
  for (const m of allText.matchAll(EMAIL_RE)) if (!IMAGE_EXT.test(m[0])) emails.add(m[0].toLowerCase());

  const hasContactForm =
    $('form')
      .filter((_, form) => {
        const f = $(form);
        if (f.is('[role="search"]') || f.find('input[type="search"]').length > 0) return false;
        const textareas = f.find('textarea').length;
        const textInputs = f.find('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])').length;
        return textareas > 0 || textInputs >= 3;
      })
      .length > 0;

  const ctaTexts = uniqueLimited(
    $('a, button, input[type="submit"], input[type="button"]')
      .map((_, el) => {
        const e = $(el);
        return e.is('input') ? (e.attr('value') ?? '') : e.text();
      })
      .get()
      .filter((t) => CTA_RE.test(t)),
    10,
    60,
  );

  const author =
    $('[rel="author"], [itemprop="author"], .author, .byline, .post-author').length > 0 || /(?<![\p{L}])автор\s*:/iu.test(allText);

  // ── main content ────────────────────────────────────────────────────────────────────────────
  let root: Cheerio<AnyNode> | null = null;
  const main = $('main, [role="main"]').first();
  if (main.length && main.text().trim().length >= 300) root = main as Cheerio<AnyNode>;
  if (!root) {
    let best: Cheerio<AnyNode> | null = null;
    let bestLen = 0;
    $('article').each((_, el) => {
      const len = $(el).text().trim().length;
      if (len > bestLen) {
        best = $(el) as Cheerio<AnyNode>;
        bestLen = len;
      }
    });
    if (best && bestLen >= 600) root = best;
  }
  if (!root) {
    const body = (bodyAll as Cheerio<AnyNode>).clone();
    body.find('nav, footer, aside, [role="navigation"], [role="contentinfo"], [role="complementary"], header nav').remove();
    root = body;
  }
  const mainText = blockText($, root);
  const full = mainText.slice(0, MAX_FULL_TEXT);
  const wordCount = wordCountOf(mainText);

  // ── headings (whole visible body minus navigation chrome, so the hero H1 is included) ───────
  const chromeFree = (bodyAll as Cheerio<AnyNode>).clone();
  chromeFree.find('nav, footer, aside, [role="navigation"], [role="contentinfo"], [role="complementary"]').remove();
  const headings: Heading[] = [];
  chromeFree.find('h1, h2, h3, h4').each((_, el) => {
    const text = squash($(el).text());
    if (!text || text.length > 200) return;
    const level = Number((el as { tagName?: string }).tagName?.[1] ?? 2);
    const prev = headings[headings.length - 1];
    if (prev && prev.level === level && prev.text === text) return;
    headings.push({ level, text });
  });
  const cappedHeadings = headings.slice(0, 60);
  const h1 = cappedHeadings.filter((h) => h.level === 1).map((h) => h.text);
  const outline = cappedHeadings.slice(0, 80).map((h) => `H${h.level}: ${h.text}`);

  // ── links and images ────────────────────────────────────────────────────────────────────────
  let internal = 0;
  let external = 0;
  $('a[href]').each((_, el) => {
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
  const imagesWithAlt = images.filter((_, el) => squash($(el).attr('alt') ?? '').length > 0).length;

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
