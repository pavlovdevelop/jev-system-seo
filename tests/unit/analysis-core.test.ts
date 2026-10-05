import { describe, expect, it } from 'vitest';
import type { PageMetrics, PageTypeAnswer } from '../../src/shared/schemas';
import { assessSerp, resultStrength, type ResultSignal } from '../../src/server/analysis/assessment';
import { judgeKeyword, judgePage, judgeShallowResult } from '../../src/server/analysis/judge';
import { compositeScores, median, optimizationScore, percentile, weighted } from '../../src/server/analysis/scoring';
import { pageSignals, type PeerStats } from '../../src/server/analysis/signals';
import { extractPage } from '../../src/server/crawl/extract';
import { readFileSync } from 'node:fs';
import { choiceAnswer, noulAnswer, scoreAnswer, scriptedJev } from '../helpers/fake-jev';
import { APIError } from '@typesafe-ai/sdk';
import type { PageContext } from '../../src/server/jev/questions';
import type { FetchInfo } from '../../src/shared/schemas';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf-8');
const KEYWORD = 'изработка на уеб сайт';
const URL_ = 'https://www.studio-pixel.example/uslugi/izrabotka-na-uebsait/';
const okFetch: FetchInfo = { status: 'ok', httpStatus: 200, error: null, finalUrl: URL_, ttfbMs: 250, bytes: 5000, fromCache: false };
const pt = (value: PageTypeAnswer['value'], p = 0.85): PageTypeAnswer => ({ value, p, confidence: 0.8, runnerUp: null });

const richPage = () => extractPage(fixture('service-page.html'), { url: URL_, keyword: KEYWORD, now: new Date('2026-10-05') });
const ctxFor = (page = richPage()): PageContext => ({ keyword: KEYWORD, market: 'bg', url: URL_, domain: 'studio-pixel.example', serpTitle: 'T', serpSnippet: 'S', page });

describe('weighted()', () => {
  it('renormalises over the parts that are present and returns null when none are', () => {
    expect(weighted([{ value: 1, weight: 1 }, { value: 0, weight: 1 }])).toBe(0.5);
    expect(weighted([{ value: 1, weight: 1 }, { value: null, weight: 5 }])).toBe(1);
    expect(weighted([{ value: undefined, weight: 1 }])).toBeNull();
    expect(weighted([{ value: 5, weight: 1 }])).toBe(1); // clamped
  });
  it('median / percentile', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([1, 2, 3, 4, 5], 0.75)).toBe(4);
  });
});

describe('compositeScores', () => {
  const rich = richPage().metrics;
  const thin = extractPage(fixture('thin-page.html'), { url: 'http://thin.example/', keyword: KEYWORD }).metrics;

  it('rewards a well-optimised page and punishes a sloppy one (measured only)', () => {
    expect(optimizationScore(rich)).toBeGreaterThan(0.85);
    expect(optimizationScore(thin)).toBeLessThan(0.3);
  });

  it('combines Jev atoms with measured facts and stays within 0..1', () => {
    const strong = compositeScores({
      metrics: rich,
      judgments: { topicDepth: { value: 0.9, raw: 3.6, levels: 5, confidence: 0.8 }, needSatisfied: { value: 0.85, raw: 2.55, levels: 4, confidence: 0.7 }, genericContent: { p: 0.1 }, showsPortfolio: { p: 0.9 }, showsReviews: { p: 0.8 }, showsIdentity: { p: 0.9 }, clearCta: { p: 0.95 }, statesPrices: { p: 0.9 } },
    }, { targetWords: 150 });
    const weak = compositeScores({ metrics: thin, judgments: { topicDepth: { value: 0.1, raw: 0.4, levels: 5, confidence: 0.7 }, genericContent: { p: 0.9 }, clearCta: { p: 0.05 }, statesPrices: { p: 0.05 } } });
    for (const k of ['content', 'optimization', 'trust', 'conversion', 'overall'] as const) {
      expect(strong[k]).not.toBeNull();
      expect(strong[k]!).toBeGreaterThanOrEqual(0);
      expect(strong[k]!).toBeLessThanOrEqual(1);
    }
    expect(strong.overall!).toBeGreaterThan(0.8);
    expect(weak.overall!).toBeLessThan(0.3);
  });

  it('degrades gracefully: no metrics, no judgments → nulls, not zeros', () => {
    expect(compositeScores({ metrics: null, judgments: {} })).toEqual({ content: null, optimization: null, trust: null, conversion: null, overall: null });
    const onlyJev = compositeScores({ metrics: null, judgments: { topicDepth: { value: 0.5, raw: 2, levels: 5, confidence: 0.5 } } });
    expect(onlyJev.content).toBe(0.5);
    expect(onlyJev.overall).toBe(0.5);
  });
});

describe('pageSignals', () => {
  const peers: PeerStats = { pages: 8, medianWords: 900, faqShare: 0.5, dominantIntent: 'transactional', dominantPageType: 'service_page' };
  const ids = (s: ReturnType<typeof pageSignals>, kind: 'strength' | 'weakness') => s.filter((x) => x.kind === kind).map((x) => x.id);
  // the fixture page is deliberately short; give the "rich" scenario a realistic length
  const richMetrics = { ...richPage().metrics, wordCount: 1500 };
  const base = { metrics: richMetrics, fetch: okFetch, composite: compositeScores({ metrics: richMetrics, judgments: {} }) };

  it('reports measured strengths of the rich fixture page', () => {
    const s = pageSignals({ ...base, judgments: {} }, peers, new Date('2026-10-05'));
    expect(ids(s, 'strength')).toEqual(expect.arrayContaining(['keyword_in_title_h1', 'schema_markup', 'faq', 'fast_response']));
    expect(ids(s, 'weakness')).not.toContain('thin_content');
  });

  it('turns confident Jev answers into signals and ignores unsure ones', () => {
    const confident = pageSignals({ ...base, judgments: { statesPrices: { p: 0.93 }, showsPortfolio: { p: 0.88 }, clearCta: { p: 0.04 }, showsReviews: { p: 0.62 }, topicDepth: { value: 0.85, raw: 3.4, levels: 5, confidence: 0.8 } } }, peers);
    expect(ids(confident, 'strength')).toEqual(expect.arrayContaining(['pricing', 'portfolio', 'deep_content']));
    expect(ids(confident, 'weakness')).toContain('no_cta');
    expect(ids(confident, 'strength')).not.toContain('reviews'); // 0.62 is below the 0.7 bar
    const unsure = pageSignals({ ...base, judgments: { topicDepth: { value: 0.9, raw: 3.6, levels: 5, confidence: 0.1 } } }, peers);
    expect(ids(unsure, 'strength')).not.toContain('deep_content');
  });

  it('flags every weakness of the thin fixture page', () => {
    const thin = extractPage(fixture('thin-page.html'), { url: 'http://thin.example/', keyword: KEYWORD });
    const s = pageSignals({ metrics: thin.metrics, judgments: { pageType: pt('company_homepage'), targetsQuery: { p: 0.1 }, genericContent: { p: 0.9 } }, fetch: okFetch, composite: compositeScores({ metrics: thin.metrics, judgments: {} }) }, peers);
    expect(ids(s, 'weakness')).toEqual(expect.arrayContaining(['thin_content', 'keyword_missing_title', 'multiple_h1', 'no_meta', 'no_schema', 'no_faq', 'no_viewport', 'no_https', 'not_dedicated', 'generic_text']));
  });

  it('flags a page type that does not fit a commercial SERP, but not for informational SERPs', () => {
    const j = { pageType: pt('forum_or_social') };
    expect(ids(pageSignals({ ...base, judgments: j }, peers), 'weakness')).toContain('off_intent_type');
    expect(ids(pageSignals({ ...base, judgments: j }, { ...peers, dominantIntent: 'informational' }), 'weakness')).not.toContain('off_intent_type');
  });

  it('every signal carries evidence, a source and a confidence', () => {
    const s = pageSignals({ ...base, judgments: { statesPrices: { p: 0.9 }, clearCta: { p: 0.05 } } }, peers);
    for (const x of s) {
      expect(x.label.length).toBeGreaterThan(3);
      expect(x.evidence.length).toBeGreaterThan(0);
      expect(['measured', 'jev']).toContain(x.source);
      expect(['high', 'medium', 'low']).toContain(x.confidence);
    }
  });
});

describe('assessSerp', () => {
  const r = (position: number, over: Partial<ResultSignal> = {}): ResultSignal => ({ position, domain: `d${position}.example`, url: `https://d${position}.example/`, title: 't', pageType: pt('service_page'), targetsQuery: 0.9, titleMatch: 1, depth: null, ...over });

  it('rates a SERP of dedicated, well-matched service pages as hard and a SERP of forums/directories as easy', () => {
    const strong = assessSerp(Array.from({ length: 10 }, (_, i) => r(i + 1, { depth: 0.8 })), { intent: 'transactional' })!;
    const weak = assessSerp(
      Array.from({ length: 10 }, (_, i) => r(i + 1, { pageType: pt(i % 2 ? 'forum_or_social' : 'directory_marketplace'), targetsQuery: 0.15, titleMatch: 0.3 })),
      { intent: 'transactional' },
    )!;
    expect(strong.difficulty).toBe('hard');
    expect(weak.difficulty).toBe('easy');
    expect(weak.weakness).toBeGreaterThan(strong.weakness + 0.3);
    expect(strong.dominantPageType).toBe('service_page');
    expect(strong.components.thinContent).toBeCloseTo(0.2, 2);
    expect(weak.components.thinContent).toBeNull();
  });

  it('weights top positions more than lower ones', () => {
    const weakTop = assessSerp([r(1, { targetsQuery: 0.1, titleMatch: 0 }), ...Array.from({ length: 9 }, (_, i) => r(i + 2))], { intent: 'transactional' })!;
    const weakBottom = assessSerp([...Array.from({ length: 9 }, (_, i) => r(i + 1)), r(10, { targetsQuery: 0.1, titleMatch: 0 })], { intent: 'transactional' })!;
    expect(weakTop.weakness).toBeGreaterThan(weakBottom.weakness);
  });

  it('topical dominance makes a SERP harder', () => {
    const rows = Array.from({ length: 5 }, (_, i) => r(i + 1));
    const plain = assessSerp(rows, { intent: 'transactional' })!;
    const dominated = assessSerp(rows, { intent: 'transactional', dominance: new Map(rows.map((x) => [x.domain, 1])) })!;
    expect(dominated.weakness).toBeLessThan(plain.weakness);
  });

  it('judges blog articles as a good fit for informational intent only', () => {
    const blog = r(1, { pageType: pt('blog_article') });
    expect(resultStrength(blog, 'informational', 0).typeFit).toBe(1);
    expect(resultStrength(blog, 'transactional', 0).typeFit).toBe(0.5);
  });

  it('returns null for an empty SERP and neutral values for unknown judgments', () => {
    expect(assessSerp([], { intent: null })).toBeNull();
    const unknown = assessSerp([r(1, { pageType: null, targetsQuery: null, titleMatch: 0.5 })], { intent: null })!;
    expect(unknown.weakness).toBeGreaterThan(0.3);
    expect(unknown.weakness).toBeLessThan(0.7);
  });
});

describe('judge.ts', () => {
  const identity = { page_type: choiceAnswer('service_page', { blog_article: 0.1, other: 0.1 }, 0.8), intent_served: choiceAnswer('transactional', { informational: 0.2 }, 0.7), targets_query: noulAnswer(0.9), local_to_market: noulAnswer(0.95) };
  const content = { topic_depth: scoreAnswer(3.2, 5, 0.7), need_satisfied: scoreAnswer(2.4, 4, 0.6), generic_content: noulAnswer(0.2) };
  const trust = { states_prices: noulAnswer(0.9), shows_portfolio: noulAnswer(0.85), shows_reviews: noulAnswer(0.7), clear_cta: noulAnswer(0.95), shows_identity: noulAnswer(0.8) };

  it('fans out three focused requests and maps answers into compact judgments', async () => {
    const { jev, requests } = scriptedJev({ ...identity, ...content, ...trust });
    const { judgments, status } = await judgePage(jev, ctxFor());
    expect(requests).toHaveLength(3);
    // each request carries only the question group that needs its state slice
    const idSets = requests.map((q) => Object.keys(q.questions).filter((k) => !k.endsWith('__rev')).sort());
    expect(idSets).toContainEqual(['intent_served', 'local_to_market', 'page_type', 'targets_query']);
    expect(idSets).toContainEqual(['generic_content', 'need_satisfied', 'topic_depth']);
    expect(idSets).toContainEqual(['clear_cta', 'shows_identity', 'shows_portfolio', 'shows_reviews', 'states_prices']);
    expect(status).toBe('complete');
    expect(judgments.pageType?.value).toBe('service_page');
    expect(judgments.topicDepth).toMatchObject({ levels: 5, raw: 3.2 });
    expect(judgments.topicDepth!.value).toBeCloseTo(0.8, 3);
    expect(judgments.statesPrices?.p).toBe(0.9);
  });

  it('debiases the two choice questions with reversed twins', async () => {
    const { jev, requests } = scriptedJev({ ...identity });
    await judgePage(jev, ctxFor());
    const identityReq = requests.find((q) => 'page_type' in q.questions)!;
    expect(Object.keys(identityReq.questions).sort()).toEqual(expect.arrayContaining(['page_type', 'page_type__rev', 'intent_served', 'intent_served__rev']));
  });

  it('keeps Jev away from page text it should not see (hidden text stripped before judging)', async () => {
    const { jev, requests } = scriptedJev({});
    await judgePage(jev, ctxFor());
    const sent = JSON.stringify(requests.map((q) => q.state));
    expect(sent).not.toContain('HIDDEN-TEXT');
    expect(sent).not.toContain('Ignore all previous instructions');
  });

  it('uses only the identity slice for pages that could not be fetched, and marks them partial', async () => {
    const { jev, requests } = scriptedJev({ ...identity });
    const { judgments, status } = await judgePage(jev, { ...ctxFor(), page: null });
    expect(requests).toHaveLength(1);
    expect(status).toBe('partial');
    expect(judgments.topicDepth).toBeUndefined();
    expect(judgments.pageType?.value).toBe('service_page');
  });

  it('survives a failing slice and reports partial results', async () => {
    const { jev } = scriptedJev({ ...identity, ...trust }, { failWhen: (req) => ('topic_depth' in req.questions ? APIError.fromResponse(529, { message: 'busy' }, new Headers()) : null) });
    const { judgments, status } = await judgePage(jev, ctxFor());
    expect(status).toBe('partial');
    expect(judgments.topicDepth).toBeUndefined();
    expect(judgments.statesPrices?.p).toBe(0.9);
  });

  it('rethrows an invalid-key error instead of silently producing empty judgments', async () => {
    const { jev } = scriptedJev({}, { failWhen: () => APIError.fromResponse(401, { message: 'bad key' }, new Headers()) });
    await expect(judgePage(jev, ctxFor())).rejects.toMatchObject({ kind: 'auth' });
  });

  it('judgeKeyword screens candidates against the business profile', async () => {
    const { jev, requests } = scriptedJev({ relevant_to_business: noulAnswer(0.92), query_intent: choiceAnswer('transactional', {}, 0.8), commercial_value: scoreAnswer(2.7, 4, 0.6) });
    const j = await judgeKeyword(jev, 'изработка на сайт цена', 'Уеб студио в София', 'bg');
    expect(j).toMatchObject({ relevance: 0.92, commercialConfidence: 0.6 });
    expect(j!.commercial).toBeCloseTo(0.9, 3);
    expect(j!.intent.value).toBe('transactional');
    expect((requests[0]!.state as any).business).toBe('Уеб студио в София');
  });

  it('judgeShallowResult uses only title, snippet and URL', async () => {
    const { jev, requests } = scriptedJev({ page_type: choiceAnswer('forum_or_social'), targets_query: noulAnswer(0.2) });
    const j = await judgeShallowResult(jev, 'k', { domain: 'f.example', url: 'https://f.example/t/1', title: 'Тема', snippet: 'Коментари' });
    expect(j).toMatchObject({ targetsQuery: 0.2 });
    expect(j!.pageType.value).toBe('forum_or_social');
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['page_type', 'targets_query']);
  });

  it('returns null (not a throw) when Jev is merely unavailable', async () => {
    const { jev } = scriptedJev({}, { failWhen: () => APIError.fromResponse(500, {}, new Headers()) });
    expect(await judgeKeyword(jev, 'k', 'b', 'bg')).toBeNull();
    expect(await judgeShallowResult(jev, 'k', { domain: 'a', url: 'https://a/', title: '', snippet: '' })).toBeNull();
  });
});
