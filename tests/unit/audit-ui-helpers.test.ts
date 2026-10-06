import { describe, expect, it } from 'vitest';
import { QUESTION_STAGES, SEO_ELEMENTS, SiteAuditRequestSchema } from '../../src/shared/audit';
import {
  auditBounds,
  AUDIT_DEFAULTS,
  bgNoun,
  buildAuditRequest,
  citabilityRows,
  clampInt,
  competitorCounts,
  duration,
  elementCounts,
  estimateAudit,
  filterCompetitors,
  filterElements,
  filterQuestions,
  intervalText,
  JEV_TOKENS_PER_REQUEST,
  JEV_USD_PER_MILLION_TOKENS,
  noPageShare,
  parseBrandNames,
  pathOf,
  pipsFilled,
  pointsGain,
  questionCounts,
  signed,
  sortCompetitors,
  sortElements,
  sortQuestions,
  topPlan,
  whyNotJudged,
  askedQuestionCount,
  type AuditFormValues,
} from '../../src/web/lib/audit';
import { sampleSiteAudit } from '../helpers/site-audit-sample';

// The pure parts of the site audit UI: the estimate, form checks, filters, sorters and number formatting.

const audit = sampleSiteAudit();

describe('estimateAudit', () => {
  const base = { pages: 40, questions: 24, competitorPages: 12, rankChecks: 10, engines: 3 };

  it('follows the stated formulas for the defaults', () => {
    const e = estimateAudit(base);
    expect(e.engineCalls).toBe(24 * 3);
    // pages×6 + questions×(1+3) + competitorPages×5 + one sentiment request per answer
    expect(e.jevRequests).toBe(40 * 6 + 24 * 4 + 12 * 5 + 72);
    expect(e.serpCalls).toBe(10 + 8);
    expect(e.jevInputTokens).toBe(e.jevRequests * JEV_TOKENS_PER_REQUEST);
    expect(e.jevCostUsd).toBeCloseTo((e.jevInputTokens / 1_000_000) * JEV_USD_PER_MILLION_TOKENS, 9);
    expect(e.pagesToRead).toBe(52);
    expect(JEV_USD_PER_MILLION_TOKENS).toBe(0.042);
    expect(JEV_TOKENS_PER_REQUEST).toBe(1500);
  });

  it('never promises more than the server caps allow', () => {
    const e = estimateAudit({ ...base, pages: 500, questions: 200, caps: { maxPages: 60, maxQuestions: 40, maxEngineCalls: 100 } });
    expect(e.pages).toBe(60);
    expect(e.questions).toBe(40);
    expect(e.engineCalls).toBe(100); // 40 × 3 = 120, held to 100
    expect(e.jevRequests).toBe(60 * 6 + 40 * 4 + 12 * 5 + 100);
  });

  it('has no engine calls and no sentiment requests when no engine is asked', () => {
    const e = estimateAudit({ ...base, engines: 0 });
    expect(e.engineCalls).toBe(0);
    expect(e.jevRequests).toBe(40 * 6 + 24 * 4 + 12 * 5);
  });

  it('has no Google calls without a SERP provider', () => {
    expect(estimateAudit({ ...base, serp: false }).serpCalls).toBe(0);
    expect(estimateAudit({ ...base, serp: true }).serpCalls).toBe(18);
  });

  it('is zero for zero options and never negative or NaN for odd input', () => {
    const none = estimateAudit({ pages: 0, questions: 0, competitorPages: 0, rankChecks: 0, engines: 0 });
    expect(none.jevRequests).toBe(0);
    expect(none.jevCostUsd).toBe(0);
    const odd = estimateAudit({ pages: -5, questions: Number.NaN, competitorPages: 2.9, rankChecks: -1, engines: 1 });
    for (const v of Object.values(odd)) expect(Number.isFinite(v) && v >= 0, JSON.stringify(odd)).toBe(true);
    expect(odd.competitorPages).toBe(2);
  });

  it('grows with every option', () => {
    const r = (o: Partial<typeof base>) => estimateAudit({ ...base, ...o }).jevRequests;
    expect(r({ pages: 41 })).toBeGreaterThan(r({}));
    expect(r({ questions: 25 })).toBeGreaterThan(r({}));
    expect(r({ competitorPages: 13 })).toBeGreaterThan(r({}));
    expect(r({ engines: 2 })).toBeLessThan(r({}));
  });
});

describe('clampInt and auditBounds', () => {
  it('holds a typed number to its range and falls back when it is unreadable', () => {
    expect(clampInt('25', 1, 60, 40)).toBe(25);
    expect(clampInt(' 999 ', 1, 60, 40)).toBe(60);
    expect(clampInt('-3', 1, 60, 40)).toBe(1);
    expect(clampInt('', 1, 60, 40)).toBe(40);
    expect(clampInt('abc', 0, 40, 24)).toBe(24);
    expect(clampInt('12.9', 0, 40, 24)).toBe(12);
    expect(clampInt('5', 10, 3, 7)).toBe(10); // an impossible range collapses to its minimum
  });

  it('takes the contract range and holds it to the server caps', () => {
    const b = auditBounds({ maxPages: 60, maxQuestions: 40 });
    expect(b.maxPages).toEqual({ min: 1, max: 60 });
    expect(b.questions).toEqual({ min: 0, max: 40 });
    expect(b.competitorPages).toEqual({ min: 0, max: 30 });
    expect(b.rankChecks).toEqual({ min: 0, max: 40 });
    expect(auditBounds({ maxPages: 9999, maxQuestions: 9999 })).toMatchObject({ maxPages: { max: 500 }, questions: { max: 200 } });
    expect(auditBounds({ maxPages: 0, maxQuestions: 0 })).toMatchObject({ maxPages: { min: 1, max: 1 }, questions: { max: 0 } });
    expect(AUDIT_DEFAULTS).toEqual({ maxPages: 40, questions: 24, competitorPages: 12, rankChecks: 10 });
  });
});

describe('parseBrandNames', () => {
  it('takes one name per line and keeps spaces and commas inside a name', () => {
    expect(parseBrandNames('Моето студио\n  My Studio  \n\nMoeto Studio, ООД\r\nmy-studio.example')).toEqual({
      names: ['Моето студио', 'My Studio', 'Moeto Studio, ООД', 'my-studio.example'],
      error: null,
    });
    expect(parseBrandNames('   \n ')).toEqual({ names: [], error: null });
  });

  it('drops repeats whatever the case, Cyrillic included', () => {
    expect(parseBrandNames('Моето студио\nМОЕТО СТУДИО\nmoeto\nMOETO').names).toEqual(['Моето студио', 'moeto']);
  });

  it('refuses names that are too short, too long or too many, and says which', () => {
    expect(parseBrandNames('A').error).toMatch(/„A“ е твърде късо/);
    expect(parseBrandNames(`${'x'.repeat(61)}`).error).toMatch(/твърде дълго/);
    expect(parseBrandNames('x'.repeat(60)).error).toBeNull();
    const eleven = Array.from({ length: 11 }, (_, i) => `Марка ${i + 1}`).join('\n');
    expect(parseBrandNames(eleven).error).toMatch(/най-много 10 \(въведени са 11\)/);
    expect(parseBrandNames(Array.from({ length: 10 }, (_, i) => `Марка ${i + 1}`).join('\n')).error).toBeNull();
  });
});

describe('buildAuditRequest', () => {
  const bounds = auditBounds({ maxPages: 60, maxQuestions: 40 });
  const form: AuditFormValues = {
    domain: 'https://www.My-Studio.example/uslugi',
    market: 'bg',
    description: '  Малко студио, което прави уебсайтове и онлайн магазини за малки фирми.  ',
    brands: 'Моето студио\nMy Studio',
    competitors: 'pixel-studio.example, https://www.Webmasters-BG.example/x\nPixel-Studio.example',
    engines: ['openai', 'anthropic'],
    configuredEngines: 3,
    maxPages: '40',
    questions: '24',
    competitorPages: '12',
    rankChecks: '10',
  };
  const problem = (over: Partial<AuditFormValues>): string => {
    const r = buildAuditRequest({ ...form, ...over }, bounds);
    return r.ok ? '' : r.problem;
  };

  it('turns a good form into a request the contract accepts', () => {
    const r = buildAuditRequest(form, bounds);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toEqual({
      domain: 'my-studio.example',
      market: 'bg',
      businessDescription: 'Малко студио, което прави уебсайтове и онлайн магазини за малки фирми.',
      brandNames: ['Моето студио', 'My Studio'],
      competitors: ['pixel-studio.example', 'webmasters-bg.example'],
      options: { maxPages: 40, competitorPages: 12, questions: 24, engines: ['openai', 'anthropic'], rankChecks: 10 },
    });
    const parsed = SiteAuditRequestSchema.safeParse(r.body);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('holds the numbers to their bounds and falls back to the defaults for empty fields', () => {
    const r = buildAuditRequest({ ...form, maxPages: '999', questions: '', competitorPages: '-4', rankChecks: 'x' }, bounds);
    expect(r.ok && r.body.options).toMatchObject({ maxPages: 60, questions: 24, competitorPages: 0, rankChecks: 10 });
  });

  it('says in words what is wrong, one thing at a time', () => {
    expect(problem({ domain: '  ' })).toMatch(/Въведи домейна/);
    expect(problem({ domain: 'not a domain!!' })).toMatch(/Домейнът трябва да е един/);
    expect(problem({ domain: 'a.example b.example' })).toMatch(/Домейнът трябва да е един/);
    expect(problem({ description: 'къс' })).toMatch(/поне 10 знака/);
    expect(problem({ description: 'x'.repeat(601) })).toMatch(/най-много 600/);
    expect(problem({ brands: 'A' })).toMatch(/твърде късо/);
    expect(problem({ competitors: 'good.example\nnot-a-domain' })).toMatch(/not-a-domain/);
    expect(problem({ competitors: Array.from({ length: 31 }, (_, i) => `site${i}.example`).join('\n') })).toMatch(/най-много 30/);
  });

  it('wants at least one engine ticked when questions are asked and engines exist', () => {
    expect(problem({ engines: [] })).toMatch(/поне един ИИ двигател/);
    expect(problem({ engines: [], questions: '0' })).toBe('');
    expect(problem({ engines: [], configuredEngines: 0 })).toBe(''); // nothing configured: the AI part is skipped
    const none = buildAuditRequest({ ...form, engines: [], configuredEngines: 0 }, bounds);
    expect(none.ok && none.body.options?.engines).toEqual([]);
  });
});

describe('small formatters', () => {
  it('pipsFilled rounds like the brief says and keeps "not judged" apart from zero', () => {
    expect(pipsFilled(null)).toBeNull();
    expect(pipsFilled(undefined)).toBeNull();
    expect(pipsFilled(Number.NaN)).toBeNull();
    expect(pipsFilled(0)).toBe(0);
    expect(pipsFilled(0.5)).toBe(3);
    expect(pipsFilled(0.29)).toBe(1);
    expect(pipsFilled(0.7)).toBe(4);
    expect(pipsFilled(1)).toBe(5);
    expect(pipsFilled(1.4)).toBe(5);
    expect(pipsFilled(-0.2)).toBe(0);
    expect(pipsFilled(0.5, 4)).toBe(2);
  });

  it('pathOf shows the path and query of an address, decoded', () => {
    expect(pathOf('https://my-studio.example/blog/a-b?x=1')).toBe('/blog/a-b?x=1');
    expect(pathOf('https://my-studio.example')).toBe('/');
    expect(pathOf('https://my-studio.example/%D1%83%D1%81%D0%BB%D1%83%D0%B3%D0%B8')).toBe('/услуги');
    expect(pathOf('https://my-studio.example/%E0%A4%A')).toBe('/%E0%A4%A');
    expect(pathOf('not a url')).toBe('not a url');
  });

  it('duration is seconds, then minutes and seconds', () => {
    expect(duration(800)).toBe('800 ms');
    expect(duration(5400)).toBe('5.4 с');
    expect(duration(45_000)).toBe('45 с');
    expect(duration(214_800)).toBe('3 мин 35 с');
    expect(duration(120_000)).toBe('2 мин 0 с');
  });

  it('intervals, gains and nouns', () => {
    expect(intervalText(0.117, 0.546)).toBe('12–55%');
    expect(pointsGain(0.43, 0.51)).toBe(8);
    expect(pointsGain(0.5, 0.5)).toBe(0);
    expect([signed(8), signed(-3), signed(0)]).toEqual(['+8', '−3', '0']);
    expect(bgNoun(1, 'страница', 'страници')).toBe('страница');
    expect(bgNoun(0, 'страница', 'страници')).toBe('страници');
    expect(bgNoun(5, 'страница', 'страници')).toBe('страници');
  });
});

describe('SEO elements: filter, sort, counts', () => {
  const rows = audit.elements;
  const all = { verdict: 'all', element: 'all', query: '' } as const;

  it('filters by verdict, by element and by part of the page address (any case)', () => {
    expect(filterElements(rows, all)).toHaveLength(rows.length);
    expect(filterElements(rows, { ...all, verdict: 'change' })).toHaveLength(audit.figures.elementsToChange);
    expect(filterElements(rows, { ...all, verdict: 'keep' })).toHaveLength(rows.length - audit.figures.elementsToChange);
    expect(filterElements(rows, { ...all, element: 'title' }).every((e) => e.element === 'title')).toBe(true);
    const found = filterElements(rows, { ...all, query: '  TSENORAZ ' });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((e) => e.url.includes('/tsenoraz'))).toBe(true);
    expect(filterElements(rows, { ...all, query: 'няма-такава' })).toEqual([]);
    expect(filterElements(rows, { verdict: 'change', element: 'meta', query: '' }).every((e) => e.verdict === 'change' && e.element === 'meta')).toBe(true);
  });

  it('sorts by impact (biggest first) or by page and element order, without touching its input', () => {
    const copy = [...rows];
    const byImpact = sortElements(rows, 'impact');
    expect(rows).toEqual(copy);
    expect(byImpact.map((e) => e.impact)).toEqual([...byImpact.map((e) => e.impact)].sort((a, b) => b - a));
    expect(byImpact[0]?.verdict).toBe('change');
    const byPage = sortElements(rows, 'page');
    expect(pathOf(byPage[0]?.url ?? '')).toBe('/');
    const paths = byPage.map((e) => pathOf(e.url));
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    // inside one page the elements keep the order of SEO_ELEMENTS
    for (let i = 1; i < byPage.length; i++) {
      const [a, b] = [byPage[i - 1], byPage[i]];
      if (a && b && a.url === b.url) expect(SEO_ELEMENTS.indexOf(a.element)).toBeLessThanOrEqual(SEO_ELEMENTS.indexOf(b.element));
    }
  });

  it('counts what each chip would show, given the other filters', () => {
    const c = elementCounts(rows, all);
    expect(c.verdict.all).toBe(rows.length);
    expect(c.verdict.change + c.verdict.keep).toBe(rows.length);
    expect(Object.values(c.element).reduce((s, n) => s + n, 0)).toBe(rows.length);
    expect(c.all).toBe(rows.length);

    const changes = elementCounts(rows, { ...all, verdict: 'change' });
    expect(changes.verdict.all).toBe(rows.length); // the verdict chips ignore the verdict filter
    expect(changes.all).toBe(audit.figures.elementsToChange); // the element chips follow it
    expect(Object.values(changes.element).reduce((s, n) => s + n, 0)).toBe(audit.figures.elementsToChange);

    const titles = elementCounts(rows, { ...all, element: 'title' });
    expect(titles.verdict.all).toBe(filterElements(rows, { ...all, element: 'title' }).length);
    expect(titles.verdict.change + titles.verdict.keep).toBe(titles.verdict.all);
  });
});

describe('competitor pages: filter, sort, counts', () => {
  const rows = audit.competitorPages;

  it('sorts the strongest page first and a page that could not be scored last', () => {
    const sorted = sortCompetitors(rows);
    const overall = sorted.map((c) => c.overall);
    expect(overall[overall.length - 1]).toBeNull();
    const numbers = overall.filter((v): v is number => v !== null);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(sorted[0]?.domain).toBe('pixel-studio.example');
  });

  it('breaks ties by Google position (a missing one last), then by domain', () => {
    const base = rows[0];
    if (!base) throw new Error('sample has competitor pages');
    const tie = [
      { ...base, domain: 'b.example', overall: 0.5, googleRank: null },
      { ...base, domain: 'a.example', overall: 0.5, googleRank: null },
      { ...base, domain: 'c.example', overall: 0.5, googleRank: 3 },
    ];
    expect(sortCompetitors(tie).map((c) => c.domain)).toEqual(['c.example', 'a.example', 'b.example']);
  });

  it('filters and counts by verdict', () => {
    expect(filterCompetitors(rows, 'steal').every((c) => c.verdict === 'steal')).toBe(true);
    expect(filterCompetitors(rows, 'all')).toHaveLength(rows.length);
    expect(competitorCounts(rows)).toEqual({ all: 10, steal: 5, skip: 5 });
  });
});

describe('buyer questions: filter, sort, counts', () => {
  const rows = audit.questions;

  it('puts questions without a page first, then weak answers, then answered; the most asked first inside a group', () => {
    const sorted = sortQuestions(rows);
    const order = { no_page: 0, weak: 1, answered: 2 } as const;
    expect(sorted.map((q) => order[q.verdict])).toEqual([...sorted.map((q) => order[q.verdict])].sort((a, b) => a - b));
    for (const verdict of ['no_page', 'weak', 'answered'] as const) {
      const group = sorted.filter((q) => q.verdict === verdict);
      const volumes = group.map((q) => q.volume ?? -1);
      expect(volumes, verdict).toEqual([...volumes].sort((a, b) => b - a));
    }
    expect(sorted.filter((q) => q.verdict === 'no_page').at(-1)?.volume).toBeNull(); // an unknown volume goes last
  });

  it('breaks a tie of volume by the worst match first', () => {
    const base = rows.find((q) => q.verdict === 'weak');
    if (!base) throw new Error('sample has a weak question');
    const tie = [
      { ...base, id: 'x1', text: 'x1', volume: 100, match: 0.5 },
      { ...base, id: 'x2', text: 'x2', volume: 100, match: 0.3 },
      { ...base, id: 'x3', text: 'x3', volume: 100, match: 0.4 },
    ];
    expect(sortQuestions(tie).map((q) => q.id)).toEqual(['x2', 'x3', 'x1']);
  });

  it('filters by stage and verdict, and the counts match what a click gives', () => {
    expect(filterQuestions(rows, { stage: 'all', verdict: 'all' })).toHaveLength(24);
    expect(filterQuestions(rows, { stage: 'price', verdict: 'all' }).every((q) => q.stage === 'price')).toBe(true);
    const f = { stage: 'all', verdict: 'no_page' } as const;
    const c = questionCounts(rows, f);
    expect(c.verdict.all).toBe(24);
    expect(c.verdict.no_page).toBe(8);
    expect(c.stage.all).toBe(8);
    for (const s of QUESTION_STAGES) expect(c.stage[s]).toBe(filterQuestions(rows, { ...f, stage: s }).length);
    expect(QUESTION_STAGES.reduce((sum, s) => sum + c.stage[s], 0)).toBe(c.stage.all);
  });

  it('says what share of the questions has no page', () => {
    expect(noPageShare(audit.figures)).toBeCloseTo(8 / 24, 9);
    expect(noPageShare({ questionsNoPage: 0, questionsTotal: 0 })).toBeNull();
  });
});

describe('citability rows', () => {
  it('lists the worst page first and the pages that could not be judged last, by address', () => {
    const sorted = citabilityRows(audit.pages);
    expect(sorted).toHaveLength(audit.pages.length);
    const judged = sorted.filter((p) => p.citability);
    const nows = judged.map((p) => p.citability?.now ?? 0);
    expect(nows).toEqual([...nows].sort((a, b) => a - b));
    const rest = sorted.slice(judged.length);
    expect(rest.every((p) => p.citability === null)).toBe(true);
    expect(rest.map((p) => p.path)).toEqual([...rest.map((p) => p.path)].sort((a, b) => a.localeCompare(b)));
    expect(rest.length).toBe(2);
  });

  it('says why a page has no score', () => {
    const broken = audit.pages.find((p) => p.fetch.httpStatus === 404);
    const silent = audit.pages.find((p) => p.fetch.status === 'ok' && p.judgmentStatus === 'none');
    if (!broken || !silent) throw new Error('sample has both kinds of unjudged page');
    expect(whyNotJudged(broken)).toBe('страницата върна грешка 404');
    expect(whyNotJudged(silent)).toBe('Jev не върна оценка');
    expect(whyNotJudged({ ...broken, fetch: { ...broken.fetch, httpStatus: null } })).toBe('страницата не се зареди');
  });
});

describe('plan and geo helpers', () => {
  it('the top of the plan is the biggest loss first', () => {
    const top = topPlan(audit.plan, 3);
    expect(top).toHaveLength(3);
    expect(top.map((p) => p.priority)).toEqual([...top.map((p) => p.priority)].sort((a, b) => b - a));
    expect(top[0]?.id).toBe(audit.plan[0]?.id);
    expect(topPlan(audit.plan, 5)).toHaveLength(5);
    expect(topPlan(audit.plan, 99)).toHaveLength(audit.plan.length);
    expect(topPlan(audit.plan, 0)).toEqual([]);
    expect(topPlan([], 5)).toEqual([]);
  });

  it('counts the questions the engines were asked, not the answers', () => {
    expect(askedQuestionCount(audit.geo?.answers ?? [])).toBe(14);
    expect(askedQuestionCount([])).toBe(0);
  });
});
