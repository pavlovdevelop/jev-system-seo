import { describe, expect, it } from 'vitest';
import { runSiteAudit, type AuditDeps } from '../../src/server/audit/pipeline';
import { llmWriter, rulesWriter } from '../../src/server/audit/writer';
import { InProcessExtractor } from '../../src/server/crawl/extract-pool';
import { createDemoSiteWorld, DEMO_AUDIT_DEFAULTS } from '../../src/server/demo/site-world';
import { EngineError, type AnswerEngine } from '../../src/server/geo/engines/types';
import { Jev } from '../../src/server/jev/client';
import { createMockTransport } from '../../src/server/jev/mock';
import { PipelineError } from '../../src/server/pipeline/analyze';
import { Meter } from '../../src/server/util/meter';
import { SiteAuditRequestSchema, type SiteAuditReport } from '../../src/shared/audit';
import { scriptedJev } from '../helpers/fake-jev';

const NOW = new Date('2026-10-05T10:00:00Z');
const request = (options: Record<string, unknown> = {}) => SiteAuditRequestSchema.parse({ ...DEMO_AUDIT_DEFAULTS, options: { maxPages: 40, questions: 12, rankChecks: 6, competitorPages: 6, ...options } });

function deps(over: Partial<AuditDeps> = {}): AuditDeps {
  const world = createDemoSiteWorld({ now: () => NOW });
  return {
    jev: new Jev({ transport: createMockTransport(), model: 'mock', maxConcurrency: 16, logger: { warn: () => {}, debug: () => {} } }),
    serp: world.serp,
    volume: world.volume,
    fetcher: world.fetcher,
    extractor: new InProcessExtractor(),
    engines: world.engines,
    writer: rulesWriter,
    meter: new Meter({ maxSerpCalls: 100, maxPages: 100_000 }),
    limits: { maxPages: 100, maxQuestions: 60, maxEngineCalls: 500 },
    info: { mode: 'demo', serp: 'demo', jev: { model: 'mock', endpoint: 'demo' } },
    brandHints: world.brandHints,
    now: () => NOW,
    ...over,
  };
}
const run = (d: AuditDeps, r = request(), signal?: AbortSignal): Promise<SiteAuditReport> => runSiteAudit({ id: 'a_testrun0001', request: r, tracked: [] }, d, () => {}, signal);

describe('a complete run', () => {
  it('produces every part of the report, consistent with each other', async () => {
    const r = await run(deps());
    expect(r).toMatchObject({ kind: 'site', status: 'complete', mode: 'demo', id: 'a_testrun0001' });
    expect(r.site).toMatchObject({ domain: 'my-studio.example', source: 'sitemap', pagesFound: 14, pagesAudited: 14, truncated: false });
    expect(r.figures.elementsTotal).toBe(r.elements.length);
    expect(r.figures.elementsToChange).toBe(r.elements.filter((e) => e.verdict === 'change').length);
    expect(r.figures.questionsTotal).toBe(r.questions.length);
    expect(r.figures.pagesToSteal).toBe(r.competitorPages.filter((c) => c.verdict === 'steal').length);
    // every page that was read and judged has a citability, and the first fix never makes it worse
    for (const p of r.pages.filter((x) => x.citability)) expect(p.citability!.after).toBeGreaterThanOrEqual(p.citability!.now);
    // elements belong to audited pages; questions point at audited pages
    const urls = new Set(r.pages.map((p) => p.url));
    expect(r.elements.every((e) => urls.has(e.url))).toBe(true);
    expect(r.questions.every((q) => q.bestPage === null || urls.has(q.bestPage))).toBe(true);
    expect(r.questions.every((q) => (q.verdict === 'no_page') === (q.bestPage === null))).toBe(true);
    // the plan covers pages that exist or new ones, and every checklist ends with indexing
    for (const p of r.plan) {
      expect(p.kind === 'rewrite' ? urls.has(p.url as string) : p.url === null).toBe(true);
      expect(p.checklist.at(-1)?.text).toMatch(/индексиране/);
    }
    // the report is exactly what the schema says (the pipeline parses it, so this holds by construction)
    expect(r.geo?.engines).toHaveLength(3);
    expect(r.geo?.answers.length).toBe(r.geo!.engines.reduce((s, e) => s + e.asked, 0));
    expect(r.usage.jevRequests).toBeGreaterThan(0);
    expect(r.usage.engineCalls).toBe(r.geo!.answers.length);
    expect(r.usage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: the same run twice gives the same findings', async () => {
    const a = await run(deps());
    const b = await run(deps());
    const strip = (r: SiteAuditReport) => ({ ...r, usage: undefined, createdAt: undefined, finishedAt: undefined });
    expect(strip(b)).toEqual(strip(a));
  });

  it('marks the pages the rules found wrong, in the places they are wrong', async () => {
    const r = await run(deps());
    const row = (path: string, element: string) => r.elements.find((e) => e.url.endsWith(path) && e.element === element);
    expect(row('/uslugi/onlain-magazin', 'title')).toMatchObject({ verdict: 'change', source: 'rule', now: 'липсва' });
    expect(row('/uslugi/seo-optimizatsiya', 'title')?.reason).toMatch(/2 страници/); // the title the two service pages share
    expect(row('/blog/seo-za-malak-biznes', 'canonical')).toMatchObject({ verdict: 'change' });
    expect(row('/blog/kolko-struva-sait', 'faq')?.now).toMatch(/без schema/);
    expect(row('/portfolio', 'images')).toMatchObject({ verdict: 'change' });
    expect(row('/tseni', 'title')?.verdict).toBe('keep');
  });

  it('finds the rank of the pages that were looked up, and only those', async () => {
    const r = await run(deps(), request({ rankChecks: 14 }));
    const rank = (path: string) => r.pages.find((p) => p.path === path)?.rank;
    expect(rank('/tseni')).toBe(4);
    expect(rank('/')).toBe(8);
    expect(rank('/za-nas')).toBeNull();
    const none = await run(deps(), request({ rankChecks: 0 }));
    expect(none.pages.every((p) => p.rank === null)).toBe(true);
  });
});

describe('what is missing', () => {
  it('without a search provider: no ranks, no competitor pages — and says so', async () => {
    const r = await run(deps({ serp: null }));
    expect(r.competitorPages).toEqual([]);
    expect(r.pages.every((p) => p.rank === null)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/SERP доставчик/);
    expect(r.questions.length).toBeGreaterThan(0); // templates still give questions
    expect(r.providers.serp).toBeDefined();
  });

  it('without any AI assistant: no GEO, a plan from the unanswered questions, and a warning', async () => {
    const r = await run(deps({ engines: [] }));
    expect(r.geo).toBeNull();
    expect(r.figures.citationRate).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/ИИ двигателите не са питани/);
    expect(r.plan.length).toBeGreaterThan(0);
    expect(r.plan.every((p) => p.engines.length === 0)).toBe(true);
    expect(r.questions.every((q) => q.aiCites.length === 0 && q.citedBy.length === 0)).toBe(true);
  });

  it('with the engines the form did not tick left out', async () => {
    const r = await run(deps(), request({ engines: ['gemini'] }));
    expect(r.geo?.engines.map((e) => e.engine)).toEqual(['gemini']);
    expect(r.providers.engines.map((e) => e.engine)).toEqual(['gemini']);
  });

  it('with no questions asked at all', async () => {
    const r = await run(deps(), request({ questions: 0 }));
    expect(r.questions).toEqual([]);
    expect(r.geo).toBeNull();
    expect(r.plan).toEqual([]);
  });
});

describe('when things go wrong', () => {
  it('stops an engine whose key is rejected, keeps the others, and says the run is partial', async () => {
    const world = createDemoSiteWorld({ now: () => NOW });
    const dead: AnswerEngine = { ...world.engines[1]!, ask: async () => { throw new EngineError('auth', 'Ключът на Claude е отхвърлен'); } };
    const r = await run(deps({ engines: [world.engines[0]!, dead, world.engines[2]!] }));
    expect(r.status).toBe('partial');
    expect(r.warnings.join(' ')).toMatch(/Claude беше спрян: Ключът на Claude е отхвърлен/);
    const claude = r.geo!.engines.find((e) => e.engine === 'anthropic')!;
    expect(claude.answered).toBe(0);
    expect(r.geo!.engines.find((e) => e.engine === 'openai')!.answered).toBeGreaterThan(0);
  });

  it('respects the call budget and says how many questions it did not ask', async () => {
    const r = await run(deps({ limits: { maxPages: 100, maxQuestions: 60, maxEngineCalls: 9 } }), request({ questions: 12 }));
    expect(r.usage.engineCalls).toBe(9);
    expect(r.warnings.join(' ')).toMatch(/MAX_GEO_CALLS_PER_RUN/);
  });

  it('finishes — as a partial report — when Jev fails on everything', async () => {
    const { jev } = scriptedJev({}, { failWhen: () => new Error('503') });
    const r = await run(deps({ jev }));
    expect(r.status).toBe('partial');
    expect(r.pages.every((p) => p.judgmentStatus === 'none')).toBe(true);
    expect(r.usage.jevFailures).toBeGreaterThan(0);
    expect(r.elements.length).toBeGreaterThan(0); // the rules still work
    expect(r.warnings.join(' ')).toMatch(/Jev не върна всички оценки/);
  });

  it('refuses a site it cannot open, with the reason', async () => {
    const fetcher = { fetchPage: async (url: string) => ({ status: 'error' as const, httpStatus: null, finalUrl: url, html: null, error: 'Няма връзка', ttfbMs: null, bytes: null, fromCache: false }) };
    await expect(run(deps({ fetcher }))).rejects.toMatchObject({ name: 'PipelineError', code: 'input', message: expect.stringMatching(/Не успях да отворя сайта my-studio\.example/) });
  });

  it('stops when the run is cancelled', async () => {
    const controller = new AbortController();
    const d = deps();
    const original = d.jev.tryAsk.bind(d.jev);
    let n = 0;
    d.jev.tryAsk = ((...args: Parameters<typeof original>) => {
      if (++n === 5) controller.abort(new PipelineError('Анализът е прекратен.', 'aborted'));
      return original(...args);
    }) as typeof d.jev.tryAsk;
    await expect(run(d, request(), controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  });

  it('records pages that cannot be read without failing the audit', async () => {
    const world = createDemoSiteWorld({ now: () => NOW });
    const fetcher = { ...world.fetcher, fetchPage: async (url: string) => (url.endsWith('/portfolio') ? { status: 'http_error' as const, httpStatus: 500, finalUrl: url, html: null, error: 'HTTP 500', ttfbMs: 10, bytes: null, fromCache: false } : world.fetcher.fetchPage(url)) };
    const r = await run(deps({ fetcher }));
    const page = r.pages.find((p) => p.path === '/portfolio')!;
    expect(page).toMatchObject({ metrics: null, words: 0, citability: null, elementsToChange: 0 });
    expect(page.fetch.status).toBe('http_error');
    expect(r.elements.some((e) => e.url.endsWith('/portfolio'))).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/не се отвори/);
  });
});

describe('with a language model as the writer', () => {
  function writerEngine() {
    const calls: string[] = [];
    const engine: AnswerEngine = {
      id: 'anthropic',
      label: 'Claude',
      model: 'writer-model',
      ask: async () => { throw new Error('not used'); },
      generate: async (req) => {
        calls.push(req.prompt.slice(0, 40));
        if (/realistic questions/.test(req.prompt)) return { text: '{"questions": ["Колко струва поддръжката на уебсайт на месец?", "Как да защитя сайта си от хакери през 2026?"]}', usage: { inputTokens: 1, outputTokens: 1 } };
        if (/Rewrite ONLY/.test(req.prompt)) return { text: '{"title": "Изработка на уебсайт — цена и срок | Моето студио", "meta": "Написано от модела описание на страницата, което е достатъчно дълго, за да се използва като предложение за мета описание.", "h1": "Изработка на уебсайт за малък бизнес", "intro": "Изработваме уебсайтове за малки фирми — от 490 лв., готови за 2–3 седмици."}', usage: { inputTokens: 1, outputTokens: 1 } };
        return { text: '{"steps": [{"text": "Първо: прочети цитираните страници и отбележи структурата им.", "why": "така знаеш какво се очаква"}, {"text": "Второ: пренапиши началото с директен отговор.", "why": "ИИ чете началото"}, {"text": "Трето: добави FAQ със schema.", "why": "цитират се блокове въпрос-отговор"}]}', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return { engine, calls };
  }

  it('uses it for questions, proposals and checklists, and marks what it wrote', async () => {
    const { engine, calls } = writerEngine();
    const writer = llmWriter(engine);
    const r = await run(deps({ writer }));
    expect(r.providers.writer).toBe('Claude (writer-model)');
    expect(r.usage.writerCalls).toBe(writer.calls());
    expect(r.usage.writerCalls).toBeGreaterThan(3);
    expect(calls.length).toBe(r.usage.writerCalls);
    expect(r.questions.some((q) => q.source === 'llm')).toBe(true);
    const written = r.elements.filter((e) => e.proposalBy === 'llm');
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((e) => e.verdict === 'change' && e.proposal)).toBe(true);
    expect(r.plan.some((p) => p.writtenBy === 'llm' && p.checklist[0]?.text.startsWith('Първо'))).toBe(true);
    expect(r.warnings.join(' ')).not.toMatch(/Няма езиков модел/);
  });

  it('survives a writer that fails on every call', async () => {
    const broken: AnswerEngine = { ...writerEngine().engine, generate: async () => { throw new EngineError('unavailable', 'writer down'); } };
    const r = await run(deps({ writer: llmWriter(broken) }));
    expect(r.elements.every((e) => e.proposalBy !== 'llm')).toBe(true);
    expect(r.plan.every((p) => p.writtenBy === 'rules')).toBe(true);
    expect(r.plan.length).toBeGreaterThan(0);
  });
});
