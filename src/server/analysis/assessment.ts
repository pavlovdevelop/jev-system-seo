import type { Intent, PageType } from '../../shared/domain';
import type { PageTypeAnswer, SerpAssessment, SerpResultStrength } from '../../shared/schemas';

// How beatable is a results page for a newcomer who writes good content?
//
// Each result gets a 0..1 "strength" from five atoms (page type fit, dedication to the query, keyword in
// the title, depth of the content when it was actually read, topical dominance of the domain), and the
// SERP's weakness is the position-weighted mean of (1 − strength). The atoms are exposed in the report so
// the number can be challenged. There is no backlink/authority data here: a result can be "weak" on content
// and still be hard to outrank because of its domain's links — the README says so.

export interface ResultSignal {
  position: number;
  domain: string;
  url: string;
  title: string;
  pageType: PageTypeAnswer | null;
  /** P(page is dedicated to the query) from Jev, null when unknown. */
  targetsQuery: number | null;
  /** Share of the keyword's terms found in the title (measured). */
  titleMatch: number;
  /** 0..1 topic depth from Jev, only for pages that were crawled. */
  depth: number | null;
}

const FIT_COMMERCIAL: Record<PageType, number> = {
  service_page: 1,
  company_homepage: 0.85,
  platform_or_tool: 0.8,
  comparison_listicle: 0.7,
  ecommerce_product: 0.7,
  blog_article: 0.5,
  directory_marketplace: 0.45,
  news_or_media: 0.35,
  other: 0.3,
  forum_or_social: 0.25,
};

const FIT_INFORMATIONAL: Record<PageType, number> = {
  blog_article: 1,
  news_or_media: 0.8,
  comparison_listicle: 0.7,
  forum_or_social: 0.6,
  service_page: 0.45,
  platform_or_tool: 0.4,
  company_homepage: 0.35,
  directory_marketplace: 0.35,
  ecommerce_product: 0.3,
  other: 0.3,
};

export const STRENGTH_WEIGHTS = { typeFit: 0.3, dedicated: 0.25, titleMatch: 0.2, depth: 0.15, dominance: 0.1 } as const;
export const POSITION_WEIGHTS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2] as const;
/** Weakness at or above this → "easy" SERP; at or above MEDIUM_AT → "medium"; else "hard". */
export const EASY_AT = 0.55;
export const MEDIUM_AT = 0.4;

const positionWeight = (position: number): number => POSITION_WEIGHTS[position - 1] ?? 0.1;

export function typeFit(pageType: PageType, intent: Intent | null): number {
  return (intent === 'informational' ? FIT_INFORMATIONAL : FIT_COMMERCIAL)[pageType];
}

export function resultStrength(r: ResultSignal, intent: Intent | null, dominance: number): { strength: number; typeFit: number; dedicated: number } {
  const fit = r.pageType ? typeFit(r.pageType.value, intent) : 0.5;
  const dedicated = r.targetsQuery ?? 0.5;
  const parts: Array<[number, number]> = [
    [fit, STRENGTH_WEIGHTS.typeFit],
    [dedicated, STRENGTH_WEIGHTS.dedicated],
    [r.titleMatch, STRENGTH_WEIGHTS.titleMatch],
    [dominance, STRENGTH_WEIGHTS.dominance],
  ];
  if (r.depth !== null) parts.push([r.depth, STRENGTH_WEIGHTS.depth]);
  const total = parts.reduce((s, [, w]) => s + w, 0);
  const strength = parts.reduce((s, [v, w]) => s + v * w, 0) / total;
  return { strength, typeFit: fit, dedicated };
}

export function dominantOf<K extends string>(weights: ReadonlyMap<K, number>): K | null {
  let best: K | null = null;
  let bestWeight = 0;
  for (const [k, w] of weights) {
    if (w > bestWeight) {
      best = k;
      bestWeight = w;
    }
  }
  return best;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function assessSerp(
  results: readonly ResultSignal[],
  context: { intent: Intent | null; dominance?: ReadonlyMap<string, number> },
): SerpAssessment | null {
  if (results.length === 0) return null;

  let wSum = 0;
  let weak = 0;
  let mismatch = 0;
  let notDedicated = 0;
  let titleGap = 0;
  let dominanceSum = 0;
  let thin = 0;
  let thinW = 0;
  const typeWeights = new Map<PageType, number>();
  const strengths: SerpResultStrength[] = [];

  for (const r of results) {
    const w = positionWeight(r.position);
    const dom = context.dominance?.get(r.domain) ?? 0;
    const s = resultStrength(r, context.intent, dom);
    wSum += w;
    weak += w * (1 - s.strength);
    mismatch += w * (1 - s.typeFit);
    notDedicated += w * (1 - s.dedicated);
    titleGap += w * (1 - r.titleMatch);
    dominanceSum += w * dom;
    if (r.depth !== null) {
      thin += w * (1 - r.depth);
      thinW += w;
    }
    if (r.pageType) typeWeights.set(r.pageType.value, (typeWeights.get(r.pageType.value) ?? 0) + w);
    strengths.push({
      position: r.position,
      domain: r.domain,
      url: r.url,
      title: r.title,
      pageType: r.pageType,
      targetsQuery: r.targetsQuery === null ? null : round3(r.targetsQuery),
      titleMatch: round3(r.titleMatch),
      strength: round3(s.strength),
    });
  }

  const weakness = weak / wSum;
  const totalType = [...typeWeights.values()].reduce((a, b) => a + b, 0);
  return {
    weakness: round3(weakness),
    difficulty: weakness >= EASY_AT ? 'easy' : weakness >= MEDIUM_AT ? 'medium' : 'hard',
    dominantPageType: dominantOf(typeWeights),
    pageTypeShare: Object.fromEntries([...typeWeights].map(([t, w]) => [t, round3(w / totalType)])),
    components: {
      pageTypeMismatch: round3(mismatch / wSum),
      notDedicated: round3(notDedicated / wSum),
      titleGap: round3(titleGap / wSum),
      topicalDominance: round3(dominanceSum / wSum),
      thinContent: thinW > 0 ? round3(thin / thinW) : null,
    },
    results: strengths,
  };
}
