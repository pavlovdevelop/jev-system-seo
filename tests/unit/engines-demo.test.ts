import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoEngines, type DemoCompetitor, type DemoEngineInput } from '../../src/server/geo/engines/demo';
import type { AnswerEngine, AskOptions, EngineAnswer } from '../../src/server/geo/engines/types';

const OWN = 'my-studio.example';
const LOCATION: AskOptions['location'] = { country: 'BG', timezone: 'Europe/Sofia' };

const KINDS = ['authority', 'compare', 'brand', 'community', 'media', 'guide', 'other'] as const;
const SITES: Array<[string, DemoCompetitor['kind']]> = [
  ['pixel-studio.example', 'guide'],
  ['webmasters-bg.example', 'brand'],
  ['seo-pro.example', 'compare'],
  ['nova-agenciya.example', 'brand'],
  ['magazin-expert.example', 'authority'],
  ['top-agencii.example', 'compare'],
  ['firmi-bg.example', 'authority'],
  ['portal-za-biznes.example', 'media'],
  ['forum-programisti.example', 'community'],
  ['digital-blog.example', 'guide'],
  ['build-your-site.example', 'other'],
  ['news-today.example', 'media'],
  ['brand-one.example', 'brand'],
  ['brand-two.example', 'brand'],
];
const COMPETITORS: DemoCompetitor[] = SITES.map(([domain, kind], i) => ({ domain, url: `https://${domain}/page-${i}`, title: `Страница ${i} | ${domain}`, kind }));
const INPUT: DemoEngineInput = { ownDomain: OWN, brandNames: ['Моето студио', 'My Studio'], competitors: COMPETITORS };

const questions = (n: number, make: (i: number) => string = (i) => `Колко струва изработка на уебсайт за малък бизнес ${i}?`) => Array.from({ length: n }, (_v, i) => make(i));
const ask = (e: AnswerEngine, q: string): Promise<EngineAnswer> => e.ask(q, { location: LOCATION });
const asked = async (e: AnswerEngine, qs: string[]): Promise<EngineAnswer[]> => {
  const out: EngineAnswer[] = [];
  for (const q of qs) out.push(await ask(e, q));
  return out;
};
const brandOf = (domain: string): string =>
  (domain.split('.')[0] ?? '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
const ownCited = (a: EngineAnswer): boolean => a.citations.some((c) => c.domain === OWN);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createDemoEngines: identity', () => {
  it('returns three engines, in the order ChatGPT, Claude, Gemini, with the model "демо"', () => {
    const engines = createDemoEngines(INPUT);
    expect(engines.map((e) => e.id)).toEqual(['openai', 'anthropic', 'gemini']);
    expect(engines.map((e) => e.label)).toEqual(['ChatGPT', 'Claude', 'Gemini']);
    expect(engines.map((e) => e.model)).toEqual(['демо', 'демо', 'демо']);
  });
});

describe('createDemoEngines: determinism', () => {
  it('gives the same answer to the same question, across calls, instances and call order', async () => {
    const a = createDemoEngines(INPUT);
    const b = createDemoEngines(INPUT);
    const qs = questions(12);
    for (let i = 0; i < 3; i++) {
      const first = await asked(a[i]!, qs);
      const again = await asked(a[i]!, qs);
      const other = await asked(b[i]!, qs);
      const backwards = (await asked(b[i]!, [...qs].reverse())).reverse();
      expect(again).toEqual(first);
      expect(other).toEqual(first);
      expect(backwards).toEqual(first); // nothing depends on what was asked before
    }
  });

  it('answers differently for a different seed, a different question or a different engine', async () => {
    const q = 'Кои са най-добрите фирми за уебсайт?';
    const [openai, anthropic, gemini] = createDemoEngines(INPUT);
    const reseeded = createDemoEngines({ ...INPUT, seed: 'another-run' })[0]!;
    const sources = (a: EngineAnswer) => a.citations.map((c) => c.domain).join(',');
    const seeds = await Promise.all(questions(10).map(async (x) => [sources(await ask(openai!, x)), sources(await ask(reseeded, x))] as const));
    expect(seeds.filter(([a, b]) => a !== b).length).toBeGreaterThanOrEqual(5);
    const engines = await Promise.all(questions(10).map(async (x) => new Set([sources(await ask(openai!, x)), sources(await ask(anthropic!, x)), sources(await ask(gemini!, x))]).size));
    expect(engines.filter((n) => n >= 2).length).toBeGreaterThanOrEqual(8);
    expect(sources(await ask(openai!, q))).not.toBe(sources(await ask(openai!, `${q} `)));
  });

  it('uses "demo" as the seed when none is given', async () => {
    const implicit = createDemoEngines(INPUT)[0]!;
    const explicit = createDemoEngines({ ...INPUT, seed: 'demo' })[0]!;
    const qs = questions(5);
    expect(await asked(implicit, qs)).toEqual(await asked(explicit, qs));
  });
});

describe('createDemoEngines: the sources', () => {
  it('cites 3 to 5 sources, drawn only from the competitors and the own domain, never the same page twice', async () => {
    const urls = new Set([...COMPETITORS.map((c) => c.url), `https://${OWN}/`]);
    const domains = new Set([...COMPETITORS.map((c) => c.domain), OWN]);
    const counts = new Set<number>();
    for (const engine of createDemoEngines(INPUT)) {
      for (const a of await asked(engine, questions(60))) {
        counts.add(a.citations.length);
        expect(a.citations.length).toBeGreaterThanOrEqual(3);
        expect(a.citations.length).toBeLessThanOrEqual(5);
        // the sources drawn from the competitors number 3-5 as well (the own site comes on top of 3-4 of them)
        const drawn = a.citations.filter((c) => c.domain !== OWN).length;
        expect(drawn).toBeGreaterThanOrEqual(3);
        expect(drawn).toBeLessThanOrEqual(5);
        for (const c of a.citations) {
          expect(urls.has(c.url)).toBe(true);
          expect(domains.has(c.domain)).toBe(true);
          expect(c.domain).toBe(c.domain.toLowerCase());
          expect(c.title).not.toBe('');
        }
        expect(new Set(a.citations.map((c) => c.url)).size).toBe(a.citations.length);
        expect(new Set(a.citations.map((c) => c.domain)).size).toBe(a.citations.length); // plenty of domains: no repeats
      }
    }
    expect([...counts].sort()).toEqual([3, 4, 5]); // all three sizes occur
  });

  it('keeps the competitors\' own titles and domains on their citations', async () => {
    const [openai] = createDemoEngines(INPUT);
    for (const a of await asked(openai!, questions(20))) {
      for (const c of a.citations.filter((x) => x.domain !== OWN)) {
        const source = COMPETITORS.find((s) => s.url === c.url)!;
        expect(c).toEqual({ url: source.url, title: source.title, domain: source.domain });
      }
    }
  });

  it('cites the business\'s own site in roughly 22-34% of the answers, with a different set of questions for each engine', async () => {
    const qs = questions(200);
    const engines = createDemoEngines(INPUT);
    const hits = await Promise.all(engines.map(async (e) => (await asked(e, qs)).map(ownCited)));
    const shares = hits.map((h) => h.filter(Boolean).length / h.length);
    for (const share of shares) {
      expect(share).toBeGreaterThanOrEqual(0.15);
      expect(share).toBeLessThanOrEqual(0.42);
    }
    const pooled = shares.reduce((a, b) => a + b, 0) / shares.length;
    expect(pooled).toBeGreaterThanOrEqual(0.22);
    expect(pooled).toBeLessThanOrEqual(0.34);
    // not the same questions for every engine
    for (const [x, y] of [[0, 1], [0, 2], [1, 2]] as const) {
      const differing = qs.filter((_q, i) => hits[x]![i] !== hits[y]![i]).length;
      expect(differing).toBeGreaterThan(40);
    }
  });

  it('shows a believable mix in a run of 24 questions: some answers cite the business, most do not', async () => {
    const qs = questions(24, (i) => `Кои са най-добрите фирми за услуга номер ${i}?`);
    for (const engine of createDemoEngines(INPUT)) {
      const cited = (await asked(engine, qs)).filter(ownCited).length;
      expect(cited).toBeGreaterThanOrEqual(2);
      expect(cited).toBeLessThanOrEqual(14);
    }
  });

  it('puts the own site at varying places among the sources, never twice', async () => {
    const positions = new Set<number>();
    for (const engine of createDemoEngines(INPUT)) {
      for (const a of await asked(engine, questions(80))) {
        const at = a.citations.findIndex((c) => c.domain === OWN);
        if (at >= 0) {
          positions.add(at);
          expect(a.citations.filter((c) => c.domain === OWN)).toHaveLength(1);
        }
      }
    }
    expect(positions.size).toBeGreaterThanOrEqual(3);
  });

  it('gives the own citation the first brand name as its title', async () => {
    const engine = createDemoEngines(INPUT)[1]!;
    const own = (await asked(engine, questions(60))).flatMap((a) => a.citations).filter((c) => c.domain === OWN);
    expect(own.length).toBeGreaterThan(0);
    for (const c of own) expect(c).toEqual({ url: `https://${OWN}/`, title: 'Моето студио', domain: OWN });
  });

  it('leans each engine toward its kind of source: ChatGPT authority/guide, Claude compare/guide, Gemini brand/media', async () => {
    const qs = questions(150);
    const kindShare = async (engine: AnswerEngine, preferred: readonly string[]) => {
      let favoured = 0;
      let total = 0;
      for (const a of await asked(engine, qs)) {
        for (const c of a.citations.filter((x) => x.domain !== OWN)) {
          total++;
          if (preferred.includes(COMPETITORS.find((s) => s.url === c.url)!.kind)) favoured++;
        }
      }
      return favoured / total;
    };
    const [openai, anthropic, gemini] = createDemoEngines(INPUT) as [AnswerEngine, AnswerEngine, AnswerEngine];
    const base = (preferred: readonly string[]) => COMPETITORS.filter((c) => preferred.includes(c.kind)).length / COMPETITORS.length; // what chance alone would give
    for (const [engine, preferred] of [
      [openai, ['authority', 'guide']],
      [anthropic, ['compare', 'guide']],
      [gemini, ['brand', 'media']],
    ] as const) {
      expect(await kindShare(engine, preferred)).toBeGreaterThan(base(preferred) + 0.15);
    }
  });

  it('reports retrieved-but-uncited sources too, from the same pool and never overlapping the citations', async () => {
    let sawConsulted = false;
    let sawOwnNearMiss = false;
    for (const engine of createDemoEngines(INPUT)) {
      for (const a of await asked(engine, questions(80))) {
        const cited = new Set(a.citations.map((c) => c.url));
        for (const c of a.consulted) {
          expect(cited.has(c.url)).toBe(false);
          expect(c.domain === OWN || COMPETITORS.some((s) => s.url === c.url)).toBe(true);
        }
        expect(a.consulted.length).toBeLessThanOrEqual(30);
        if (a.consulted.length > 0) sawConsulted = true;
        if (a.consulted.some((c) => c.domain === OWN)) {
          sawOwnNearMiss = true;
          expect(ownCited(a)).toBe(false);
        }
      }
    }
    expect(sawConsulted).toBe(true);
    expect(sawOwnNearMiss).toBe(true);
  });
});

describe('createDemoEngines: the text', () => {
  it('is Bulgarian prose that names 2-3 brands of the competitors it cites', async () => {
    for (const engine of createDemoEngines(INPUT)) {
      for (const a of await asked(engine, questions(40))) {
        expect(a.text).toMatch(/[а-яА-Я]{4,}/);
        expect(a.text.length).toBeGreaterThan(80);
        expect(a.text.length).toBeLessThanOrEqual(12_000);
        const citedBrands = a.citations.filter((c) => c.domain !== OWN).map((c) => brandOf(c.domain));
        const named = citedBrands.filter((b) => a.text.includes(b));
        expect(named.length).toBeGreaterThanOrEqual(2);
        expect(named.length).toBeLessThanOrEqual(3);
        // and no brand of a competitor it did not cite
        const uncited = COMPETITORS.map((c) => c.domain).filter((d) => !a.citations.some((c) => c.domain === d));
        for (const d of uncited) expect(a.text).not.toContain(brandOf(d));
      }
    }
  });

  it('names a competitor by its title when that is a brand, else by the name its domain suggests', async () => {
    const pool: DemoCompetitor[] = [
      { domain: 'pixel-studio.example', url: 'https://pixel-studio.example/a', title: 'Пиксел Студио', kind: 'brand' },
      { domain: 'seo-pro.example', url: 'https://seo-pro.example/b', title: 'Изработка на уебсайт – цени и срокове | СЕО Про', kind: 'brand' },
      { domain: 'firmi-bg.example', url: 'https://firmi-bg.example/c', title: 'Фирми.бг', kind: 'brand' },
      { domain: 'top-agencii.example', url: 'https://top-agencii.example/d', title: 'Кои са най-добрите агенции за уебсайт през 2026 година в България?', kind: 'compare' },
      { domain: 'news-today.example', url: 'https://news-today.example/e', title: 'Новини | news-today.example', kind: 'media' },
      { domain: 'brand-one.example', url: 'https://brand-one.example/f', title: '', kind: 'brand' },
      { domain: 'build-your-site.example', url: 'https://build-your-site.example/g', title: 'Build Your Site', kind: 'other' },
    ];
    const expected: Record<string, string> = {
      'pixel-studio.example': 'Пиксел Студио',
      'seo-pro.example': 'СЕО Про', // the last part of a long page title
      'firmi-bg.example': 'Фирми.бг',
      'top-agencii.example': 'Top Agencii', // a sentence is not a brand
      'news-today.example': 'News Today', // the title only repeats the domain
      'brand-one.example': 'Brand One', // no title at all
      'build-your-site.example': 'Build Your Site',
    };
    const named = new Set<string>();
    for (const engine of createDemoEngines({ ...INPUT, competitors: pool })) {
      for (const a of await asked(engine, questions(60))) {
        const cited = a.citations.filter((x) => x.domain !== OWN).map((x) => x.domain);
        const inText = cited.filter((d) => a.text.includes(expected[d]!));
        expect(inText.length).toBeGreaterThanOrEqual(2);
        expect(inText.length).toBeLessThanOrEqual(3);
        for (const d of inText) named.add(d);
        // a brand is never named in its domain's form when its title gives the brand, and a page title is never named as a brand
        for (const d of ['pixel-studio.example', 'seo-pro.example', 'firmi-bg.example']) expect(a.text).not.toContain(d);
        for (const wrong of ['Pixel Studio', 'Seo Pro', 'Firmi Bg', 'Кои са най-добрите агенции', 'Изработка на уебсайт –', 'Новини']) expect(a.text).not.toContain(wrong);
      }
    }
    expect(named.size).toBe(pool.length); // every kind of title was exercised
  });

  it('names the first brand name when the own site is cited, and only then', async () => {
    let cited = 0;
    let notCited = 0;
    for (const engine of createDemoEngines(INPUT)) {
      for (const a of await asked(engine, questions(80))) {
        expect(a.text).not.toMatch(/null|undefined|\{list\}|\{own\}/); // no template left unfilled
        if (ownCited(a)) {
          cited++;
          expect(a.text).toContain('Моето студио');
          expect(a.text).not.toContain('My Studio'); // the first one only
          expect(a.text).toMatch(/сайта на Моето студио|предлага и Моето студио|разгледате и Моето студио/);
        } else {
          notCited++;
          expect(a.text).not.toContain('Моето студио');
          expect(a.text).not.toMatch(/сайта на|предлага и|разгледате и/); // no sentence about the business at all
        }
      }
    }
    expect(cited).toBeGreaterThan(20);
    expect(notCited).toBeGreaterThan(20);
  });

  it('falls back to a name read from the domain when no brand name is given', async () => {
    const engine = createDemoEngines({ ...INPUT, brandNames: [] })[1]!;
    const own = (await asked(engine, questions(80))).filter(ownCited);
    expect(own.length).toBeGreaterThan(0);
    for (const a of own) {
      expect(a.text).toContain('My Studio');
      expect(a.citations.find((c) => c.domain === OWN)?.title).toBe('My Studio');
    }
  });

  it('skips blank brand names', async () => {
    const engine = createDemoEngines({ ...INPUT, brandNames: ['  ', '', ' Студио Едно '] })[1]!;
    const own = (await asked(engine, questions(80))).filter(ownCited);
    expect(own.length).toBeGreaterThan(0);
    for (const a of own) expect(a.text).toContain('Студио Едно');
  });

  it('reads differently for each assistant and fits the kind of question', async () => {
    const [openai, anthropic, gemini] = createDemoEngines(INPUT) as [AnswerEngine, AnswerEngine, AnswerEngine];
    const q = 'Колко струва изработка на уебсайт?';
    const texts = [(await ask(openai, q)).text, (await ask(anthropic, q)).text, (await ask(gemini, q)).text];
    expect(new Set(texts).size).toBe(3);
    const price = (await asked(openai, ['Колко струва уебсайт 1?', 'Каква е цената на уебсайт 2?'])).map((a) => a.text).join(' ');
    expect(price).toMatch(/цен|оферт/i);
    const how = (await asked(openai, ['Как да избера фирма за сайт 1?', 'Как се прави уебсайт 2?'])).map((a) => a.text).join(' ');
    expect(how).toMatch(/ръководств|процес/i);
  });
});

describe('createDemoEngines: what is reported about the run', () => {
  it('reports a latency of 700-4200 ms (made up, not slept), plausible token counts and searched = true', async () => {
    const started = Date.now();
    const lat: number[] = [];
    for (const engine of createDemoEngines(INPUT)) {
      for (const a of await asked(engine, questions(100))) {
        lat.push(a.latencyMs);
        expect(a.searched).toBe(true);
        expect(a.model).toBe('демо');
        expect(a.usage.inputTokens).toBeGreaterThanOrEqual(500);
        expect(a.usage.inputTokens).toBeLessThanOrEqual(20_000);
        expect(a.usage.outputTokens).toBeGreaterThanOrEqual(100);
        expect(a.usage.outputTokens).toBeLessThanOrEqual(3_000);
        expect(a.usage.searches).toBe(a.queries.length);
      }
    }
    expect(Math.min(...lat)).toBeGreaterThanOrEqual(700);
    expect(Math.max(...lat)).toBeLessThanOrEqual(4200);
    expect(Math.max(...lat) - Math.min(...lat)).toBeGreaterThan(2000); // it varies
    expect(Number.isInteger(lat[0])).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000); // 300 answers of "2-4 seconds" took no time at all
  });

  it('derives 1 to 3 distinct search queries from the question', async () => {
    const lengths = new Set<number>();
    for (const engine of createDemoEngines(INPUT)) {
      for (const [i, q] of questions(60, (n) => `Кои са най-добрите фирми за изработка на уебсайт в София ${n}?`).entries()) {
        const a = await ask(engine, q);
        lengths.add(a.queries.length);
        expect(a.queries.length).toBeGreaterThanOrEqual(1);
        expect(a.queries.length).toBeLessThanOrEqual(3);
        expect(new Set(a.queries).size).toBe(a.queries.length);
        expect(a.queries[0]).toContain('изработка');
        expect(a.queries[0]).not.toContain('?');
        for (const query of a.queries) expect(query).toBe(query.trim());
        expect(i).toBeGreaterThanOrEqual(0);
      }
    }
    expect([...lengths].sort()).toEqual([1, 2, 3]);
  });

  it('writes English queries for an English question', async () => {
    const [openai] = createDemoEngines(INPUT);
    for (const a of await asked(openai!, questions(30, (i) => `What are the best web design agencies in London ${i}?`))) {
      for (const query of a.queries) expect(query).not.toMatch(/[а-яА-Я]/);
    }
  });

  it('copes with a question that has no usable words', async () => {
    const [openai] = createDemoEngines(INPUT);
    for (const q of ['', '   ', '?!', '123']) {
      const a = await ask(openai!, q);
      expect(a.queries.length).toBeGreaterThanOrEqual(1);
      expect(a.queries.every((x) => x.length > 0)).toBe(true);
    }
  });
});

describe('createDemoEngines: no network, no timers', () => {
  it('never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network is off'));
    for (const engine of createDemoEngines(INPUT)) {
      await asked(engine, questions(10));
      await engine.generate({ prompt: 'p' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('settles without any timer: ask() and generate() finish while every timer is frozen', async () => {
    vi.useFakeTimers();
    for (const engine of createDemoEngines(INPUT)) {
      const a = await ask(engine, 'Колко струва?');
      expect(a.citations.length).toBeGreaterThan(0);
      await engine.generate({ prompt: 'p' });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends with aborted (fatal) when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    for (const engine of createDemoEngines(INPUT)) {
      await expect(engine.ask('q?', { location: LOCATION, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', fatal: true });
      await expect(engine.generate({ prompt: 'p', signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
    }
  });
});

describe('createDemoEngines: generate', () => {
  it('returns a deterministic placeholder, marked as coming from the demo', async () => {
    for (const engine of createDemoEngines(INPUT)) {
      const a = await engine.generate({ prompt: 'Напиши заглавие за страница за уебсайтове.', system: 's' });
      const b = await engine.generate({ prompt: 'Напиши заглавие за страница за уебсайтове.', system: 's' });
      expect(a).toEqual(b);
      expect(typeof a.text).toBe('string');
      expect(a.text).toMatch(/демо/i);
      expect(a.text).toContain('Напиши заглавие');
      expect(a.usage.inputTokens).toBeGreaterThan(0);
      expect(a.usage.outputTokens).toBeGreaterThan(0);
    }
  });

  it('answers a JSON-only request with valid JSON, and shortens a long prompt in the placeholder', async () => {
    const engine = createDemoEngines(INPUT)[0]!;
    const json = await engine.generate({ prompt: 'x', json: true });
    expect(() => JSON.parse(json.text)).not.toThrow();
    const long = await engine.generate({ prompt: `${'много '.repeat(500)}край` });
    expect(long.text.length).toBeLessThan(300);
  });
});

describe('createDemoEngines: unusual input', () => {
  it('normalises the own domain: a URL, a www prefix, capitals', async () => {
    const engine = createDemoEngines({ ...INPUT, ownDomain: 'https://www.My-Studio.example/izrabotka?x=1' })[1]!;
    const own = (await asked(engine, questions(80))).flatMap((a) => a.citations).filter((c) => c.domain === OWN);
    expect(own.length).toBeGreaterThan(0);
    expect(own[0]).toMatchObject({ url: `https://${OWN}/`, domain: OWN });
  });

  it('never cites an own site it does not have', async () => {
    for (const ownDomain of ['', '   ']) {
      const engine = createDemoEngines({ ...INPUT, ownDomain })[1]!;
      for (const a of await asked(engine, questions(60))) expect(a.citations.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('copes with few competitors: it cites what there is', async () => {
    const two = createDemoEngines({ ...INPUT, competitors: COMPETITORS.slice(0, 2) });
    for (const engine of two) {
      for (const a of await asked(engine, questions(40))) {
        const others = a.citations.filter((c) => c.domain !== OWN);
        expect(others.length).toBeLessThanOrEqual(2);
        expect(a.citations.length).toBeLessThanOrEqual(3);
        expect(a.text.length).toBeGreaterThan(20);
      }
    }
  });

  it('copes with no competitors at all', async () => {
    for (const engine of createDemoEngines({ ...INPUT, competitors: [] })) {
      for (const a of await asked(engine, questions(40))) {
        expect(a.citations.every((c) => c.domain === OWN)).toBe(true);
        expect(a.citations.length).toBeLessThanOrEqual(1);
        expect(a.consulted.every((c) => c.domain === OWN)).toBe(true);
        expect(a.text.length).toBeGreaterThan(20);
      }
    }
  });

  it('ignores competitors that cannot be cited (no http url, no domain) and repeated pages', async () => {
    const odd: DemoCompetitor[] = [
      ...COMPETITORS,
      { domain: 'bad.example', url: 'javascript:alert(1)', title: 'bad', kind: 'other' },
      { domain: '', url: 'https://nodomain.example/', title: 'no domain', kind: 'other' },
      { ...COMPETITORS[0]! },
    ];
    for (const engine of createDemoEngines({ ...INPUT, competitors: odd })) {
      for (const a of await asked(engine, questions(60))) {
        expect(a.citations.map((c) => c.domain)).not.toContain('bad.example');
        expect(a.citations.map((c) => c.url)).not.toContain('https://nodomain.example/');
        expect(new Set(a.citations.map((c) => c.url)).size).toBe(a.citations.length);
      }
    }
  });

  it('prefers sources from different domains when a domain has several pages', async () => {
    const pages: DemoCompetitor[] = [
      ...['a', 'b', 'c'].flatMap((d) => [1, 2, 3].map((n) => ({ domain: `${d}.example`, url: `https://${d}.example/p${n}`, title: `${d} ${n}`, kind: 'guide' as const }))),
      ...['d', 'e', 'f'].map((d) => ({ domain: `${d}.example`, url: `https://${d}.example/`, title: d, kind: 'other' as const })),
    ];
    for (const engine of createDemoEngines({ ...INPUT, competitors: pages })) {
      for (const a of await asked(engine, questions(40))) {
        const domains = a.citations.map((c) => c.domain);
        expect(new Set(domains).size).toBe(domains.length); // six domains are enough for five citations
      }
    }
  });

  it('keeps the KINDS list honest (every kind is accepted)', async () => {
    const all = KINDS.map((kind, i) => ({ domain: `k${i}.example`, url: `https://k${i}.example/`, title: kind, kind }));
    const [openai] = createDemoEngines({ ...INPUT, competitors: all });
    expect((await ask(openai!, 'q')).citations.length).toBeGreaterThanOrEqual(3);
  });
});
