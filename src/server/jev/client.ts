import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type ChoiceQuestion,
  type EntryType,
  type Fetch,
  type NoulQuestion,
  type Question,
  type Questions,
  type ScoreQuestion,
} from '@typesafe-ai/sdk';
import type { JevConfig } from '../config';
import { fnv1a, seededShuffle, sha1Hex } from '../util/hash';
import { createLimiter } from '../util/limit';

// ───────────────────────── typed answers ─────────────────────────

export interface NoulResult {
  /** Probability that the answer is yes (0..1). */
  p: number;
}

export interface ChoiceResult<K extends string = string> {
  value: K;
  /** Probability of the selected option. */
  p: number;
  /** 0 = Jev could not separate the options, 1 = certain. See https://docs.typesafe.ai/confidence */
  confidence: number;
  probabilities: Record<K, number>;
  runnerUp: { value: K; p: number } | null;
}

export interface ScoreResult {
  /** Expected level in rubric units (may fall between levels). */
  raw: number;
  /** raw / (levels - 1), 0..1. */
  value: number;
  levels: number;
  confidence: number;
  probabilities: number[];
}

type AnswerFor<T> = T extends NoulQuestion
  ? NoulResult
  : T extends ScoreQuestion
    ? ScoreResult
    : T extends ChoiceQuestion<infer C>
      ? ChoiceResult<Extract<keyof C, string>>
      : never;

export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };
type ChoiceKeys<Q extends Questions> = {
  [K in keyof Q]: Q[K] extends ChoiceQuestion ? K : never;
}[keyof Q] &
  string;

// ───────────────────────── errors ─────────────────────────

export type JevErrorKind = 'auth' | 'rate_limit' | 'invalid_request' | 'unavailable' | 'bad_response' | 'aborted';

export class JevError extends Error {
  constructor(
    public readonly kind: JevErrorKind,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'JevError';
  }

  /** Errors that make every further Jev call pointless (wrong key, revoked access). */
  get fatal(): boolean {
    return this.kind === 'auth' || this.kind === 'aborted';
  }
}

function describeBody(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300);
  if (body && typeof body === 'object') {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string') return m.slice(0, 300);
    try {
      return JSON.stringify(body).slice(0, 300);
    } catch {
      return '';
    }
  }
  return '';
}

export function toJevError(err: unknown): JevError {
  if (err instanceof JevError) return err;
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new JevError('auth', 'Jev отхвърли API ключа (401/403). Провери JEV_API_KEY и JEV_BASE_URL.', err.status, { cause: err });
  }
  if (err instanceof UnprocessableEntityError || err instanceof BadRequestError) {
    return new JevError('invalid_request', `Jev отхвърли заявката: ${describeBody(err.body)}`, err.status, { cause: err });
  }
  if (err instanceof RateLimitError) {
    return new JevError('rate_limit', 'Jev ограничи заявките (429) и повторенията свършиха.', 429, { cause: err });
  }
  if (err instanceof APIUserAbortError) return new JevError('aborted', 'Заявката към Jev е прекратена.', undefined, { cause: err });
  if (err instanceof APIError) {
    return new JevError('unavailable', `Jev върна грешка ${err.status}: ${describeBody(err.body)}`, err.status, { cause: err });
  }
  if (err instanceof APIConnectionError) {
    return new JevError('unavailable', `Няма връзка с Jev: ${err.message}`, undefined, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new JevError('unavailable', `Неочаквана грешка при Jev: ${message}`, undefined, { cause: err });
}

// ───────────────────────── confidence maths (docs.typesafe.ai/confidence) ─────────────────────────

export function choiceConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n <= 1) return 1;
  const pmax = Math.max(...probabilities);
  return clamp01((pmax - 1 / n) / (1 - 1 / n));
}

export function scoreConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n <= 1) return 1;
  let m = 0;
  for (let i = 1; i < n; i++) if ((probabilities[i] ?? 0) > (probabilities[m] ?? 0)) m = i;
  let spread = 0;
  probabilities.forEach((p, i) => (spread += p * Math.abs(i - m)));
  let evenSpread = 0;
  for (let i = 0; i < n; i++) evenSpread += Math.abs(i - (n - 1) / 2);
  evenSpread /= n;
  return clamp01(1 - spread / evenSpread);
}

/** Distance from 0.5, the docs' suggested confidence-style number for a Noul. */
export const noulConfidence = (p: number): number => Math.abs(2 * p - 1);

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function normalise(values: number[]): number[] {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  return sum > 0 ? clean.map((v) => v / sum) : clean.map(() => 1 / clean.length);
}

// ───────────────────────── transport abstraction ─────────────────────────

export interface SystemOneResponse {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

/** The slice of the TypeSafe client we use; tests and the demo mode provide their own implementations. */
export interface SystemOneTransport {
  systemOne(
    request: { state: EntryType; questions: Questions; model?: string },
    options?: { signal?: AbortSignal },
  ): PromiseLike<SystemOneResponse>;
}

export function createSdkTransport(cfg: JevConfig, fetchImpl?: Fetch): SystemOneTransport {
  const sdk = new TypeSafeClient({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    defaultModel: cfg.model,
    timeout: 20_000,
    retry: { maxRetries: 3 },
    logLevel: 'warn',
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return {
    systemOne: (request, options) => sdk.systemOne(request, options) as unknown as PromiseLike<SystemOneResponse>,
  };
}

// ───────────────────────── response validation ─────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseNoul(id: string, raw: unknown): NoulResult {
  const v = isRecord(raw) ? raw.noul : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new JevError('bad_response', `Jev: липсва числов отговор "noul" за въпрос "${id}"`);
  }
  return { p: clamp01(v) };
}

function parseChoice(id: string, raw: unknown, question: ChoiceQuestion): ChoiceResult {
  const options = Object.keys(question.criteria);
  if (!isRecord(raw)) throw new JevError('bad_response', `Jev: невалиден отговор за "${id}"`);
  const probs = isRecord(raw.probabilities) ? raw.probabilities : {};
  const weights = normalise(options.map((o) => (typeof probs[o] === 'number' ? (probs[o] as number) : 0)));
  const hasProbs = options.some((o) => typeof probs[o] === 'number');

  let value = typeof raw.choice === 'string' && options.includes(raw.choice) ? raw.choice : undefined;
  if (value === undefined && hasProbs) value = options[weights.indexOf(Math.max(...weights))];
  if (value === undefined) throw new JevError('bad_response', `Jev: непознат избор за "${id}"`);

  const probabilities = Object.fromEntries(options.map((o, i) => [o, weights[i] ?? 0]));
  const ranked = options.map((o) => [o, probabilities[o] ?? 0] as const).sort((a, b) => b[1] - a[1]);
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? clamp01(raw.confidence)
      : choiceConfidence(weights);
  const second = ranked.find(([o]) => o !== value);
  return {
    value,
    p: probabilities[value] ?? 0,
    confidence,
    probabilities,
    runnerUp: second ? { value: second[0], p: second[1] } : null,
  };
}

function parseScore(id: string, raw: unknown, question: ScoreQuestion): ScoreResult {
  const levels = question.criteria.length;
  if (!isRecord(raw) || typeof raw.score !== 'number' || !Number.isFinite(raw.score)) {
    throw new JevError('bad_response', `Jev: липсва числов отговор "score" за "${id}"`);
  }
  // The wire format documents `probabilities` as a map keyed by level ("0".."n-1"); SDK examples show arrays.
  // Accept both so a harmless format difference does not break the pipeline.
  const rawProbs = raw.probabilities;
  const probs = Array.from({ length: levels }, (_, i) => {
    const v = Array.isArray(rawProbs) ? rawProbs[i] : isRecord(rawProbs) ? rawProbs[String(i)] : undefined;
    return typeof v === 'number' ? v : 0;
  });
  const probabilities = normalise(probs);
  const rawScore = Math.min(levels - 1, Math.max(0, raw.score));
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? clamp01(raw.confidence)
      : scoreConfidence(probabilities);
  return { raw: rawScore, value: rawScore / (levels - 1), levels, confidence, probabilities };
}

function parseAnswer(id: string, raw: unknown, question: Question): NoulResult | ChoiceResult | ScoreResult {
  switch (question.type) {
    case 'noul':
      return parseNoul(id, raw);
    case 'choice':
      return parseChoice(id, raw, question);
    case 'score':
      return parseScore(id, raw, question);
  }
}

/** Average two distributions over the same options (used to cancel option-order bias). */
function mergeChoice(a: ChoiceResult, b: ChoiceResult): ChoiceResult {
  const options = Object.keys(a.probabilities);
  const weights = options.map((o) => ((a.probabilities[o] ?? 0) + (b.probabilities[o] ?? 0)) / 2);
  const probabilities = Object.fromEntries(options.map((o, i) => [o, weights[i] ?? 0]));
  const ranked = options.map((o) => [o, probabilities[o] ?? 0] as const).sort((x, y) => y[1] - x[1]);
  const [top, second] = [ranked[0], ranked[1]];
  return {
    value: top?.[0] ?? a.value,
    p: top?.[1] ?? 0,
    confidence: choiceConfidence(weights),
    probabilities,
    runnerUp: second ? { value: second[0], p: second[1] } : null,
  };
}

// ───────────────────────── the Jev facade ─────────────────────────

export interface JevStats {
  requests: number;
  cacheHits: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface AskOptions<Q extends Questions> {
  /**
   * Choice questions to ask twice in one request — once with the options in the given order and once reversed —
   * and average the two distributions. Jev leans towards the first option, so this cancels that bias
   * (docs.typesafe.ai/model-jaggedness/jev-1.13, "Choice option order").
   */
  debias?: ReadonlyArray<ChoiceKeys<Q>>;
  /** Deterministically shuffle the option order of every choice, so any residual bias spreads across items. */
  shuffleChoices?: boolean;
  signal?: AbortSignal;
}

export interface JevOptions {
  transport: SystemOneTransport;
  model: string;
  maxConcurrency?: number;
  pricePerMTok?: number;
  cacheSize?: number;
  logger?: Pick<Console, 'warn' | 'debug'>;
}

const REVERSED = '__rev';

export class Jev {
  readonly model: string;
  private readonly transport: SystemOneTransport;
  private readonly limit: ReturnType<typeof createLimiter>;
  private readonly pricePerMTok: number;
  private readonly cache = new Map<string, Answers<Questions>>();
  private readonly cacheSize: number;
  private readonly logger: Pick<Console, 'warn' | 'debug'>;
  private readonly warned = new Set<string>();
  private readonly counters = { requests: 0, cacheHits: 0, failures: 0, inputTokens: 0, outputTokens: 0 };

  constructor(options: JevOptions) {
    this.transport = options.transport;
    this.model = options.model;
    this.limit = createLimiter(options.maxConcurrency ?? 8);
    this.pricePerMTok = options.pricePerMTok ?? 0.042;
    this.cacheSize = options.cacheSize ?? 2000;
    this.logger = options.logger ?? console;
  }

  stats(): JevStats {
    return {
      ...this.counters,
      estimatedCostUsd: (this.counters.inputTokens * this.pricePerMTok) / 1_000_000,
    };
  }

  /** Asks all questions about one state in a single request. Throws JevError on failure. */
  async ask<const Q extends Questions>(state: EntryType, questions: Q, options: AskOptions<Q> = {}): Promise<Answers<Q>> {
    const debias = new Set<string>(options.debias ?? []);
    const seed = fnv1a(typeof state === 'string' ? state : JSON.stringify(state));

    // Build the wire questions: optionally shuffle choice options, optionally add a reversed twin.
    const wire: Record<string, Question> = {};
    for (const [id, question] of Object.entries(questions) as Array<[string, Question]>) {
      if (id.endsWith(REVERSED)) throw new Error(`Question id must not end with "${REVERSED}": ${id}`);
      if (question.type !== 'choice') {
        wire[id] = question;
        continue;
      }
      const keys = Object.keys(question.criteria);
      const forward = options.shuffleChoices ? seededShuffle(keys, seed ^ fnv1a(id)) : keys;
      wire[id] = withOrder(question, forward);
      if (debias.has(id)) wire[`${id}${REVERSED}`] = withOrder(question, [...forward].reverse());
    }

    const key = this.cacheSize > 0 ? sha1Hex(JSON.stringify([state, wire])) : '';
    const hit = this.cacheSize > 0 ? this.cache.get(key) : undefined;
    if (hit) {
      this.counters.cacheHits++;
      return hit as Answers<Q>;
    }

    const response = await this.limit(() => this.send(state, wire, options.signal));

    const out: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions) as Array<[string, Question]>) {
      const parsed = parseAnswer(id, response.answers[id], wire[id] as Question);
      if (question.type === 'choice' && debias.has(id)) {
        const twin = parseAnswer(`${id}${REVERSED}`, response.answers[`${id}${REVERSED}`], wire[`${id}${REVERSED}`] as Question);
        out[id] = mergeChoice(parsed as ChoiceResult, twin as ChoiceResult);
      } else {
        out[id] = parsed;
      }
    }

    if (this.cacheSize > 0) {
      if (this.cache.size >= this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, out as Answers<Questions>);
    }
    return out as Answers<Q>;
  }

  /**
   * Like `ask`, but degrades to `null` on transient failures so one bad page cannot sink a whole analysis.
   * Fatal errors (invalid key, abort) are rethrown: continuing would only burn time.
   */
  async tryAsk<const Q extends Questions>(state: EntryType, questions: Q, options: AskOptions<Q> = {}): Promise<Answers<Q> | null> {
    try {
      return await this.ask(state, questions, options);
    } catch (err) {
      const e = toJevError(err);
      if (e.fatal) throw e;
      this.counters.failures++;
      if (!this.warned.has(e.kind)) {
        this.warned.add(e.kind);
        this.logger.warn(`[jev] ${e.kind}: ${e.message}`);
      }
      return null;
    }
  }

  private async send(state: EntryType, questions: Record<string, Question>, signal?: AbortSignal) {
    this.counters.requests++;
    try {
      const res = await this.transport.systemOne({ state, questions: questions as Questions, model: this.model }, signal ? { signal } : undefined);
      if (!isRecord(res) || !isRecord(res.answers)) throw new JevError('bad_response', 'Jev: отговорът няма поле "answers"');
      this.counters.inputTokens += Number(res.usage?.input_tokens) || 0;
      this.counters.outputTokens += Number(res.usage?.output_tokens) || 0;
      return res;
    } catch (err) {
      throw toJevError(err);
    }
  }
}

function withOrder(question: ChoiceQuestion, order: readonly string[]): ChoiceQuestion {
  const criteria: Record<string, EntryType> = {};
  for (const k of order) criteria[k] = question.criteria[k] ?? null;
  return { ...question, criteria };
}

export type { Questions, Question, EntryType };
