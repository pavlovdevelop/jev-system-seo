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
