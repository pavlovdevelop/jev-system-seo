import type { EngineId } from '../../../shared/domain';
import type { EngineUsage } from './types';

// Rough cost of one answer, for the usage line of a report. These are list prices as the vendors documented them in
// 2026-10; a plan with discounts, caching or batch pricing will differ, so show the number as an estimate.

interface Price {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

// A model matches by its exact id or by an id that continues with "-" (a dated snapshot, "-preview", ...). The longest
// matching id wins, so "claude-opus-5-5" is not priced as "claude-opus-5".
const PRICES: Record<EngineId, ReadonlyArray<readonly [string, Price]>> = {
  openai: [
    ['gpt-6-astra', { input: 10, output: 50 }],
    ['gpt-6.1-sol', { input: 2, output: 10 }],
    ['gpt-6-luna', { input: 0.1, output: 0.5 }],
  ],
  anthropic: [
    ['claude-fable-5', { input: 10, output: 50 }],
    ['claude-opus-5', { input: 5, output: 25 }],
    ['claude-opus-5-5', { input: 4, output: 20 }],
    ['claude-opus-4-8', { input: 5, output: 25 }],
    ['claude-opus-4-7', { input: 5, output: 25 }],
    ['claude-opus-4-6', { input: 5, output: 25 }],
    ['claude-sonnet-5', { input: 2, output: 10 }],
    ['claude-sonnet-5-5', { input: 2, output: 10 }],
    ['claude-sonnet-4-6', { input: 3, output: 15 }],
    ['claude-haiku-4-5', { input: 1, output: 5 }],
  ],
  gemini: [
    ['gemini-3.8-flash', { input: 0.75, output: 3.75 }],
    ['gemini-3.1-pro', { input: 2, output: 12 }],
  ],
};

/**
 * USD per web search. Approximate: OpenAI and Anthropic bill about $10 per 1,000 searches, Google about $14 per 1,000
 * grounded queries; the vendors differ in what counts as one search and change these fees now and then.
 */
const SEARCH_FEE_USD: Record<EngineId, number> = { openai: 0.01, anthropic: 0.01, gemini: 0.014 };

function priceOf(engine: EngineId, model: string): Price | null {
  const id = model.trim().toLowerCase().replace(/^models\//, '');
  let best: { length: number; price: Price } | null = null;
  for (const [known, price] of PRICES[engine]) {
    if ((id === known || id.startsWith(`${known}-`)) && (best === null || known.length > best.length)) best = { length: known.length, price };
  }
  return best?.price ?? null;
}

const nonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** Tokens × the model's price per million, plus searches × the per-search fee, in USD to 4 decimals; null when the model has no price here. */
export function estimateCostUsd(engine: EngineId, model: string, usage: EngineUsage): number | null {
  const price = priceOf(engine, model);
  if (!price) return null;
  const usd =
    (nonNegative(usage.inputTokens) * price.input + nonNegative(usage.outputTokens) * price.output) / 1_000_000 +
    nonNegative(usage.searches) * SEARCH_FEE_USD[engine];
  return Math.round(usd * 10_000) / 10_000;
}
