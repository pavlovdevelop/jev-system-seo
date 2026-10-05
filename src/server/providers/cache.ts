import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

  async set(ns: string, key: string, value: unknown, ttlMs = this.defaultTtlMs): Promise<void> {
    if (!this.enabled || ttlMs <= 0) return;
    const file = this.file(ns, key);
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, gzipSync(JSON.stringify({ key, expiresAt: Date.now() + ttlMs, value })));
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
