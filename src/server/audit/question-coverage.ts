import type { NextStep, QuestionStage } from '../../shared/audit';
import { ANSWER_MATCH } from '../../shared/weights';
import type { Jev } from '../jev/client';
import { mapLimit } from '../util/limit';
import { coverQuestions, coverState, pageOverlap, type SitePageContext } from './questions';

// Does the site have a page that answers a buyer's question? Candidate pages are found by word overlap (cheap, in
// code); Jev then reads only the best few and says how completely each one answers. The number comes from Jev's
// score, the decision (no page / weak / answered) from thresholds in shared/weights.ts.

export interface CoveragePage {
  url: string;
  ctx: SitePageContext;
  /** The page's "answer first" criterion (0..1), when known: a weak answer on a page that buries it needs a different fix. */
  answerFirst: number | null;
}

export interface QuestionInput {
  id: string;
  text: string;
  stage: QuestionStage;
}

export interface CoverageResult {
  id: string;
  bestPage: string | null;
  match: number | null;
  angleFits: number | null;
  verdict: 'no_page' | 'weak' | 'answered';
  nextStep: NextStep;
  /** False when Jev could not answer and the verdict rests on word overlap alone. */
  judged: boolean;
}

const CANDIDATES = 3;
const MIN_OVERLAP = 0.12;

export function verdictOf(match: number): CoverageResult['verdict'] {
  return match < ANSWER_MATCH.weakBelow ? 'no_page' : match < ANSWER_MATCH.answeredAt ? 'weak' : 'answered';
}

/** What to do about a question, from the buyer's intention and how the site fares. */
export function nextStepFor(stage: QuestionStage, verdict: CoverageResult['verdict'], angleFits: number | null, answerFirst: number | null): NextStep {
  if (verdict === 'answered') return 'none';
  if (verdict === 'no_page') return stage === 'compare' ? 'write_versus' : stage === 'local' ? 'add_local' : 'write_guide';
  // a weak answer: first the angle, then burying the answer, then the stage's usual gap
  if (angleFits !== null && angleFits < 0.4) return stage === 'compare' ? 'write_versus' : 'write_guide';
  if (answerFirst !== null && answerFirst < 0.5) return 'answer_at_top';
  if (stage === 'trust') return 'add_proof';
  if (stage === 'price') return 'add_prices';
  if (stage === 'local') return 'add_local';
  return 'answer_at_top';
}

export async function checkCoverage(questions: readonly QuestionInput[], pages: readonly CoveragePage[], jev: Jev, signal?: AbortSignal): Promise<CoverageResult[]> {
  return mapLimit(questions, 6, async (q): Promise<CoverageResult> => {
    signal?.throwIfAborted();
    const candidates = pages
      .map((p) => ({ p, overlap: pageOverlap(q.text, p.ctx.page) }))
      .filter((c) => c.overlap >= MIN_OVERLAP)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, CANDIDATES);
    if (candidates.length === 0) return { id: q.id, bestPage: null, match: 0, angleFits: null, verdict: 'no_page', nextStep: nextStepFor(q.stage, 'no_page', null, null), judged: true };

    const judged = await Promise.all(
      candidates.map(async (c) => ({ c, answers: await jev.tryAsk(coverState(q.text, c.p.ctx), coverQuestions, { ...(signal ? { signal } : {}) }) })),
    );
    const answered = judged.filter((j): j is { c: (typeof candidates)[number]; answers: NonNullable<(typeof judged)[number]['answers']> } => j.answers !== null);
    if (answered.length === 0) {
      // Jev did not answer: fall back to the overlap alone and say so
      const top = candidates[0] as (typeof candidates)[number];
      const verdict = top.overlap >= 0.5 ? 'weak' : 'no_page';
      return { id: q.id, bestPage: verdict === 'no_page' ? null : top.p.url, match: null, angleFits: null, verdict, nextStep: nextStepFor(q.stage, verdict, null, top.p.answerFirst), judged: false };
    }
    answered.sort((a, b) => b.answers.answers_question.value - a.answers.answers_question.value || b.c.overlap - a.c.overlap);
    const best = answered[0] as (typeof answered)[number];
    const match = Math.round(best.answers.answers_question.value * 1000) / 1000;
    const verdict = verdictOf(match);
    const angleFits = Math.round(best.answers.angle_fits.p * 1000) / 1000;
    return { id: q.id, bestPage: verdict === 'no_page' ? null : best.c.p.url, match, angleFits, verdict, nextStep: nextStepFor(q.stage, verdict, angleFits, best.c.p.answerFirst), judged: true };
  });
}
