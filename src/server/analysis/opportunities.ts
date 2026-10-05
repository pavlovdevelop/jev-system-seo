import { INTENT_LABELS, PAGE_TYPE_LABELS, type KeywordSource, type OpportunityLabel, type PageType } from '../../shared/domain';
import type { Opportunity, SerpAssessment } from '../../shared/schemas';
import { LABEL_THRESHOLDS, MIN_RELEVANCE, OPPORTUNITY_WEIGHTS } from '../../shared/weights';
import { keywordKey, keywordTerms } from '../nlp/bg';
import type { KeywordVolume } from '../providers/serp/types';
import type { KeywordJudgment } from './judge';
import { hasLocalModifier } from './lexicon';

// Opportunity = "a keyword where a small site with good content could rank soon, and that is worth ranking for".
//
//   score = 100 × relevance × ( 0.50·weakness + 0.20·commercial + 0.15·specificity + 0.15·demand )
//
// relevance, commercial and the page-level atoms behind `weakness` come from Jev; specificity and demand are
// measured. Missing data falls back to a neutral value instead of zero, and a keyword whose SERP was never
// fetched is capped so it can never outrank one we actually verified. Weights live here, not in a prompt.

export const NEUTRAL = { weakness: 0.35, demand: 0.4 } as const;
export { LABEL_THRESHOLDS, MIN_RELEVANCE, OPPORTUNITY_WEIGHTS };

export interface OpportunityInput {
  keyword: string;
  sources: readonly KeywordSource[];
  /** null only if Jev was unavailable; the seed keyword is passed with relevance 1. */
  judgment: KeywordJudgment | null;
  assessment: SerpAssessment | null;
  volume: KeywordVolume | null;
  ownPosition: number | null;
  deep: boolean;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export function specificityOf(keyword: string): number {
  const n = keywordTerms(keyword).length;
  const base = n <= 1 ? 0.2 : n === 2 ? 0.45 : n === 3 ? 0.7 : n === 4 ? 0.9 : 1;
  return r3(clamp01(base + (hasLocalModifier(keyword) ? 0.1 : 0)));
}

/** 3,000+ searches a month saturates the scale; unknown volume stays unknown (null). */
export function demandOf(volume: number | null): number | null {
  return volume === null ? null : r3(clamp01(Math.log10(volume + 1) / 3.5));
}

const STRONG_TYPES: readonly PageType[] = ['service_page', 'company_homepage', 'platform_or_tool'];
const NOUN: Partial<Record<PageType, string>> = {
  forum_or_social: 'форуми',
  directory_marketplace: 'директории',
  blog_article: 'блог статии',
  news_or_media: 'медийни статии',
  comparison_listicle: 'класации',
  ecommerce_product: 'онлайн магазини',
  other: 'други страници',
};

const joinBg = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`);

function formatVolume(v: number): string {
  return v.toLocaleString('bg-BG').replace(/\p{Zs}/gu, ' ');
}

export function reasonsFor(input: OpportunityInput, scores: { weakness: number | null; commercial: number; specificity: number; demand: number | null }): string[] {
  const reasons: string[] = [];
  const a = input.assessment;
  if (a) {
    const weakTypes = Object.entries(a.pageTypeShare)
      .filter(([t, share]) => !STRONG_TYPES.includes(t as PageType) && share >= 0.15)
      .sort((x, y) => y[1] - x[1])
      .map(([t]) => NOUN[t as PageType] ?? PAGE_TYPE_LABELS[t as PageType].toLowerCase());
    if (a.components.pageTypeMismatch >= 0.45 && weakTypes.length > 0) {
      reasons.push(`Много от резултатите са ${joinBg(weakTypes.slice(0, 3))}, а не специализирани страници`);
    }
    if (a.components.notDedicated >= 0.4) reasons.push('Повечето резултати не са посветени на самата фраза');
    if (a.components.titleGap >= 0.35) {
      const full = a.results.filter((r) => r.titleMatch >= 0.999).length;
      reasons.push(`Само ${full} от ${a.results.length} заглавия съдържат цялата фраза`);
    }
    if (a.components.thinContent !== null && a.components.thinContent >= 0.5) reasons.push('Съдържанието на водещите страници е плитко');
    if (a.components.topicalDominance >= 0.5) reasons.push('Няколко силни домейна доминират по тази тема');
    if (a.weakness < 0.4) reasons.push('Водещите резултати са специализирани и добре оптимизирани');
  } else {
    reasons.push('Няма данни за конкуренцията — SERP не е извлечен за тази фраза');
  }
  if (input.judgment) {
    if (scores.commercial >= 0.65) reasons.push('Високо търговско намерение: търсещият е близо до поръчка');
    else if (scores.commercial <= 0.3) reasons.push('Ниско търговско намерение: привлича читатели, не клиенти');
  }
  if (input.volume?.volume != null) reasons.push(`≈ ${formatVolume(input.volume.volume)} търсения месечно`);
  if (scores.specificity >= 0.9) reasons.push('Дълга, конкретна фраза — по-малко конкуренция');
  if (input.ownPosition !== null) {
    reasons.push(input.ownPosition <= 3 ? `Вече си на позиция ${input.ownPosition}` : `Вече си на позиция ${input.ownPosition} — има потенциал за подобрение`);
  }
  return reasons.slice(0, 6);
}

function formatFor(input: OpportunityInput): PageType | null {
  const dominant = input.assessment?.dominantPageType;
  if (dominant) return dominant;
  switch (input.judgment?.intent.value) {
    case 'informational':
      return 'blog_article';
    case 'transactional':
    case 'commercial_investigation':
    case 'local':
      return 'service_page';
    default:
      return null;
  }
}

export function scoreOpportunity(input: OpportunityInput): Opportunity {
  const relevance = input.judgment?.relevance ?? 1;
  const commercial = input.judgment?.commercial ?? 0.5;
  const specificity = specificityOf(input.keyword);
  const demand = demandOf(input.volume?.volume ?? null);
  const weakness = input.assessment?.weakness ?? null;
  const w = OPPORTUNITY_WEIGHTS;

  const base = w.weakness * (weakness ?? NEUTRAL.weakness) + w.commercial * commercial + w.specificity * specificity + w.demand * (demand ?? NEUTRAL.demand);
  let score = 100 * relevance * base;
  if (!input.assessment) score = Math.min(score, LABEL_THRESHOLDS.unverifiedCap);
  score = Math.round(score * 10) / 10;

  let label: OpportunityLabel;
  if (relevance < MIN_RELEVANCE) label = 'skip';
  else if (input.assessment?.difficulty === 'easy' && score >= LABEL_THRESHOLDS.quickWin) label = 'quick_win';
  else if (score >= LABEL_THRESHOLDS.good) label = 'good';
  else if (score >= LABEL_THRESHOLDS.hard) label = 'hard';
  else label = 'skip';

  return {
    keyword: input.keyword,
    normalized: keywordKey(input.keyword),
    sources: [...input.sources],
    volume: input.volume?.volume ?? null,
    cpc: input.volume?.cpc ?? null,
    competitionIndex: input.volume?.competitionIndex ?? null,
    relevance: r3(relevance),
    commercial: r3(commercial),
    intent: input.judgment?.intent ?? null,
    assessment: input.assessment,
    specificity,
    demand,
    score,
    label,
    reasons: reasonsFor(input, { weakness, commercial, specificity, demand }),
    recommendedFormat: formatFor(input),
    ownPosition: input.ownPosition,
    deep: input.deep,
  };
}

/** Best opportunities first; quick wins ahead of everything else at equal score. */
export function rankOpportunities(list: readonly Opportunity[]): Opportunity[] {
  const order: Record<OpportunityLabel, number> = { quick_win: 0, good: 1, hard: 2, skip: 3 };
  return [...list].sort((a, b) => order[a.label] - order[b.label] || b.score - a.score || a.keyword.localeCompare(b.keyword));
}

export { INTENT_LABELS };
