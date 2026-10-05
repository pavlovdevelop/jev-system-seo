import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AnalyzeRequestSchema, DomainSchema, SettingsPatchSchema } from '../shared/schemas';
import { opportunitiesCsv, reportMarkdown } from './export';
import type { JobManager } from './jobs';
import { PipelineError } from './pipeline/analyze';
import { DEMO_DEFAULTS, type Runtime } from './runtime';
import { ID_PATTERN, type Store } from './store';
import { sleep } from './util/limit';

export interface AppDeps {
  runtime: Runtime;
  store: Store;
  jobs: JobManager;
  /** Directory with the built SPA (dist/web). When absent, only the API is served (dev mode uses Vite). */
  webRoot?: string;
}

const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'jev-seo-radar';

const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createApp(deps: AppDeps): Hono {
  const { runtime, store, jobs } = deps;
  const { config } = runtime;
  const app = new Hono();

  // ───────────── security ─────────────
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
      referrerPolicy: 'no-referrer',
      xFrameOptions: 'DENY',
      crossOriginOpenerPolicy: 'same-origin',
    }),
  );

  // Optional shared password (HTTP Basic). The browser remembers it for the session.
  if (config.appPassword) {
    const expected = config.appPassword;
    app.use('*', async (c, next) => {
      if (c.req.path === '/api/health') return next();
      const header = c.req.header('authorization') ?? '';
      if (header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
        const password = decoded.slice(decoded.indexOf(':') + 1);
        if (safeEqual(password, expected)) return next();
      }
      return c.text('Необходима е парола.', 401, { 'WWW-Authenticate': 'Basic realm="Jev SEO Radar", charset="UTF-8"' });
    });
  }

  // CSRF: browsers attach Basic-auth credentials to cross-site requests automatically, so state-changing
  // calls must carry a custom header (which cross-origin pages cannot send without a CORS preflight we never grant)
  // and, when an Origin header is present, it must match the host being called.
  app.use('/api/*', async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    if (c.req.header(CSRF_HEADER) !== CSRF_VALUE) return fail(c, 403, 'csrf', 'Липсва задължителен заглавен ред на заявката.');
    const origin = c.req.header('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== c.req.header('host')) return fail(c, 403, 'csrf', 'Заявката е от чужд произход.');
      } catch {
        return fail(c, 403, 'csrf', 'Невалиден произход на заявката.');
      }
    }
    return next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => fail(c, 400, 'too_large', 'Заявката е твърде голяма.') }));

  // ───────────── API ─────────────
  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/status', (c) => c.json(runtime.status()));

  app.get('/api/settings', async (c) => {
    const settings = await store.getSettings();
    return c.json({ settings, demoDefaults: config.demo ? DEMO_DEFAULTS : null });
  });

  app.put('/api/settings', async (c) => {
    const parsed = SettingsPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 422, 'invalid', parsed.error.issues[0]?.message ?? 'Невалидни настройки');
    return c.json({ settings: await store.updateSettings(parsed.data) });
  });

  const CompetitorBody = z.object({ domain: DomainSchema, note: z.string().trim().max(200).default('') });
  app.post('/api/competitors', async (c) => {
    const parsed = CompetitorBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 422, 'invalid', parsed.error.issues[0]?.message ?? 'Невалиден домейн');
    const current = await store.getSettings();
    if (current.competitors.length >= 100) return fail(c, 409, 'limit', 'Достигнат е лимитът от 100 конкуренти.');
    return c.json({ settings: await store.addCompetitor(parsed.data.domain, parsed.data.note) }, 201);
  });

  app.delete('/api/competitors/:domain', async (c) => {
    const parsed = DomainSchema.safeParse(c.req.param('domain'));
    if (!parsed.success) return fail(c, 422, 'invalid', 'Невалиден домейн');
    return c.json({ settings: await store.removeCompetitor(parsed.data) });
  });

  app.get('/api/competitors/overview', async (c) => c.json({ competitors: await store.competitorOverview() }));

  app.post('/api/analyses', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return fail(c, 400, 'invalid_json', 'Очаква се JSON.');
    const parsed = AnalyzeRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(c, 422, 'invalid', `${issue?.path.join('.') || 'заявка'}: ${issue?.message ?? 'невалидни данни'}`);
    }
    // Fall back to the saved profile for anything the form left blank.
    const settings = await store.getSettings();
    const request = {
      ...parsed.data,
      businessDescription: parsed.data.businessDescription || settings.businessDescription,
      ownDomain: parsed.data.ownDomain ?? settings.ownDomain,
      options: {
        ...parsed.data.options,
        maxCandidates: Math.min(parsed.data.options.maxCandidates, config.limits.maxCandidates),
        deepPages: Math.min(parsed.data.options.deepPages, config.limits.maxPagesPerRun),
      },
    };
    if (!config.demo && !config.jev) return fail(c, 503, 'jev_not_configured', 'Jev не е настроен. Добави JEV_API_KEY в .env и рестартирай сървъра.');
    if (!config.demo && !config.serp && request.manualUrls.length === 0) {
      return fail(c, 422, 'no_serp', 'Няма настроен SERP доставчик. Добави SERPER_API_KEY в .env или въведи URL адреси на конкуренти ръчно.');
    }
    try {
      return c.json({ job: jobs.start(request) }, 202);
    } catch (err) {
      if (err instanceof PipelineError) return fail(c, 429, 'busy', err.message);
      throw err;
    }
  });

  app.get('/api/jobs', (c) => c.json({ jobs: jobs.list() }));

  app.get('/api/jobs/:id', (c) => {
    const state = jobs.get(c.req.param('id'));
    return state ? c.json({ job: state }) : fail(c, 404, 'not_found', 'Задачата не е намерена (може да е изтекла след рестарт).');
  });

  app.delete('/api/jobs/:id', (c) => (jobs.cancel(c.req.param('id')) ? c.json({ ok: true }) : fail(c, 404, 'not_found', 'Няма активна задача с такъв номер.')));

  app.get('/api/jobs/:id/events', (c) => {
    const id = c.req.param('id');
    if (!jobs.get(id)) return fail(c, 404, 'not_found', 'Задачата не е намерена (може да е изтекла след рестарт).');
    return streamSSE(c, async (stream) => {
      const inbox: Array<{ type: string; payload: unknown }> = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const unsubscribe = jobs.subscribe(id, (msg) => {
        inbox.push(msg);
        wake?.();
      });
      stream.onAbort(() => {
        finished = true;
        wake?.();
      });
      try {
        while (!finished) {
          while (inbox.length > 0) {
            const msg = inbox.shift() as (typeof inbox)[number];
            await stream.writeSSE({ event: msg.type, data: JSON.stringify(msg.payload) });
            if (msg.type === 'state' && ['done', 'error'].includes((msg.payload as { status: string }).status)) finished = true;
          }
          if (finished) break;
          // wait for the next message, but send a heartbeat so proxies keep the connection open
          await Promise.race([new Promise<void>((resolveWake) => (wake = resolveWake)), sleep(15_000)]);
          wake = null;
          if (inbox.length === 0 && !finished) await stream.writeSSE({ event: 'ping', data: '{}' });
        }
      } finally {
        unsubscribe?.();
      }
    });
  });

  app.get('/api/reports', async (c) => c.json({ reports: await store.listReports() }));

  app.get('/api/reports/:id', async (c) => {
    const report = await store.getReport(c.req.param('id'));
    return report ? c.json({ report }) : fail(c, 404, 'not_found', 'Отчетът не е намерен.');
  });

  app.delete('/api/reports/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) return fail(c, 404, 'not_found', 'Отчетът не е намерен.');
    return (await store.deleteReport(id)) ? c.json({ ok: true }) : fail(c, 404, 'not_found', 'Отчетът не е намерен.');
  });

  app.get('/api/reports/:id/export', async (c) => {
    const report = await store.getReport(c.req.param('id'));
    if (!report) return fail(c, 404, 'not_found', 'Отчетът не е намерен.');
    const format = c.req.query('format') ?? 'json';
    const slug = report.seed.keyword.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'report';
    if (format === 'csv') {
      return new Response(opportunitiesCsv(report), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="opportunities-${encodeURIComponent(slug)}.csv"` } });
    }
    if (format === 'md') {
      return new Response(reportMarkdown(report), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="report-${encodeURIComponent(slug)}.md"` } });
    }
    if (format === 'json') {
      return new Response(JSON.stringify(report, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="report-${encodeURIComponent(slug)}.json"` } });
    }
    return fail(c, 400, 'invalid_format', 'Форматът трябва да е json, csv или md.');
  });

  app.all('/api/*', (c) => fail(c, 404, 'not_found', 'Няма такъв адрес.'));

  // ───────────── the SPA ─────────────
  const webRoot = deps.webRoot ? resolve(deps.webRoot) : null;
  if (webRoot && existsSync(webRoot)) {
    const relRoot = webRoot.startsWith(process.cwd()) ? `.${webRoot.slice(process.cwd().length)}` : webRoot;
    app.use('/*', serveStatic({ root: relRoot }));
    app.get('*', serveStatic({ root: relRoot, path: 'index.html' }));
  } else {
    app.get('/', (c) => c.text('Jev SEO Radar API работи. Интерфейсът не е build-нат — стартирай „npm run build“ или „npm run dev“.', 200));
  }

  app.onError((err, c) => {
    console.error('[http]', err);
    return fail(c, 500, 'internal', 'Вътрешна грешка на сървъра.');
  });

  return app;
}
