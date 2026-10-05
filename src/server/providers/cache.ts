import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Market } from '../../shared/markets';
import type { SerpData } from '../../shared/schemas';
import type { FetchedPage, PageFetcher } from '../crawl/fetcher';
import { sha1Hex } from '../util/hash';
import type { Meter } from '../util/meter';
import type { CallOptions, KeywordVolume, SerpProvider, SerpQuery, VolumeProvider } from './serp/types';

/** Small TTL cache on disk (gzipped JSON, one file per key). Re-running an analysis should not re-pay for SERPs or re-hit competitor sites. */
export class DiskCache {
  constructor(
    private readonly dir: string,
    private readonly defaultTtlMs: number,
  ) {}

  get enabled(): boolean {
    return this.defaultTtlMs > 0;
  }

  private file(ns: string, key: string): string {
    return join(this.dir, ns, `${sha1Hex(key)}.json.gz`);
  }

  async get<T>(ns: string, key: string): Promise<T | null> {
    if (!this.enabled) return null;
    const file = this.file(ns, key);
    try {
      const entry = JSON.parse(gunzipSync(await readFile(file)).toString('utf-8')) as { key: string; expiresAt: number; value: T };
      if (entry.key !== key) return null;
      if (entry.expiresAt <= Date.now()) {
        await rm(file, { force: true });
        return null;
      }
      return entry.value;
    } catch {
      return null; // missing or corrupt entries are simply misses
    }
  }

  /**
   * Entries only expire when they are read again, so keys nobody asks for twice would stay forever. This deletes the
   * expired ones. A file's modification time is set to its expiry when it is written, so a file whose time is still
   * ahead is valid without being opened; only files that look expired (or were written by an older version, which used
   * the write time) are read to confirm. Entries have different TTLs (a SERP lives a day, search volumes a week), which
   * is why the age of a file alone cannot decide. Returns how many files it removed.
   */
  async prune(now = Date.now()): Promise<number> {
    if (!this.enabled) return 0;
    let removed = 0;
    let namespaces: string[];
    try {
      namespaces = await readdir(this.dir);
    } catch {
      return 0; // nothing cached yet
    }
    for (const ns of namespaces) {
      let files: string[];
      try {
        files = await readdir(join(this.dir, ns));
      } catch {
        continue;
      }
      for (const name of files) {
        const file = join(this.dir, ns, name);
        try {
          if ((await stat(file)).mtimeMs > now) continue; // its expiry is still ahead
          let expiresAt = 0;
          try {
            expiresAt = (JSON.parse(gunzipSync(await readFile(file)).toString('utf-8')) as { expiresAt?: number }).expiresAt ?? 0;
          } catch {
            // unreadable: treated as expired below
          }
          if (expiresAt <= now) {
            await rm(file, { force: true });
            removed++;
          } else {
            await utimes(file, new Date(expiresAt), new Date(expiresAt)); // an older file: from now on it carries its expiry
          }
        } catch {
          // a file that vanished or cannot be read is not our problem
        }
      }
    }
    return removed;
  }

  async set(ns: string, key: string, value: unknown, ttlMs = this.defaultTtlMs): Promise<void> {
    if (!this.enabled || ttlMs <= 0) return;
    const file = this.file(ns, key);
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      const expiresAt = Date.now() + ttlMs;
      await writeFile(tmp, gzipSync(JSON.stringify({ key, expiresAt, value })), { mode: 0o600 });
      await utimes(tmp, new Date(expiresAt), new Date(expiresAt)); // the file's time is its expiry (see prune)
      await rename(tmp, file);
    } catch {
      // A cache that cannot write must never break an analysis.
    }
  }
}

const HOUR = 3_600_000;

/** Pays for each distinct SERP once per TTL. Cache hits are free and do not count against the run budget. */
export class CachedSerpProvider implements SerpProvider {
  readonly id: SerpProvider['id'];
  readonly suggest: SerpProvider['suggest'];

  constructor(
    private readonly inner: SerpProvider,
    private readonly cache: DiskCache,
    private readonly meter: Meter,
  ) {
    this.id = inner.id;
    if (inner.suggest) {
      const suggest = inner.suggest.bind(inner);
      this.suggest = async (keyword: string, market: Market, options?: CallOptions) => {
        const key = `suggest|${inner.id}|${market.id}|${keyword.trim().toLowerCase()}`;
        const hit = await this.cache.get<string[]>('suggest', key);
        if (hit) return hit;
        const fresh = await suggest(keyword, market, options);
        if (fresh.length > 0) await this.cache.set('suggest', key, fresh);
        return fresh;
      };
    }
  }

  async search(query: SerpQuery, options?: CallOptions): Promise<SerpData> {
    const key = `serp|${this.id}|${query.market.id}|${query.depth}|${query.keyword.trim().toLowerCase()}`;
    const hit = await this.cache.get<SerpData>('serp', key);
    if (hit) {
      this.meter.serpCacheHits++;
      return hit;
    }
    this.meter.takeSerpCall();
    const fresh = await this.inner.search(query, options);
    await this.cache.set('serp', key, fresh);
    return fresh;
  }
}

/** Volumes change monthly, so they are cached per keyword for a week and requested in a single bulk call. */
export class CachedVolumeProvider implements VolumeProvider {
  readonly id: VolumeProvider['id'];

  constructor(
    private readonly inner: VolumeProvider,
    private readonly cache: DiskCache,
    private readonly meter: Meter,
  ) {
    this.id = inner.id;
  }

  async volumes(keywords: readonly string[], market: Market, options?: CallOptions): Promise<Map<string, KeywordVolume>> {
    const out = new Map<string, KeywordVolume>();
    const missing: string[] = [];
    for (const kw of new Set(keywords.map((k) => k.trim().toLowerCase()))) {
      const hit = await this.cache.get<KeywordVolume>('volume', `${this.id}|${market.id}|${kw}`);
      if (hit) out.set(kw, hit);
      else missing.push(kw);
    }
    if (missing.length > 0) {
      this.meter.volumeCalls++;
      const fresh = await this.inner.volumes(missing, market, options);
      for (const [kw, v] of fresh) {
        out.set(kw, v);
        await this.cache.set('volume', `${this.id}|${market.id}|${kw}`, v, 7 * 24 * HOUR);
      }
    }
    return out;
  }
}

/** Caches successfully fetched pages so a re-run does not hit competitor sites again. Only `ok` pages are stored. */
export class CachedFetcher implements PageFetcher {
  constructor(
    private readonly inner: PageFetcher,
    private readonly cache: DiskCache,
  ) {}

  async fetchPage(url: string, options?: { signal?: AbortSignal }): Promise<FetchedPage> {
    const hit = await this.cache.get<FetchedPage>('page', url);
    if (hit) return { ...hit, fromCache: true };
    const page = await this.inner.fetchPage(url, options);
    if (page.status === 'ok') await this.cache.set('page', url, page);
    return page;
  }
}
