import { CRITERIA, type Citability, type CriteriaScores, type Criterion } from '../../shared/audit';
import type { PageJudgments, PageMetrics } from '../../shared/schemas';
import { CITABILITY_FIX_TARGET, CITABILITY_WEIGHTS, COMPETITOR_PAGE_WEIGHTS, FRESH_FLOOR, FRESH_MONTHS, STALE_MONTHS } from '../../shared/weights';
import type { Answers } from '../jev/client';
import type { ExtractedPage } from '../jev/questions';
import type { citabilityQuestions } from './questions';

// What makes an AI assistant pick a page as a source, as eight criteria (0..1 each; null = could not be judged).
// Jev judges the ones that need reading (does the opening answer the question? are there concrete facts?); the rest
// are measured from the page. The index is a weighted mean (weights in shared/weights.ts) — a heuristic, printed in
// the report, not a measured probability.

type CitabilityAnswers = Partial<Answers<typeof citabilityQuestions>>;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const MONTH_MS = 30.44 * 24 * 3_600_000;

/** Months since the page was last changed or published; falls back to the newest year mentioned in the text. */
export function ageMonthsOf(m: PageMetrics, now: Date): number | null {
  const stamp = m.modifiedAt ?? m.publishedAt;
  if (stamp) {
    const t = Date.parse(stamp);
    if (Number.isFinite(t)) return Math.max(0, Math.round(((now.getTime() - t) / MONTH_MS) * 10) / 10);
  }
  if (m.latestYear !== null && m.latestYear >= 2000) return Math.max(0, (now.getFullYear() - m.latestYear) * 12 + 3);
  return null;
}

export function freshnessScore(ageMonths: number | null): number | null {
  if (ageMonths === null) return null;
  if (ageMonths <= FRESH_MONTHS) return 1;
  if (ageMonths >= STALE_MONTHS) return FRESH_FLOOR;
  return r3(1 - ((1 - FRESH_FLOOR) * (ageMonths - FRESH_MONTHS)) / (STALE_MONTHS - FRESH_MONTHS));
}

/** How much structured data the page carries, 0..1. */
export function schemaRichness(types: readonly string[]): number {
  const distinct = new Set(types.map((t) => t.toLowerCase())).size;
  return distinct === 0 ? 0 : distinct === 1 ? 0.45 : distinct === 2 ? 0.75 : 1;
}

export interface CriteriaInput {
  extracted: ExtractedPage;
  now: Date;
  judgments: PageJudgments;
  citability: CitabilityAnswers | null;
}

export function criteriaScores(input: CriteriaInput): CriteriaScores {
  const { extracted, judgments, citability } = input;
  const m = extracted.metrics;
  const hints = extracted.hints;

  const identityHints = [m.hasAuthor, hints.companyRegistration, hints.address, hints.aboutLink].filter(Boolean).length / 4;
  const identity = judgments.showsIdentity?.p;
  const sourcesMeasured = clamp01(m.externalDomains / 4);

  const faq = m.hasFaqSchema ? (m.faqQuestions >= 3 || m.faqQuestions === 0 ? 1 : 0.8) : m.hasFaqSection ? 0.55 : m.headings.filter((h) => h.level >= 2 && /\?\s*$/.test(h.text)).length >= 2 ? 0.4 : 0;
  const compare = m.tables >= 1 ? 1 : m.lists >= 3 ? 0.7 : m.lists >= 1 ? 0.4 : 0.1;

  return {
    answer: citability?.answer_first ? r3(citability.answer_first.value) : null,
    faq: r3(faq),
    author: r3(identity === undefined ? clamp01(0.15 + 0.7 * identityHints) : 0.5 * identityHints + 0.5 * identity),
    fresh: freshnessScore(ageMonthsOf(m, input.now)),
    sources: r3(citability?.cites_sources ? 0.5 * sourcesMeasured + 0.5 * citability.cites_sources.p : sourcesMeasured),
    facts: citability?.specific_facts ? r3(citability.specific_facts.value) : null,
    compare: r3(compare),
    links: r3(clamp01(m.links.internal / Math.max(6, m.wordCount / 150))),
  };
}

/** The weighted mean of the criteria that could be judged; null when Jev's two reading criteria are both missing. */
export function citabilityIndex(scores: CriteriaScores): number | null {
  if (scores.answer === null && scores.facts === null) return null;
  let sum = 0;
  let weight = 0;
  for (const c of CRITERIA) {
    const v = scores[c];
    if (v === null) continue;
    sum += CITABILITY_WEIGHTS[c] * v;
    weight += CITABILITY_WEIGHTS[c];
  }
  return weight > 0 ? r3(sum / weight) : null;
}

export const score10 = (index: number): number => Math.round(index * 100) / 10;

const FIX_ACTION: Record<Criterion, string> = {
  answer: 'Започни с директен отговор в първите 40 думи',
  facts: 'Добави конкретни факти: цени, срокове, числа, спецификации',
  sources: 'Цитирай 3–4 авторитетни източника с връзки',
  author: 'Покажи автор с квалификация и данни за фирмата',
  faq: 'Добави въпроси и отговори с FAQPage schema',
  fresh: 'Обнови съдържанието и покажи дата на актуализация',
  compare: 'Добави таблица за сравнение или структуриран списък',
  links: 'Добави вътрешни връзки към свързани страници',
};
export const fixActionOf = (criterion: Criterion): string => FIX_ACTION[criterion];

/** The citability of one page: now, after the first fix, and what that fix is. */
export function citabilityOf(scores: CriteriaScores): Citability | null {
  const now = citabilityIndex(scores);
  if (now === null) return null;
  let best: Criterion | null = null;
  let bestGap = 0.04; // a gap this small is not worth a fix
  for (const c of CRITERIA) {
    const v = scores[c];
    if (v === null) continue;
    const gap = CITABILITY_WEIGHTS[c] * (1 - v);
    if (gap > bestGap) {
      bestGap = gap;
      best = c;
    }
  }
  if (!best) return { now, after: now, fixFirst: null };
  const lifted: CriteriaScores = { ...scores, [best]: Math.max(scores[best] ?? 0, CITABILITY_FIX_TARGET) };
  return { now, after: Math.max(now, citabilityIndex(lifted) ?? now), fixFirst: { criterion: best, action: FIX_ACTION[best] } };
}

// ───────────────────────── competitor pages ─────────────────────────

export interface CompetitorScores {
  answer: number | null;
  depth: number | null;
  proof: number | null;
  schema: number | null;
  fresh: number | null;
}

export function competitorScores(judgments: PageJudgments, criteria: CriteriaScores, metrics: PageMetrics): CompetitorScores {
  const proofParts = [judgments.showsPortfolio?.p, judgments.showsReviews?.p, judgments.showsIdentity?.p].filter((v): v is number => v !== undefined);
  return {
    answer: criteria.answer,
    depth: judgments.topicDepth ? r3(judgments.topicDepth.value) : null,
    proof: proofParts.length > 0 ? r3(proofParts.reduce((a, b) => a + b, 0) / proofParts.length) : null,
    schema: r3(schemaRichness(metrics.schemaTypes)),
    fresh: criteria.fresh,
  };
}

export function competitorOverall(scores: CompetitorScores): number | null {
  let sum = 0;
  let weight = 0;
  for (const key of Object.keys(COMPETITOR_PAGE_WEIGHTS) as Array<keyof typeof COMPETITOR_PAGE_WEIGHTS>) {
    const v = scores[key];
    if (v === null) continue;
    sum += COMPETITOR_PAGE_WEIGHTS[key] * v;
    weight += COMPETITOR_PAGE_WEIGHTS[key];
  }
  return weight >= 0.5 ? r3(sum / weight) : null;
}
