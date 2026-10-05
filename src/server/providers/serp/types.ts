import { getDomain, getHostname } from 'tldts';
import type { Market } from '../../../shared/markets';
import type { SerpData } from '../../../shared/schemas';

export type SerpErrorKind = 'auth' | 'quota' | 'rate_limit' | 'unavailable' | 'bad_response' | 'budget';

export class SerpError extends Error {
  constructor(
    public readonly kind: SerpErrorKind,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SerpError';
  }

  /** Errors after which further calls to the same provider are pointless. */
  get fatal(): boolean {
    return this.kind === 'auth' || this.kind === 'quota' || this.kind === 'budget';
  }
}

export interface SerpQuery {
  keyword: string;
  market: Market;
  /** Number of organic results to request. */
  depth: 10 | 20;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface SerpProvider {
  readonly id: 'serper' | 'dataforseo' | 'demo';
  search(query: SerpQuery, options?: CallOptions): Promise<SerpData>;
  /** Autocomplete suggestions; optional and always best-effort. */
  suggest?(keyword: string, market: Market, options?: CallOptions): Promise<string[]>;
}

export interface KeywordVolume {
  /** Average monthly searches; null when the data source has no figure. */
  volume: number | null;
  cpc: number | null;
  /** Google Ads competition index, 0..100. */
  competitionIndex: number | null;
}

export interface VolumeProvider {
  readonly id: 'dataforseo' | 'demo';
  /** Returns volumes keyed by the lowercase keyword. Keywords without data are simply absent. */
  volumes(keywords: readonly string[], market: Market, options?: CallOptions): Promise<Map<string, KeywordVolume>>;
}

/** Registrable domain (eTLD+1, treating hosted platforms like wixsite.com as public suffixes). */
export function domainOf(url: string): string {
  const d = getDomain(url, { allowPrivateDomains: true });
  if (d) return d.toLowerCase();
  return (getHostname(url) ?? '').replace(/^www\./, '').toLowerCase();
}

export const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

const squash = (s: string | undefined | null): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** Builds a SerpData from loosely-typed provider rows, dropping non-http links and duplicate URLs. */
export function buildSerpData(input: {
  provider: string;
  keyword: string;
  market: Market;
  organic: Array<{ url: string; title?: string | undefined; snippet?: string | undefined; position?: number | undefined }>;
  peopleAlsoAsk?: Array<{ question: string; snippet?: string | undefined }>;
  relatedSearches?: string[];
  suggestions?: string[];
  now?: Date;
}): SerpData {
  const seen = new Set<string>();
  const results: SerpData['results'] = [];
  input.organic.forEach((row, index) => {
    if (!isHttpUrl(row.url) || seen.has(row.url)) return;
    seen.add(row.url);
    results.push({
      position: Number.isInteger(row.position) && (row.position as number) > 0 ? (row.position as number) : index + 1,
      url: row.url,
      domain: domainOf(row.url),
      title: squash(row.title),
      snippet: squash(row.snippet),
    });
  });
  results.sort((a, b) => a.position - b.position);

  const uniq = (list: string[]) => [...new Set(list.map(squash).filter(Boolean))];
  const paa = new Map<string, { question: string; snippet: string | null }>();
  for (const p of input.peopleAlsoAsk ?? []) {
    const question = squash(p.question);
    if (question && !paa.has(question.toLowerCase())) paa.set(question.toLowerCase(), { question, snippet: squash(p.snippet) || null });
  }
  return {
    keyword: input.keyword,
    market: input.market.id,
    fetchedAt: (input.now ?? new Date()).toISOString(),
    provider: input.provider,
    results,
    peopleAlsoAsk: [...paa.values()],
    relatedSearches: uniq(input.relatedSearches ?? []),
    suggestions: uniq(input.suggestions ?? []),
  };
}
