import { z } from 'zod';
import type { Market } from '../../../shared/markets';
import type { SerpData } from '../../../shared/schemas';
import { postJson, type FetchLike } from './http';
import { buildSerpData, SerpError, type CallOptions, type SerpProvider, type SerpQuery } from './types';

// Serper.dev — Google results as JSON. https://serper.dev
//   POST https://google.serper.dev/search   headers: X-API-KEY   body: { q, gl, hl, num }
// The response schema is parsed leniently: unknown fields are ignored and optional blocks may be missing.

const OrganicSchema = z.object({
  title: z.string().optional(),
  link: z.string(),
  snippet: z.string().optional(),
  position: z.number().optional(),
});

const SearchResponseSchema = z.object({
  organic: z.array(OrganicSchema).default([]),
  peopleAlsoAsk: z.array(z.object({ question: z.string(), snippet: z.string().optional() })).default([]),
  relatedSearches: z.array(z.object({ query: z.string() })).default([]),
});

const AutocompleteSchema = z.object({
  suggestions: z.array(z.union([z.string(), z.object({ value: z.string() })])).default([]),
});

export class SerperProvider implements SerpProvider {
  readonly id = 'serper' as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl?: FetchLike,
    private readonly baseUrl = 'https://google.serper.dev',
  ) {}

  async search(query: SerpQuery, options: CallOptions = {}): Promise<SerpData> {
    const raw = await postJson(
      `${this.baseUrl}/search`,
      { q: query.keyword, gl: query.market.gl, hl: query.market.hl, num: query.depth },
      { vendor: 'Serper', secrets: [this.apiKey], headers: { 'x-api-key': this.apiKey }, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), ...(options.signal ? { signal: options.signal } : {}) },
    );
    const parsed = SearchResponseSchema.safeParse(raw);
    if (!parsed.success) throw new SerpError('bad_response', 'Serper: неочакван формат на отговора', undefined, { cause: parsed.error });
    const data = parsed.data;
    return buildSerpData({
      provider: this.id,
      keyword: query.keyword,
      market: query.market,
      organic: data.organic.map((o) => ({ url: o.link, title: o.title, snippet: o.snippet, position: o.position })),
      peopleAlsoAsk: data.peopleAlsoAsk,
      relatedSearches: data.relatedSearches.map((r) => r.query),
    });
  }

  async suggest(keyword: string, market: Market, options: CallOptions = {}): Promise<string[]> {
    try {
      const raw = await postJson(
        `${this.baseUrl}/autocomplete`,
        { q: keyword, gl: market.gl, hl: market.hl },
        { vendor: 'Serper', secrets: [this.apiKey], retries: 0, headers: { 'x-api-key': this.apiKey }, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), ...(options.signal ? { signal: options.signal } : {}) },
      );
      const parsed = AutocompleteSchema.safeParse(raw);
      if (!parsed.success) return [];
      return parsed.data.suggestions.map((s) => (typeof s === 'string' ? s : s.value));
    } catch (err) {
      // Autocomplete is a bonus source: only a dead key/quota should stop the run, everything else is ignored.
      if (err instanceof SerpError && err.fatal) throw err;
      return [];
    }
  }
}
