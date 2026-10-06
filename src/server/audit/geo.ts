import type { AnswerRecord, EngineRun } from '../../shared/audit';
import { ENGINE_LABELS, type EngineId } from '../../shared/domain';
import type { MarketId } from '../../shared/markets';
import { estimateCostUsd } from '../geo/engines/pricing';
import { EngineError, locationFor, type AnswerEngine, type EngineAnswer } from '../geo/engines/types';
import type { Jev } from '../jev/client';
import { domainOf } from '../providers/serp/types';
import { createLimiter } from '../util/limit';
import { sentimentQuestions, sentimentState } from './questions';

// GEO: ask the AI assistants the buyer questions and measure whether the business is cited or named, and who is
// cited instead. The counting and the arithmetic are all here, in code; Jev only reads how warmly an answer speaks
// about the business when it names it.

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

// ───────────────────────── who is who in an answer ─────────────────────────

export interface KnownBrand {
  domain: string;
  /** Lower-case names an answer may use for it: the domain, its label, a brand name. */
  names: string[];
}

export interface BrandMatcher {
  ownDomain: string;
  own: string[];
  competitors: KnownBrand[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names a domain goes by in prose: "pixel-studio.example" → "pixel-studio.example", "pixel-studio", "pixel studio", "pixelstudio". */
export function namesOfDomain(domain: string): string[] {
  const label = domain.split('.')[0] ?? domain;
  return [...new Set([domain, label, label.replace(/-/g, ' '), label.replace(/-/g, '')].map((n) => n.toLowerCase()).filter((n) => n.length >= 4))];
}

export function brandMatcher(input: { domain: string; brandNames: readonly string[]; competitors: ReadonlyArray<{ domain: string; names?: readonly string[] }> }): BrandMatcher {
  const ownDomain = domainOf(`https://${input.domain}`);
  const own = [...new Set([...input.brandNames.map((n) => n.trim().toLowerCase()), ...namesOfDomain(ownDomain)].filter((n) => n.length >= 3))];
  const seen = new Set<string>([ownDomain]);
  const competitors: KnownBrand[] = [];
  for (const c of input.competitors) {
    const domain = domainOf(`https://${c.domain}`);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    competitors.push({ domain, names: [...new Set([...namesOfDomain(domain), ...(c.names ?? []).map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3)])] });
  }
  return { ownDomain, own, competitors };
}

/** Where (character index) the first of `names` occurs in `text` as a whole word, or -1. A Bulgarian name may carry up to three more letters (the article, a plural). */
export function firstMention(text: string, names: readonly string[]): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const name of names) {
    const cyrillic = /\p{Script=Cyrillic}$/u.test(name);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}${cyrillic ? '\\p{L}{0,3}' : ''}(?![\\p{L}\\p{N}])`, 'u');
    const at = lower.search(re);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
}

export interface Analysed {
  status: 'cited' | 'named' | 'missing';
  position: number | null;
  share: number;
  citations: Array<{ domain: string; url: string; title: string }>;
  brands: string[];
}

export function analyseAnswer(answer: EngineAnswer, matcher: BrandMatcher): Analysed {
  const source = answer.citations.length > 0 ? answer.citations : answer.consulted;
  const citations = source.slice(0, 12).map((c) => ({ domain: c.domain, url: clip(c.url, 300), title: clip(c.title, 160) }));
  const domains: string[] = [];
  for (const c of source) if (c.domain && !domains.includes(c.domain)) domains.push(c.domain);

  const ownCitations = source.filter((c) => c.domain === matcher.ownDomain).length;
  const ownAt = firstMention(answer.text, matcher.own);

  // competitors named in the text, in the order they appear
  const named = matcher.competitors
    .map((c) => ({ domain: c.domain, at: firstMention(answer.text, c.names) }))
    .filter((c) => c.at >= 0)
    .sort((a, b) => a.at - b.at);
  const brands = named.map((n) => n.domain).slice(0, 10);

  if (ownCitations > 0) {
    return { status: 'cited', position: domains.indexOf(matcher.ownDomain) + 1, share: r3(ownCitations / Math.max(1, source.length)), citations, brands };
  }
  if (ownAt >= 0) {
    const ahead = named.filter((n) => n.at < ownAt).length;
    return { status: 'named', position: ahead + 1, share: r3(1 / (1 + named.length)), citations, brands };
  }
  return { status: 'missing', position: null, share: 0, citations, brands };
}

// ───────────────────────── statistics ─────────────────────────

/** The share k/n with its 95% Wilson score interval: honest about how little a few dozen questions can say. */
export function wilson(k: number, n: number): { rate: number; low: number; high: number } {
  if (n <= 0) return { rate: 0, low: 0, high: 0 };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { rate: r3(p), low: r3(Math.max(0, centre - margin)), high: r3(Math.min(1, centre + margin)) };
}

// ───────────────────────── running the engines ─────────────────────────

export interface AskedQuestion {
  id: string;
  text: string;
}

export interface RawAnswer {
  engine: EngineId;
  questionId: string;
  answer: EngineAnswer | null;
  error: string | null;
  latencyMs: number;
}

export interface EngineRunResult {
  answers: RawAnswer[];
  /** Engines that were stopped early, with the reason (a rejected key, a missing model, a run of failures). */
  stopped: Map<EngineId, string>;
  /** Questions that were not asked because the call budget ran out. */
  skipped: number;
}

const BREAKER = 6;

/**
 * Asks every question to every engine, at most `maxCalls` requests in all, a few at a time per engine. A rejected key
 * stops that engine at once; a run of failures stops it too, so a broken engine does not burn the whole timeout.
 */
export async function runEngines(input: {
  engines: readonly AnswerEngine[];
  questions: readonly AskedQuestion[];
  market: MarketId;
  maxCalls: number;
  concurrency?: number;
  signal?: AbortSignal;
  onAnswer?: (done: number, total: number) => void;
}): Promise<EngineRunResult> {
  const { engines, questions } = input;
  const perEngine = engines.length === 0 ? 0 : Math.min(questions.length, Math.floor(input.maxCalls / engines.length));
  const asked = questions.slice(0, perEngine);
  const total = asked.length * engines.length;
  const stopped = new Map<EngineId, string>();
  const answers: RawAnswer[] = [];
  let done = 0;
  const location = locationFor(input.market);

  await Promise.all(
    engines.map(async (engine) => {
      const limit = createLimiter(input.concurrency ?? 3);
      let consecutiveFailures = 0;
      await Promise.all(
        asked.map((q) =>
          limit(async () => {
            input.signal?.throwIfAborted();
            if (stopped.has(engine.id)) return;
            const started = Date.now();
            try {
              const answer = await engine.ask(q.text, { location, ...(input.signal ? { signal: input.signal } : {}) });
              consecutiveFailures = 0;
              answers.push({ engine: engine.id, questionId: q.id, answer, error: null, latencyMs: answer.latencyMs || Date.now() - started });
            } catch (err) {
              if (input.signal?.aborted) throw err;
              const e = err instanceof EngineError ? err : new EngineError('unavailable', err instanceof Error ? err.message : 'Неизвестна грешка');
              if (e.fatal) stopped.set(engine.id, e.message);
              else if (++consecutiveFailures >= BREAKER) stopped.set(engine.id, `${ENGINE_LABELS[engine.id]} отговори с грешка ${BREAKER} пъти поред: ${e.message}`);
              answers.push({ engine: engine.id, questionId: q.id, answer: null, error: clip(e.message, 200), latencyMs: Date.now() - started });
            } finally {
              input.onAnswer?.(++done, total);
            }
          }),
        ),
      );
    }),
  );
  return { answers, stopped, skipped: (questions.length - asked.length) * engines.length };
}

// ───────────────────────── records and summaries ─────────────────────────

/** How warmly the answer speaks about the brand (0..1), read by Jev; null when Jev could not say. */
export async function readSentiment(jev: Jev, brand: string, question: string, answerText: string, signal?: AbortSignal): Promise<number | null> {
  const a = await jev.tryAsk(sentimentState(brand, question, answerText), sentimentQuestions, { shuffleChoices: true, ...(signal ? { signal } : {}) });
  if (!a) return null;
  const p = a.recommendation.probabilities;
  if ((p.not_mentioned ?? 0) > 0.6) return null; // Jev does not see the brand in the answer: no reading
  const named = (p.recommended ?? 0) + (p.mentioned_neutral ?? 0) + (p.discouraged ?? 0);
  return named > 0 ? r3(((p.recommended ?? 0) + 0.5 * (p.mentioned_neutral ?? 0)) / named) : null;
}

export function toRecord(raw: RawAnswer, analysed: Analysed | null, sentiment: number | null): AnswerRecord {
  if (!raw.answer || !analysed) {
    return { engine: raw.engine, questionId: raw.questionId, status: 'failed', latencyMs: Math.round(raw.latencyMs), position: null, share: 0, sentiment: null, citations: [], brands: [], excerpt: '', error: raw.error ?? 'Няма отговор' };
  }
  return {
    engine: raw.engine,
    questionId: raw.questionId,
    status: analysed.status,
    latencyMs: Math.round(raw.latencyMs),
    position: analysed.position,
    share: analysed.share,
    sentiment: analysed.status === 'missing' ? null : sentiment,
    citations: analysed.citations,
    brands: analysed.brands,
    excerpt: clip(raw.answer.text.replace(/\s+/g, ' ').trim(), 500),
    error: null,
  };
}

export function summarizeEngine(engine: AnswerEngine, records: readonly AnswerRecord[], raws: readonly RawAnswer[], ownDomain: string): EngineRun {
  const mine = records.filter((r) => r.engine === engine.id);
  const answered = mine.filter((r) => r.status !== 'failed');
  const citingUs = answered.filter((r) => r.status !== 'missing').length;
  const skippingUs = answered.length - citingUs;
  const { rate, low, high } = wilson(citingUs, answered.length);

  // who the engine cites: domains by the number of answers that cite them
  const counts = new Map<string, number>();
  const instead = new Map<string, number>();
  for (const r of answered) {
    for (const d of new Set(r.citations.map((c) => c.domain))) {
      counts.set(d, (counts.get(d) ?? 0) + 1);
      if (r.status === 'missing' && d !== ownDomain) instead.set(d, (instead.get(d) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  const topInstead = [...instead.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  const used = raws.filter((r) => r.engine === engine.id && r.answer);
  const usage = used.reduce(
    (u, r) => ({ inputTokens: u.inputTokens + (r.answer?.usage.inputTokens ?? 0), outputTokens: u.outputTokens + (r.answer?.usage.outputTokens ?? 0), searches: u.searches + (r.answer?.usage.searches ?? 0) }),
    { inputTokens: 0, outputTokens: 0, searches: 0 },
  );
  const cost = estimateCostUsd(engine.id, engine.model, usage);

  return {
    engine: engine.id,
    label: ENGINE_LABELS[engine.id],
    model: engine.model,
    // an engine that never answered keeps its configured mode (every adapter sends its search tool)
    search: used.length === 0 ? true : used.some((r) => r.answer?.searched),
    asked: mine.length,
    answered: answered.length,
    failed: mine.length - answered.length,
    citingUs,
    skippingUs,
    rate,
    rateLow: low,
    rateHigh: high,
    citedInstead: topInstead ? { domain: topInstead[0], answers: topInstead[1] } : null,
    topCited: top.map(([domain, n]) => ({ domain, answers: n, share: r3(n / Math.max(1, answered.length)) })),
    usage: { calls: raws.filter((r) => r.engine === engine.id).length, ...usage, estimatedCostUsd: cost === null ? null : Math.round(cost * 10_000) / 10_000 },
  };
}

