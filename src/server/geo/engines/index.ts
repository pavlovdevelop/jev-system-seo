import { AnthropicEngine } from './anthropic';
import { GeminiEngine } from './gemini';
import type { EngineHttpOptions } from './http';
import { OpenAiEngine } from './openai';
import type { AnswerEngine, EngineConfig, EnginesConfig } from './types';

export { createDemoEngines, type DemoCompetitor, type DemoEngineInput, type DemoSourceKind } from './demo';
export { anthropicCaps, AnthropicEngine, type AnthropicCaps } from './anthropic';
export { GeminiEngine } from './gemini';
export { OpenAiEngine } from './openai';
export type { EngineHttpOptions } from './http';
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

const hasKey = (config: EngineConfig | null): config is EngineConfig => typeof config?.apiKey === 'string' && config.apiKey.trim() !== '';

/** The engines that have a key, always in the order ChatGPT, Claude, Gemini. A missing or blank key leaves the engine out. */
export function createEngines(config: EnginesConfig, options: EngineHttpOptions = {}): AnswerEngine[] {
  const engines: AnswerEngine[] = [];
  if (hasKey(config.openai)) engines.push(new OpenAiEngine(config.openai, options));
  if (hasKey(config.anthropic)) engines.push(new AnthropicEngine(config.anthropic, options));
  if (hasKey(config.gemini)) engines.push(new GeminiEngine(config.gemini, options));
  return engines;
}
