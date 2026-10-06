import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { DEMO_AUDIT_DEFAULTS } from '../../src/server/demo/site-world';
import { loadConfig } from '../../src/server/config';
import { JobManager } from '../../src/server/jobs';
import { Runtime } from '../../src/server/runtime';
import { Store } from '../../src/server/store';
import { SiteAuditReportSchema } from '../../src/shared/audit';

const H = { 'x-requested-with': 'jev-seo-radar', 'content-type': 'application/json' };
const quiet = { info: () => {}, error: () => {} };

let dir: string;
let running: JobManager | null = null;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jev-audit-'));
});
afterEach(async () => {
  await running?.idle();
  running = null;
  await rm(dir, { recursive: true, force: true });
});

async function setup(env: Record<string, string> = { DEMO_MODE: '1' }) {
  const config = loadConfig({ DATA_DIR: dir, ...env }, []);
  const store = new Store(config.dataDir);
  await store.init();
  const runtime = new Runtime(config);
  const jobs = new JobManager({ store, runtime, maxConcurrent: 2, logger: quiet });
  running = jobs;
  const app = createApp({ runtime, store, jobs });
  const call = (path: string, init: RequestInit = {}) => app.request(path, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = H) => call(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { call, post, store, jobs, config };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const DEMO_BODY = { ...DEMO_AUDIT_DEFAULTS, options: { maxPages: 40, questions: 12, rankChecks: 6, competitorPages: 6 } };

async function runAudit(ctx: Awaited<ReturnType<typeof setup>>, body: unknown = DEMO_BODY) {
  const res = await ctx.post('/api/audits', body);
  expect(res.status).toBe(202);
  const { job } = (await res.json()) as { job: { id: string; kind: string } };
  const done = await waitFor(async () => {
    const { job: j } = (await (await ctx.call(`/api/jobs/${job.id}`)).json()) as { job: { status: string; reportId: string | null; error: string | null; kind: string } };
    return j.status === 'done' || j.status === 'error' ? j : null;
  });
  return { job, done };
}

describe('POST /api/audits (demo)', () => {
  it('audits the demo site end to end and saves a valid report under an a_ id', async () => {
    const ctx = await setup();
    const { job, done } = await runAudit(ctx);
    expect(job.kind).toBe('site');
    expect(done).toMatchObject({ status: 'done', kind: 'site', error: null });
    expect(done.reportId).toMatch(/^a_[a-z0-9]+$/);

    const res = await ctx.call(`/api/audits/${done.reportId}`);
    expect(res.status).toBe(200);
    const { audit } = (await res.json()) as { audit: unknown };
    const parsed = SiteAuditReportSchema.parse(audit);
    expect(parsed.mode).toBe('demo');
    expect(parsed.site).toMatchObject({ domain: 'my-studio.example', source: 'sitemap', pagesAudited: 14 });
    expect(parsed.pages).toHaveLength(14);
    expect(parsed.elements.length).toBeGreaterThan(50);
    expect(parsed.questions.length).toBeGreaterThan(6);
    expect(parsed.geo?.engines.map((e) => e.engine)).toEqual(['openai', 'anthropic', 'gemini']);
    expect(parsed.plan.length).toBeGreaterThan(0);
    expect(parsed.figures.questionsTotal).toBe(parsed.questions.length);
    expect(parsed.usage.jevRequests).toBeGreaterThan(50);
    expect(parsed.providers.writer).toBeNull();
  });

  it('lists, exports and deletes audits', async () => {
    const ctx = await setup();
    const { done } = await runAudit(ctx);
    const id = done.reportId as string;

    const list = (await (await ctx.call('/api/audits')).json()) as { audits: Array<{ id: string; domain: string; pagesAudited: number }> };
    expect(list.audits).toHaveLength(1);
    expect(list.audits[0]).toMatchObject({ id, domain: 'my-studio.example', pagesAudited: 14 });

    const md = await ctx.call(`/api/audits/${id}/export?format=md`);
    expect(md.headers.get('content-type')).toMatch(/markdown/);
    expect(md.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-[A-Za-z0-9._-]+\.md"$/);
    expect(await md.text()).toContain('# Одит на сайта my-studio.example');
    const csv = await ctx.call(`/api/audits/${id}/export?format=csv`);
    expect((await csv.text()).split('\r\n')[0]).toContain('Елемент');
    expect((await (await ctx.call(`/api/audits/${id}/export?format=json`)).json()) as { id: string }).toMatchObject({ id });
    expect((await ctx.call(`/api/audits/${id}/export?format=pdf`)).status).toBe(400);

    expect((await ctx.call(`/api/audits/${id}`, { method: 'DELETE', headers: H })).status).toBe(200);
    expect((await ctx.call(`/api/audits/${id}`)).status).toBe(404);
    expect(((await (await ctx.call('/api/audits')).json()) as { audits: unknown[] }).audits).toHaveLength(0);
  });

  it('does not touch the keyword reports', async () => {
    const ctx = await setup();
    await runAudit(ctx);
    expect(((await (await ctx.call('/api/reports')).json()) as { reports: unknown[] }).reports).toHaveLength(0);
  });
});

describe('validation and limits', () => {
  it('refuses a request without the header the browser adds (CSRF), and ids that are not ids', async () => {
    const ctx = await setup();
    expect((await ctx.post('/api/audits', DEMO_BODY, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await ctx.call('/api/audits/not-an-id')).status).toBe(404);
    expect((await ctx.call('/api/audits/..%2F..%2Fsettings', { method: 'DELETE', headers: H })).status).toBe(404);
    expect((await ctx.call('/api/audits/r_abcdef123456')).status).toBe(404); // a report id is not an audit id
  });

  it('asks for a domain and a business description when the profile has none, and says what is wrong', async () => {
    const ctx = await setup();
    const noDomain = await ctx.post('/api/audits', { businessDescription: 'Студио за сайтове за малки фирми' });
    expect(noDomain.status).toBe(422);
    expect(((await noDomain.json()) as { error: { message: string } }).error.message).toMatch(/domain/);
    const noBusiness = await ctx.post('/api/audits', { domain: 'my-studio.example' });
    expect(noBusiness.status).toBe(422);
    expect(((await noBusiness.json()) as { error: { message: string } }).error.message).toMatch(/businessDescription/);
    expect((await ctx.post('/api/audits', { domain: 'localhost', businessDescription: 'Студио за сайтове' })).status).toBe(422);
    expect((await ctx.post('/api/audits', { ...DEMO_BODY, options: { maxPages: 100_000 } })).status).toBe(422);
  });

  it('fills what the form left blank from the saved profile', async () => {
    const ctx = await setup();
    await ctx.call('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ ownDomain: 'my-studio.example', businessDescription: DEMO_AUDIT_DEFAULTS.businessDescription, brandNames: ['Моето студио'] }) });
    const { done } = await runAudit(ctx, { options: { questions: 6, competitorPages: 0, rankChecks: 0 } });
    expect(done.status).toBe('done');
    const { audit } = (await (await ctx.call(`/api/audits/${done.reportId}`)).json()) as { audit: { request: { domain: string; brandNames: string[] } } };
    expect(audit.request.domain).toBe('my-studio.example');
    expect(audit.request.brandNames).toEqual(['Моето студио']);
  });

  it('caps the options at what the server allows', async () => {
    const ctx = await setup({ DEMO_MODE: '1', MAX_AUDIT_PAGES: '5', MAX_GEO_QUESTIONS: '4' });
    const { done } = await runAudit(ctx, { ...DEMO_BODY, options: { maxPages: 40, questions: 30, rankChecks: 0, competitorPages: 0 } });
    const { audit } = (await (await ctx.call(`/api/audits/${done.reportId}`)).json()) as { audit: { site: { pagesAudited: number; truncated: boolean }; questions: unknown[]; request: { options: { maxPages: number; questions: number } } } };
    expect(audit.request.options).toMatchObject({ maxPages: 5, questions: 4 });
    expect(audit.site.pagesAudited).toBe(5);
    expect(audit.site.truncated).toBe(true);
    expect(audit.questions.length).toBeLessThanOrEqual(4);
  });

  it('refuses new audits once the stored ones reach MAX_REPORTS', async () => {
    const ctx = await setup({ DEMO_MODE: '1', MAX_REPORTS: '1' });
    await runAudit(ctx, { ...DEMO_BODY, options: { questions: 0, competitorPages: 0, rankChecks: 0 } });
    const second = await ctx.post('/api/audits', DEMO_BODY);
    expect(second.status).toBe(409);
  });

  it('needs Jev outside demo mode', async () => {
    const ctx = await setup({ SERPER_API_KEY: 'x' });
    const res = await ctx.post('/api/audits', { domain: 'my-studio.example', businessDescription: 'Студио за сайтове за малки фирми' });
    expect(res.status).toBe(503);
  });
});

describe('status and settings', () => {
  it('reports which AI assistants are configured, with models, and never their keys', async () => {
    const ctx = await setup({ JEV_API_KEY: 'jev-secret', OPENAI_API_KEY: 'sk-openai-secret', ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
    const text = await (await ctx.call('/api/status')).text();
    for (const secret of ['jev-secret', 'sk-openai-secret', 'sk-ant-secret']) expect(text).not.toContain(secret);
    const status = JSON.parse(text) as { engines: Array<{ id: string; configured: boolean; model: string | null }>; writer: { configured: boolean; engine: string | null }; audit: { maxPages: number } };
    expect(status.engines).toEqual([
      { id: 'openai', label: 'ChatGPT', configured: true, model: 'gpt-6.1-sol' },
      { id: 'anthropic', label: 'Claude', configured: true, model: 'claude-sonnet-5-5' },
      { id: 'gemini', label: 'Gemini', configured: false, model: null },
    ]);
    expect(status.writer).toEqual({ configured: true, engine: 'anthropic' });
    expect(status.audit.maxPages).toBe(100);
  });

  it('keeps the brand names in the settings', async () => {
    const ctx = await setup();
    const put = await ctx.call('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ brandNames: ['Моето студио', 'My Studio'] }) });
    expect(((await put.json()) as { settings: { brandNames: string[] } }).settings.brandNames).toEqual(['Моето студио', 'My Studio']);
    expect((await ctx.call('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ brandNames: ['x'] }) })).status).toBe(422);
    const got = (await (await ctx.call('/api/settings')).json()) as { settings: { brandNames: string[] }; demoDefaults: { brandNames: string[] } };
    expect(got.settings.brandNames).toEqual(['Моето студио', 'My Studio']);
    expect(got.demoDefaults.brandNames).toEqual(DEMO_AUDIT_DEFAULTS.brandNames);
  });
});
