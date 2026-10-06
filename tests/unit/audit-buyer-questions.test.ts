import { describe, expect, it } from 'vitest';
import { balance, collectQuestions, dedupe, questionVolumes, screenQuestions, templateQuestions, type RawQuestion, type ScreenedQuestion } from '../../src/server/audit/buyer-questions';
import { rulesWriter, type Writer } from '../../src/server/audit/writer';
import { buildSerpData, SerpError, type SerpProvider } from '../../src/server/providers/serp/types';
import { MARKETS } from '../../src/shared/markets';
import { choiceAnswer, noulAnswer, scriptedJev } from '../helpers/fake-jev';

const serpWith = (over: Partial<SerpProvider> & { paa?: string[]; related?: string[] } = {}): SerpProvider => ({
  id: 'demo',
  async search(query) {
    return buildSerpData({
      provider: 'demo',
      keyword: query.keyword,
      market: query.market,
      organic: [{ url: 'https://a.example/', title: 'A', snippet: 's', position: 1 }],
      peopleAlsoAsk: (over.paa ?? ['Колко струва изработката на сайт?']).map((question) => ({ question })),
      relatedSearches: over.related ?? ['изработка на сайт цена', 'как да избера фирма за сайт'],
    });
  },
  async suggest() {
    return ['как да избера хостинг', 'изработка на сайт варна'];
  },
  ...('search' in over ? { search: over.search } : {}),
});

describe('template questions', () => {
  it('writes Bulgarian questions for a Bulgarian market and English ones otherwise', () => {
    const bg = templateQuestions(['Изработка на уебсайт'], 'bg');
    expect(bg).toHaveLength(6);
    expect(bg.every((q) => q.source === 'template' && /\?$/.test(q.text))).toBe(true);
    expect(bg[0]?.text).toBe('Колко струва изработка на уебсайт?');
    const en = templateQuestions(['web design'], 'us');
    expect(en[0]?.text).toBe('How much does web design cost?');
    expect(templateQuestions(['', '  '], 'bg')).toEqual([]);
  });
});

describe('collecting', () => {
  it('gathers people-also-ask, question-shaped related searches and suggestions, the writer\'s questions and the templates', async () => {
    const writer: Writer = { ...rulesWriter, id: 'anthropic', model: 'm', questions: async () => ['Кои са най-добрите студиа за уебсайтове в София?'] };
    const raw = await collectQuestions({ business: 'Студио', market: 'bg', seeds: ['изработка на сайт'], count: 10, serp: serpWith(), writer });
    const bySource = (s: string) => raw.filter((q) => q.source === s).map((q) => q.text);
    expect(bySource('paa')).toEqual(['Колко струва изработката на сайт?']);
    expect(bySource('related')).toEqual(['Как да избера фирма за сайт?']); // "изработка на сайт цена" is not a question
    expect(bySource('suggest')).toEqual(['Как да избера хостинг?']);
    expect(bySource('llm')).toHaveLength(1);
    expect(bySource('template')).toHaveLength(6);
  });

  it('asks the writer to avoid what it already has', async () => {
    let avoided: readonly string[] = [];
    const writer: Writer = { ...rulesWriter, id: 'openai', model: 'm', questions: async (i) => ((avoided = i.avoid), []) };
    await collectQuestions({ business: 'Студио', market: 'bg', seeds: ['сайт'], count: 10, serp: serpWith(), writer });
    expect(avoided).toContain('Колко струва изработката на сайт?');
  });

  it('works without a search provider, and a failing seed does not sink the set', async () => {
    const noSerp = await collectQuestions({ business: 'Студио', market: 'bg', seeds: ['сайт'], count: 5, serp: null, writer: rulesWriter });
    expect(noSerp.every((q) => q.source === 'template')).toBe(true);
    const flaky = serpWith({ search: async () => { throw new SerpError('unavailable', '503'); } });
    const out = await collectQuestions({ business: 'Студио', market: 'bg', seeds: ['сайт', 'магазин'], count: 5, serp: flaky, writer: rulesWriter });
    expect(out.length).toBeGreaterThan(0);
  });

  it('stops for a rejected key, which every further call would hit too', async () => {
    const dead = serpWith({ search: async () => { throw new SerpError('auth', '401'); } });
    await expect(collectQuestions({ business: 'Студио', market: 'bg', seeds: ['сайт'], count: 5, serp: dead, writer: rulesWriter })).rejects.toBeInstanceOf(SerpError);
  });

  it('does not let a failing writer sink the set either', async () => {
    const writer: Writer = { ...rulesWriter, id: 'gemini', model: 'm', questions: async () => { throw new Error('boom'); } };
    const out = await collectQuestions({ business: 'Студио', market: 'bg', seeds: ['сайт'], count: 5, serp: null, writer });
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('dedupe', () => {
  it('counts a question and its inflected twin once and keeps the more trustworthy source', () => {
    const raw: RawQuestion[] = [
      { text: 'Колко струва изработката на сайт?', source: 'template' },
      { text: 'Колко струва изработка на сайтове?', source: 'llm' },
      { text: 'Как да избера фирма за сайт?', source: 'paa' },
      { text: 'къс?', source: 'llm' },
      { text: 'Колко струва изработката на сайт?'.padEnd(250, 'а'), source: 'llm' },
    ];
    const out = dedupe(raw);
    expect(out).toHaveLength(2);
    expect(out.find((q) => /Колко струва/.test(q.text))?.source).toBe('llm');
  });
});

describe('screening and balancing', () => {
  const raw: RawQuestion[] = [
    { text: 'Колко струва изработката на сайт?', source: 'paa' },
    { text: 'Как се готви боб?', source: 'llm' },
  ];

  it('keeps what Jev finds relevant and labels it with the buyer\'s intention', async () => {
    const { jev } = scriptedJev({ relevant_to_business: noulAnswer(0.9), question_stage: choiceAnswer('price', { discover: 0.1 }) });
    const out = await screenQuestions(raw, 'Студио', 'bg', jev);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ stage: 'price', relevance: 0.9 });
  });

  it('drops what Jev finds off-topic, and keeps (unlabelled) what Jev could not read', async () => {
    const off = scriptedJev({ relevant_to_business: noulAnswer(0.1), question_stage: choiceAnswer('price') });
    expect(await screenQuestions(raw, 'Студио', 'bg', off.jev)).toEqual([]);
    const dead = scriptedJev({}, { failWhen: () => new Error('503') });
    const kept = await screenQuestions(raw, 'Студио', 'bg', dead.jev);
    expect(kept).toHaveLength(2);
    expect(kept.every((q) => q.stage === 'discover')).toBe(true);
  });

  it('takes questions round-robin over the stages, most trustworthy source first', () => {
    const q = (text: string, stage: ScreenedQuestion['stage'], source: ScreenedQuestion['source'], relevance = 0.8): ScreenedQuestion => ({ text, stage, source, relevance });
    const pool = [
      q('цена 1?', 'price', 'template'), q('цена 2?', 'price', 'llm'), q('цена 3?', 'price', 'paa'),
      q('сравнение 1?', 'compare', 'llm'), q('доверие 1?', 'trust', 'llm'),
    ];
    const four = balance(pool, 4).map((x) => x.text);
    expect(four).toHaveLength(4);
    expect(four.slice(0, 3).sort()).toEqual(['доверие 1?', 'сравнение 1?', 'цена 2?'].sort()); // one of each stage first; llm before paa before template
    expect(balance(pool, 99)).toHaveLength(5);
    expect(balance([], 5)).toEqual([]);
  });

  it('stops at exactly the number asked for, also in the middle of a round', () => {
    const q = (text: string, stage: ScreenedQuestion['stage']): ScreenedQuestion => ({ text, stage, source: 'llm', relevance: 0.8 });
    const pool = [q('цена 1?', 'price'), q('цена 2?', 'price'), q('сравнение 1?', 'compare'), q('сравнение 2?', 'compare'), q('доверие 1?', 'trust')];
    // round 1 could add two more questions; only one fits
    expect(balance(pool, 4)).toHaveLength(4);
    expect(balance(pool, 4).map((x) => x.text)).toEqual(['сравнение 1?', 'цена 1?', 'доверие 1?', 'сравнение 2?']); // stages in their fixed order, then round two
    expect(balance(pool, 1)).toHaveLength(1);
    expect(balance(pool, 0)).toEqual([]);
  });
});

describe('volumes', () => {
  it('maps volumes by lower-case text and ignores unknown ones', async () => {
    const volume = { id: 'demo' as const, volumes: async () => new Map([['колко струва сайт?', { volume: 90, cpc: null, competitionIndex: null }], ['друго?', { volume: null, cpc: null, competitionIndex: null }]]) };
    const out = await questionVolumes(['Колко струва сайт?', 'друго?'], 'bg', volume);
    expect([...out.entries()]).toEqual([['колко струва сайт?', 90]]);
    expect((await questionVolumes(['x'], 'bg', null)).size).toBe(0);
    expect((await questionVolumes(['x'], 'bg', { id: 'demo', volumes: async () => { throw new Error('x'); } })).size).toBe(0);
    expect(MARKETS.bg.id).toBe('bg');
  });
});
