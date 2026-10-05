import { APIError } from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import { PipelineError, runAnalysis } from '../../src/server/pipeline/analyze';
import { DEMO_BUSINESS, DEMO_KEYWORD, DEMO_OWN_DOMAIN } from '../../src/server/demo/world';
import { Jev } from '../../src/server/jev/client';
import { ReportSchema, AnalyzeRequestSchema, type AnalyzeRequest } from '../../src/shared/schemas';
import { demoDeps } from '../helpers/demo-deps';
import { scriptedJev } from '../helpers/fake-jev';

const req = (over: Record<string, unknown> = {}): AnalyzeRequest =>
  AnalyzeRequestSchema.parse({ keyword: DEMO_KEYWORD, ownDomain: DEMO_OWN_DOMAIN, businessDescription: DEMO_BUSINESS, options: { serpDepth: 20 }, ...over });
const noop = () => {};

describe('full analysis over the demo world', () => {
  const run = async (over: Record<string, unknown> = {}, tracked: string[] = ['webmasters-bg.example']) =>
    runAnalysis({ id: 'r_test', request: req({ competitors: ['pixel-studio.example'], ...over }), tracked }, demoDeps(), noop);

  it('produces a schema-valid report and reports progress from start to finish', async () => {
    const events: Array<[string, number]> = [];
    const report = await runAnalysis({ id: 'r_test', request: req(), tracked: [] }, demoDeps(), (step, pct) => events.push([step, pct]));
    expect(() => ReportSchema.parse(report)).not.toThrow();
    expect(report.mode).toBe('demo');
    const steps = [...new Set(events.map((e) => e[0]))];
    expect(steps).toEqual(['serp', 'crawl', 'judge', 'expand', 'candidates', 'volumes', 'score', 'save']);
    const pcts = events.map((e) => e[1]);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
  });

  it('understands the SERP: dominant page type, intent, difficulty and the user\'s own rank', async () => {
    const r = await run();
    expect(r.seed.intent).toMatchObject({ dominantPageType: 'service_page', dominantIntent: 'transactional', agreement: true });
    expect(r.seed.assessment?.difficulty).toBe('hard');
    expect(r.seed.ownRank).toEqual({ position: 13, url: expect.stringContaining('my-studio.example') });
    expect(r.seed.pages.map((p) => p.position)).toEqual([...r.seed.pages.map((p) => p.position)].sort((a, b) => (a ?? 99) - (b ?? 99)));
  });

  it('tells strong pages from weak ones and degrades gracefully on blocked pages', async () => {
    const r = await run();
    const byDomain = Object.fromEntries(r.seed.pages.map((p) => [p.domain, p]));
    expect(byDomain['pixel-studio.example']!.composite.overall!).toBeGreaterThan(0.85);
    expect(byDomain['firmi-bg.example']!.composite.overall!).toBeLessThan(0.5);
    expect(byDomain['pixel-studio.example']!.composite.overall!).toBeGreaterThan(byDomain['fabrika-za-saitove.example']!.composite.overall!);
    // robots-blocked and 403 pages are still judged — from title and snippet only
    expect(byDomain['top-agencii.example']).toMatchObject({ fetch: { status: 'blocked_robots' }, metrics: null, judgmentStatus: 'partial' });
    expect(byDomain['top-agencii.example']!.judgments.pageType?.value).toBe('comparison_listicle');
    expect(byDomain['build-your-site.example']!.fetch).toMatchObject({ status: 'http_error', httpStatus: 403 });
    expect(r.warnings.join(' ')).toMatch(/robots\.txt/);
  });

  it('attaches evidence-based strengths and weaknesses to competitors', async () => {
    const r = await run();
    const pixel = r.competitors.find((c) => c.domain === 'pixel-studio.example')!;
    expect(pixel.role).toBe('tracked');
    // decision-relevant strengths (content depth, pricing, portfolio, CTA) come first; hygiene like schema comes later
    expect(pixel.strengths.map((s) => s.id).slice(0, 4)).toEqual(['deep_content', 'pricing', 'portfolio', 'cta']);
    expect(pixel.strengths.map((s) => s.id)).toContain('faq');
    const fabrika = r.competitors.find((c) => c.domain === 'fabrika-za-saitove.example')!;
    expect(fabrika.weaknesses.map((s) => s.id)).toEqual(expect.arrayContaining(['generic_text', 'no_cta']));
    for (const s of [...pixel.strengths, ...fabrika.weaknesses]) expect(s.evidence.length).toBeGreaterThan(0);
  });

  it('lists the user first, then tracked competitors, with visibility computed from many SERPs', async () => {
    const r = await run();
    expect(r.competitors.slice(0, 3).map((c) => [c.domain, c.role])).toEqual([[DEMO_OWN_DOMAIN, 'own'], ['pixel-studio.example', 'tracked'], ['webmasters-bg.example', 'tracked']]);
    expect(r.competitors.find((c) => c.domain === 'pixel-studio.example')!.visibility.keywordsSeen).toBeGreaterThan(5);
    const total = r.competitors.reduce((s, c) => s + c.visibility.shareOfVoice, 0);
    expect(total).toBeGreaterThan(0.8);
    expect(total).toBeLessThanOrEqual(1.001);
  });

  it('finds ranked opportunities, including a quick win in a specific niche, and explains them', async () => {
    const r = await run();
    const candidates = r.opportunities.filter((o) => !o.deep);
    expect(candidates.length).toBeGreaterThanOrEqual(15);
    expect(r.opportunities.some((o) => o.deep && o.keyword === DEMO_KEYWORD)).toBe(true);
    const quick = candidates.filter((o) => o.label === 'quick_win');
    expect(quick.length).toBeGreaterThanOrEqual(1);
    for (const o of quick) {
      expect(o.assessment?.difficulty).toBe('easy');
      expect(o.reasons.length).toBeGreaterThan(0);
      expect(o.relevance).toBeGreaterThanOrEqual(0.5);
    }
    // sorted: quick wins first, then by score
    const order = ['quick_win', 'good', 'hard', 'skip'];
    const labels = r.opportunities.map((o) => order.indexOf(o.label));
    expect(labels).toEqual([...labels].sort((a, b) => a - b));
  });

  it('never recommends irrelevant ideas (job seekers, free-site seekers) or the seed twice', async () => {
    const r = await run();
    const kws = r.opportunities.map((o) => o.keyword);
    expect(kws.filter((k) => /безплатно/.test(k))).toEqual([]);
    expect(new Set(r.opportunities.map((o) => o.normalized)).size).toBe(r.opportunities.length);
  });

  it('builds a content brief and finds the gaps of the user\'s own page', async () => {
    const r = await run();
    expect(r.brief.pageType).toBe('service_page');
    expect(r.brief.length).not.toBeNull();
    expect(r.brief.subtopics.length).toBeGreaterThan(3);
    expect(r.brief.questions.map((q) => q.question)).toContain('Колко струва изработката на сайт?');
    expect(r.brief.schemaTypes.map((s) => s.type)).toEqual(expect.arrayContaining(['Organization', 'Service', 'FAQPage']));
    const kinds = new Set(r.brief.ownGaps!.map((g) => g.kind));
    expect(kinds).toContain('length');
    expect(kinds).toContain('subtopic');
    expect(r.seed.ownPage?.role).toBe('own');
    const own = r.competitors.find((c) => c.role === 'own')!;
    expect(own.scorecard?.overall).not.toBeNull();
  });

  it('accounts for what the run spent', async () => {
    const r = await run();
    expect(r.usage.jevRequests).toBeGreaterThan(100);
    expect(r.usage.jevInputTokens).toBeGreaterThan(10_000);
    expect(r.usage.estimatedJevCostUsd).toBeGreaterThan(0);
    expect(r.usage.estimatedJevCostUsd).toBeLessThan(0.1);
    expect(r.usage.serpCalls).toBeGreaterThan(15);
    expect(r.usage.pagesFetched).toBeGreaterThanOrEqual(8);
    expect(r.usage).toMatchObject({ pagesBlocked: 1, pagesFailed: 1, jevFailures: 0 });
  });

  it('is deterministic', async () => {
    // wall-clock fields legitimately differ between runs
    const strip = (r: Awaited<ReturnType<typeof run>>) =>
      JSON.stringify({ ...r, usage: { ...r.usage, durationMs: 0 }, finishedAt: 0, seed: { ...r.seed, serp: { ...r.seed.serp, fetchedAt: 0 } } });
    expect(strip(await run())).toBe(strip(await run()));
  });

  it('respects the options: no expansion means no candidates and no extra SERP calls', async () => {
    const r = await run({ options: { expandKeywords: false, serpDepth: 10 } });
    expect(r.opportunities.map((o) => o.deep)).toEqual([true]);
    expect(r.usage.serpCalls).toBe(1);
    expect(r.competitors.length).toBeGreaterThan(0);
  });

  it('caps SERP spending with the run budget and says so', async () => {
    const deps = demoDeps({}, { MAX_SERP_CALLS_PER_RUN: '6' });
    const r = await runAnalysis({ id: 'r_budget', request: req(), tracked: [] }, deps, noop);
    expect(r.usage.serpCalls).toBeLessThanOrEqual(6);
    expect(r.opportunities.filter((o) => !o.deep).length).toBeLessThanOrEqual(5);
    expect(r.warnings.join(' ')).toMatch(/Лимитът от 6 SERP заявки/);
  });
});

describe('manual mode (no SERP provider)', () => {
  const manual = (urls: string[], over: Record<string, unknown> = {}) =>
    runAnalysis(
      { id: 'r_manual', request: req({ manualUrls: urls, options: { expandKeywords: true, maxCandidates: 5, serpDepth: 10 }, ...over }), tracked: [] },
      demoDeps({ serp: null, volume: null }),
      noop,
    );

  it('analyses only the supplied URLs and labels the report accordingly', async () => {
    const r = await manual(['https://pixel-studio.example/uslugi/izrabotka-na-uebsait/', 'https://sait-ot-nulata.example/', 'https://fabrika-za-saitove.example/izrabotka-na-saitove.html']);
    expect(r.seed.serp.provider).toBe('manual');
    expect(r.seed.pages.map((p) => p.role)).toEqual(['manual', 'manual', 'manual']);
    expect(r.seed.pages[0]!.composite.overall!).toBeGreaterThan(r.seed.pages[1]!.composite.overall!);
    expect(r.warnings.join(' ')).toMatch(/Няма настроен SERP доставчик/);
  });

  it('keeps unverified keyword ideas from outranking verified ones and says why', async () => {
    const r = await manual(['https://pixel-studio.example/uslugi/izrabotka-na-uebsait/', 'https://sait-ot-nulata.example/', 'https://fabrika-za-saitove.example/izrabotka-na-saitove.html']);
    const ideas = r.opportunities.filter((o) => !o.deep);
    expect(ideas.length).toBeGreaterThan(0);
    for (const o of ideas) {
      expect(o.assessment).toBeNull();
      expect(o.score).toBeLessThanOrEqual(52);
      expect(o.label).not.toBe('quick_win');
      expect(o.reasons.join(' ')).toMatch(/Няма данни за конкуренцията/);
    }
  });

  it('fails clearly with neither a SERP provider nor URLs', async () => {
    await expect(manual([])).rejects.toMatchObject({ code: 'input', message: expect.stringMatching(/SERPER_API_KEY/) });
  });
});

describe('failure handling', () => {
  it('turns a rejected Jev key into an actionable error instead of an empty report', async () => {
    const { jev } = scriptedJev({}, { failWhen: () => APIError.fromResponse(401, { message: 'bad' }, new Headers()) });
    const err = await runAnalysis({ id: 'r', request: req(), tracked: [] }, demoDeps({ jev }), noop).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toMatchObject({ code: 'jev', message: expect.stringMatching(/JEV_API_KEY/) });
  });

  it('reports a partial result when Jev is merely flaky', async () => {
    let n = 0;
    const real = demoDeps();
    const flaky: Jev = new Proxy(real.jev, {
      get(target, prop, receiver) {
        if (prop === 'tryAsk') {
          return async (...args: Parameters<Jev['tryAsk']>) => (++n % 7 === 0 ? null : target.tryAsk(...args));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const r = await runAnalysis({ id: 'r', request: req(), tracked: [] }, { ...real, jev: flaky }, noop);
    expect(r.status).toBe('partial');
    expect(r.warnings.join(' ')).toMatch(/Jev не върна всички оценки/);
    expect(r.seed.pages.length).toBeGreaterThan(5);
  });

  it('survives candidate-SERP failures and a dead volume provider', async () => {
    const real = demoDeps();
    let searches = 0;
    const serp = {
      ...real.serp!,
      id: 'demo' as const,
      async search(q: Parameters<NonNullable<typeof real.serp>['search']>[0], o?: Parameters<NonNullable<typeof real.serp>['search']>[1]) {
        if (++searches > 1 && searches % 3 === 0) throw new (await import('../../src/server/providers/serp/types')).SerpError('unavailable', 'временна грешка', 503);
        return real.serp!.search(q, o);
      },
    };
    const volume = { id: 'demo' as const, async volumes(): Promise<never> { throw new (await import('../../src/server/providers/serp/types')).SerpError('unavailable', 'volume down', 500); } };
    const r = await runAnalysis({ id: 'r', request: req(), tracked: [] }, { ...real, serp, volume }, noop);
    expect(r.warnings.join(' ')).toMatch(/SERP заявката не успя/);
    expect(r.warnings.join(' ')).toMatch(/Обемът на търсенията не е наличен/);
    expect(r.opportunities.every((o) => o.volume === null)).toBe(true);
    expect(r.opportunities.length).toBeGreaterThan(5);
  });

  it('stops asking for SERPs after a fatal provider error but still returns what it has', async () => {
    const real = demoDeps();
    let searches = 0;
    const SerpError = (await import('../../src/server/providers/serp/types')).SerpError;
    const serp = {
      ...real.serp!,
      id: 'demo' as const,
      async search(q: Parameters<NonNullable<typeof real.serp>['search']>[0], o?: Parameters<NonNullable<typeof real.serp>['search']>[1]) {
        if (++searches > 6) throw new SerpError('quota', 'Няма кредити', 402);
        return real.serp!.search(q, o);
      },
    };
    const r = await runAnalysis({ id: 'r', request: req(), tracked: [] }, { ...real, serp }, noop);
    expect(r.status).toBe('partial');
    expect(r.warnings.join(' ')).toMatch(/SERP заявките бяха прекратени/);
    expect(r.opportunities.length).toBeGreaterThan(1);
  });

  it('surfaces a dead SERP key on the seed query as an error', async () => {
    const real = demoDeps();
    const SerpError = (await import('../../src/server/providers/serp/types')).SerpError;
    const serp = { ...real.serp!, id: 'demo' as const, async search(): Promise<never> { throw new SerpError('auth', 'Serper отхвърли API ключа', 401); } };
    await expect(runAnalysis({ id: 'r', request: req(), tracked: [] }, { ...real, serp }, noop)).rejects.toMatchObject({ code: 'serp', message: expect.stringMatching(/Serper/) });
  });

  it('can be cancelled', async () => {
    const ctrl = new AbortController();
    const deps = demoDeps();
    const p = runAnalysis({ id: 'r', request: req(), tracked: [] }, deps, (step) => { if (step === 'crawl') ctrl.abort(new PipelineError('Анализът е прекратен.', 'aborted')); }, ctrl.signal);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });

  it('refuses an empty SERP', async () => {
    const real = demoDeps();
    const serp = { ...real.serp!, id: 'demo' as const, async search(q: Parameters<NonNullable<typeof real.serp>['search']>[0]) { const s = await real.serp!.search(q); return { ...s, results: [] }; } };
    await expect(runAnalysis({ id: 'r', request: req(), tracked: [] }, { ...real, serp }, noop)).rejects.toMatchObject({ code: 'input', message: expect.stringMatching(/не върна резултати/) });
  });
});
