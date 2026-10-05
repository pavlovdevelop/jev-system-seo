import type { Intent, PageType } from '../../shared/domain';
import type { PageAnalysis } from '../../shared/schemas';
import { dominantOf } from '../analysis/assessment';
import { POSITION_WEIGHTS } from '../analysis/assessment';

// What does Google think this query is about? Not what the keyword looks like — what the results ARE.
// Each judged page votes for its page type and the intent it serves, weighted by rank and by how sure Jev was.

const posWeight = (position: number | null): number => (position === null ? 0 : (POSITION_WEIGHTS[position - 1] ?? 0.1));

export interface IntentVote {
  dominantPageType: PageType | null;
  dominantIntent: Intent | null;
  dominantShare: number | null;
  pageTypeShare: Record<string, number>;
  intentShare: Record<string, number>;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export function voteIntent(pages: readonly PageAnalysis[]): IntentVote {
  const types = new Map<PageType, number>();
  const intents = new Map<Intent, number>();
  for (const p of pages) {
    const w = posWeight(p.position);
    if (w === 0) continue;
    if (p.judgments.pageType) types.set(p.judgments.pageType.value, (types.get(p.judgments.pageType.value) ?? 0) + w * (0.5 + 0.5 * p.judgments.pageType.confidence));
    if (p.judgments.intentServed) intents.set(p.judgments.intentServed.value, (intents.get(p.judgments.intentServed.value) ?? 0) + w * (0.5 + 0.5 * p.judgments.intentServed.confidence));
  }
  const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
  const share = (m: Map<string, number>): Record<string, number> => {
    const t = total(m);
    return t > 0 ? Object.fromEntries([...m].map(([k, v]) => [k, r3(v / t)])) : {};
  };
  const dominantPageType = dominantOf(types);
  const typeShare = share(types);
  return {
    dominantPageType,
    dominantIntent: dominantOf(intents),
    dominantShare: dominantPageType ? (typeShare[dominantPageType] ?? null) : null,
    pageTypeShare: typeShare,
    intentShare: share(intents),
  };
}
