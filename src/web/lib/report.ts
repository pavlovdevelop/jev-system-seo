import type { CompositeScores, Opportunity, PageAnalysis, Report } from '../../shared/schemas';

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export const DIMENSIONS: Array<{ key: keyof CompositeScores; label: string }> = [
  { key: 'content', label: 'Съдържание' },
  { key: 'optimization', label: 'Оптимизация' },
  { key: 'trust', label: 'Доверие' },
  { key: 'conversion', label: 'Конверсия' },
  { key: 'overall', label: 'Общо' },
];

/** Median of each composite dimension across the competitor pages (the user's own page excluded). */
export function peerMedians(pages: readonly PageAnalysis[]): Record<keyof CompositeScores, number | null> {
  const peers = pages.filter((p) => p.role !== 'own');
  const out = {} as Record<keyof CompositeScores, number | null>;
  for (const { key } of DIMENSIONS) out[key] = median(peers.map((p) => p.composite[key]).filter((v): v is number => v !== null));
  return out;
}

export const candidatesOf = (report: Report): Opportunity[] => report.opportunities.filter((o) => !o.deep);
export const seedOpportunity = (report: Report): Opportunity | undefined => report.opportunities.find((o) => o.deep);
