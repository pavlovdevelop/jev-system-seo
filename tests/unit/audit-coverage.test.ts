import { describe, expect, it } from 'vitest';
import { checkCoverage, nextStepFor, verdictOf, type CoveragePage } from '../../src/server/audit/question-coverage';
import type { SitePageContext } from '../../src/server/audit/questions';
import { extractPage } from '../../src/server/crawl/extract';
import { noulAnswer, scoreAnswer, scriptedJev } from '../helpers/fake-jev';
import { buildHtml } from '../helpers/pages';

const NOW = new Date('2026-10-05T10:00:00Z');
const mk = (url: string, title: string, h2s: string[], answerFirst: number | null = 0.8): CoveragePage => {
  const extracted = extractPage(buildHtml({ title, h1: title, h2s, paragraphs: h2s.map(() => 'Конкретен текст по темата с числа 490 лв. и срокове.') }), { url, keyword: '', now: NOW });
  return { url, answerFirst, ctx: { url, market: 'bg', business: 'Студио за сайтове', phrase: title.toLowerCase(), page: extracted } satisfies SitePageContext };
};
const PRICES = mk('https://x.example/tseni', 'Цени за изработка на сайт', ['Колко струва изработката на сайт', 'Какво е включено в цената']);
const BLOG = mk('https://x.example/blog', 'Как да изберем фирма за сайт', ['Как да сравним оферти', 'Портфолио и отзиви']);
const q = (id: string, text: string, stage: 'price' | 'howto' | 'compare' | 'local' | 'trust' | 'discover' = 'price') => ({ id, text, stage });

describe('verdicts and next steps', () => {
  it('turns the match into a verdict at the documented thresholds', () => {
    expect([0, 0.29, 0.3, 0.61, 0.62, 1].map(verdictOf)).toEqual(['no_page', 'no_page', 'weak', 'weak', 'answered', 'answered']);
  });

  it('chooses the next step from the buyer\'s intention and what is wrong with the page', () => {
    expect(nextStepFor('price', 'answered', null, null)).toBe('none');
    expect(nextStepFor('compare', 'no_page', null, null)).toBe('write_versus');
    expect(nextStepFor('local', 'no_page', null, null)).toBe('add_local');
    expect(nextStepFor('howto', 'no_page', null, null)).toBe('write_guide');
    expect(nextStepFor('compare', 'weak', 0.2, 0.9)).toBe('write_versus'); // the wrong angle comes first
    expect(nextStepFor('price', 'weak', 0.8, 0.3)).toBe('answer_at_top');
    expect(nextStepFor('trust', 'weak', 0.8, 0.9)).toBe('add_proof');
    expect(nextStepFor('price', 'weak', 0.8, 0.9)).toBe('add_prices');
    expect(nextStepFor('discover', 'weak', null, null)).toBe('answer_at_top');
  });
});

describe('checkCoverage', () => {
  it('has no page when no candidate shares words with the question — without asking Jev anything', async () => {
    const { jev, requests } = scriptedJev({});
    const [r] = await checkCoverage([q('q1', 'Как се готви боб?')], [PRICES, BLOG], jev);
    expect(r).toMatchObject({ bestPage: null, verdict: 'no_page', match: 0, judged: true });
    expect(requests).toHaveLength(0);
  });

  it("asks Jev about the best few candidates and takes the best answer, with that page and Jev's angle verdict", async () => {
    const { jev, requests } = scriptedJev({ answers_question: scoreAnswer(3.4, 5), angle_fits: noulAnswer(0.8) });
    const [r] = await checkCoverage([q('q1', 'Колко струва изработката на сайт?')], [PRICES, BLOG], jev);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.length).toBeLessThanOrEqual(3);
    expect(r).toMatchObject({ bestPage: 'https://x.example/tseni', verdict: 'answered', nextStep: 'none', judged: true });
    expect(r?.match).toBeCloseTo(0.85, 1);
    expect(r?.angleFits).toBe(0.8);
  });

  it('calls a half answer weak and says what to do', async () => {
    const { jev } = scriptedJev({ answers_question: scoreAnswer(1.8, 5), angle_fits: noulAnswer(0.2) });
    const [r] = await checkCoverage([q('q1', 'Колко струва изработката на сайт?', 'compare')], [PRICES], jev);
    expect(r?.verdict).toBe('weak');
    expect(r?.nextStep).toBe('write_versus');
  });

  it('does not name a best page when the answer is below the "weak" line', async () => {
    const { jev } = scriptedJev({ answers_question: scoreAnswer(0.5, 5), angle_fits: noulAnswer(0.5) });
    const [r] = await checkCoverage([q('q1', 'Колко струва изработката на сайт?')], [PRICES], jev);
    expect(r).toMatchObject({ verdict: 'no_page', bestPage: null });
  });

  it('falls back to word overlap, and says it did, when Jev cannot answer', async () => {
    const { jev } = scriptedJev({}, { failWhen: () => new Error('503') });
    const [r] = await checkCoverage([q('q1', 'Колко струва изработката на сайт?')], [PRICES], jev);
    expect(r?.judged).toBe(false);
    expect(r?.match).toBeNull();
    expect(['weak', 'no_page']).toContain(r?.verdict);
  });

  it('stops when the run is aborted', async () => {
    const { jev } = scriptedJev({});
    const controller = new AbortController();
    controller.abort();
    await expect(checkCoverage([q('q1', 'Колко струва сайт?')], [PRICES], jev, controller.signal)).rejects.toThrow();
  });
});
