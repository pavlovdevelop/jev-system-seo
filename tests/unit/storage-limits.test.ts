import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager } from '../../src/server/jobs';
import { DiskCache } from '../../src/server/providers/cache';
import { Store } from '../../src/server/store';
import { sha1Hex } from '../../src/server/util/hash';

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

  it('stamps every file with its own expiry, so prune can tell without opening it', async () => {
    const cache = new DiskCache(join(dir, 'cache'), 3_600_000);
    const before = Date.now();
    await cache.set('serp', 'a', { a: 1 });
    await cache.set('volume', 'b', { b: 2 }, 7 * 24 * 3_600_000);
    const mtimeOf = async (ns: string) => (await stat(join(dir, 'cache', ns, (await readdir(join(dir, 'cache', ns)))[0] as string))).mtimeMs;
    expect(Math.abs((await mtimeOf('serp')) - (before + 3_600_000))).toBeLessThan(5_000);
    expect(Math.abs((await mtimeOf('volume')) - (before + 7 * 24 * 3_600_000))).toBeLessThan(5_000);
    expect(await cache.get('serp', 'a')).toEqual({ a: 1 });
  });

  it('prune judges every entry by its own TTL, not by the age of its file', async () => {
    const cache = new DiskCache(join(dir, 'cache'), 3_600_000);
    await cache.set('serp', 'day', { a: 1 }); // lives one hour in this test
    await cache.set('volume', 'week', { b: 2 }, 7 * 24 * 3_600_000);
    expect(await cache.prune()).toBe(0); // nothing has expired yet
    expect(await cache.prune(Date.now() + 2 * 3_600_000)).toBe(1); // two hours on: only the short-lived entry is gone
    expect(await readdir(join(dir, 'cache', 'serp'))).toHaveLength(0);
    expect(await readdir(join(dir, 'cache', 'volume'))).toHaveLength(1);
    expect(await cache.prune(Date.now() + 8 * 24 * 3_600_000)).toBe(1);
    expect(await readdir(join(dir, 'cache', 'volume'))).toHaveLength(0);
  });

  it('prune handles files an older version wrote (modification time = write time) and unreadable ones', async () => {
    const root = join(dir, 'cache');
    await mkdir(join(root, 'serp'), { recursive: true });
    const legacy = async (key: string, expiresAt: number, mtime: number): Promise<string> => {
      const file = join(root, 'serp', `${sha1Hex(key)}.json.gz`);
      await writeFile(file, gzipSync(JSON.stringify({ key, expiresAt, value: { key } })));
      await utimes(file, new Date(mtime), new Date(mtime));
      return file;
    };
    const now = Date.now();
    const stillValid = await legacy('valid', now + 3_600_000, now - 30 * 60_000);
    await legacy('expired', now - 60_000, now - 2 * 3_600_000);
    const garbage = join(root, 'serp', 'garbage.json.gz');
    await writeFile(garbage, 'not gzip at all');
    await utimes(garbage, new Date(now - 1000), new Date(now - 1000));

    expect(await new DiskCache(root, 3_600_000).prune(now)).toBe(2); // the expired one and the unreadable one
    expect(await readdir(join(root, 'serp'))).toEqual([`${sha1Hex('valid')}.json.gz`]);
    // the survivor now carries its expiry, so the next prune does not have to open it
    expect(Math.abs((await stat(stillValid)).mtimeMs - (now + 3_600_000))).toBeLessThan(5_000);
    expect(await new DiskCache(root, 3_600_000).get('serp', 'valid')).toEqual({ key: 'valid' });
  });

  it('prune is a no-op for an empty or disabled cache', async () => {
    expect(await new DiskCache(join(dir, 'nothing-here'), 3_600_000).prune()).toBe(0);
    const cache = new DiskCache(join(dir, 'cache'), 3_600_000);
    await cache.set('serp', 'k', { a: 1 });
    expect(await new DiskCache(join(dir, 'cache'), 0).prune(Date.now() + 10 * 3_600_000)).toBe(0);
    expect(await readdir(join(dir, 'cache', 'serp'))).toHaveLength(1);
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
