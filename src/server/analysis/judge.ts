import type { PageType } from '../../shared/domain';
import type { MarketId } from '../../shared/markets';
import type { IntentAnswer, NoulAnswer, PageJudgments, PageTypeAnswer, ScoreAnswer } from '../../shared/schemas';
import type { ChoiceResult, Jev, NoulResult, ScoreResult } from '../jev/client';
import {
  contentQuestions,
  contentState,
  identityQuestions,
  identityState,
  keywordQuestions,
  keywordState,
  shallowQuestions,
  shallowState,
  trustQuestions,
  trustState,
  type PageContext,
} from '../jev/questions';

// The glue between the question catalogue and the analysis: ask Jev, then keep only compact,
// decision-shaped snapshots (value + how sure Jev was) in the report.

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export const noulLite = (a: NoulResult): NoulAnswer => ({ p: r3(a.p) });

export const scoreLite = (a: ScoreResult): ScoreAnswer => ({
  value: r3(a.value),
  raw: r3(a.raw),
  levels: a.levels,
  confidence: r3(a.confidence),
});

export function choiceLite<K extends string>(a: ChoiceResult<K>): { value: K; p: number; confidence: number; runnerUp: { value: K; p: number } | null } {
  return {
    value: a.value,
    p: r3(a.p),
    confidence: r3(a.confidence),
    runnerUp: a.runnerUp ? { value: a.runnerUp.value, p: r3(a.runnerUp.p) } : null,
  };
}

export type JudgmentStatus = 'complete' | 'partial' | 'none';

/**
 * Judges one page with three focused requests (identity / content / trust). Each request carries only the
 * evidence its questions need — Jev loses accuracy when the state is padded with unrelated detail.
 * Invalid-key errors propagate; any other failure just leaves that slice of the judgments empty.
 */
export async function judgePage(jev: Jev, ctx: PageContext): Promise<{ judgments: PageJudgments; status: JudgmentStatus }> {
  const contentSt = contentState(ctx);
  const trustSt = trustState(ctx);

  const [identity, content, trust] = await Promise.all([
    jev.tryAsk(identityState(ctx), identityQuestions, { debias: ['page_type', 'intent_served'] }),
    contentSt ? jev.tryAsk(contentSt, contentQuestions) : Promise.resolve(null),
    trustSt ? jev.tryAsk(trustSt, trustQuestions) : Promise.resolve(null),
  ]);

  const judgments: PageJudgments = {};
  if (identity) {
    judgments.pageType = choiceLite(identity.page_type);
    judgments.intentServed = choiceLite(identity.intent_served);
    judgments.targetsQuery = noulLite(identity.targets_query);
    judgments.localToMarket = noulLite(identity.local_to_market);
  }
  if (content) {
    judgments.topicDepth = scoreLite(content.topic_depth);
    judgments.needSatisfied = scoreLite(content.need_satisfied);
    judgments.genericContent = noulLite(content.generic_content);
  }
  if (trust) {
    judgments.statesPrices = noulLite(trust.states_prices);
    judgments.showsPortfolio = noulLite(trust.shows_portfolio);
    judgments.showsReviews = noulLite(trust.shows_reviews);
    judgments.clearCta = noulLite(trust.clear_cta);
    judgments.showsIdentity = noulLite(trust.shows_identity);
  }

  const expected = 1 + (contentSt ? 1 : 0) + (trustSt ? 1 : 0);
  const answered = [identity, content, trust].filter(Boolean).length;
  const status: JudgmentStatus = answered === 0 ? 'none' : answered === expected && ctx.page ? 'complete' : 'partial';
  return { judgments, status };
}

export interface KeywordJudgment {
  /** P(the query describes a need the business can fulfil). */
  relevance: number;
  intent: IntentAnswer;
  /** 0..1 expected readiness to pay. */
  commercial: number;
  commercialConfidence: number;
}

/** Screens a candidate keyword against the business profile. Returns null if Jev could not answer. */
export async function judgeKeyword(jev: Jev, keyword: string, business: string, market: MarketId): Promise<KeywordJudgment | null> {
  const a = await jev.tryAsk(keywordState(keyword, business, market), keywordQuestions, { shuffleChoices: true });
  if (!a) return null;
  return {
    relevance: r3(a.relevant_to_business.p),
    intent: choiceLite(a.query_intent),
    commercial: r3(a.commercial_value.value),
    commercialConfidence: r3(a.commercial_value.confidence),
  };
}

export interface ShallowJudgment {
  pageType: PageTypeAnswer;
  targetsQuery: number;
}

/** Cheap judgment of a search result from its title and snippet alone (used for candidate-keyword SERPs). */
export async function judgeShallowResult(
  jev: Jev,
  keyword: string,
  result: { domain: string; url: string; title: string; snippet: string },
): Promise<ShallowJudgment | null> {
  const a = await jev.tryAsk(shallowState(keyword, result), shallowQuestions, { shuffleChoices: true });
  if (!a) return null;
  return { pageType: choiceLite(a.page_type) as PageTypeAnswer & { value: PageType }, targetsQuery: r3(a.targets_query.p) };
}
