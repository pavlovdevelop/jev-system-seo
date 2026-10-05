import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { ExtractError, extractPage } from '../../src/server/crawl/extract';
import type { PageExtractor } from '../../src/server/crawl/extract-pool';
import type { FetchedPage, PageFetcher } from '../../src/server/crawl/fetcher';
import { crawlTargets } from '../../src/server/pipeline/crawl';
import type { Target } from '../../src/server/pipeline/targets';
import { Runtime } from '../../src/server/runtime';
import { Meter } from '../../src/server/util/meter';
import { buildHtml } from '../helpers/pages';
import { demoDeps } from '../helpers/demo-deps';

const NOW = new Date('2026-10-05T10:00:00Z');
const target = (url: string): Target => ({ url, position: 1, title: 't', snippet: 's', domain: 'a.example', role: 'serp' });
const okPage = (html: string): FetchedPage => ({ status: 'ok', httpStatus: 200, finalUrl: 'https://a.example/final', html, error: null, ttfbMs: 5, bytes: html.length, fromCache: false });
const failedPage: FetchedPage = { status: 'error', httpStatus: null, finalUrl: null, html: null, error: 'timeout', ttfbMs: null, bytes: null, fromCache: false };
const fetcherOf = (pages: Record<string, FetchedPage>): PageFetcher => ({ fetchPage: async (url) => pages[url] ?? failedPage });
const meter = (): Meter => new Meter({ maxSerpCalls: 5, maxPages: 10 });
const HTML = buildHtml({ title: 'Изработка на уеб сайт', h1: 'Изработка на уеб сайт', paragraphs: ['Правим сайтове за малки фирми.'] });

describe('crawlTargets and the page extractor', () => {
  it('reads each downloaded page with the extractor it was given, passing the address it ended up at', async () => {
    const calls: { html: string; url: string; keyword: string; now: Date | undefined }[] = [];
    const fake: PageExtractor = {
      mode: 'worker',
      extract: async (html, ctx) => {
        calls.push({ html, url: ctx.url, keyword: ctx.keyword, now: ctx.now });
        return extractPage(html, ctx);
      },
      close: async () => undefined,
    };
    const [one] = await crawlTargets([target('https://a.example/start')], {
      keyword: 'изработка на уеб сайт',
      fetcher: fetcherOf({ 'https://a.example/start': okPage(HTML) }),
      extractor: fake,
      meter: meter(),
      now: NOW,
    });
    expect(calls).toEqual([{ html: HTML, url: 'https://a.example/final', keyword: 'изработка на уеб сайт', now: NOW }]);
    expect(one?.extracted?.metrics.title).toBe('Изработка на уеб сайт');
    expect(one?.fetch.status).toBe('ok');
  });

  it('marks a page the extractor gave up on as not analysable and carries on with the others', async () => {
    const extractor: PageExtractor = {
      mode: 'worker',
      extract: async (html, ctx) => {
        if (html.includes('ВРЕДНА')) throw new ExtractError('Разборът на страницата не приключи за 10 с и беше прекратен');
        return extractPage(html, ctx);
      },
      close: async () => undefined,
    };
    const result = await crawlTargets([target('https://a.example/bad'), target('https://a.example/good')], {
      keyword: 'k',
      fetcher: fetcherOf({ 'https://a.example/bad': okPage('<html><body>ВРЕДНА</body></html>'), 'https://a.example/good': okPage(HTML) }),
      extractor,
      meter: meter(),
      now: NOW,
    });
    expect(result[0]?.extracted).toBeNull();
    expect(result[0]?.fetch).toMatchObject({ status: 'error' });
    expect(result[0]?.fetch.error).toMatch(/Грешка при разбор на HTML: Разборът на страницата не приключи/);
    expect(result[1]?.extracted?.metrics.title).toBe('Изработка на уеб сайт');
  });

  it('does not bother the extractor with pages that were never downloaded', async () => {
    let called = 0;
    const extractor: PageExtractor = {
      mode: 'worker',
      extract: async () => {
        called++;
        throw new Error('not expected to be called');
      },
      close: async () => undefined,
    };
    const [one] = await crawlTargets([target('https://a.example/down')], { keyword: 'k', fetcher: fetcherOf({}), extractor, meter: meter(), now: NOW });
    expect(called).toBe(0);
    expect(one?.extracted).toBeNull();
    expect(one?.fetch.status).toBe('error');
  });

  it('reads pages in this thread when no extractor is given', async () => {
    const [one] = await crawlTargets([target('https://a.example/start')], { keyword: 'k', fetcher: fetcherOf({ 'https://a.example/start': okPage(HTML) }), meter: meter(), now: NOW });
    expect(one?.extracted).toEqual(extractPage(HTML, { url: 'https://a.example/final', keyword: 'k', now: NOW }));
  });
});

describe('Runtime and the page extractor', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jev-runtime-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives every live run the same extractor, and the demo none', async () => {
    const runtime = new Runtime(loadConfig({ JEV_API_KEY: 'test-key', DATA_DIR: dir }, []));
    const first = runtime.createRun();
    const second = runtime.createRun();
    expect(first.deps.extractor).toBe(runtime.extractor);
    expect(second.deps.extractor).toBe(runtime.extractor);
    expect(runtime.extractor.mode).toBe('in-process'); // no built worker script sits next to the sources
    await Promise.all([first.close(), second.close()]);
    expect(demoDeps().extractor).toBeUndefined();
  });
});
