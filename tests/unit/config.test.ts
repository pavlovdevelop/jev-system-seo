import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeJev, loadConfig } from '../../src/server/config';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o;

describe('loadConfig', () => {
  it('works with an empty environment (demo / unconfigured)', () => {
    const c = loadConfig(env({}), []);
    expect(c.jev).toBeNull();
    expect(c.serp).toBeNull();
    expect(c.volume).toBeNull();
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8787);
    expect(c.demo).toBe(false);
  });

  it('detects demo mode from the flag or the env var', () => {
    expect(loadConfig(env({}), ['--demo']).demo).toBe(true);
    expect(loadConfig(env({ DEMO_MODE: 'true' }), []).demo).toBe(true);
  });

  it('uses the native TypeSafe endpoint for ordinary keys', () => {
    const j = loadConfig(env({ JEV_API_KEY: 'sk-abc' }), []).jev!;
    expect(j).toMatchObject({ flavor: 'typesafe', baseURL: 'https://api.typesafe.ai', model: 'jev-latest' });
  });

  it('accepts TYPESAFE_API_KEY as an alias', () => {
    expect(loadConfig(env({ TYPESAFE_API_KEY: 'sk-abc' }), []).jev?.apiKey).toBe('sk-abc');
  });

  it('auto-detects Vercel AI Gateway keys (vck_…)', () => {
    const j = loadConfig(env({ JEV_API_KEY: 'vck_123' }), []).jev!;
    expect(j).toMatchObject({ flavor: 'vercel', baseURL: 'https://ai-gateway.vercel.sh/typesafe', model: 'typesafe-ai/jev' });
  });

  it('lets explicit JEV_BASE_URL / JEV_MODEL win', () => {
    const j = loadConfig(env({ JEV_API_KEY: 'vck_123', JEV_BASE_URL: 'https://proxy.example.com/typesafe/', JEV_MODEL: 'jev-1.13.0' }), []).jev!;
    expect(j).toMatchObject({ flavor: 'custom', baseURL: 'https://proxy.example.com/typesafe', model: 'jev-1.13.0' });
  });

  it('refuses to send the key over cleartext http (except loopback)', () => {
    expect(() => loadConfig(env({ JEV_API_KEY: 'k', JEV_BASE_URL: 'http://evil.example.com' }), [])).toThrow(ConfigError);
    expect(() => loadConfig(env({ JEV_API_KEY: 'k', JEV_BASE_URL: 'http://127.0.0.1:9999' }), [])).not.toThrow();
  });

  it('picks the SERP provider automatically and validates explicit choices', () => {
    expect(loadConfig(env({ SERPER_API_KEY: 'k' }), []).serp).toEqual({ provider: 'serper', apiKey: 'k' });
    expect(loadConfig(env({ DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }), []).serp).toEqual({ provider: 'dataforseo', login: 'a', password: 'b' });
    expect(loadConfig(env({ SERPER_API_KEY: 'k', SERP_PROVIDER: 'none' }), []).serp).toBeNull();
    expect(() => loadConfig(env({ SERP_PROVIDER: 'serper' }), [])).toThrow(/SERPER_API_KEY/);
    expect(() => loadConfig(env({ SERP_PROVIDER: 'bing' }), [])).toThrow(ConfigError);
  });

  it('enables volumes whenever DataForSEO credentials exist, unless disabled', () => {
    const e = { SERPER_API_KEY: 'k', DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' };
    expect(loadConfig(env(e), []).volume).toEqual({ login: 'a', password: 'b' });
    expect(loadConfig(env({ ...e, VOLUME_PROVIDER: 'none' }), []).volume).toBeNull();
  });

  it('validates numeric settings', () => {
    expect(() => loadConfig(env({ PORT: 'abc' }), [])).toThrow(/PORT/);
    expect(() => loadConfig(env({ MAX_CANDIDATES: '1000' }), [])).toThrow(/MAX_CANDIDATES/);
  });

  it('describeJev never exposes the key', () => {
    const d = describeJev(loadConfig(env({ JEV_API_KEY: 'super-secret' }), []).jev);
    expect(JSON.stringify(d)).not.toContain('super-secret');
    expect(d).toEqual({ flavor: 'typesafe', model: 'jev-latest', host: 'api.typesafe.ai' });
  });
});

describe('AI assistants and the whole-site audit', () => {
  it('has none, no writer and the default caps when nothing is set', () => {
    const c = loadConfig(env({}), []);
    expect(c.engines).toEqual({ openai: null, anthropic: null, gemini: null });
    expect(c.writer).toBeNull();
    expect(c.audit).toEqual({ maxPages: 100, maxQuestions: 60, maxEngineCalls: 150 });
  });

  it('reads each assistant\'s key and model, with a default model, and ignores a blank key', () => {
    const c = loadConfig(env({ OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: ' sk-a ', ANTHROPIC_MODEL: 'claude-sonnet-5-5', GEMINI_API_KEY: '   ' }), []);
    expect(c.engines.openai).toEqual({ apiKey: 'sk-o', model: 'gpt-6.1-sol' });
    expect(c.engines.anthropic).toEqual({ apiKey: 'sk-a', model: 'claude-sonnet-5-5' });
    expect(c.engines.gemini).toBeNull();
  });

  it('takes the Gemini key from GOOGLE_API_KEY too, with GEMINI_API_KEY first', () => {
    expect(loadConfig(env({ GOOGLE_API_KEY: 'g1' }), []).engines.gemini).toEqual({ apiKey: 'g1', model: 'gemini-3.8-flash' });
    expect(loadConfig(env({ GOOGLE_API_KEY: 'g1', GEMINI_API_KEY: 'g2' }), []).engines.gemini?.apiKey).toBe('g2');
  });

  it('picks the writer: Claude, then ChatGPT, then Gemini — or what WRITER_ENGINE says', () => {
    expect(loadConfig(env({ OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }), []).writer).toBe('openai');
    expect(loadConfig(env({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' }), []).writer).toBe('anthropic');
    expect(loadConfig(env({ GEMINI_API_KEY: 'g' }), []).writer).toBe('gemini');
    expect(loadConfig(env({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', WRITER_ENGINE: 'openai' }), []).writer).toBe('openai');
    expect(loadConfig(env({ OPENAI_API_KEY: 'o', WRITER_ENGINE: 'none' }), []).writer).toBeNull();
  });

  it('refuses a writer that is unknown or has no key', () => {
    expect(() => loadConfig(env({ WRITER_ENGINE: 'bing', OPENAI_API_KEY: 'o' }), [])).toThrow(/WRITER_ENGINE/);
    expect(() => loadConfig(env({ WRITER_ENGINE: 'gemini', OPENAI_API_KEY: 'o' }), [])).toThrow(/ключ/);
  });

  it('bounds the audit caps', () => {
    expect(loadConfig(env({ MAX_AUDIT_PAGES: '500', MAX_GEO_QUESTIONS: '0', MAX_GEO_CALLS_PER_RUN: '2000' }), []).audit).toEqual({ maxPages: 500, maxQuestions: 0, maxEngineCalls: 2000 });
    expect(() => loadConfig(env({ MAX_AUDIT_PAGES: '501' }), [])).toThrow(/MAX_AUDIT_PAGES/);
    expect(() => loadConfig(env({ MAX_GEO_QUESTIONS: '201' }), [])).toThrow(/MAX_GEO_QUESTIONS/);
    expect(() => loadConfig(env({ MAX_GEO_CALLS_PER_RUN: 'много' }), [])).toThrow(/MAX_GEO_CALLS_PER_RUN/);
  });
});

describe('.env.example', () => {
  const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  // KEY=value lines, whether active or commented out as an optional example
  const entries = [...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => ({ name: m[1] as string, value: (m[2] as string).trim(), active: !m[0].startsWith('#') }));

  it('lists the settings (guards the parsing below against silently matching nothing)', () => {
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(['JEV_API_KEY', 'SERPER_API_KEY', 'APP_PASSWORD', 'DATA_DIR']));
  });

  it('loads as a valid configuration when copied unchanged to .env', () => {
    const active = Object.fromEntries(entries.filter((e) => e.active).map((e) => [e.name, e.value]));
    const c = loadConfig(env(active), []);
    expect(c.jev).toBeNull();
    expect(c.serp).toBeNull();
    expect(c.appPassword).toBeNull();
    expect(c.host).toBe('127.0.0.1');
  });

  it('documents only variables the server actually reads', () => {
    const source = ['../../src/server/config.ts', '../../src/server/index.ts'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
    const unknown = entries.map((e) => e.name).filter((name) => !source.includes(name));
    expect(unknown).toEqual([]);
  });

  it('every commented-out example is also valid when switched on', () => {
    const all = Object.fromEntries(entries.filter((e) => e.name !== 'SERP_PROVIDER' && e.name !== 'VOLUME_PROVIDER' && e.name !== 'DEMO_MODE' && e.name !== 'ALLOW_PUBLIC_WITHOUT_PASSWORD').map((e) => [e.name, e.value || 'x']));
    expect(() => loadConfig(env({ ...all, JEV_API_KEY: 'k', SERPER_API_KEY: 'k' }), [])).not.toThrow();
  });
});
