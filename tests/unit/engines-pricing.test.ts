import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../../src/server/geo/engines/pricing';
import type { EngineUsage } from '../../src/server/geo/engines/types';

const u = (inputTokens: number, outputTokens: number, searches = 0): EngineUsage => ({ inputTokens, outputTokens, searches });

describe('estimateCostUsd', () => {
  it.each([
    // [engine, model, price in / out per 1M tokens]
    ['openai', 'gpt-6-astra', 10, 50],
    ['openai', 'gpt-6.1-sol', 2, 10],
    ['openai', 'gpt-6-luna', 0.1, 0.5],
    ['anthropic', 'claude-fable-5', 10, 50],
    ['anthropic', 'claude-opus-5-5', 4, 20],
    ['anthropic', 'claude-opus-5', 5, 25],
    ['anthropic', 'claude-opus-4-8', 5, 25],
    ['anthropic', 'claude-opus-4-7', 5, 25],
    ['anthropic', 'claude-opus-4-6', 5, 25],
    ['anthropic', 'claude-sonnet-5-5', 2, 10],
    ['anthropic', 'claude-sonnet-5', 2, 10],
    ['anthropic', 'claude-sonnet-4-6', 3, 15],
    ['anthropic', 'claude-haiku-4-5', 1, 5],
    ['gemini', 'gemini-3.8-flash', 0.75, 3.75],
    ['gemini', 'gemini-3.1-pro', 2, 12],
  ] as const)('%s %s costs %d per 1M tokens in and %d out', (engine, model, input, output) => {
    expect(estimateCostUsd(engine, model, u(1_000_000, 0))).toBe(input);
    expect(estimateCostUsd(engine, model, u(0, 1_000_000))).toBe(output);
    expect(estimateCostUsd(engine, model, u(1_000_000, 1_000_000))).toBe(input + output);
  });

  it('adds a per-search fee: 1 cent for OpenAI and Anthropic, 1.4 cents for Gemini', () => {
    expect(estimateCostUsd('openai', 'gpt-6.1-sol', u(0, 0, 3))).toBe(0.03);
    expect(estimateCostUsd('anthropic', 'claude-opus-5-5', u(0, 0, 4))).toBe(0.04);
    expect(estimateCostUsd('gemini', 'gemini-3.8-flash', u(0, 0, 2))).toBe(0.028);
  });

  it('adds tokens and searches together', () => {
    // 10,000 in x $4 + 2,000 out x $20 (per million) = 0.04 + 0.04, plus 3 searches at a cent
    expect(estimateCostUsd('anthropic', 'claude-opus-5-5', u(10_000, 2_000, 3))).toBe(0.11);
    // a typical ChatGPT answer: 4,200 in, 510 out, 2 searches
    expect(estimateCostUsd('openai', 'gpt-6.1-sol', u(4_200, 510, 2))).toBe(0.0335);
  });

  it('rounds to four decimals', () => {
    // 1 input token on gpt-6-luna is $0.0000001
    expect(estimateCostUsd('openai', 'gpt-6-luna', u(1, 0))).toBe(0);
    expect(estimateCostUsd('openai', 'gpt-6-luna', u(333_333, 0))).toBe(0.0333);
    expect(estimateCostUsd('gemini', 'gemini-3.8-flash', u(1234, 567))).toBe(0.0031); // 0.0009255 + 0.00212625 = 0.00305175
  });

  it('returns null for a model that is not in the table', () => {
    expect(estimateCostUsd('openai', 'gpt-9', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('anthropic', 'claude-opus-4-5', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('anthropic', 'claude-mythos-5', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('gemini', 'gemini-2.0-flash', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('openai', 'демо', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('openai', '', u(1000, 1000))).toBeNull();
  });

  it('keeps the vendors apart: a model is looked up in its own engine\'s table only', () => {
    expect(estimateCostUsd('anthropic', 'gpt-6.1-sol', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('openai', 'claude-opus-5-5', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('gemini', 'claude-haiku-4-5', u(1000, 1000))).toBeNull();
  });

  it('matches by id prefix: dated snapshots and -preview builds are priced like the model', () => {
    expect(estimateCostUsd('gemini', 'gemini-3.1-pro-preview', u(1_000_000, 0))).toBe(2);
    expect(estimateCostUsd('gemini', 'gemini-3.1-pro-preview-05-06', u(0, 1_000_000))).toBe(12);
    expect(estimateCostUsd('gemini', 'gemini-3.8-flash-001', u(1_000_000, 0))).toBe(0.75);
    expect(estimateCostUsd('gemini', 'models/gemini-3.8-flash', u(1_000_000, 0))).toBe(0.75);
    expect(estimateCostUsd('openai', 'gpt-6.1-sol-2026-09-30', u(1_000_000, 0))).toBe(2);
    expect(estimateCostUsd('anthropic', 'claude-haiku-4-5-20251001', u(1_000_000, 0))).toBe(1);
    expect(estimateCostUsd('anthropic', 'claude-fable-5-1', u(1_000_000, 0))).toBe(10);
    expect(estimateCostUsd('anthropic', 'claude-fable-5-20260801', u(0, 1_000_000))).toBe(50);
    expect(estimateCostUsd('anthropic', ' CLAUDE-OPUS-5-5 ', u(1_000_000, 0))).toBe(4);
  });

  it('prices the longest matching id: claude-opus-5-5 is not claude-opus-5', () => {
    expect(estimateCostUsd('anthropic', 'claude-opus-5-5', u(1_000_000, 0))).toBe(4);
    expect(estimateCostUsd('anthropic', 'claude-opus-5-5-20261001', u(1_000_000, 0))).toBe(4);
    expect(estimateCostUsd('anthropic', 'claude-opus-5', u(1_000_000, 0))).toBe(5);
    expect(estimateCostUsd('anthropic', 'claude-opus-5-20261001', u(1_000_000, 0))).toBe(5);
    expect(estimateCostUsd('anthropic', 'claude-sonnet-5-5', u(1_000_000, 0))).toBe(2);
    expect(estimateCostUsd('anthropic', 'claude-sonnet-4-6', u(1_000_000, 0))).toBe(3);
  });

  it('does not price a different model that merely starts with the same letters', () => {
    expect(estimateCostUsd('anthropic', 'claude-opus-50', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('anthropic', 'claude-fable-50', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('openai', 'gpt-6-lunar', u(1000, 1000))).toBeNull();
    expect(estimateCostUsd('gemini', 'gemini-3.1-pro2', u(1000, 1000))).toBeNull();
  });

  it('treats negative or non-finite counts as zero', () => {
    expect(estimateCostUsd('openai', 'gpt-6.1-sol', u(-5, -5, -5))).toBe(0);
    expect(estimateCostUsd('openai', 'gpt-6.1-sol', u(NaN, Infinity, NaN))).toBe(0);
    expect(estimateCostUsd('openai', 'gpt-6.1-sol', u(0, 0, 0))).toBe(0);
  });
});
