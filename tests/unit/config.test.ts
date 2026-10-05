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
