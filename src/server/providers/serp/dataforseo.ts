import { z } from 'zod';
import type { Market } from '../../../shared/markets';
import type { SerpData } from '../../../shared/schemas';
import { postJson, type FetchLike } from './http';
import { buildSerpData, SerpError, type CallOptions, type KeywordVolume, type SerpProvider, type SerpQuery, type VolumeProvider } from './types';

// DataForSEO — https://docs.dataforseo.com
//   SERP:   POST /v3/serp/google/organic/live/advanced
//   Volume: POST /v3/keywords_data/google_ads/search_volume/live   (one request prices the same for 1 or 1000 keywords)
// Auth is HTTP Basic (API login + API password from the DataForSEO dashboard). Bulgaria = location_code 2100.

const API = 'https://api.dataforseo.com';

const TaskEnvelope = z.object({
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  tasks: z
    .array(
      z.object({
        status_code: z.number().optional(),
        status_message: z.string().optional(),
        result: z.array(z.unknown()).nullable().optional(),
      }),
    )
    .default([]),
});

const SerpResultSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).nullable().default([]),
});

const OrganicItem = z.object({
  url: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  rank_absolute: z.number().nullish(),
  rank_group: z.number().nullish(),
});

const VolumeItem = z.object({
  keyword: z.string(),
  search_volume: z.number().nullish(),
  cpc: z.number().nullish(),
  competition_index: z.number().nullish(),
});

function authHeader(login: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}` };
}

/** Validates the envelope and returns the first task's result array, or throws a descriptive SerpError. */
function unwrap(raw: unknown, vendor: string): unknown[] {
  const env = TaskEnvelope.safeParse(raw);
  if (!env.success) throw new SerpError('bad_response', `${vendor}: неочакван формат на отговора`, undefined, { cause: env.error });
  const { status_code, status_message, tasks } = env.data;
  if (status_code !== undefined && status_code !== 20000) {
    if (status_code === 40101 || status_code === 40100) throw new SerpError('auth', `${vendor}: невалидни данни за достъп (${status_message ?? status_code})`);
    if (status_code === 40200 || status_code === 40201) throw new SerpError('quota', `${vendor}: недостатъчен баланс (${status_message ?? status_code})`);
    throw new SerpError('bad_response', `${vendor}: ${status_message ?? `код ${status_code}`}`);
  }
  const task = tasks[0];
  if (!task) throw new SerpError('bad_response', `${vendor}: липсва резултат`);
  if (task.status_code !== undefined && task.status_code !== 20000) {
    throw new SerpError('bad_response', `${vendor}: ${task.status_message ?? `код ${task.status_code}`}`);
  }
  return task.result ?? [];
}

export class DataForSeoProvider implements SerpProvider, VolumeProvider {
  readonly id = 'dataforseo' as const;

  constructor(
    private readonly login: string,
    private readonly password: string,
    private readonly fetchImpl?: FetchLike,
    private readonly baseUrl = API,
  ) {}

  private opts(options: CallOptions) {
    return {
      vendor: 'DataForSEO',
      headers: authHeader(this.login, this.password),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }

  async search(query: SerpQuery, options: CallOptions = {}): Promise<SerpData> {
    const raw = await postJson(
      `${this.baseUrl}/v3/serp/google/organic/live/advanced`,
      [{ keyword: query.keyword, location_code: query.market.dfsLocationCode, language_code: query.market.dfsLanguageCode, device: 'desktop', depth: query.depth }],
      this.opts(options),
    );
    const first = unwrap(raw, 'DataForSEO')[0];
    const parsed = SerpResultSchema.safeParse(first ?? {});
    if (!parsed.success) throw new SerpError('bad_response', 'DataForSEO: неочакван формат на SERP', undefined, { cause: parsed.error });

    const organic: Array<{ url: string; title?: string; snippet?: string; position?: number }> = [];
    const paa: Array<{ question: string; snippet?: string }> = [];
    const related: string[] = [];

    for (const item of parsed.data.items ?? []) {
      const type = item.type;
      if (type === 'organic') {
        const o = OrganicItem.safeParse(item);
        if (o.success) {
          organic.push({
            url: o.data.url,
            ...(o.data.title ? { title: o.data.title } : {}),
            ...(o.data.description ? { snippet: o.data.description } : {}),
            ...(o.data.rank_group ? { position: o.data.rank_group } : {}),
          });
        }
      } else if (type === 'people_also_ask') {
        for (const el of Array.isArray(item.items) ? (item.items as Array<Record<string, unknown>>) : []) {
          if (typeof el.title === 'string') paa.push({ question: el.title });
        }
      } else if (type === 'related_searches') {
        for (const el of Array.isArray(item.items) ? (item.items as unknown[]) : []) {
          if (typeof el === 'string') related.push(el);
          else if (el && typeof el === 'object') {
            const t = (el as Record<string, unknown>).title ?? (el as Record<string, unknown>).query;
            if (typeof t === 'string') related.push(t);
          }
        }
      }
    }
    return buildSerpData({ provider: this.id, keyword: query.keyword, market: query.market, organic, peopleAlsoAsk: paa, relatedSearches: related });
  }

  async volumes(keywords: readonly string[], market: Market, options: CallOptions = {}): Promise<Map<string, KeywordVolume>> {
    // Google Ads limits: ≤1000 keywords per request, ≤80 characters and ≤10 words each.
    const usable = [...new Set(keywords.map((k) => k.trim()).filter((k) => k && k.length <= 80 && k.split(/\s+/).length <= 10))].slice(0, 1000);
    const out = new Map<string, KeywordVolume>();
    if (usable.length === 0) return out;

    const raw = await postJson(
      `${this.baseUrl}/v3/keywords_data/google_ads/search_volume/live`,
      [{ keywords: usable, location_code: market.dfsLocationCode, language_code: market.dfsLanguageCode }],
      this.opts(options),
    );
    for (const row of unwrap(raw, 'DataForSEO')) {
      const v = VolumeItem.safeParse(row);
      if (!v.success) continue;
      out.set(v.data.keyword.trim().toLowerCase(), {
        volume: v.data.search_volume ?? null,
        cpc: v.data.cpc ?? null,
        competitionIndex: v.data.competition_index ?? null,
      });
    }
    return out;
  }
}
