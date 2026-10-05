import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../scripts/build-server';
import { ExtractError, extractPage } from '../../src/server/crawl/extract';
import { createExtractor, InProcessExtractor, WorkerExtractor, type PageExtractor } from '../../src/server/crawl/extract-pool';

// The pool is tested against a helper script that hangs, crashes or hoards memory on command, and — once — against the
// real worker built exactly like production.

const root = fileURLToPath(new URL('../..', import.meta.url));
const helper = pathToFileURL(join(root, 'tests/helpers/pool-worker.mjs'));
const ctx = { url: 'https://x.test/', keyword: 'k' };
const echo = async (e: PageExtractor, html: string): Promise<string> => ((await e.extract(html, ctx)) as unknown as { echo: string }).echo;

const opened: PageExtractor[] = [];
const pool = (options: Partial<ConstructorParameters<typeof WorkerExtractor>[0]> = {}): WorkerExtractor => {
  const w = new WorkerExtractor({ file: helper, timeoutMs: 5_000, ...options });
  opened.push(w);
  return w;
};
afterEach(async () => {
  await Promise.all(opened.splice(0).map((e) => e.close()));
});

describe('WorkerExtractor', () => {
  it('hands a page to the worker and returns what it answers', async () => {
    const w = pool();
    expect(await echo(w, 'hello')).toBe('hello');
    expect(await echo(w, 'again')).toBe('again'); // the same thread serves the next page
  });

  it('sends one page at a time and keeps the order of those waiting', async () => {
    const w = pool();
    const done = await Promise.all([echo(w, 'SLOW:60:a'), echo(w, 'SLOW:5:b'), echo(w, 'SLOW:5:c'), echo(w, 'd')]);
    expect(done).toEqual(['a', 'b', 'c', 'd']);
    const seen = await Promise.all(['SLOW:20:x', 'SLOW:20:y'].map(async (h) => ((await w.extract(h, ctx)) as unknown as { inFlight: number }).inFlight));
    expect(seen).toEqual([1, 1]); // never two pages in the worker at once
  });

  it('gives the worker no environment variables, so the server\'s keys are not there for a page to reach', async () => {
    process.env.POOL_TEST_SECRET = 'do-not-leak';
    try {
      expect(await echo(pool(), 'ENV')).toBe('');
    } finally {
      delete process.env.POOL_TEST_SECRET;
    }
  });

  it('stops a worker that does not answer in time — and the main thread keeps running meanwhile', async () => {
    const w = pool({ timeoutMs: 500 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = performance.now();
    const hung = await w.extract('HANG', ctx).catch((e: unknown) => e);
    const took = performance.now() - started;
    clearInterval(timer);
    expect(hung).toBeInstanceOf(ExtractError);
    expect((hung as Error).message).toMatch(/не приключи/);
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(3_000);
    // A loop that blocked this thread would have let almost no tick through; 500 ms of 20 ms ticks is 25.
    expect(ticks).toBeGreaterThanOrEqual(12);
  });

  it('replaces a stopped worker, and the pages that were waiting behind it are still read', async () => {
    const w = pool({ timeoutMs: 400 });
    const results = await Promise.allSettled([w.extract('HANG', ctx), echo(w, 'after-1'), echo(w, 'after-2')]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'after-1' });
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: 'after-2' });
    expect(await echo(w, 'later')).toBe('later');
  });

  it.each([
    ['an exception nobody caught', 'THROW', /спря неочаквано/],
    ['an exit', 'EXIT', /спря неочаквано/],
  ])('survives a worker that dies from %s: that page fails, the next is fine', async (_name, html, message) => {
    const w = pool();
    const err = await w.extract(html, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect((err as Error).message).toMatch(message);
    expect(await echo(w, 'next')).toBe('next');
  });

  it('says so when Node reports that the worker ran out of memory', async () => {
    const w = pool();
    const err = await w.extract('OOM-CODE', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect((err as Error).message).toMatch(/не стигна паметта/);
    expect(await echo(w, 'next')).toBe('next');
  });

  // The limit is a V8 setting, and a --max-old-space-size in NODE_OPTIONS (some hosts and sandboxes set one) overrides it:
  // the worker then runs on until the deadline instead, which the test above for a hung worker covers.
  it.skipIf(/max-old-space-size/.test(process.env.NODE_OPTIONS ?? ''))('stops a worker that hoards memory, without the server going with it', async () => {
    const w = pool({ maxMemoryMb: 48 });
    const err = await w.extract('OOM', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect((err as Error).message).toMatch(/не стигна паметта/);
    expect(await echo(w, 'next')).toBe('next');
  });

  it('turns the worker\'s own errors back into errors, keeping ExtractError an ExtractError', async () => {
    const w = pool();
    const known = await w.extract('FAIL-EXTRACT', ctx).catch((e: unknown) => e);
    expect(known).toBeInstanceOf(ExtractError);
    expect((known as Error).message).toBe('Страницата е твърде сложна');
    const other = await w.extract('FAIL-OTHER', ctx).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(Error);
    expect(other).not.toBeInstanceOf(ExtractError);
    expect((other as Error).message).toBe('нещо друго');
  });

  it('ignores an answer that belongs to no page it is waiting for', async () => {
    expect(await echo(pool(), 'WRONG-ID')).toBe('right');
  });

  it('reports a worker script that cannot start instead of hanging or crashing the server', async () => {
    const w = pool({ file: pathToFileURL(join(root, 'tests/helpers/does-not-exist.mjs')) });
    for (let i = 0; i < 2; i++) {
      const err = await w.extract('x', ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExtractError);
      expect((err as Error).message).toMatch(/спря неочаквано/);
    }
  });

  it('rejects what is waiting when it is closed, and refuses new pages afterwards', async () => {
    const w = pool({ timeoutMs: 30_000 });
    const running = w.extract('HANG', ctx).catch((e: unknown) => e);
    const waiting = w.extract('queued', ctx).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    await w.close();
    expect(await running).toBeInstanceOf(ExtractError);
    expect(await waiting).toBeInstanceOf(ExtractError);
    await expect(w.extract('late', ctx)).rejects.toBeInstanceOf(ExtractError);
    await expect(w.close()).resolves.toBeUndefined(); // closing twice is harmless
  });
});

describe('InProcessExtractor', () => {
  it('is extractPage, as a promise', async () => {
    const html = readFileSync(join(root, 'tests/fixtures/service-page.html'), 'utf-8');
    const c = { url: 'https://www.studio-pixel.example/uslugi/', keyword: 'изработка на уеб сайт', now: new Date('2026-10-05') };
    expect(await new InProcessExtractor().extract(html, c)).toEqual(extractPage(html, c));
    expect(new InProcessExtractor().mode).toBe('in-process');
  });
});

describe('the production bundle', () => {
  const outdir = 'node_modules/.cache/jev-seo-radar-tests/dist';
  const workerFile = pathToFileURL(join(root, outdir, 'extract-worker.mjs'));

  beforeAll(async () => {
    await buildServer(outdir);
  }, 60_000);

  it('is built next to the server, which is where the server looks for it', () => {
    expect(existsSync(join(root, outdir, 'server.mjs'))).toBe(true);
    expect(existsSync(fileURLToPath(workerFile))).toBe(true);
  });

  it('createExtractor picks the worker when its script exists, and the current thread when it does not', async () => {
    const withWorker = createExtractor(workerFile);
    expect(withWorker.mode).toBe('worker');
    await withWorker.close();
    expect(createExtractor(pathToFileURL(join(root, outdir, 'nope.mjs'))).mode).toBe('in-process');
    expect(createExtractor().mode).toBe('in-process'); // no worker script sits next to the sources
  });

  it('reads a page exactly like the in-process extractor does', async () => {
    const worker = new WorkerExtractor({ file: workerFile });
    opened.push(worker);
    for (const name of ['service-page.html', 'thin-page.html']) {
      const html = readFileSync(join(root, 'tests/fixtures', name), 'utf-8');
      const c = { url: 'https://www.studio-pixel.example/uslugi/', keyword: 'изработка на уеб сайт', now: new Date('2026-10-05') };
      expect(await worker.extract(html, c), name).toEqual(extractPage(html, c));
    }
  });

  it('copes with pages built to be expensive, with the main thread running freely', async () => {
    const worker = new WorkerExtractor({ file: workerFile, timeoutMs: 20_000 });
    opened.push(worker);
    const hostile = {
      flat: `<html><body>${'<div>изработка на уеб сайт цена 100 лв</div>'.repeat(30_000)}`,
      tiny: `<html><body>${'<b>a</b>'.repeat(180_000)}`,
      deep: `<html><body>${'<div>'.repeat(150_000)}x`,
    };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    for (const [name, html] of Object.entries(hostile)) {
      const page = await worker.extract(html, ctx);
      expect(page.metrics.wordCount, name).toBeGreaterThanOrEqual(name === 'flat' ? 1_000 : 0);
    }
    clearInterval(timer);
    const took = performance.now() - started;
    // While the worker was busy the event loop kept turning: a blocked loop would manage a handful of ticks, not this many.
    expect(ticks).toBeGreaterThan(took / 10 / 4);
  });
});
