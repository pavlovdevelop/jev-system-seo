import { join } from 'node:path';
import type { StatusResponse } from '../shared/schemas';
import { describeJev, type AppConfig } from './config';
import { SafeFetcher, type PageFetcher } from './crawl/fetcher';
import { DEMO_BUSINESS, DEMO_KEYWORD, DEMO_OWN_DOMAIN, createDemoWorld } from './demo/world';
import { Jev, createSdkTransport } from './jev/client';
import { createMockFetch } from './jev/mock';
import type { PipelineDeps } from './pipeline/analyze';
import { PipelineError } from './pipeline/analyze';
import { CachedFetcher, CachedSerpProvider, CachedVolumeProvider, DiskCache } from './providers/cache';
import { DataForSeoProvider } from './providers/serp/dataforseo';
import { SerperProvider } from './providers/serp/serper';
import type { SerpProvider, VolumeProvider } from './providers/serp/types';
import { Meter } from './util/meter';

export const APP_VERSION = '0.1.0';

export const DEMO_DEFAULTS = { keyword: DEMO_KEYWORD, businessDescription: DEMO_BUSINESS, ownDomain: DEMO_OWN_DOMAIN, competitors: ['pixel-studio.example', 'webmasters-bg.example'] };

export interface RunHandle {
  deps: PipelineDeps;
  /** Releases sockets etc. Always call once the run is over. */
  close(): Promise<void>;
}

/** Builds the per-run dependency graph (fresh Jev client, meter and fetcher, so usage numbers are exact). */
export class Runtime {
  private readonly cache: DiskCache;

  constructor(readonly config: AppConfig) {
    this.cache = new DiskCache(join(config.dataDir, 'cache'), config.cacheTtlHours * 3_600_000);
  }

  status(): StatusResponse {
    const { config } = this;
    const jev = describeJev(config.jev);
    return {
      version: APP_VERSION,
      demo: config.demo,
      authRequired: config.appPassword !== null,
      jev: config.demo
        ? { configured: true, flavor: 'demo', model: 'jev-demo (mock)', host: null }
        : { configured: config.jev !== null, flavor: jev.flavor, model: jev.model, host: jev.host },
      serp: config.demo ? { provider: 'demo', configured: true } : { provider: config.serp?.provider ?? 'none', configured: config.serp !== null },
      volume: config.demo ? { provider: 'demo', configured: true } : { provider: config.volume ? 'dataforseo' : 'none', configured: config.volume !== null },
      limits: { maxCandidates: config.limits.maxCandidates, maxDeepPages: config.limits.maxPagesPerRun },
    };
  }

  /** Deletes cache files older than the TTL (called at startup and now and then). */
  pruneCache(): Promise<number> {
    return this.cache.prune();
  }

  private liveSerp(): SerpProvider | null {
    const s = this.config.serp;
    if (!s) return null;
    return s.provider === 'serper' ? new SerperProvider(s.apiKey) : new DataForSeoProvider(s.login, s.password);
  }

  private liveVolume(): VolumeProvider | null {
    const v = this.config.volume;
    return v ? new DataForSeoProvider(v.login, v.password) : null;
  }

  createRun(): RunHandle {
    const { config } = this;
    const meter = new Meter({ maxSerpCalls: config.limits.maxSerpCallsPerRun, maxPages: config.limits.maxPagesPerRun });

    if (config.demo) {
      const world = createDemoWorld();
      const noCache = new DiskCache(join(config.dataDir, 'cache'), 0);
      const jev = new Jev({
        transport: createSdkTransport({ apiKey: 'demo', baseURL: 'https://demo.invalid', model: 'jev-demo', flavor: 'custom', pricePerMTok: 0.042 }, createMockFetch()),
        model: 'jev-demo (mock)',
        pricePerMTok: 0.042,
      });
      return {
        deps: {
          jev,
          serp: new CachedSerpProvider(world.serp, noCache, meter),
          volume: new CachedVolumeProvider(world.volume, noCache, meter),
          fetcher: world.fetcher,
          meter,
          limits: { maxPagesPerRun: config.limits.maxPagesPerRun, maxCandidates: config.limits.maxCandidates },
          info: { mode: 'demo', serp: 'demo', volume: 'demo', jev: { model: 'jev-demo (mock)', endpoint: 'demo (без мрежа)' } },
        },
        close: async () => undefined,
      };
    }

    if (!config.jev) {
      throw new PipelineError('Jev не е настроен. Добави JEV_API_KEY в .env (или стартирай демо режима с „npm run demo“).', 'input');
    }
    const jevCfg = config.jev;
    const jev = new Jev({ transport: createSdkTransport(jevCfg), model: jevCfg.model, pricePerMTok: jevCfg.pricePerMTok });
    const serpRaw = this.liveSerp();
    const volumeRaw = this.liveVolume();
    const fetcher = new SafeFetcher({
      userAgent: config.crawler.userAgent,
      timeoutMs: config.crawler.timeoutMs,
      maxBytes: config.crawler.maxBytes,
      allowPrivateNetworks: config.crawler.allowPrivateNetworks,
    });
    const cachedFetcher: PageFetcher = new CachedFetcher(fetcher, this.cache);
    const described = describeJev(jevCfg);

    return {
      deps: {
        jev,
        serp: serpRaw ? new CachedSerpProvider(serpRaw, this.cache, meter) : null,
        volume: volumeRaw ? new CachedVolumeProvider(volumeRaw, this.cache, meter) : null,
        fetcher: cachedFetcher,
        meter,
        limits: { maxPagesPerRun: config.limits.maxPagesPerRun, maxCandidates: config.limits.maxCandidates },
        info: {
          mode: 'live',
          serp: serpRaw?.id ?? 'manual',
          volume: volumeRaw?.id ?? null,
          jev: { model: jevCfg.model, endpoint: described.host ?? 'custom' },
        },
      },
      close: () => fetcher.close(),
    };
  }
}
