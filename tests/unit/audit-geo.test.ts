import { describe, expect, it } from 'vitest';
import { analyseAnswer, brandMatcher, firstMention, namesOfDomain, readSentiment, runEngines, summarizeEngine, toRecord, wilson, type RawAnswer } from '../../src/server/audit/geo';
import { EngineError, type AnswerEngine, type EngineAnswer } from '../../src/server/geo/engines/types';
import { choiceAnswer, scriptedJev } from '../helpers/fake-jev';

const cite = (url: string, title = 'x') => ({ url, title, domain: new URL(url).hostname.replace(/^www\./, '') });
const answer = (text: string, citations: EngineAnswer['citations'] = [], over: Partial<EngineAnswer> = {}): EngineAnswer => ({
  text,
  citations,
  consulted: [],
  searched: true,
  queries: [],
  latencyMs: 1200,
  usage: { inputTokens: 1000, outputTokens: 300, searches: 2 },
  model: 'm',
  ...over,
});
const matcher = brandMatcher({
  domain: 'my-studio.example',
  brandNames: ['Моето студио'],
  competitors: [{ domain: 'pixel-studio.example', names: ['Пиксел Студио'] }, { domain: 'webmasters-bg.example' }, { domain: 'my-studio.example' }],
});

describe('names and mentions', () => {
  it('knows the ways a domain is written in prose', () => {
    expect(namesOfDomain('pixel-studio.example').sort()).toEqual(['pixel studio', 'pixel-studio', 'pixel-studio.example', 'pixelstudio'].sort());
    expect(namesOfDomain('go.bg')).toEqual(['go.bg']); // names shorter than four characters are too ambiguous to look for... except the domain itself
  });

  it('finds a name as a whole word only, and lets a Bulgarian name carry an article or a plural', () => {
    expect(firstMention('Препоръчвам Моето студио за сайтове.', ['моето студио'])).toBe(12);
    expect(firstMention('Моето студиото е добро', ['моето студио'])).toBe(0);
    expect(firstMention('Pixel Studios are fine', ['pixel studio'])).toBe(-1); // a longer Latin word is another word
    expect(firstMention('Виж pixel-studio.example днес', ['pixel-studio.example'])).toBeGreaterThan(0);
    expect(firstMention('нищо общо', ['моето студио', 'my-studio'])).toBe(-1);
    expect(firstMention('Първо my-studio, после Моето студио', ['моето студио', 'my-studio'])).toBe(6);
  });

  it('builds a matcher that drops our own domain from the competitors and merges the aliases', () => {
    expect(matcher.ownDomain).toBe('my-studio.example');
    expect(matcher.own).toEqual(expect.arrayContaining(['моето студио', 'my-studio.example', 'my-studio', 'my studio']));
    expect(matcher.competitors.map((c) => c.domain)).toEqual(['pixel-studio.example', 'webmasters-bg.example']);
    expect(matcher.competitors[0]?.names).toEqual(expect.arrayContaining(['пиксел студио', 'pixel studio']));
  });
});

describe('analyseAnswer', () => {
  it('is "cited" when our domain is among the sources, with our place and share', () => {
    const a = analyseAnswer(answer('Ето три варианта.', [cite('https://pixel-studio.example/a'), cite('https://my-studio.example/tseni'), cite('https://my-studio.example/blog'), cite('https://healthline.com/x')]), matcher);
    expect(a.status).toBe('cited');
    expect(a.position).toBe(2);
    expect(a.share).toBe(0.5);
    expect(a.citations).toHaveLength(4);
  });

  it('is "named" when the text mentions us without a citation, ranked by the order brands appear in the text', () => {
    const a = analyseAnswer(answer('Добри са Пиксел Студио и Уебмастърс, както и Моето студио.', [cite('https://healthline.com/x')]), matcher);
    expect(a.status).toBe('named');
    expect(a.position).toBe(2); // pixel-studio comes first; webmasters has no Cyrillic alias, so only one brand is ahead
    expect(a.brands).toEqual(['pixel-studio.example']);
    expect(a.share).toBeCloseTo(0.5, 3);
  });

  it('is "missing" when we are neither cited nor named, and still lists who is named', () => {
    const a = analyseAnswer(answer('Препоръчвам Пиксел Студио.', [cite('https://healthline.com/x')]), matcher);
    expect(a).toMatchObject({ status: 'missing', position: null, share: 0, brands: ['pixel-studio.example'] });
  });

  it('falls back to the consulted sources when the engine cited nothing', () => {
    const a = analyseAnswer(answer('Текст.', [], { consulted: [cite('https://my-studio.example/x')] }), matcher);
    expect(a.status).toBe('cited');
  });

  it('keeps at most twelve citations and shortens long urls and titles', () => {
    const many = Array.from({ length: 20 }, (_, i) => cite(`https://site${i}.example/${'p'.repeat(500)}`, 'т'.repeat(500)));
    const a = analyseAnswer(answer('Текст.', many), matcher);
    expect(a.citations).toHaveLength(12);
    expect(a.citations[0]!.url.length).toBeLessThanOrEqual(300);
    expect(a.citations[0]!.title.length).toBeLessThanOrEqual(160);
  });
});

describe('wilson', () => {
  it('is honest about small samples', () => {
    expect(wilson(0, 0)).toEqual({ rate: 0, low: 0, high: 0 });
    const w = wilson(7, 24);
    expect(w.rate).toBeCloseTo(0.292, 3);
    expect(w.low).toBeCloseTo(0.149, 2);
    expect(w.high).toBeCloseTo(0.492, 2);
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBe(1);
    const big = wilson(290, 1000);
    expect(big.high - big.low).toBeLessThan(wilson(7, 24).high - wilson(7, 24).low);
  });
});

function fakeEngine(id: AnswerEngine['id'], ask: AnswerEngine['ask']): AnswerEngine {
  return { id, label: id, model: 'm', ask, generate: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 } }) };
}
const questions = Array.from({ length: 10 }, (_, i) => ({ id: `q${i + 1}`, text: `Въпрос ${i + 1}?` }));

describe('runEngines', () => {
  it('asks every question of every engine, a few at a time, and reports progress', async () => {
    let live = 0;
    let peak = 0;
    const slow = async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return answer('ok');
    };
    const progress: number[] = [];
    const out = await runEngines({ engines: [fakeEngine('openai', slow), fakeEngine('gemini', slow)], questions, market: 'bg', maxCalls: 100, concurrency: 3, onAnswer: (done) => progress.push(done) });
    expect(out.answers).toHaveLength(20);
    expect(out.skipped).toBe(0);
    expect(peak).toBeLessThanOrEqual(6); // three per engine
    expect(progress.at(-1)).toBe(20);
    expect(new Set(out.answers.map((a) => a.engine))).toEqual(new Set(['openai', 'gemini']));
  });

  it('never sends more than the call budget and says how many questions it left out', async () => {
    let calls = 0;
    const out = await runEngines({ engines: [fakeEngine('openai', async () => (calls++, answer('ok'))), fakeEngine('anthropic', async () => (calls++, answer('ok')))], questions, market: 'bg', maxCalls: 7 });
    expect(calls).toBe(6); // three questions each
    expect(out.skipped).toBe(14);
  });

  it('sends the market\'s location and the question exactly as written', async () => {
    const seen: Array<[string, string]> = [];
    await runEngines({ engines: [fakeEngine('openai', async (q, o) => (seen.push([q, o.location.country]), answer('ok')))], questions: [{ id: 'q1', text: 'Колко струва сайт?' }], market: 'gb', maxCalls: 5 });
    expect(seen).toEqual([['Колко струва сайт?', 'GB']]);
  });

  it('stops an engine whose key is rejected at once, and keeps the others going', async () => {
    const dead = fakeEngine('openai', async () => { throw new EngineError('auth', 'Ключът е отхвърлен'); });
    const fine = fakeEngine('anthropic', async () => answer('ok'));
    const out = await runEngines({ engines: [dead, fine], questions, market: 'bg', maxCalls: 100, concurrency: 1 });
    expect(out.stopped.get('openai')).toMatch(/отхвърлен/);
    expect(out.answers.filter((a) => a.engine === 'anthropic' && a.answer)).toHaveLength(10);
    expect(out.answers.filter((a) => a.engine === 'openai')).toHaveLength(1); // the first call found out; the rest were not sent
  });

  it('stops an engine after a run of ordinary failures, and a success resets the count', async () => {
    let n = 0;
    const flaky = fakeEngine('gemini', async () => { n++; throw new EngineError('unavailable', 'Недостъпен'); });
    const out = await runEngines({ engines: [flaky], questions: [...questions, ...questions], market: 'bg', maxCalls: 100, concurrency: 1 });
    expect(n).toBe(6);
    expect(out.stopped.get('gemini')).toMatch(/6 пъти поред/);
    let k = 0;
    const alternating = fakeEngine('gemini', async () => { if (k++ % 2 === 0) throw new EngineError('unavailable', 'x'); return answer('ok'); });
    const ok = await runEngines({ engines: [alternating], questions, market: 'bg', maxCalls: 100, concurrency: 1 });
    expect(ok.stopped.size).toBe(0);
  });

  it('rethrows when the run is aborted, and records unknown errors as failed answers', async () => {
    const controller = new AbortController();
    const engine = fakeEngine('openai', async () => { controller.abort(); throw new EngineError('aborted', 'x'); });
    await expect(runEngines({ engines: [engine], questions, market: 'bg', maxCalls: 100, signal: controller.signal, concurrency: 1 })).rejects.toThrow();
    const weird = await runEngines({ engines: [fakeEngine('openai', async () => { throw new TypeError('странно'); })], questions: [questions[0]!], market: 'bg', maxCalls: 5 });
    expect(weird.answers[0]).toMatchObject({ answer: null, error: 'странно' });
  });
});

describe('records and engine summaries', () => {
  const raw = (engine: RawAnswer['engine'], questionId: string, a: EngineAnswer | null): RawAnswer => ({ engine, questionId, answer: a, error: a ? null : 'грешка', latencyMs: 900 });
  const engine = fakeEngine('openai', async () => answer('x'));
  const mk = (rawAnswer: RawAnswer, sentiment: number | null = null) => toRecord(rawAnswer, rawAnswer.answer ? analyseAnswer(rawAnswer.answer, matcher) : null, sentiment);

  it('turns an answer into a record and a failure into a failed one', () => {
    const r = mk(raw('openai', 'q1', answer('Препоръчвам Моето студио. '.repeat(100), [cite('https://my-studio.example/')])), 0.8);
    expect(r).toMatchObject({ status: 'cited', position: 1, sentiment: 0.8, latencyMs: 900, error: null });
    expect(r.excerpt.length).toBeLessThanOrEqual(500);
    expect(mk(raw('openai', 'q2', null))).toMatchObject({ status: 'failed', citations: [], error: 'грешка', sentiment: null });
    expect(mk(raw('openai', 'q3', answer('Само конкурент.', [cite('https://healthline.com/x')])), 0.9).sentiment).toBeNull(); // nothing to be warm about when we are missing
  });

  it('summarises an engine: rate with its interval, who is cited instead of us, usage and cost', () => {
    const raws = [
      raw('openai', 'q1', answer('a', [cite('https://my-studio.example/')])),
      raw('openai', 'q2', answer('b', [cite('https://healthline.com/x'), cite('https://pixel-studio.example/y')])),
      raw('openai', 'q3', answer('c', [cite('https://healthline.com/z')])),
      raw('openai', 'q4', answer('d Моето студио', [])),
      raw('openai', 'q5', null),
      raw('anthropic', 'q1', answer('other engine', [cite('https://zzz.example/')])),
    ];
    const records = raws.map((r) => mk(r));
    const s = summarizeEngine(engine, records, raws, 'my-studio.example');
    expect(s).toMatchObject({ engine: 'openai', asked: 5, answered: 4, failed: 1, citingUs: 2, skippingUs: 2 });
    expect(s.rate).toBe(0.5);
    expect(s.rateLow).toBeLessThan(0.5);
    expect(s.rateHigh).toBeGreaterThan(0.5);
    expect(s.citedInstead).toEqual({ domain: 'healthline.com', answers: 2 });
    expect(s.topCited[0]).toMatchObject({ domain: 'healthline.com', answers: 2 });
    expect(s.topCited.map((t) => t.domain)).toContain('my-studio.example'); // our own share is visible next to the others'
    expect(s.usage).toMatchObject({ calls: 5, inputTokens: 4000, outputTokens: 1200, searches: 8 });
    expect(s.search).toBe(true);
    expect(s.usage.estimatedCostUsd).toBeNull(); // model "m" has no price
    const priced = summarizeEngine({ ...engine, model: 'gpt-6.1-sol' }, records, raws, 'my-studio.example');
    expect(priced.usage.estimatedCostUsd).toBeCloseTo(4000 * 2e-6 + 1200 * 10e-6 + 8 * 0.01, 4);
  });

  it('counts "cited instead of us" only in the answers where we are missing', () => {
    const raws = [
      raw('openai', 'q1', answer('a', [cite('https://my-studio.example/'), cite('https://pixel-studio.example/a')])),
      raw('openai', 'q2', answer('b', [cite('https://my-studio.example/'), cite('https://pixel-studio.example/b')])),
      raw('openai', 'q3', answer('c', [cite('https://pixel-studio.example/c')])),
      raw('openai', 'q4', answer('d', [cite('https://healthline.com/x')])),
      raw('openai', 'q5', answer('e', [cite('https://healthline.com/y')])),
    ];
    const s = summarizeEngine(engine, raws.map((r) => mk(r)), raws, 'my-studio.example');
    expect(s.topCited[0]).toMatchObject({ domain: 'pixel-studio.example', answers: 3 }); // cited most often overall…
    expect(s.citedInstead).toEqual({ domain: 'healthline.com', answers: 2 }); // …but only once instead of us
  });

  it('copes with an engine that answered nothing', () => {
    const s = summarizeEngine(engine, [], [], 'my-studio.example');
    expect(s).toMatchObject({ asked: 0, answered: 0, rate: 0, citedInstead: null, topCited: [] });
  });
});

describe('readSentiment', () => {
  it('reads how warmly the answer speaks about us: recommended counts fully, neutral half', async () => {
    const warm = scriptedJev({ recommendation: choiceAnswer('recommended', { mentioned_neutral: 0.2, discouraged: 0, not_mentioned: 0 }) });
    expect(await readSentiment(warm.jev, 'Моето студио', 'Въпрос?', 'Препоръчвам Моето студио.')).toBeCloseTo(0.9, 1);
    const neutral = scriptedJev({ recommendation: choiceAnswer('mentioned_neutral', { recommended: 0.1, discouraged: 0.1, not_mentioned: 0 }) });
    const v = await readSentiment(neutral.jev, 'Моето студио', 'Въпрос?', 'Има и Моето студио.');
    expect(v).toBeGreaterThan(0.4);
    expect(v).toBeLessThan(0.7);
  });

  it('gives no reading when Jev does not see the brand in the answer, or cannot answer', async () => {
    const none = scriptedJev({ recommendation: choiceAnswer('not_mentioned', { recommended: 0.05 }) });
    expect(await readSentiment(none.jev, 'Моето студио', 'Въпрос?', 'Текст.')).toBeNull();
    const dead = scriptedJev({}, { failWhen: () => new Error('503') });
    expect(await readSentiment(dead.jev, 'Моето студио', 'Въпрос?', 'Текст.')).toBeNull();
  });
});
