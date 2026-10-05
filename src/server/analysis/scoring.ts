import type { CompositeScores, PageJudgments, PageMetrics } from '../../shared/schemas';

// Composite scoring (docs.typesafe.ai/patterns/composite-scoring): break a judgment into atomic
// signals, normalise each to 0..1, and combine them with weights that live HERE, in code, where they can
// be read, tuned and tested. Jev supplies the semantic atoms; measured facts supply the rest.

type Part = { value: number | null | undefined; weight: number };

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Weighted mean over the parts that are present; null when nothing is known. */
export function weighted(parts: readonly Part[]): number | null {
  let sum = 0;
  let total = 0;
  for (const p of parts) {
    if (p.value === null || p.value === undefined || !Number.isFinite(p.value)) continue;
    sum += clamp01(p.value) * p.weight;
    total += p.weight;
  }
  return total > 0 ? Math.round((sum / total) * 1000) / 1000 : null;
}

/** Words the average top result has — what "long enough" means for this keyword. */
export const DEFAULT_TARGET_WORDS = 1200;

export const WEIGHTS = {
  content: { depth: 0.35, need: 0.25, specific: 0.15, length: 0.25 },
  trust: { portfolio: 0.3, reviews: 0.3, identity: 0.25, contact: 0.15 },
  conversion: { cta: 0.4, prices: 0.25, form: 0.2, contact: 0.15 },
  overall: { content: 0.4, optimization: 0.25, trust: 0.2, conversion: 0.15 },
} as const;

/** On-page optimisation checklist, scored 0..1 from measured facts only (no Jev involved). */
export function optimizationScore(m: PageMetrics): number {
  const titleLen = m.titleLength;
  const titleLenScore = titleLen >= 25 && titleLen <= 65 ? 1 : (titleLen >= 15 && titleLen < 25) || (titleLen > 65 && titleLen <= 80) ? 0.5 : 0;
  const metaLen = m.metaDescriptionLength;
  const metaScore = m.metaDescription ? (metaLen >= 70 && metaLen <= 170 ? 1 : 0.5) : 0;
  const altScore = m.images.total === 0 ? 0.5 : m.images.withAlt / m.images.total;
  const canonicalScore = m.canonicalIsSelf === true ? 1 : m.canonical === null ? 0.3 : 0;

  return (
    weighted([
      { value: m.keyword.titleCoverage, weight: 0.18 },
      { value: m.keyword.inH1 ? 1 : 0, weight: 0.14 },
      { value: titleLenScore, weight: 0.06 },
      { value: metaScore, weight: 0.08 },
      { value: m.h1.length === 1 ? 1 : 0, weight: 0.06 },
      { value: Math.min(1, m.h2Count / 4), weight: 0.1 },
      { value: m.keyword.inUrl ? 1 : 0, weight: 0.04 },
      { value: m.keyword.inMeta ? 1 : 0, weight: 0.04 },
      { value: m.schemaTypes.length > 0 ? 1 : 0, weight: 0.08 },
      { value: altScore, weight: 0.05 },
      { value: canonicalScore, weight: 0.04 },
      { value: m.hasViewport ? 1 : 0, weight: 0.04 },
      { value: m.https ? 1 : 0, weight: 0.04 },
      { value: m.noindex ? 0 : 1, weight: 0.05 },
    ]) ?? 0
  );
}

export function compositeScores(
  page: { metrics: PageMetrics | null; judgments: PageJudgments },
  options: { targetWords?: number } = {},
): CompositeScores {
  const { metrics: m, judgments: j } = page;
  const target = Math.max(300, options.targetWords ?? DEFAULT_TARGET_WORDS);
  const contact = m ? (m.phones > 0 || m.emails > 0 ? 1 : 0) : null;
  const w = WEIGHTS;

  const content = weighted([
    { value: j.topicDepth?.value, weight: w.content.depth },
    { value: j.needSatisfied?.value, weight: w.content.need },
    { value: j.genericContent ? 1 - j.genericContent.p : null, weight: w.content.specific },
    { value: m ? Math.min(1, m.wordCount / target) : null, weight: w.content.length },
  ]);
  const optimization = m ? Math.round(optimizationScore(m) * 1000) / 1000 : null;
  const trust = weighted([
    { value: j.showsPortfolio?.p, weight: w.trust.portfolio },
    { value: j.showsReviews?.p, weight: w.trust.reviews },
    { value: j.showsIdentity?.p, weight: w.trust.identity },
    { value: contact, weight: w.trust.contact },
  ]);
  const conversion = weighted([
    { value: j.clearCta?.p, weight: w.conversion.cta },
    { value: j.statesPrices?.p, weight: w.conversion.prices },
    { value: m ? (m.hasContactForm ? 1 : 0) : null, weight: w.conversion.form },
    { value: contact, weight: w.conversion.contact },
  ]);
  const overall = weighted([
    { value: content, weight: w.overall.content },
    { value: optimization, weight: w.overall.optimization },
    { value: trust, weight: w.overall.trust },
    { value: conversion, weight: w.overall.conversion },
  ]);
  return { content, optimization, trust, conversion, overall };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
  return s[idx] as number;
}
