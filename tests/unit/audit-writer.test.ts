import { describe, expect, it } from 'vitest';
import { extractJson, llmWriter, rulesWriter } from '../../src/server/audit/writer';
import type { AnswerEngine, GenerateRequest } from '../../src/server/geo/engines/types';

function engine(reply: string | (() => string), calls: GenerateRequest[] = []): AnswerEngine {
  return {
    id: 'anthropic',
    label: 'Claude',
    model: 'test-model',
    ask: async () => {
      throw new Error('not used');
    },
    generate: async (request) => {
      calls.push(request);
      return { text: typeof reply === 'function' ? reply() : reply, usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
}

describe('extractJson', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['Ето отговора:\n```json\n{"questions": ["а?", "б?"]}\n```\nУспех!', { questions: ['а?', 'б?'] }],
    ['[1, 2, 3] и още текст', [1, 2, 3]],
    ['{"text": "скоби } в низ и \\" кавичка", "n": {"x": 1}}', { text: 'скоби } в низ и " кавичка', n: { x: 1 } }],
  ])('reads %s', (text, expected) => {
    expect(extractJson(text)).toEqual(expected);
  });

  it.each(['няма json', '{"a": ', '{"a": 1', ''])('returns null for %j', (text) => {
    expect(extractJson(text)).toBeNull();
  });
});

describe('the rules writer', () => {
  it('writes nothing, so every caller falls back to its rules', async () => {
    expect(rulesWriter.id).toBe('rules');
    expect(await rulesWriter.questions({ business: 'x', market: 'bg', count: 5, avoid: [] })).toEqual([]);
    expect(await rulesWriter.proposals({ url: 'u', business: 'x', market: 'bg', brand: 'b', phrase: null, current: { title: '', meta: '', h1: '', intro: '' }, wanted: [] })).toEqual({});
    expect(await rulesWriter.checklist({ kind: 'create', business: 'x', market: 'bg', title: 't', url: null, questions: [], findings: [], winners: [], baseline: [] })).toBeNull();
    expect(rulesWriter.calls()).toBe(0);
  });
});

describe('llmWriter', () => {
  it('asks for buyer questions in the market language, avoids the ones it already has, and keeps only usable lines', async () => {
    const calls: GenerateRequest[] = [];
    const writer = llmWriter(engine('{"questions": ["Колко струва изработката на сайт за малка фирма?", "късо", "Кои са най-добрите студиа за уебсайтове в България?"]}', calls));
    const out = await writer.questions({ business: 'Студио за уебсайтове', market: 'bg', count: 10, avoid: ['Колко струва сайт?'] });
    expect(out).toEqual(['Колко струва изработката на сайт за малка фирма?', 'Кои са най-добрите студиа за уебсайтове в България?']);
    expect(calls[0]?.json).toBe(true);
    expect(calls[0]?.prompt).toMatch(/Bulgarian/);
    expect(calls[0]?.prompt).toContain('Колко струва сайт?');
    expect(writer.calls()).toBe(1);
    expect(writer.id).toBe('anthropic');
    expect(writer.model).toBe('test-model');
  });

  it('returns nothing for an unusable reply instead of throwing', async () => {
    const writer = llmWriter(engine('Съжалявам, не мога.'));
    expect(await writer.questions({ business: 'x', market: 'bg', count: 5, avoid: [] })).toEqual([]);
    expect(await writer.proposals({ url: 'u', business: 'x', market: 'bg', brand: 'b', phrase: null, current: { title: '', meta: '', h1: '', intro: '' }, wanted: [{ element: 'title', reason: 'r' }] })).toEqual({});
    expect(await writer.checklist({ kind: 'rewrite', business: 'x', market: 'bg', title: 't', url: 'u', questions: [], findings: [], winners: [], baseline: [] })).toBeNull();
  });

  it('returns only the rewritten elements that were asked for', async () => {
    const calls: GenerateRequest[] = [];
    const writer = llmWriter(engine('{"title": "Цени за сайт | Моето студио", "meta": "Описание, което не е поискано, но е налично в отговора.", "h1": "ок"}', calls));
    const out = await writer.proposals({ url: 'u', business: 'x', market: 'bg', brand: 'Моето студио', phrase: 'цени', current: { title: 'Т', meta: '', h1: '', intro: '' }, wanted: [{ element: 'title', reason: 'къс' }, { element: 'h1', reason: 'липсва' }] });
    expect(out).toEqual({ title: 'Цени за сайт | Моето студио' }); // h1 "ок" is too short to use; meta was not requested
    expect(calls[0]?.prompt).toContain('placeholder in square brackets');
  });

  it('needs at least three usable checklist steps', async () => {
    const few = llmWriter(engine('{"steps": [{"text": "Само една стъпка тук", "why": "а"}]}'));
    expect(await few.checklist({ kind: 'create', business: 'x', market: 'bg', title: 't', url: null, questions: [], findings: [], winners: [], baseline: [] })).toBeNull();
    const many = llmWriter(engine('{"steps": [{"text": "Стъпка номер едно", "why": "а"}, {"text": "Стъпка номер две", "why": "б"}, {"text": "Стъпка номер три", "why": "в"}]}'));
    expect(await many.checklist({ kind: 'create', business: 'x', market: 'bg', title: 't', url: null, questions: [], findings: [], winners: [], baseline: [] })).toHaveLength(3);
  });
});
