import { PAGE_TYPE_LABELS, WEAK_COMMERCIAL_PAGE_TYPES } from '../../shared/domain';
import type { CompetitorProfile, PageAnalysis, SerpResultStrength } from '../../shared/schemas';

// "Who are my real competitors?" — not the ones I can name, but the domains that actually show up in the
// results for the keywords I care about. Visibility uses a click-through curve, so rank 1 counts far more
// than rank 9, and a domain that appears in many SERPs outweighs one that appears once.

export const CTR_CURVE = [0.3, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.015] as const;
const ctr = (position: number): number => CTR_CURVE[position - 1] ?? 0.005;

export interface SerpObservation {
  keyword: string;
  deep: boolean;
  results: readonly SerpResultStrength[];
}

export interface ProfileInput {
  observations: readonly SerpObservation[];
  /** Pages that were crawled and judged for the seed keyword (one per domain is used). */
  seedPages: readonly PageAnalysis[];
  ownDomain: string | null;
  tracked: readonly string[];
  maxDiscovered?: number;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function vulnerabilityReason(r: SerpResultStrength): string {
  if (r.targetsQuery !== null && r.targetsQuery < 0.4) return 'страницата не е посветена на фразата';
  if (r.pageType && WEAK_COMMERCIAL_PAGE_TYPES.includes(r.pageType.value) && r.pageType.value !== 'blog_article') return `${PAGE_TYPE_LABELS[r.pageType.value].toLowerCase()} вместо специализирана страница`;
  if (r.titleMatch < 0.6) return 'заглавието не съдържа цялата фраза';
  return `слаб резултат (сила ${Math.round(r.strength * 100)}%)`;
}

export function buildCompetitorProfiles(input: ProfileInput): CompetitorProfile[] {
  type Acc = { score: number; keywords: Set<string>; positions: number[]; top3: number; top10: number; best: number | null; vulnerable: CompetitorProfile['vulnerableKeywords'] };
  const byDomain = new Map<string, Acc>();
  let totalScore = 0;

  for (const obs of input.observations) {
    for (const r of obs.results) {
      const acc = byDomain.get(r.domain) ?? { score: 0, keywords: new Set(), positions: [], top3: 0, top10: 0, best: null, vulnerable: [] };
      const weight = ctr(r.position);
      acc.score += weight;
      totalScore += weight;
      if (!acc.keywords.has(obs.keyword)) {
        acc.keywords.add(obs.keyword);
        if (r.position <= 3) acc.top3++;
        if (r.position <= 10) acc.top10++;
      }
      acc.positions.push(r.position);
      acc.best = acc.best === null ? r.position : Math.min(acc.best, r.position);
      if (r.position >= 3 && r.strength < 0.5) acc.vulnerable.push({ keyword: obs.keyword, position: r.position, reason: vulnerabilityReason(r) });
      byDomain.set(r.domain, acc);
    }
  }

  const seedByDomain = new Map<string, PageAnalysis>();
  for (const p of input.seedPages) if (!seedByDomain.has(p.domain)) seedByDomain.set(p.domain, p);

  const trackedSet = new Set(input.tracked);
  const domains = new Set<string>([...byDomain.keys(), ...trackedSet]);
  if (input.ownDomain) domains.add(input.ownDomain);

  const profiles: CompetitorProfile[] = [...domains].map((domain) => {
    const acc = byDomain.get(domain);
    const page = seedByDomain.get(domain);
    const role: CompetitorProfile['role'] = domain === input.ownDomain ? 'own' : trackedSet.has(domain) ? 'tracked' : 'discovered';
    const signals = page?.signals ?? [];
    return {
      domain,
      role,
      visibility: {
        keywordsSeen: acc?.keywords.size ?? 0,
        top3: acc?.top3 ?? 0,
        top10: acc?.top10 ?? 0,
        bestPosition: acc?.best ?? null,
        avgPosition: acc && acc.positions.length > 0 ? r3(acc.positions.reduce((a, b) => a + b, 0) / acc.positions.length) : null,
        shareOfVoice: acc && totalScore > 0 ? r3(acc.score / totalScore) : 0,
      },
      seedPage: page ? { url: page.url, position: page.position, title: page.title } : null,
      scorecard: page && page.composite.overall !== null ? page.composite : null,
      strengths: signals.filter((s) => s.kind === 'strength').slice(0, 6),
      weaknesses: signals.filter((s) => s.kind === 'weakness').slice(0, 6),
      vulnerableKeywords: (acc?.vulnerable ?? []).sort((a, b) => b.position - a.position).slice(0, 5),
    };
  });

  const own = profiles.filter((p) => p.role === 'own');
  const tracked = profiles.filter((p) => p.role === 'tracked').sort((a, b) => b.visibility.shareOfVoice - a.visibility.shareOfVoice);
  const discovered = profiles
    .filter((p) => p.role === 'discovered')
    .sort((a, b) => b.visibility.shareOfVoice - a.visibility.shareOfVoice || a.domain.localeCompare(b.domain))
    .slice(0, input.maxDiscovered ?? 12);
  return [...own, ...tracked, ...discovered];
}
