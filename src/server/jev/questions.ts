import { choice, noul, score, type EntryType } from '@typesafe-ai/sdk';
import type { Intent, PageType } from '../../shared/domain';
import { MARKETS, type MarketId } from '../../shared/markets';
import type { PageMetrics } from '../../shared/schemas';
import { stripInvisible } from '../../shared/text';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Jev question catalogue.
//
// Design rules (from docs.typesafe.ai/model-jaggedness/jev-1.13):
//  • Instructions and criteria are written in English — Jev's accuracy is best there. Only the page
//    *content* inside `state` is Bulgarian.
//  • One literal judgment per question, no negations, an explicit "other" option on every Choice.
//  • Numbers stay in code. Jev gets named buckets, never raw counts to compare.
//  • Each request carries a small, focused state slice ("context rot" hurts accuracy), and all the
//    questions that need the same slice are fanned out together in one call.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PAGE_TYPE_CRITERIA = {
  service_page:
    'A page of a company or freelancer that sells or offers a service (for example web design, repairs or consulting) and aims to win inquiries or orders.',
  company_homepage: 'The main homepage of a company or agency that presents the business and several of its services.',
  blog_article: 'An informational article, guide, tutorial or how-to that teaches the reader something.',
  comparison_listicle:
    'A ranking, list or comparison of several providers, products or options, such as "top 10" or "best X".',
  directory_marketplace:
    'A directory, business listing, classifieds site, freelance marketplace or other aggregator that lists many providers.',
  platform_or_tool:
    'A software platform, website builder, CMS or online tool that the visitor uses to do the task themselves.',
  forum_or_social: 'A forum thread, community question-and-answer page, or a social media page or post.',
  news_or_media: 'A news item or a magazine or media article.',
  ecommerce_product: 'A product page or a product category page of an online shop.',
  other: 'Any other kind of page, or the type is unclear.',
} satisfies Record<PageType, string>;

const INTENT_CRITERIA = {
  informational: 'The searcher wants to learn or understand something and is not yet looking to buy.',
  commercial_investigation: 'The searcher is researching or comparing providers or options before deciding.',
  transactional: 'The searcher is ready to hire, buy, order or request a quote now.',
  navigational: 'The searcher wants to reach one specific brand, company or website.',
  local: 'The searcher wants a provider or a place near them, in a specific city or area.',
  other: 'None of these fits, or it is unclear.',
} satisfies Record<Intent, string>;

// ───────────────────────── slice A: what is this page? (title, meta, H1, intro) ─────────────────────────

export const identityQuestions = {
  page_type: choice('What type of page is this? Judge by what the page itself is and does.', PAGE_TYPE_CRITERIA),
  intent_served: choice('Which searcher need does this page serve best?', INTENT_CRITERIA),
  targets_query: noul(
    'The page is written specifically for the search query in `search_query`, and that query is its main topic.',
  ),
  local_to_market: noul(
    'The page is clearly aimed at customers in the market described in `market`: its language, places, prices or contact details point to that market.',
  ),
};

// ───────────────────────── slice B: how good is the content? (outline + text samples) ─────────────────────────

export const contentQuestions = {
  topic_depth: score('How thoroughly does the page cover the topic of `search_query`?', [
    'Almost nothing: a stub, or the page is about something else.',
    'Superficial: a few generic sentences without specifics.',
    'Adequate: covers the main points with some specifics.',
    'Thorough: covers most subtopics a visitor would ask about, with concrete details such as process, options, timelines or examples.',
    'Exhaustive: covers the topic in depth with concrete details, examples, comparisons and answers to common questions.',
  ]),
  need_satisfied: score('How well does the page satisfy what a person searching `search_query` is looking for?', [
    'Not at all.',
    'Partly: the visitor would still need to look elsewhere for the main answer.',
    'Mostly: the visitor gets most of what they need.',
    'Fully: the visitor gets everything they need on this page.',
  ]),
  generic_content: noul(
    'The text is generic marketing filler that could describe almost any company: it has no concrete facts, numbers, examples or process details.',
  ),
};

// ───────────────────────── slice C: trust and conversion (pre-extracted evidence) ─────────────────────────

export const trustQuestions = {
  states_prices: noul('The page states concrete prices, price ranges or a price list for the service.'),
  shows_portfolio: noul('The page shows examples of completed work, a portfolio, or case studies.'),
  shows_reviews: noul('The page shows reviews, testimonials, ratings or client logos from real customers.'),
  clear_cta: noul(
    'The page contains a clear call to action that asks the visitor to contact the company, request a quote, order or buy.',
  ),
  shows_identity: noul(
    'The page identifies the people or company behind it, for example a team, a founder, company registration details or a physical address.',
  ),
};

// ───────────────────────── keyword-level questions (candidate screening) ─────────────────────────

export const keywordQuestions = {
  relevant_to_business: noul(
    'The search query in `search_query` describes a need that the business described in `business` can fulfil.',
  ),
  query_intent: choice('What does the person who types `search_query` want?', INTENT_CRITERIA),
  commercial_value: score('How likely is a person who types `search_query` to be ready to pay for a service?', [
    'Almost certainly only curious or looking for free information.',
    'Possibly interested in paying later.',
    'Likely comparing providers or prices.',
    'Ready to hire or order now.',
  ]),
};

// ───────────────────────── shallow SERP-result questions (title + snippet only) ─────────────────────────

export const shallowQuestions = {
  page_type: choice('What type of page does this search result lead to?', PAGE_TYPE_CRITERIA),
  targets_query: noul(
    'The result is dedicated to the search query in `search_query`, and that query is the main topic of the page.',
  ),
};

// ───────────────────────── state builders ─────────────────────────

/** Text prepared for Jev: invisible/control characters removed, whitespace collapsed, clipped on a word boundary. */
export function clip(text: string | null | undefined, max: number): string {
  if (!text) return '';
  // zero-width, bidi, separators, BOM, tag characters: invisible to a reader, visible to a model
  const cleaned = stripInvisible(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function lengthBucket(wordCount: number): string {
  if (wordCount < 150) return 'very short';
  if (wordCount < 400) return 'short';
  if (wordCount < 900) return 'medium';
  if (wordCount < 1800) return 'long';
  return 'very long';
}

/** Server-side extraction output that is richer than what we persist in reports. */
export interface ExtractedPage {
  metrics: PageMetrics;
  /** "H1: …", "H2: …" lines in document order. */
  outline: string[];
  text: { intro: string; middle: string; full: string };
  hints: {
    aboutLink: boolean;
    companyRegistration: boolean;
    address: boolean;
    author: boolean;
    workHeadings: string[];
  };
}

export interface PageContext {
  keyword: string;
  market: MarketId;
  url: string;
  domain: string;
  serpTitle: string;
  serpSnippet: string;
  page: ExtractedPage | null;
}

export function identityState(ctx: PageContext): EntryType {
  const m = ctx.page?.metrics;
  return {
    search_query: ctx.keyword,
    market: MARKETS[ctx.market].description,
    page: {
      url: ctx.url,
      domain: ctx.domain,
      title: clip(m?.title || ctx.serpTitle, 200),
      meta_description: clip(m?.metaDescription || ctx.serpSnippet, 300),
      h1: clip(m?.h1[0], 200),
      intro: clip(ctx.page?.text.intro, 600),
    },
  };
}

export function contentState(ctx: PageContext): EntryType | null {
  const page = ctx.page;
  if (!page) return null;
  return {
    search_query: ctx.keyword,
    page_outline: page.outline.slice(0, 40).map((line) => clip(line, 120)),
    content_start: clip(page.text.intro, 1200),
    content_middle: clip(page.text.middle, 800),
    length: lengthBucket(page.metrics.wordCount),
  };
}

export function trustState(ctx: PageContext): EntryType | null {
  const page = ctx.page;
  if (!page) return null;
  const m = page.metrics;
  return {
    search_query: ctx.keyword,
    page: { title: clip(m.title, 160), h1: clip(m.h1[0], 160) },
    call_to_action_texts: m.ctaTexts.slice(0, 10).map((t) => clip(t, 60)),
    price_mentions: m.priceMentions.slice(0, 8).map((t) => clip(t, 100)),
    contact: {
      phone_numbers_found: m.phones > 0,
      email_addresses_found: m.emails > 0,
      contact_form_present: m.hasContactForm,
    },
    social_proof_snippets: m.socialProof.slice(0, 8).map((t) => clip(t, 140)),
    headings_about_work_or_clients: page.hints.workHeadings.slice(0, 8).map((t) => clip(t, 100)),
    navigation_labels: m.navLabels.slice(0, 12).map((t) => clip(t, 40)),
    identity_hints: {
      about_or_team_link: page.hints.aboutLink,
      company_registration_number_mentioned: page.hints.companyRegistration,
      postal_address_mentioned: page.hints.address,
      author_named: page.hints.author,
    },
  };
}

export function keywordState(keyword: string, business: string, market: MarketId): EntryType {
  return {
    search_query: keyword,
    business: clip(business, 600) || 'A small business that sells services to local customers.',
    market: MARKETS[market].description,
  };
}

export function shallowState(
  keyword: string,
  result: { domain: string; url: string; title: string; snippet: string },
): EntryType {
  return {
    search_query: keyword,
    result: {
      domain: result.domain,
      url: clip(result.url, 200),
      title: clip(result.title, 200),
      snippet: clip(result.snippet, 300),
    },
  };
}
