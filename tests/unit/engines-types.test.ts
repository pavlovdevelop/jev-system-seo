import { describe, expect, it } from 'vitest';
import { MARKET_IDS } from '../../src/shared/markets';
import { createEngines } from '../../src/server/geo/engines';
import {
  AnswerCollector,
  asCount,
  capText,
  EngineError,
  locationFor,
  MAX_ANSWER_CHARS,
  type EngineErrorKind,
  type EngineUsage,
} from '../../src/server/geo/engines/types';

const meta = (over: Partial<{ searched: boolean; latencyMs: number; usage: EngineUsage; model: string }> = {}) => ({
  searched: true,
  latencyMs: 5,
  usage: { inputTokens: 1, outputTokens: 2, searches: 3 },
  model: 'm',
  ...over,
});

describe('EngineError', () => {
  it('is an Error named EngineError that carries kind, status and cause', () => {
    const cause = new Error('inner');
    const err = new EngineError('quota', 'няма квота', 429, { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'EngineError', kind: 'quota', message: 'няма квота', status: 429 });
    expect(err.cause).toBe(cause);
    expect(new EngineError('unavailable', 'x').status).toBeUndefined();
  });

  it.each([
    ['auth', true],
    ['model', true],
    ['aborted', true],
    ['rate_limit', false],
    ['quota', false],
    ['refused', false],
    ['unavailable', false],
    ['bad_response', false],
  ] as Array<[EngineErrorKind, boolean]>)('%s is fatal: %s', (kind, fatal) => {
    expect(new EngineError(kind, 'x').fatal).toBe(fatal);
  });
});

describe('locationFor', () => {
  it('puts every market in a country and a time zone', () => {
    expect(locationFor('bg')).toEqual({ country: 'BG', timezone: 'Europe/Sofia' });
    expect(locationFor('bg-en')).toEqual({ country: 'BG', timezone: 'Europe/Sofia' });
    expect(locationFor('gb')).toEqual({ country: 'GB', timezone: 'Europe/London' });
    expect(locationFor('us')).toEqual({ country: 'US', timezone: 'America/New_York' });
    for (const id of MARKET_IDS) {
      const { country, timezone } = locationFor(id);
      expect(country).toMatch(/^[A-Z]{2}$/);
      expect(() => new Intl.DateTimeFormat('en', { timeZone: timezone })).not.toThrow(); // a real IANA name
    }
  });

  it('hands out a fresh object each time', () => {
    const a = locationFor('bg');
    a.country = 'XX';
    expect(locationFor('bg').country).toBe('BG');
  });
});

describe('createEngines', () => {
  const key = (name: string) => ({ apiKey: `${name}-key-123456`, model: `${name}-model` });

  it('returns the configured engines in the fixed order openai, anthropic, gemini', () => {
    const engines = createEngines({ gemini: key('g'), openai: key('o'), anthropic: key('a') });
    expect(engines.map((e) => e.id)).toEqual(['openai', 'anthropic', 'gemini']);
    expect(engines.map((e) => e.label)).toEqual(['ChatGPT', 'Claude', 'Gemini']);
    expect(engines.map((e) => e.model)).toEqual(['o-model', 'a-model', 'g-model']);
  });

  it('leaves out an engine without a key (missing or blank)', () => {
    expect(createEngines({ openai: null, anthropic: null, gemini: null })).toEqual([]);
    expect(createEngines({ openai: null, anthropic: key('a'), gemini: null }).map((e) => e.id)).toEqual(['anthropic']);
    expect(createEngines({ openai: key('o'), anthropic: null, gemini: { apiKey: '  ', model: 'g' } }).map((e) => e.id)).toEqual(['openai']);
  });

  it('hands its options to every engine', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      seen.push(url);
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    };
    const engines = createEngines({ openai: key('o'), anthropic: key('a'), gemini: key('g') }, { fetchImpl, retries: 0 });
    for (const engine of engines) {
      await expect(engine.generate({ prompt: 'x' })).rejects.toMatchObject({ kind: 'auth' });
    }
    expect(seen).toEqual(['https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages', 'https://generativelanguage.googleapis.com/v1beta/interactions']);
  });
});

describe('capText and asCount', () => {
  it('cuts to the limit without splitting a surrogate pair', () => {
    expect(capText('abc', 5)).toBe('abc');
    expect(capText('abcdef', 3)).toBe('abc');
    const cut = capText(`ab${'😀'}cd`, 3); // the emoji is two UTF-16 units: a cut at 3 would leave half of it
    expect(cut).toBe('ab');
    expect([...cut].every((c) => c.codePointAt(0)! < 0xd800 || c.codePointAt(0)! > 0xdfff)).toBe(true);
  });

  it('counts only finite positive numbers', () => {
    expect(asCount(12)).toBe(12);
    expect(asCount(12.4)).toBe(12);
    for (const v of [0, -3, NaN, Infinity, '12', null, undefined, {}, []]) expect(asCount(v)).toBe(0);
  });
});

describe('AnswerCollector', () => {
  it('de-duplicates sources by domain and url, in order of appearance', () => {
    const c = new AnswerCollector();
    c.cite('https://www.a.example/x', 'A');
    c.cite('https://b.example/y', 'B');
    c.cite('https://www.a.example/x', 'A again');
    c.cite('https://a.example/other', 'A2');
    const { citations } = c.build(meta());
    expect(citations.map((x) => [x.url, x.title, x.domain])).toEqual([
      ['https://www.a.example/x', 'A', 'a.example'],
      ['https://b.example/y', 'B', 'b.example'],
      ['https://a.example/other', 'A2', 'a.example'],
    ]);
  });

  it('keeps two redirect links that name the same domain apart, but not the same link twice', () => {
    const c = new AnswerCollector();
    c.cite('https://redirect.example/r/1', 'x.example', 'x.example');
    c.cite('https://redirect.example/r/2', 'x.example', 'x.example');
    c.cite('https://redirect.example/r/1', 'x.example', 'x.example');
    expect(c.build(meta()).citations.map((x) => x.url)).toEqual(['https://redirect.example/r/1', 'https://redirect.example/r/2']);
  });

  it('drops what is not a usable http(s) url and cleans titles', () => {
    const c = new AnswerCollector();
    for (const bad of ['javascript:alert(1)', 'ftp://a.example/x', '', 'not a url', 42, null, undefined, `https://a.example/${'x'.repeat(2100)}`]) c.cite(bad, 't');
    c.cite('https://ok.example/', ' Titel​  with\n gaps ');
    const { citations } = c.build(meta());
    expect(citations).toEqual([{ url: 'https://ok.example/', title: 'Titel with gaps', domain: 'ok.example' }]);
  });

  it('gives a missing title as an empty string', () => {
    const c = new AnswerCollector();
    c.cite('https://a.example/', undefined);
    c.cite('https://b.example/', 42);
    expect(c.build(meta()).citations.map((x) => x.title)).toEqual(['', '']);
  });

  it('caps citations, consulted sources and queries', () => {
    const c = new AnswerCollector();
    for (let i = 0; i < 50; i++) {
      c.cite(`https://c${i}.example/`, `c${i}`);
      c.consult(`https://s${i}.example/`, `s${i}`);
      c.query(`query ${i}`);
    }
    const a = c.build(meta());
    expect(a.citations).toHaveLength(30);
    expect(a.citations[0]?.domain).toBe('c0.example');
    expect(a.consulted).toHaveLength(30);
    expect(a.queries).toHaveLength(10);
    expect(a.queries[0]).toBe('query 0');
  });

  it('reports as consulted only what was not cited, and still fills the 30 from the rest', () => {
    const c = new AnswerCollector();
    for (let i = 0; i < 5; i++) c.cite(`https://s${i}.example/`, 'x');
    for (let i = 0; i < 40; i++) c.consult(`https://s${i}.example/`, 'x');
    const { consulted } = c.build(meta());
    expect(consulted).toHaveLength(30);
    expect(consulted.map((x) => x.domain)).not.toContain('s0.example');
    expect(consulted[0]?.domain).toBe('s5.example');
  });

  it('keeps queries unique and trimmed, and ignores what is not text', () => {
    const c = new AnswerCollector();
    for (const q of [' a  b ', 'a b', '', '   ', 5, null, undefined, 'c']) c.query(q);
    expect(c.build(meta()).queries).toEqual(['a b', 'c']);
  });

  it('caps the text at 12,000 characters', () => {
    const c = new AnswerCollector();
    c.appendText('x'.repeat(15_000));
    const a = c.build(meta());
    expect(a.text).toHaveLength(MAX_ANSWER_CHARS);
    expect(c.fullText()).toHaveLength(15_000); // plain generation is not capped at 12,000
  });

  it('trims the text and drops invisible characters', () => {
    const c = new AnswerCollector();
    c.appendText('  Hel​lo⁠ wor­ld \n');
    expect(c.build(meta()).text).toBe('Hello world');
  });

  it('separates text that follows a tool block only when the pieces would run together', () => {
    const c = new AnswerCollector();
    c.appendText('I will search.');
    c.appendText('Based on the results', true);
    c.appendText(' it is fine.');
    c.appendText(' Also', true);
    c.appendText('\nNext', true);
    expect(c.fullText()).toBe('I will search.\n\nBased on the results it is fine. Also\nNext');
    const first = new AnswerCollector();
    first.appendText('Start', true); // nothing before it: no leading break
    expect(first.fullText()).toBe('Start');
  });

  it('ignores pieces that are not text', () => {
    const c = new AnswerCollector();
    c.appendText(undefined);
    c.appendText(7);
    c.appendText('');
    expect(c.hasText).toBe(false);
    c.appendText('  ');
    expect(c.hasText).toBe(false); // whitespace alone is no answer
    c.appendText('x');
    expect(c.hasText).toBe(true);
  });

  it('does not grow without bound on a runaway reply', () => {
    const c = new AnswerCollector();
    for (let i = 0; i < 100; i++) c.appendText('y'.repeat(10_000));
    expect(c.fullText().length).toBeLessThan(100_000);
  });

  it('passes the metadata through untouched', () => {
    const c = new AnswerCollector();
    c.appendText('t');
    expect(c.build(meta({ searched: false, latencyMs: 9, model: 'zzz', usage: { inputTokens: 7, outputTokens: 8, searches: 0 } }))).toMatchObject({
      text: 't',
      searched: false,
      latencyMs: 9,
      model: 'zzz',
      usage: { inputTokens: 7, outputTokens: 8, searches: 0 },
      citations: [],
      consulted: [],
      queries: [],
    });
  });
});
