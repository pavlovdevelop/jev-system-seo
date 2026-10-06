import { join } from 'node:path';
import { ENGINE_IDS, ENGINE_LABELS } from '../shared/domain';
import type { StatusResponse } from '../shared/schemas';
import type { AuditDeps } from './audit/pipeline';
import { llmWriter, rulesWriter } from './audit/writer';
import { describeJev, type AppConfig } from './config';
import { createExtractor, InProcessExtractor, type PageExtractor } from './crawl/extract-pool';
import { SafeFetcher, type PageFetcher } from './crawl/fetcher';
import { createDemoSiteWorld, DEMO_AUDIT_DEFAULTS } from './demo/site-world';
import { DEMO_BUSINESS, DEMO_KEYWORD, DEMO_OWN_DOMAIN, createDemoWorld } from './demo/world';
import { createEngines } from './geo/engines';
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

export const DEMO_DEFAULTS = {
  keyword: DEMO_KEYWORD,
  businessDescription: DEMO_BUSINESS,
  ownDomain: DEMO_OWN_DOMAIN,
  competitors: ['pixel-studio.example', 'webmasters-bg.example'],
  brandNames: [...DEMO_AUDIT_DEFAULTS.brandNames],
};

export interface RunHandle {
  deps: PipelineDeps;
  /** Releases sockets etc. Always call once the run is over. */
  close(): Promise<void>;
}

export interface AuditRunHandle {
  deps: AuditDeps;
  close(): Promise<void>;
}

/** Builds the per-run dependency graph (fresh Jev client, meter and fetcher, so usage numbers are exact). */
export class Runtime {
  private readonly cache: DiskCache;
  private extractorInstance: PageExtractor | null = null;

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
      engines: ENGINE_IDS.map((id) => ({
        id,
        label: ENGINE_LABELS[id],
        configured: config.demo || config.engines[id] !== null,
        model: config.demo ? 'демо' : (config.engines[id]?.model ?? null),
      })),
      writer: { configured: !config.demo && config.writer !== null, engine: config.demo ? null : config.writer },
      audit: { maxPages: config.audit.maxPages, maxQuestions: config.audit.maxQuestions, maxEngineCalls: config.audit.maxEngineCalls },
    };
  }

  /** One page extractor — and so at most one worker thread — serves every analysis. It starts its thread on first use. */
  get extractor(): PageExtractor {
    return (this.extractorInstance ??= createExtractor());
  }

  /** Deletes the cache files whose time is up (called at startup and now and then). */
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
        extractor: this.extractor,
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

  /**
   * The dependencies of one whole-site audit. Pages are never cached here: an audit of your own site must see it as
   * it is now, not as it was yesterday. Jev gets more parallel requests than in a keyword analysis (an audit asks
   * several questions about every page).
   */
  createAuditRun(): AuditRunHandle {
    const { config } = this;
    const meter = new Meter({ maxSerpCalls: config.limits.maxSerpCallsPerRun, maxPages: 1_000_000 });
    const limits = { maxPages: config.audit.maxPages, maxQuestions: config.audit.maxQuestions, maxEngineCalls: config.audit.maxEngineCalls };

    if (config.demo) {
      const world = createDemoSiteWorld();
      const noCache = new DiskCache(join(config.dataDir, 'cache'), 0);
      const jev = new Jev({
        transport: createSdkTransport({ apiKey: 'demo', baseURL: 'https://demo.invalid', model: 'jev-demo', flavor: 'custom', pricePerMTok: 0.042 }, createMockFetch()),
        model: 'jev-demo (mock)',
        pricePerMTok: 0.042,
        maxConcurrency: 16,
      });
      return {
        deps: {
          jev,
          serp: new CachedSerpProvider(world.serp, noCache, meter),
          volume: new CachedVolumeProvider(world.volume, noCache, meter),
          fetcher: world.fetcher,
          extractor: new InProcessExtractor(),
          engines: world.engines,
          writer: rulesWriter,
          meter,
          limits,
          info: { mode: 'demo', serp: 'demo', jev: { model: 'jev-demo (mock)', endpoint: 'demo (без мрежа)' } },
          brandHints: world.brandHints,
        },
        close: async () => undefined,
      };
    }

    if (!config.jev) {
      throw new PipelineError('Jev не е настроен. Добави JEV_API_KEY в .env (или стартирай демо режима с „npm run demo“).', 'input');
    }
    const jevCfg = config.jev;
    const jev = new Jev({ transport: createSdkTransport(jevCfg), model: jevCfg.model, pricePerMTok: jevCfg.pricePerMTok, maxConcurrency: 12 });
    const serpRaw = this.liveSerp();
    const volumeRaw = this.liveVolume();
    const fetcher = new SafeFetcher({
      userAgent: config.crawler.userAgent,
      timeoutMs: config.crawler.timeoutMs,
      maxBytes: config.crawler.maxBytes,
      allowPrivateNetworks: config.crawler.allowPrivateNetworks,
    });
    const engines = createEngines(config.engines);
    const writerEngine = config.writer ? engines.find((e) => e.id === config.writer) : undefined;
    const described = describeJev(jevCfg);
    return {
      deps: {
        jev,
        serp: serpRaw ? new CachedSerpProvider(serpRaw, this.cache, meter) : null,
        volume: volumeRaw ? new CachedVolumeProvider(volumeRaw, this.cache, meter) : null,
        fetcher,
        extractor: this.extractor,
        engines,
        writer: writerEngine ? llmWriter(writerEngine) : rulesWriter,
        meter,
        limits,
        info: { mode: 'live', serp: serpRaw?.id ?? null, jev: { model: jevCfg.model, endpoint: described.host ?? 'custom' } },
      },
      close: () => fetcher.close(),
    };
  }
}
