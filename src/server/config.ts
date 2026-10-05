import { resolve } from 'node:path';

export type JevFlavor = 'typesafe' | 'vercel' | 'custom';

export interface JevConfig {
  apiKey: string;
  /** API root; the SDK appends /v1/systemone. */
  baseURL: string;
  model: string;
  flavor: JevFlavor;
  /** USD per million input tokens, used only for the cost estimate shown in reports. */
  pricePerMTok: number;
}

export type SerpConfig =
  | { provider: 'serper'; apiKey: string }
  | { provider: 'dataforseo'; login: string; password: string };

export interface AppConfig {
  host: string;
  port: number;
  appPassword: string | null;
  dataDir: string;
  demo: boolean;
  jev: JevConfig | null;
  serp: SerpConfig | null;
  /** DataForSEO credentials used for search volumes (independent of the SERP provider). */
  volume: { login: string; password: string } | null;
  crawler: {
    userAgent: string;
    timeoutMs: number;
    maxBytes: number;
    /** Only ever true in tests that crawl a local fixture server. */
    allowPrivateNetworks: boolean;
  };
  limits: {
    maxSerpCallsPerRun: number;
    maxPagesPerRun: number;
    maxConcurrentJobs: number;
    maxCandidates: number;
  };
  cacheTtlHours: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Невалидна конфигурация:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_USER_AGENT = 'JevSeoRadar/0.1 (+https://github.com/pavlovdevelop/jev-system-seo)';

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function int(
  problems: string[],
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const v = clean(raw);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} трябва да е цяло число между ${min} и ${max} (получено: "${v}")`);
    return fallback;
  }
  return n;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

/** Cleartext HTTP is only acceptable for loopback (local test doubles); API keys must never travel unencrypted. */
function validateBaseUrl(problems: string[], raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
      problems.push('JEV_BASE_URL трябва да е https:// (API ключът не бива да се изпраща некриптиран)');
    }
    return raw.replace(/\/+$/, '');
  } catch {
    problems.push(`JEV_BASE_URL не е валиден URL: "${raw}"`);
    return raw;
  }
}

export function resolveJevConfig(env: NodeJS.ProcessEnv, problems: string[]): JevConfig | null {
  const apiKey = clean(env.JEV_API_KEY) ?? clean(env.TYPESAFE_API_KEY);
  if (!apiKey) return null;

  const pricePerMTok = Number(clean(env.JEV_PRICE_PER_MTOK) ?? '0.042');
  const price = Number.isFinite(pricePerMTok) && pricePerMTok >= 0 ? pricePerMTok : 0.042;
  const explicitBase = clean(env.JEV_BASE_URL);
  const explicitModel = clean(env.JEV_MODEL);

  if (explicitBase) {
    return {
      apiKey,
      baseURL: validateBaseUrl(problems, explicitBase),
      model: explicitModel ?? 'jev-latest',
      flavor: 'custom',
      pricePerMTok: price,
    };
  }
  // Keys issued by Vercel AI Gateway start with "vck_"; the gateway speaks TypeSafe's wire format
  // at a different base URL and with its own model slug (documented by Vercel).
  if (apiKey.startsWith('vck_')) {
    return {
      apiKey,
      baseURL: 'https://ai-gateway.vercel.sh/typesafe',
      model: explicitModel ?? 'typesafe-ai/jev',
      flavor: 'vercel',
      pricePerMTok: price,
    };
  }
  return {
    apiKey,
    baseURL: 'https://api.typesafe.ai',
    model: explicitModel ?? 'jev-latest',
    flavor: 'typesafe',
    pricePerMTok: price,
  };
}

function resolveSerpConfig(env: NodeJS.ProcessEnv, problems: string[]): SerpConfig | null {
  const wanted = clean(env.SERP_PROVIDER)?.toLowerCase();
  const serperKey = clean(env.SERPER_API_KEY);
  const dfsLogin = clean(env.DATAFORSEO_LOGIN);
  const dfsPassword = clean(env.DATAFORSEO_PASSWORD);

  if (wanted === 'none') return null;
  if (wanted && wanted !== 'serper' && wanted !== 'dataforseo') {
    problems.push(`SERP_PROVIDER трябва да е serper, dataforseo или none (получено: "${wanted}")`);
    return null;
  }
  if (wanted === 'serper' || (!wanted && serperKey)) {
    if (!serperKey) {
      problems.push('SERP_PROVIDER=serper изисква SERPER_API_KEY');
      return null;
    }
    return { provider: 'serper', apiKey: serperKey };
  }
  if (wanted === 'dataforseo' || (!wanted && dfsLogin && dfsPassword)) {
    if (!dfsLogin || !dfsPassword) {
      problems.push('SERP_PROVIDER=dataforseo изисква DATAFORSEO_LOGIN и DATAFORSEO_PASSWORD');
      return null;
    }
    return { provider: 'dataforseo', login: dfsLogin, password: dfsPassword };
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): AppConfig {
  const problems: string[] = [];

  const demoFlag = argv.includes('--demo') || ['1', 'true'].includes((clean(env.DEMO_MODE) ?? '').toLowerCase());
  const host = clean(env.HOST) ?? '127.0.0.1';
  const port = int(problems, 'PORT', env.PORT, 8787, 1, 65535);
  const appPassword = clean(env.APP_PASSWORD) ?? null;

  const dfsLogin = clean(env.DATAFORSEO_LOGIN);
  const dfsPassword = clean(env.DATAFORSEO_PASSWORD);
  const volumeEnabled = (clean(env.VOLUME_PROVIDER) ?? '').toLowerCase() !== 'none';

  const config: AppConfig = {
    host,
    port,
    appPassword,
    dataDir: resolve(clean(env.DATA_DIR) ?? './data'),
    demo: demoFlag,
    jev: resolveJevConfig(env, problems),
    serp: resolveSerpConfig(env, problems),
    volume: volumeEnabled && dfsLogin && dfsPassword ? { login: dfsLogin, password: dfsPassword } : null,
    crawler: {
      userAgent: clean(env.CRAWLER_USER_AGENT) ?? DEFAULT_USER_AGENT,
      timeoutMs: int(problems, 'CRAWL_TIMEOUT_MS', env.CRAWL_TIMEOUT_MS, 12_000, 1_000, 60_000),
      maxBytes: int(problems, 'CRAWL_MAX_BYTES', env.CRAWL_MAX_BYTES, 2_000_000, 50_000, 20_000_000),
      allowPrivateNetworks: false,
    },
    limits: {
      maxSerpCallsPerRun: int(problems, 'MAX_SERP_CALLS_PER_RUN', env.MAX_SERP_CALLS_PER_RUN, 45, 1, 300),
      maxPagesPerRun: int(problems, 'MAX_PAGES_PER_RUN', env.MAX_PAGES_PER_RUN, 16, 1, 60),
      maxConcurrentJobs: int(problems, 'MAX_CONCURRENT_JOBS', env.MAX_CONCURRENT_JOBS, 2, 1, 10),
      maxCandidates: int(problems, 'MAX_CANDIDATES', env.MAX_CANDIDATES, 40, 0, 100),
    },
    cacheTtlHours: int(problems, 'CACHE_TTL_HOURS', env.CACHE_TTL_HOURS, 24, 0, 24 * 30),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Non-secret description of the Jev endpoint, safe to show in the UI and in reports. */
export function describeJev(jev: JevConfig | null): { flavor: JevFlavor | 'none'; model: string | null; host: string | null } {
  if (!jev) return { flavor: 'none', model: null, host: null };
  let host: string | null = null;
  try {
    host = new URL(jev.baseURL).host;
  } catch {
    host = null;
  }
  return { flavor: jev.flavor, model: jev.model, host };
}

export { isLoopbackHost };
