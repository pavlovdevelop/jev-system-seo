import { AnthropicEngine } from './anthropic';
import { GeminiEngine } from './gemini';
import type { EngineHttpOptions } from './http';
import { OpenAiEngine } from './openai';
import type { AnswerEngine, EnginesConfig } from './types';

export { createDemoEngines, type DemoCompetitor, type DemoEngineInput, type DemoSourceKind } from './demo';
export { anthropicCaps, AnthropicEngine, type AnthropicCaps } from './anthropic';
export { GeminiEngine } from './gemini';
export { OpenAiEngine } from './openai';
export { estimateCostUsd } from './pricing';
export { EngineError, locationFor } from './types';
export type {
  AnswerEngine,
  AskOptions,
  EngineAnswer,
  EngineCitation,
  EngineConfig,
  EngineErrorKind,
  EngineFactoryOptions,
  EnginesConfig,
  EngineUsage,
  FetchLike,
  GenerateRequest,
  GenerateResult,
} from './types';

/** The engines that have a key, always in the order ChatGPT, Claude, Gemini. A missing or blank key leaves the engine out. */
export function createEngines(config: EnginesConfig, options: EngineHttpOptions = {}): AnswerEngine[] {
  const engines: AnswerEngine[] = [];
  if (config.openai?.apiKey.trim()) engines.push(new OpenAiEngine(config.openai, options));
  if (config.anthropic?.apiKey.trim()) engines.push(new AnthropicEngine(config.anthropic, options));
  if (config.gemini?.apiKey.trim()) engines.push(new GeminiEngine(config.gemini, options));
  return engines;
}
