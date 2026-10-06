import type { EngineId } from '../../../shared/domain';
import type { MarketId } from '../../../shared/markets';
import { stripInvisible } from '../../../shared/text';
import { domainOf, isHttpUrl } from '../../providers/serp/types';

// The contract between the GEO pipeline and the three assistants (ChatGPT, Claude, Gemini). Everything above the
// "helpers" banner is the interface the pipeline codes against; below it are the small tools every adapter (and the
// demo engines) use to keep the answers they return inside the limits promised here.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface EngineCitation {
  url: string;
  title: string;
  /** registrable domain, lower-case, e.g. "healthline.com" */
  domain: string;
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  /** web searches the engine ran (0 when unknown) */
  searches: number;
}

export interface EngineAnswer {
  /** answer text, capped at 12,000 chars */
  text: string;
  /** sources the answer relies on (inline citations / grounding), de-duplicated by url, in order of appearance, max 30 */
  citations: EngineCitation[];
  /** other sources the engine retrieved but did not cite (may be empty), max 30 */
  consulted: EngineCitation[];
  /** true if the web-search tool ran at least once */
  searched: boolean;
  /** search queries the engine issued (max 10) */
  queries: string[];
  latencyMs: number;
  usage: EngineUsage;
  /** model that actually answered (from the response when present, else the configured one) */
  model: string;
}

export interface AskOptions {
  /** Where the asker is; steers the search. country = ISO 3166-1 alpha-2, timezone = IANA name. */
  location: { country: string; timezone: string };
  signal?: AbortSignal;
}

export interface GenerateRequest {
  system?: string;
  prompt: string;
  /** default 2000 */
  maxTokens?: number;
  signal?: AbortSignal;
  /** the prompt asks for JSON only; use the vendor's JSON mode where it is documented */
  json?: boolean;
}

export interface GenerateResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type EngineErrorKind = 'auth' | 'rate_limit' | 'quota' | 'model' | 'refused' | 'unavailable' | 'bad_response' | 'aborted';

export class EngineError extends Error {
  constructor(
    public readonly kind: EngineErrorKind,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EngineError';
  }

  /** Errors after which further calls to the same engine are pointless: every one of them would fail the same way. */
  get fatal(): boolean {
    return this.kind === 'auth' || this.kind === 'model' || this.kind === 'aborted';
  }
}

export interface AnswerEngine {
  readonly id: EngineId;
  /** ENGINE_LABELS[id] */
  readonly label: string;
  readonly model: string;
  /** Asks a buyer question exactly as a person would type it — no extra instructions — with the web-search tool on. */
  ask(question: string, options: AskOptions): Promise<EngineAnswer>;
  /** Plain text generation, no web search (used for writing proposals/checklists). */
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export interface EngineConfig {
  apiKey: string;
  model: string;
}

export interface EnginesConfig {
  openai: EngineConfig | null;
  anthropic: EngineConfig | null;
  gemini: EngineConfig | null;
}

export interface EngineFactoryOptions {
  fetchImpl?: FetchLike;
  /** per request, default 90_000 for ask, 120_000 for generate */
  timeoutMs?: number;
  /** retries after the first attempt for 429/5xx/network errors, default 2 */
  retries?: number;
}

/** Where the asker is, per market: steers the assistants' web search toward that country. */
export function locationFor(marketId: MarketId): { country: string; timezone: string } {
  switch (marketId) {
    case 'gb':
      return { country: 'GB', timezone: 'Europe/London' };
    case 'us':
      return { country: 'US', timezone: 'America/New_York' };
    case 'bg':
    case 'bg-en':
      return { country: 'BG', timezone: 'Europe/Sofia' };
  }
}

// ───────────────────────── helpers shared by the adapters ─────────────────────────

/** The location as the vendors want it: the country code in capitals (a caller may hand in a Google `gl` such as "bg"). */
export const vendorLocation = (location: AskOptions['location']): { country: string; timezone: string } => ({
  country: location.country.trim().toUpperCase(),
  timezone: location.timezone.trim(),
});

export const MAX_ANSWER_CHARS = 12_000;
export const MAX_CITATIONS = 30;
export const MAX_CONSULTED = 30;
export const MAX_QUERIES = 10;

/** Cut-offs while reading a response, so a runaway reply cannot grow the buffers without bound. */
const TEXT_INTAKE_LIMIT = 4 * MAX_ANSWER_CHARS;
const SOURCE_INTAKE_LIMIT = 200;
const MAX_URL_CHARS = 2048;
const MAX_TITLE_CHARS = 300;
const MAX_QUERY_CHARS = 300;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A token/search count: only a finite, positive number counts; anything else is 0. */
export const asCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Cuts a string to at most `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Text that came from a third party (page titles, model output): invisible characters out, whitespace collapsed. */
const tidy = (value: unknown, max: number): string => (typeof value === 'string' ? capText(stripInvisible(value).replace(/\s+/g, ' ').trim(), max) : '');

/**
 * Gathers what an assistant's reply contains and enforces the limits of EngineAnswer: text capped, sources
 * de-duplicated (by domain + url) in order of appearance and capped, retrieved-but-uncited sources kept apart from
 * the cited ones, queries unique and capped. Adapters feed it as they walk the reply and call build() at the end.
 */
export class AnswerCollector {
  private text = '';
  private readonly cited = new Map<string, EngineCitation>();
  private readonly retrieved = new Map<string, EngineCitation>();
  private readonly asked = new Set<string>();

  /**
   * Appends a piece of the answer. `newBlock` says the piece starts after something that is not text (a search, a
   * separate message): if the text so far and the piece would run together without a space, a paragraph break goes between.
   */
  appendText(piece: unknown, newBlock = false): void {
    if (typeof piece !== 'string' || piece === '' || this.text.length >= TEXT_INTAKE_LIMIT) return;
    if (newBlock && this.text !== '' && !/\s$/.test(this.text) && !/^\s/.test(piece)) this.text += '\n\n';
    this.text += piece;
  }

  /** A source the answer relies on. `domain` overrides the one derived from the url (Gemini hides the real host behind a redirect). */
  cite(url: unknown, title?: unknown, domain?: string): void {
    this.add(this.cited, MAX_CITATIONS, url, title, domain);
  }

  /** A source the engine retrieved. It is reported as "consulted" only when it was not cited as well. */
  consult(url: unknown, title?: unknown, domain?: string): void {
    this.add(this.retrieved, SOURCE_INTAKE_LIMIT, url, title, domain);
  }

  query(query: unknown): void {
    const q = tidy(query, MAX_QUERY_CHARS);
    if (q !== '' && this.asked.size < MAX_QUERIES) this.asked.add(q);
  }

  /** The answer so far, cleaned, without the 12,000-character cap (for plain text generation). */
  fullText(maxChars = 100_000): string {
    return capText(stripInvisible(this.text).trim(), maxChars);
  }

  get hasText(): boolean {
    return this.fullText(1).length > 0;
  }

  build(meta: { searched: boolean; latencyMs: number; usage: EngineUsage; model: string }): EngineAnswer {
    const citations = [...this.cited.values()].slice(0, MAX_CITATIONS);
    const consulted = [...this.retrieved.entries()].filter(([key]) => !this.cited.has(key)).map(([, c]) => c).slice(0, MAX_CONSULTED);
    return {
      text: capText(stripInvisible(this.text).trim(), MAX_ANSWER_CHARS),
      citations,
      consulted,
      searched: meta.searched,
      queries: [...this.asked],
      latencyMs: meta.latencyMs,
      usage: meta.usage,
      model: meta.model,
    };
  }

  private add(into: Map<string, EngineCitation>, limit: number, url: unknown, title: unknown, domain: string | undefined): void {
    if (into.size >= limit || typeof url !== 'string') return;
    const clean = url.trim();
    if (clean.length > MAX_URL_CHARS || !isHttpUrl(clean)) return;
    const host = (domain || domainOf(clean)).toLowerCase();
    if (host === '') return;
    const key = `${host}|${clean}`;
    if (!into.has(key)) into.set(key, { url: clean, title: tidy(title, MAX_TITLE_CHARS), domain: host });
  }
}

/** Whole milliseconds since `started` (a performance.now() reading). */
export const elapsedMs = (started: number): number => Math.max(0, Math.round(performance.now() - started));
