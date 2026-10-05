import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../../src/server/config';
import type { PipelineDeps } from '../../src/server/pipeline/analyze';
import { Runtime } from '../../src/server/runtime';

export function demoConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ DEMO_MODE: '1', DATA_DIR: join(tmpdir(), `jev-radar-test-${process.pid}`), ...env }, []);
}

/** The production demo wiring (Runtime.createRun) with a fixed clock, optionally overridden per test. */
export function demoDeps(over: Partial<PipelineDeps> = {}, env: Record<string, string> = {}): PipelineDeps {
  const { deps } = new Runtime(demoConfig(env)).createRun();
  return { ...deps, now: () => new Date('2026-10-05T10:00:00Z'), ...over };
}
