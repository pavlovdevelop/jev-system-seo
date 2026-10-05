import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';
import { JobManager } from '../../src/server/jobs';
import { Runtime } from '../../src/server/runtime';
import { Store } from '../../src/server/store';
import { FailureLimiter } from '../../src/server/util/throttle';
import { ReportSchema } from '../../src/shared/schemas';

const H = { 'x-requested-with': 'jev-seo-radar', 'content-type': 'application/json' };
const quiet = { info: () => {}, error: () => {} };

let dir: string;
let running: JobManager | null = null;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'jev-app-')); });
afterEach(async () => {
  await running?.idle(); // let in-flight jobs finish writing before the temp dir disappears
  running = null;
  await rm(dir, { recursive: true, force: true });
});

async function setup(env: Record<string, string> = { DEMO_MODE: '1' }, maxConcurrent = 2, extra: Partial<AppDeps> = {}) {
  const config = loadConfig({ DATA_DIR: dir, ...env }, []);
  const store = new Store(config.dataDir);
  await store.init();
  const runtime = new Runtime(config);
  const jobs = new JobManager({ store, runtime, maxConcurrent, logger: quiet });
  running = jobs;
  const app = createApp({ runtime, store, jobs, ...extra });
  const call = (path: string, init: RequestInit = {}) => app.request(path, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = H) => call(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, call, post, store, jobs, config };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const finished = async (call: Awaited<ReturnType<typeof setup>>['call'], id: string) =>
  waitFor(async () => {
    const { job } = (await (await call(`/api/jobs/${id}`)).json()) as { job: { status: string; reportId: string | null; error: string | null } };
    return job.status === 'done' || job.status === 'error' ? job : null;
  });

describe('status and security', () => {
  it('reports provider status without leaking any secret', async () => {
    const { call } = await setup({ JEV_API_KEY: 'super-secret-key', SERPER_API_KEY: 'another-secret', DATAFORSEO_LOGIN: 'login-x', DATAFORSEO_PASSWORD: 'pw-y' });
    const res = await call('/api/status');
    const text = await res.text();
    for (const secret of ['super-secret-key', 'another-secret', 'login-x', 'pw-y']) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ demo: false, jev: { configured: true, flavor: 'typesafe', host: 'api.typesafe.ai' }, serp: { provider: 'serper', configured: true }, volume: { provider: 'dataforseo', configured: true } });
  });

  it('sends strict security headers', async () => {
    const { call } = await setup();
    const h = (await call('/api/status')).headers;
    expect(h.get('content-security-policy')).toContain("default-src 'self'");
    expect(h.get('content-security-policy')).toContain("object-src 'none'");
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('referrer-policy')).toBe('no-referrer');
  });

  it('requires the password when one is configured, but keeps /api/health open', async () => {
    const { call } = await setup({ DEMO_MODE: '1', APP_PASSWORD: 's3cret' });
    expect((await call('/api/health')).status).toBe(200);
    const denied = await call('/api/status');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toMatch(/Basic/);
    const basic = (pw: string) => ({ authorization: `Basic ${Buffer.from(`radar:${pw}`).toString('base64')}` });
    expect((await call('/api/status', { headers: basic('wrong') })).status).toBe(401);
    expect((await call('/api/status', { headers: basic('s3cret') })).status).toBe(200);
    expect((await call('/api/status', { headers: { authorization: 'Bearer s3cret' } })).status).toBe(401);
  });

  it('blocks cross-site and header-less state changes (CSRF)', async () => {
    const { post } = await setup();
    const body = { keyword: 'изработка на уебсайт' };
    expect((await post('/api/analyses', body, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await post('/api/analyses', body, { ...H, origin: 'https://evil.example', host: 'localhost:8787' })).status).toBe(403);
    expect((await post('/api/analyses', body, { ...H, origin: 'not a url', host: 'localhost:8787' })).status).toBe(403);
    expect((await post('/api/analyses', body, { ...H, origin: 'http://localhost:8787', host: 'localhost:8787' })).status).toBe(202);
  });

  it('rejects oversized bodies and malformed JSON', async () => {
    const { call, post } = await setup();
    const big = await call('/api/analyses', { method: 'POST', headers: H, body: JSON.stringify({ keyword: 'x'.repeat(100_000) }) });
    expect(big.status).toBe(400);
    const bad = await call('/api/analyses', { method: 'POST', headers: H, body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await post('/api/analyses', { keyword: 'a' })).status).toBe(422);
  });

  it('returns JSON 404s and never touches the filesystem for malformed ids', async () => {
    const { call } = await setup();
    expect((await call('/api/nope')).status).toBe(404);
    for (const id of ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', 'r_', 'x', 'r_UPPER']) expect((await call(`/api/reports/${id}`)).status).toBe(404);
    expect((await call('/api/reports/r_abcdef123456/export?format=json')).status).toBe(404);
  });
});

describe('Host check (DNS rebinding) and password guessing', () => {
  const asHost = (host: string) => ({ headers: { host } });

  it('answers only to loopback names when there is no password', async () => {
    const { call } = await setup();
    for (const host of ['localhost:8787', 'LOCALHOST', '127.0.0.1:5173', '[::1]:8787']) expect((await call('/api/status', asHost(host))).status, host).toBe(200);
    // a rebound attacker name, and look-alikes
    for (const host of ['evil.example:8787', 'localhost.evil.example', '127.0.0.1.evil.example', 'evil.example', '[::1', '']) {
      expect((await call('/api/status', asHost(host))).status, host).toBe(421);
    }
    // an HTTP request without any Host header cannot come from a browser
    expect((await call('/api/status')).status).toBe(200);
  });

  it('refuses rebound requests to every route, not just the API, and cannot be used to start an analysis', async () => {
    const { call, post } = await setup();
    const evil = { host: 'evil.example:8787', origin: 'http://evil.example:8787' };
    expect((await post('/api/analyses', { keyword: 'изработка на уебсайт' }, { ...H, ...evil })).status).toBe(421);
    expect((await call('/api/reports', asHost('evil.example'))).status).toBe(421);
    expect((await call('/', asHost('evil.example'))).status).toBe(421);
  });

  it('lets the operator add the names the app is really reached by', async () => {
    const { call } = await setup({ DEMO_MODE: '1', ALLOWED_HOSTS: 'radar.local, Radar.Example' });
    expect((await call('/api/status', asHost('radar.local:8080'))).status).toBe(200);
    expect((await call('/api/status', asHost('radar.example'))).status).toBe(200);
    expect((await call('/api/status', asHost('other.example'))).status).toBe(421);
  });

  it('does not restrict hosts when a password protects the instance', async () => {
    const { call } = await setup({ DEMO_MODE: '1', APP_PASSWORD: 'a-long-enough-secret' });
    expect((await call('/api/status', asHost('anything.example'))).status).toBe(401);
  });

  const basic = (pw: string) => ({ authorization: `Basic ${Buffer.from(`radar:${pw}`).toString('base64')}` });

  it('blocks a client after too many wrong passwords, even for the right one, and releases it later', async () => {
    let now = 1_000_000;
    const limiter = new FailureLimiter(3, 60_000, 100, () => now);
    const { call } = await setup({ DEMO_MODE: '1', APP_PASSWORD: 'correct horse battery' }, 2, { login: { limiter, failureDelayMs: 0 } });
    for (let i = 0; i < 3; i++) expect((await call('/api/status', { headers: basic(`wrong-${i}`) })).status).toBe(401);
    const blocked = await call('/api/status', { headers: basic('correct horse battery') });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    now += 61_000;
    expect((await call('/api/status', { headers: basic('correct horse battery') })).status).toBe(200);
  });

  it('does not count requests without credentials (the browser first asks without any) as failures', async () => {
    const limiter = new FailureLimiter(3, 60_000, 100);
    const { call } = await setup({ DEMO_MODE: '1', APP_PASSWORD: 'correct horse battery' }, 2, { login: { limiter, failureDelayMs: 0 } });
    for (let i = 0; i < 10; i++) expect((await call('/api/status')).status).toBe(401);
    expect((await call('/api/status', { headers: basic('correct horse battery') })).status).toBe(200);
  });

  it('keeps counting separately per client behind a proxy (last X-Forwarded-For entry)', async () => {
    const limiter = new FailureLimiter(2, 60_000, 100);
    const { call } = await setup({ DEMO_MODE: '1', APP_PASSWORD: 'correct horse battery' }, 2, { login: { limiter, failureDelayMs: 0 } });
    const from = (ip: string, pw: string) => ({ headers: { ...basic(pw), 'x-forwarded-for': `203.0.113.99, ${ip}` } });
    for (let i = 0; i < 2; i++) expect((await call('/api/status', from('198.51.100.7', 'nope'))).status).toBe(401);
    expect((await call('/api/status', from('198.51.100.7', 'correct horse battery'))).status).toBe(429);
    // another client behind the same proxy is not affected, and a forged first entry does not help the attacker
    expect((await call('/api/status', from('198.51.100.8', 'correct horse battery'))).status).toBe(200);
  });
});

describe('report limit', () => {
  it('refuses new analyses once the configured number of reports is stored, until some are deleted', async () => {
    const { post, call } = await setup({ DEMO_MODE: '1', MAX_REPORTS: '2' });
    const ids: string[] = [];
    for (const keyword of ['изработка на уебсайт', 'изработка на уебсайт цена']) {
      const { job } = (await (await post('/api/analyses', { keyword })).json()) as { job: { id: string } };
      const done = await finished(call, job.id);
      ids.push(done.reportId as string);
    }
    const refused = await post('/api/analyses', { keyword: 'уеб дизайн' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('limit');
    expect((await call(`/api/reports/${ids[0]}`, { method: 'DELETE', headers: H })).status).toBe(200);
    expect((await post('/api/analyses', { keyword: 'уеб дизайн' })).status).toBe(202);
  });
});

describe('settings and competitor registry', () => {
  it('saves the business profile, own domain and market', async () => {
    const { call } = await setup();
    const put = await call('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ businessDescription: '  Уеб студио в София  ', ownDomain: 'https://www.My-Studio.example/about', market: 'bg-en' }) });
    expect(put.status).toBe(200);
    const { settings } = (await (await call('/api/settings')).json()) as any;
    expect(settings).toMatchObject({ businessDescription: 'Уеб студио в София', ownDomain: 'my-studio.example', market: 'bg-en' });
  });

  it('validates settings', async () => {
    const { call } = await setup();
    expect((await call('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ ownDomain: 'localhost' }) })).status).toBe(422);
    expect((await call('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ market: 'mars' }) })).status).toBe(422);
  });

  it('adds, de-duplicates and removes tracked competitors', async () => {
    const { call, post } = await setup();
    expect((await post('/api/competitors', { domain: 'https://www.Pixel-Studio.example/x', note: 'основен' })).status).toBe(201);
    await post('/api/competitors', { domain: 'pixel-studio.example' });
    await post('/api/competitors', { domain: 'sub.pixel-studio.example' }); // same registrable domain
    let { settings } = (await (await call('/api/settings')).json()) as any;
    expect(settings.competitors).toHaveLength(1);
    expect(settings.competitors[0]).toMatchObject({ domain: 'pixel-studio.example', note: 'основен' });
    expect((await post('/api/competitors', { domain: 'not a domain' })).status).toBe(422);
    expect((await post('/api/competitors', { domain: '10.0.0.1' })).status).toBe(422);
    const del = await call('/api/competitors/pixel-studio.example', { method: 'DELETE', headers: H });
    expect(del.status).toBe(200);
    ({ settings } = (await (await call('/api/settings')).json()) as any);
    expect(settings.competitors).toEqual([]);
  });
});

describe('analysis lifecycle (demo mode)', () => {
  it('runs an analysis end to end: start → progress → report → list → export → delete', async () => {
    const { call, post } = await setup();
    await post('/api/competitors', { domain: 'pixel-studio.example' });
    await call('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ ownDomain: 'my-studio.example', businessDescription: 'Малко студио за уебсайтове и онлайн магазини.' }) });

    const started = await post('/api/analyses', { keyword: 'изработка на уебсайт', options: { serpDepth: 20 } });
    expect(started.status).toBe(202);
    const { job } = (await started.json()) as any;
    expect(job).toMatchObject({ status: 'queued', keyword: 'изработка на уебсайт' });

    const done = await finished(call, job.id);
    expect(done).toMatchObject({ status: 'done', error: null });
    const reportId = done.reportId!;

    const { report } = (await (await call(`/api/reports/${reportId}`)).json()) as any;
    expect(() => ReportSchema.parse(report)).not.toThrow();
    // the saved profile fills what the form left blank
    expect(report.request.ownDomain).toBe('my-studio.example');
    expect(report.request.businessDescription).toContain('онлайн магазини');
    expect(report.competitors[0]).toMatchObject({ domain: 'my-studio.example', role: 'own' });
    expect(report.competitors.find((c: any) => c.domain === 'pixel-studio.example').role).toBe('tracked');

    const { reports } = (await (await call('/api/reports')).json()) as any;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: reportId, keyword: 'изработка на уебсайт', mode: 'demo', status: 'complete', difficulty: 'hard' });
    expect(reports[0].quickWins).toBeGreaterThanOrEqual(1);
    expect(reports[0]).not.toHaveProperty('digest');

    const overview = (await (await call('/api/competitors/overview')).json()) as any;
    expect(overview.competitors[0]).toMatchObject({ domain: 'my-studio.example', own: true });
    expect(overview.competitors.find((c: any) => c.domain === 'pixel-studio.example')).toMatchObject({ tracked: true, reports: 1 });

    const csv = await call(`/api/reports/${reportId}/export?format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    // an ASCII-only name (the keyword in Latin letters): non-ASCII file names are not honoured by every browser
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="opportunities-izrabotka-na-uebsayt.csv"');
    const bytes = new Uint8Array(await csv.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM so Excel reads the Cyrillic correctly
    const csvText = await csv.text();
    expect(csvText).toContain('Фраза,Оценка,Категория');
    expect(csvText.split('\r\n').length).toBeGreaterThan(15);

    const md = await (await call(`/api/reports/${reportId}/export?format=md`)).text();
    expect(md).toContain('# SEO анализ: „изработка на уебсайт“');
    expect(md).toContain('ДЕМО');
    expect(md).toContain('## Възможности (фрази)');
    expect(md).toContain('## План за съдържание');

    const json = await call(`/api/reports/${reportId}/export?format=json`);
    expect(json.headers.get('content-disposition')).toContain('.json');
    const jsonText = await json.text();
    expect(() => ReportSchema.parse(JSON.parse(jsonText))).not.toThrow();
    expect((await call(`/api/reports/${reportId}/export?format=xml`)).status).toBe(400);

    expect((await call(`/api/reports/${reportId}`, { method: 'DELETE', headers: H })).status).toBe(200);
    expect((await call(`/api/reports/${reportId}`)).status).toBe(404);
    expect(((await (await call('/api/reports')).json()) as any).reports).toEqual([]);
  });

  it('streams progress as Server-Sent Events and ends with the final state', async () => {
    const { call, post } = await setup();
    const { job } = (await (await post('/api/analyses', { keyword: 'изработка на уебсайт' })).json()) as any;
    const res = await call(`/api/jobs/${job.id}/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text(); // the stream closes by itself once the job is done
    const events = text.split('\n\n').filter(Boolean).map((chunk) => {
      const lines = chunk.split('\n');
      return { event: lines.find((l) => l.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(lines.find((l) => l.startsWith('data:'))!.slice(5)) };
    });
    const progress = events.filter((e) => e.event === 'progress').map((e) => e.data);
    expect(progress.length).toBeGreaterThan(10);
    expect(progress.map((p: any) => p.pct)).toEqual([...progress.map((p: any) => p.pct)].sort((a, b) => a - b));
    expect(progress.at(-1)).toMatchObject({ step: 'done', pct: 100 });
    expect(events.at(-1)).toMatchObject({ event: 'state', data: { status: 'done', error: null } });
  });

  it('replays progress for a subscriber that connects late', async () => {
    const { call, post } = await setup();
    const { job } = (await (await post('/api/analyses', { keyword: 'изработка на уебсайт' })).json()) as any;
    await finished(call, job.id);
    const text = await (await call(`/api/jobs/${job.id}/events`)).text();
    expect(text).toContain('event: progress');
    expect(text).toContain('"status":"done"');
  });

  it('queues beyond the concurrency limit and can cancel a queued job', async () => {
    const { call, post } = await setup({ DEMO_MODE: '1' }, 1);
    const a = ((await (await post('/api/analyses', { keyword: 'изработка на уебсайт' })).json()) as any).job;
    const b = ((await (await post('/api/analyses', { keyword: 'изработка на онлайн магазин' })).json()) as any).job;
    expect((await call(`/api/jobs/${b.id}`, { method: 'DELETE', headers: H })).status).toBe(200);
    const doneB = await finished(call, b.id);
    expect(doneB).toMatchObject({ status: 'error', error: expect.stringMatching(/прекратен/) });
    expect(await finished(call, a.id)).toMatchObject({ status: 'done' });
    expect((await call(`/api/jobs/${a.id}`, { method: 'DELETE', headers: H })).status).toBe(404); // already finished
    expect(((await (await call('/api/reports')).json()) as any).reports).toHaveLength(1);
  });
});

describe('live mode configuration errors', () => {
  it('explains how to fix a missing Jev key', async () => {
    const { post } = await setup({});
    const res = await post('/api/analyses', { keyword: 'изработка на уебсайт' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'jev_not_configured', message: expect.stringContaining('JEV_API_KEY') } });
  });

  it('explains how to fix a missing SERP provider, and accepts manual URLs instead', async () => {
    const { post } = await setup({ JEV_API_KEY: 'k' });
    const res = await post('/api/analyses', { keyword: 'изработка на уебсайт' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'no_serp', message: expect.stringContaining('SERPER_API_KEY') } });
    expect((await post('/api/analyses', { keyword: 'изработка на уебсайт', manualUrls: ['https://example.com/'] })).status).toBe(202);
  });

  it('rejects private or non-http URLs before anything is fetched', async () => {
    const { post } = await setup({ JEV_API_KEY: 'k' });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/x']) {
      expect((await post('/api/analyses', { keyword: 'изработка на уебсайт', manualUrls: [url] })).status).toBe(422);
    }
  });
});
