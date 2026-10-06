// The numbers behind every score, in one place. The server computes with them and the UI's "methodology"
// panel prints them, so what the screen says is always what the code does.

/** Strength of one search result (0..1) = weighted mean of these atoms. */
export const STRENGTH_WEIGHTS = { typeFit: 0.3, dedicated: 0.25, titleMatch: 0.2, depth: 0.15, dominance: 0.1 } as const;

/** SERP weakness at or above EASY_AT → "easy"; at or above MEDIUM_AT → "medium"; otherwise "hard". */
export const EASY_AT = 0.5;
export const MEDIUM_AT = 0.38;

/** Page composite scores. */
export const COMPOSITE_WEIGHTS = {
  content: { depth: 0.35, need: 0.25, specific: 0.15, length: 0.25 },
  trust: { portfolio: 0.3, reviews: 0.3, identity: 0.25, contact: 0.15 },
  conversion: { cta: 0.4, prices: 0.25, form: 0.2, contact: 0.15 },
  overall: { content: 0.4, optimization: 0.25, trust: 0.2, conversion: 0.15 },
} as const;

/** score = 100 × relevance × (weakness·w + commercial·w + specificity·w + demand·w) */
export const OPPORTUNITY_WEIGHTS = { weakness: 0.5, commercial: 0.2, specificity: 0.15, demand: 0.15 } as const;
export const LABEL_THRESHOLDS = { quickWin: 52, good: 42, hard: 28, unverifiedCap: 52 } as const;
export const MIN_RELEVANCE = 0.5;

// ───────────────────────── whole-site audit ─────────────────────────
// These weights are judgement calls, not coefficients fitted to data: nobody publishes how AI assistants choose
// their sources. They are printed in the report's methodology so the reader can disagree with them.

/** How much each criterion adds to a page's citability index (sums to 1). */
export const CITABILITY_WEIGHTS = { answer: 0.22, facts: 0.17, sources: 0.14, author: 0.12, faq: 0.1, fresh: 0.1, compare: 0.08, links: 0.07 } as const;
/** "After" projection: the first fix lifts its criterion to at least this much. */
export const CITABILITY_FIX_TARGET = 0.8;
/** A fresh page is at most this many months old; the score falls linearly to FRESH_FLOOR at STALE_MONTHS. */
export const FRESH_MONTHS = 6;
export const STALE_MONTHS = 24;
export const FRESH_FLOOR = 0.1;

/** How well a page answers a buyer question: below WEAK_BELOW there is no page for it, below ANSWERED_AT a weak one. */
export const ANSWER_MATCH = { weakBelow: 0.3, answeredAt: 0.62 } as const;

/** A competitor page is "worth stealing" from this overall score up, when it is also relevant. */
export const STEAL_AT = 0.58;
export const STEAL_MIN_RELEVANCE = 0.45;
/** The five scores of a competitor page, and how they add up. */
export const COMPETITOR_PAGE_WEIGHTS = { answer: 0.28, depth: 0.28, proof: 0.2, schema: 0.12, fresh: 0.12 } as const;

/** Title and meta description lengths (characters) that fit a search result without being cut. */
export const TITLE_LENGTH = { min: 25, max: 62 } as const;
export const META_LENGTH = { min: 70, max: 160 } as const;

/** Impact of an element fix: how much the page matters × how far from the top it is (see audit/elements.ts). */
export const PAGE_IMPORTANCE = {
  company_homepage: 1,
  service_page: 0.95,
  ecommerce_product: 0.85,
  comparison_listicle: 0.7,
  platform_or_tool: 0.7,
  blog_article: 0.6,
  directory_marketplace: 0.4,
  news_or_media: 0.4,
  forum_or_social: 0.3,
  other: 0.35,
} as const;
