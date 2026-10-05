import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKETS } from '../../src/shared/markets';
import { CachedFetcher, CachedSerpProvider, CachedVolumeProvider, DiskCache } from '../../src/server/providers/cache';
import { DataForSeoProvider } from '../../src/server/providers/serp/dataforseo';
import { postJson } from '../../src/server/providers/serp/http';
import { SerperProvider } from '../../src/server/providers/serp/serper';
import { buildSerpData, domainOf, SerpError, type SerpProvider } from '../../src/server/providers/serp/types';
import { Meter } from '../../src/server/util/meter';
import type { FetchedPage } from '../../src/server/crawl/fetcher';

const BG = MARKETS.bg;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call { url: string; headers: Record<string, string>; body: any }
function recorder(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}

describe('domainOf', () => {
  it('returns the registrable domain', () => {
    expect(domainOf('https://www.example.com/a?b=1')).toBe('example.com');
    expect(domainOf('https://blog.example.co.uk/post')).toBe('example.co.uk');
    expect(domainOf('https://sub.studio.example.bg/')).toBe('example.bg');
    expect(domainOf('http://192.0.2.10/page')).toBe('192.0.2.10');
  });
  it('keeps users of hosted platforms apart', () => {
    expect(domainOf('https://pixelstudio.wixsite.com/site')).toBe('pixelstudio.wixsite.com');
    expect(domainOf('https://someone.github.io/page')).toBe('someone.github.io');
  });
});

describe('buildSerpData', () => {
  it('drops non-http links and duplicate URLs, keeps order and de-duplicates questions', () => {
    const d = buildSerpData({
      provider: 'x', keyword: 'k', market: BG,
      organic: [
        { url: 'https://a.example/1', title: ' A ', snippet: 'x' },
        { url: 'javascript:alert(1)', title: 'bad' },
        { url: 'https://a.example/1', title: 'dup' },
        { url: 'https://b.example/', title: 'B', position: 5 },
      ],
      peopleAlsoAsk: [{ question: 'Колко струва?' }, { question: 'колко струва?', snippet: 'dup' }],
      relatedSearches: ['a', 'a', ' b '],
    });
    expect(d.results.map((r) => [r.position, r.domain, r.title])).toEqual([[1, 'a.example', 'A'], [5, 'b.example', 'B']]);
    expect(d.peopleAlsoAsk).toHaveLength(1);
    expect(d.relatedSearches).toEqual(['a', 'b']);
  });
});

describe('postJson', () => {
  const opts = { vendor: 'Test', headers: {} };

  it('retries 5xx/429 and then succeeds', async () => {
    const r = recorder((_c, n) => (n < 3 ? json({ e: 1 }, n === 1 ? 503 : 429, { 'retry-after': '0' }) : json({ ok: true })));
    expect(await postJson('https://x.test', {}, { ...opts, fetchImpl: r.fetchImpl, retries: 2 })).toEqual({ ok: true });
    expect(r.calls).toHaveLength(3);
  });

  it('gives up after the retries and reports the last error', async () => {
    const r = recorder(() => json({}, 500, { 'retry-after': '0' }));
    await expect(postJson('https://x.test', {}, { ...opts, fetchImpl: r.fetchImpl, retries: 1 })).rejects.toMatchObject({ kind: 'unavailable', status: 500 });
    expect(r.calls).toHaveLength(2);
  });

  it.each([[401, 'auth'], [403, 'auth'], [402, 'quota']] as const)('maps %i to %s without retrying', async (status, kind) => {
    const r = recorder(() => json({ message: 'x' }, status));
    await expect(postJson('https://x.test', {}, { ...opts, fetchImpl: r.fetchImpl })).rejects.toMatchObject({ kind });
    expect(r.calls).toHaveLength(1);
  });

  it('treats a 400 about credits as quota and other 400s as bad_response', async () => {
    const q = recorder(() => json({ message: 'Not enough credits' }, 400));
    await expect(postJson('https://x.test', {}, { ...opts, fetchImpl: q.fetchImpl })).rejects.toMatchObject({ kind: 'quota' });
    const b = recorder(() => json({ message: 'bad field' }, 400));
    await expect(postJson('https://x.test', {}, { ...opts, fetchImpl: b.fetchImpl })).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('reports invalid JSON bodies and network failures', async () => {
    await expect(postJson('https://x.test', {}, { ...opts, fetchImpl: async () => new Response('<html>', { status: 200 }) })).rejects.toMatchObject({ kind: 'bad_response' });
    await expect(postJson('https://x.test', {}, { ...opts, retries: 0, fetchImpl: async () => { throw new Error('ECONNRESET'); } })).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

const SERPER_FIXTURE = {
  searchParameters: { q: 'изработка на уеб сайт', gl: 'bg', hl: 'bg', num: 10, type: 'search' },
  organic: [
    { title: 'Изработка на уебсайт - Студио А', link: 'https://www.studio-a.example/izrabotka', snippet: 'Професионална изработка…', position: 1 },
    { title: 'Изработка на сайтове | Б', link: 'https://b.example/', snippet: 'Цени от 490 лв.', position: 2, sitelinks: [{ title: 'Цени', link: 'https://b.example/ceni' }] },
    { title: 'Тема във форума', link: 'https://forum.example/t/123', position: 3 },
  ],
  peopleAlsoAsk: [{ question: 'Колко струва изработката на сайт?', snippet: 'Между 500 и 3000 лв.', title: 'x', link: 'https://x.example' }],
  relatedSearches: [{ query: 'изработка на сайт цена' }, { query: 'изработка на онлайн магазин' }],
  credits: 1,
};

describe('SerperProvider', () => {
  it('sends the documented request and maps the response', async () => {
    const r = recorder(() => json(SERPER_FIXTURE));
    const serp = await new SerperProvider('KEY', r.fetchImpl).search({ keyword: 'изработка на уеб сайт', market: BG, depth: 10 });
    expect(r.calls[0]).toMatchObject({ url: 'https://google.serper.dev/search', body: { q: 'изработка на уеб сайт', gl: 'bg', hl: 'bg', num: 10 } });
    expect(r.calls[0]!.headers['x-api-key']).toBe('KEY');
    expect(serp.provider).toBe('serper');
    expect(serp.results.map((x) => [x.position, x.domain])).toEqual([[1, 'studio-a.example'], [2, 'b.example'], [3, 'forum.example']]);
    expect(serp.peopleAlsoAsk).toEqual([{ question: 'Колко струва изработката на сайт?', snippet: 'Между 500 и 3000 лв.' }]);
    expect(serp.relatedSearches).toEqual(['изработка на сайт цена', 'изработка на онлайн магазин']);
  });

  it('tolerates missing optional blocks', async () => {
    const r = recorder(() => json({ organic: [{ link: 'https://a.example/' }] }));
    const serp = await new SerperProvider('K', r.fetchImpl).search({ keyword: 'x', market: BG, depth: 10 });
    expect(serp.results).toHaveLength(1);
    expect(serp.peopleAlsoAsk).toEqual([]);
  });

  it('rejects structurally wrong responses', async () => {
    const r = recorder(() => json({ organic: 'nope' }));
    await expect(new SerperProvider('K', r.fetchImpl).search({ keyword: 'x', market: BG, depth: 10 })).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('autocomplete accepts strings or {value} objects and never throws on soft failures', async () => {
    const ok = recorder(() => json({ suggestions: [{ value: 'a b' }, 'c d'] }));
    expect(await new SerperProvider('K', ok.fetchImpl).suggest('x', BG)).toEqual(['a b', 'c d']);
    expect(ok.calls[0]).toMatchObject({ url: 'https://google.serper.dev/autocomplete', body: { q: 'x', gl: 'bg', hl: 'bg' } });
    const soft = recorder(() => json({}, 500));
    expect(await new SerperProvider('K', soft.fetchImpl).suggest('x', BG)).toEqual([]);
    const weird = recorder(() => json({ suggestions: 42 }));
    expect(await new SerperProvider('K', weird.fetchImpl).suggest('x', BG)).toEqual([]);
    const dead = recorder(() => json({}, 401));
    await expect(new SerperProvider('K', dead.fetchImpl).suggest('x', BG)).rejects.toMatchObject({ kind: 'auth' });
  });
});

const DFS_SERP_FIXTURE = {
  version: '0.1.20250101', status_code: 20000, status_message: 'Ok.', cost: 0.002,
  tasks: [{
    status_code: 20000, status_message: 'Ok.',
    result: [{
      keyword: 'изработка на уеб сайт', se_results_count: 1234,
      items: [
        { type: 'paid', rank_group: 1, url: 'https://ad.example/', title: 'Ad' },
        { type: 'organic', rank_group: 1, rank_absolute: 2, domain: 'studio-a.example', url: 'https://studio-a.example/izrabotka', title: 'Студио А', description: 'Описание А' },
        { type: 'people_also_ask', items: [{ type: 'people_also_ask_element', title: 'Колко време отнема?' }, { type: 'people_also_ask_element', title: 'Какво е CMS?' }] },
        { type: 'organic', rank_group: 2, rank_absolute: 5, domain: 'b.example', url: 'https://b.example/', title: 'Б', description: null },
        { type: 'featured_snippet', url: 'https://snippet.example/', title: 'Snippet' },
        { type: 'related_searches', items: ['изработка на сайт цена', { title: 'изработка на магазин' }] },
      ],
    }],
  }],
};

describe('DataForSeoProvider', () => {
  const provider = (r: ReturnType<typeof recorder>) => new DataForSeoProvider('login', 'secret', r.fetchImpl);

  it('sends Basic auth and the documented SERP request, then keeps only organic results', async () => {
    const r = recorder(() => json(DFS_SERP_FIXTURE));
    const serp = await provider(r).search({ keyword: 'изработка на уеб сайт', market: BG, depth: 20 });
    expect(r.calls[0]!.url).toBe('https://api.dataforseo.com/v3/serp/google/organic/live/advanced');
    expect(r.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('login:secret').toString('base64')}`);
    expect(r.calls[0]!.body).toEqual([{ keyword: 'изработка на уеб сайт', location_code: 2100, language_code: 'bg', device: 'desktop', depth: 20 }]);
    expect(serp.results.map((x) => [x.position, x.domain, x.snippet])).toEqual([[1, 'studio-a.example', 'Описание А'], [2, 'b.example', '']]);
    expect(serp.peopleAlsoAsk.map((p) => p.question)).toEqual(['Колко време отнема?', 'Какво е CMS?']);
    expect(serp.relatedSearches).toEqual(['изработка на сайт цена', 'изработка на магазин']);
  });

  it('maps envelope-level errors', async () => {
    const auth = recorder(() => json({ status_code: 40101, status_message: 'Authentication failed.', tasks: [] }));
    await expect(provider(auth).search({ keyword: 'x', market: BG, depth: 10 })).rejects.toMatchObject({ kind: 'auth' });
    const funds = recorder(() => json({ status_code: 20000, tasks: [{ status_code: 40201, status_message: 'Insufficient funds' }] }));
    await expect(provider(funds).search({ keyword: 'x', market: BG, depth: 10 })).rejects.toMatchObject({ kind: 'bad_response' });
    const top = recorder(() => json({ status_code: 40200, status_message: 'Payment required', tasks: [] }));
    await expect(provider(top).search({ keyword: 'x', market: BG, depth: 10 })).rejects.toMatchObject({ kind: 'quota' });
  });

  it('requests search volumes in one bulk call and keys results by lowercase keyword', async () => {
    const r = recorder(() => json({ status_code: 20000, tasks: [{ status_code: 20000, result: [
      { keyword: 'Изработка на сайт', search_volume: 1900, cpc: 1.2, competition_index: 64 },
      { keyword: 'изработка на сайт цена', search_volume: null, cpc: null, competition_index: null },
    ] }] }));
    const v = await provider(r).volumes(['Изработка на сайт', 'изработка на сайт цена', 'изработка на сайт', 'x '.repeat(11)], BG);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live');
    expect(r.calls[0]!.body[0]).toEqual({ keywords: ['Изработка на сайт', 'изработка на сайт цена', 'изработка на сайт'], location_code: 2100, language_code: 'bg' });
    expect(v.get('изработка на сайт')).toEqual({ volume: 1900, cpc: 1.2, competitionIndex: 64 });
    expect(v.get('изработка на сайт цена')).toEqual({ volume: null, cpc: null, competitionIndex: null });
  });
});

describe('caching and run budget', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'jev-cache-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const fakeSerp = () => {
    let calls = 0;
    const provider: SerpProvider = { id: 'serper', async search(q) { calls++; return buildSerpData({ provider: 'serper', keyword: q.keyword, market: q.market, organic: [{ url: 'https://a.example/' }] }); } };
    return { provider, calls: () => calls };
  };

  it('DiskCache round-trips, expires entries and can be disabled', async () => {
    const c = new DiskCache(dir, 60_000);
    await c.set('ns', 'k', { a: 1 });
    expect(await c.get('ns', 'k')).toEqual({ a: 1 });
    expect(await c.get('ns', 'other')).toBeNull();
    await c.set('ns', 'old', { a: 2 }, 1);
    await new Promise((r) => setTimeout(r, 15));
    expect(await c.get('ns', 'old')).toBeNull();
    const off = new DiskCache(dir, 0);
    await off.set('ns', 'k2', 1);
    expect(await off.get('ns', 'k2')).toBeNull();
  });

  it('DiskCache treats corrupt files as misses', async () => {
    const c = new DiskCache(dir, 60_000);
    await c.set('ns', 'k', 1);
    const { sha1Hex } = await import('../../src/server/util/hash');
    await writeFile(join(dir, 'ns', `${sha1Hex('k')}.json.gz`), 'garbage');
    expect(await c.get('ns', 'k')).toBeNull();
  });

  it('CachedSerpProvider pays once per distinct query and does not charge the budget on hits', async () => {
    const { provider, calls } = fakeSerp();
    const meter = new Meter({ maxSerpCalls: 5, maxPages: 5 });
    const cached = new CachedSerpProvider(provider, new DiskCache(dir, 60_000), meter);
    const q = { keyword: 'Сайт', market: BG, depth: 10 as const };
    await cached.search(q);
    await cached.search({ ...q, keyword: 'сайт ' });
    expect(calls()).toBe(1);
    expect(meter.serpCalls).toBe(1);
    expect(meter.serpCacheHits).toBe(1);
  });

  it('enforces the per-run SERP budget', async () => {
    const { provider } = fakeSerp();
    const meter = new Meter({ maxSerpCalls: 2, maxPages: 5 });
    const cached = new CachedSerpProvider(provider, new DiskCache(dir, 0), meter);
    await cached.search({ keyword: 'a', market: BG, depth: 10 });
    await cached.search({ keyword: 'b', market: BG, depth: 10 });
    const err = await cached.search({ keyword: 'c', market: BG, depth: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(SerpError);
    expect(err).toMatchObject({ kind: 'budget', fatal: true });
  });

  it('CachedVolumeProvider asks only for keywords it has not seen', async () => {
    const asked: string[][] = [];
    const inner = { id: 'dataforseo' as const, async volumes(k: readonly string[]) { asked.push([...k]); return new Map(k.map((x) => [x, { volume: 10, cpc: null, competitionIndex: null }])); } };
    const meter = new Meter({ maxSerpCalls: 1, maxPages: 1 });
    const cached = new CachedVolumeProvider(inner, new DiskCache(dir, 60_000), meter);
    await cached.volumes(['a', 'b'], BG);
    const second = await cached.volumes(['A', 'c'], BG);
    expect(asked).toEqual([['a', 'b'], ['c']]);
    expect(second.size).toBe(2);
    expect(meter.volumeCalls).toBe(2);
  });

  it('CachedFetcher stores only successful pages', async () => {
    const ok: FetchedPage = { status: 'ok', httpStatus: 200, finalUrl: 'https://a.example/', html: '<p>x</p>', error: null, ttfbMs: 5, bytes: 8, fromCache: false };
    const fail: FetchedPage = { ...ok, status: 'http_error', httpStatus: 500, html: null, error: 'HTTP 500' };
    const robots: FetchedPage = { ...ok, status: 'blocked_robots', html: null, error: 'robots' };
    let calls = 0;
    const inner = { async fetchPage(url: string) { calls++; return url.includes('bad') ? fail : url.includes('robots') ? robots : ok; } };
    const f = new CachedFetcher(inner, new DiskCache(dir, 60_000));
    await f.fetchPage('https://a.example/');
    expect((await f.fetchPage('https://a.example/')).fromCache).toBe(true);
    await f.fetchPage('https://bad.example/');
    await f.fetchPage('https://bad.example/');
    await f.fetchPage('https://robots.example/');
    expect(calls).toBe(4); // ok once, bad twice (not cached), robots once
  });
});
