import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager } from '../../src/server/jobs';
import { DiskCache } from '../../src/server/providers/cache';
import { Store } from '../../src/server/store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jev-limits-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const posix = process.platform !== 'win32';

describe('DiskCache', () => {
  it.runIf(posix)('writes private files in private directories', async () => {
    const cache = new DiskCache(join(dir, 'cache'), 3_600_000);
    await cache.set('serp', 'k', { a: 1 });
    expect(await mode(join(dir, 'cache', 'serp'))).toBe(0o700);
    const files = (await import('node:fs/promises')).readdir(join(dir, 'cache', 'serp'));
    expect(await mode(join(dir, 'cache', 'serp', (await files)[0] as string))).toBe(0o600);
  });

  it('prune deletes what has not been written for longer than the TTL and keeps the rest', async () => {
    const cache = new DiskCache(join(dir, 'cache'), 3_600_000);
    await cache.set('serp', 'old', { a: 1 });
    await cache.set('serp', 'fresh', { a: 2 });
    const { readdir } = await import('node:fs/promises');
    const [first] = await readdir(join(dir, 'cache', 'serp'));
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    await utimes(join(dir, 'cache', 'serp', first as string), longAgo, longAgo);
    expect(await cache.prune()).toBe(1);
    expect(await readdir(join(dir, 'cache', 'serp'))).toHaveLength(1);
    // and an empty or disabled cache is simply a no-op
    expect(await new DiskCache(join(dir, 'nothing-here'), 3_600_000).prune()).toBe(0);
    expect(await new DiskCache(join(dir, 'cache'), 0).prune()).toBe(0);
  });
});

describe('Store', () => {
  it.runIf(posix)('keeps settings and reports readable by the owner only', async () => {
    const store = new Store(join(dir, 'data'));
    await store.init();
    await store.updateSettings({ businessDescription: 'тест' });
    expect(await mode(join(dir, 'data', 'reports'))).toBe(0o700);
    expect(await mode(join(dir, 'data', 'settings.json'))).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, 'data', 'settings.json'), 'utf-8'))).toMatchObject({ businessDescription: 'тест' });
  });
});

describe('JobManager', () => {
  it('does not remember more finished jobs than a fixed number', () => {
    const jm = new JobManager({ store: {} as never, runtime: {} as never, maxConcurrent: 1, logger: { info: () => {}, error: () => {} } });
    const jobs = (jm as unknown as { jobs: Map<string, { state: { id: string; status: string; createdAt: string } }> }).jobs;
    for (let i = 0; i < 130; i++) jobs.set(`j_${i}`, { state: { id: `j_${i}`, status: 'done', createdAt: new Date(1_000_000 + i).toISOString() } });
    jobs.set('j_running', { state: { id: 'j_running', status: 'running', createdAt: new Date(0).toISOString() } });
    (jm as unknown as { forgetOldFinished(): void }).forgetOldFinished();
    expect(jobs.size).toBe(101); // the 100 newest finished jobs and the running one
    expect(jobs.has('j_0')).toBe(false);
    expect(jobs.has('j_129')).toBe(true);
    expect(jobs.has('j_running')).toBe(true);
  });
});
