import { describe, expect, it } from 'vitest';
import type { CriteriaScores, FixPlan, SitePage, SkipAnalysis, WinnerPage } from '../../src/shared/audit';
import { baselineSteps, buildPlan, clusterQuestions, targetWords } from '../../src/server/audit/plan';
import { actionFor, skipReasons, sourceKindOf, whyCited } from '../../src/server/audit/skips';
import { rulesWriter, type Writer } from '../../src/server/audit/writer';
import { extractPage } from '../../src/server/crawl/extract';
import { buildHtml } from '../helpers/pages';

const NOW = new Date('2026-10-05T10:00:00Z');
const crit = (over: Partial<CriteriaScores> = {}): CriteriaScores => ({ answer: 0.8, faq: 0.8, author: 0.8, fresh: 0.8, sources: 0.8, facts: 0.8, compare: 0.8, links: 0.8, ...over });

describe('sourceKindOf', () => {
  it.each([
    ['wikipedia.org', 'blog_article', 'authority'],
    ['nsi.bg', null, 'authority'],
    ['reddit.com', null, 'community'],
    ['forum-programisti.example', 'forum_or_social', 'community'],
    ['news.example', 'news_or_media', 'media'],
    ['top-agencii.example', 'comparison_listicle', 'compare'],
    ['firmi-bg.example', 'directory_marketplace', 'compare'],
    ['pixel-studio.example', 'service_page', 'brand'],
    ['digital-blog.example', 'blog_article', 'guide'],
    ['whatever.example', null, 'other'],
  ] as const)('%s (%s) is %s', (domain, type, kind) => {
    expect(sourceKindOf({ domain, type, criteria: null })).toBe(kind);
  });

  it('a well-sourced, signed article is an authority', () => {
    expect(sourceKindOf({ domain: 'blog.example', type: 'blog_article', criteria: crit({ sources: 0.9, author: 0.8 }) })).toBe('authority');
  });
});

describe('targetWords', () => {
  it('is never under 600 words, matches the pages that are cited, and asks half as much again of a long page', () => {
    expect(targetWords(null, 0)).toBe(600);
    expect(targetWords(undefined, 100)).toBe(600);
    expect(targetWords(0, 0)).toBe(600);
    expect(targetWords(1200, 300)).toBe(1200);
    expect(targetWords(400, 800)).toBe(1200);
  });
});

describe('skipReasons', () => {
  const own = (over: Partial<{ words: number | null; ageMonths: number | null; criteria: CriteriaScores | null }> = {}) => ({ url: 'https://x.example/p', words: 900, ageMonths: 3, criteria: crit(), ...over });

  it('says "no page" when there is none', () => {
    expect(skipReasons({ own: null, winner: null, match: null, angleFits: null })).toEqual(['no_page']);
  });

  it('lists what is wrong, worst first and at most four', () => {
    const reasons = skipReasons({
      own: own({ words: 200, ageMonths: 30, criteria: crit({ answer: 0.1, facts: 0.1, author: 0.1, fresh: 0.1 }) }),
      winner: { words: 1500, criteria: crit() },
      match: 0.4,
      angleFits: 0.1,
    });
    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toBe('wrong_angle');
    expect(new Set(reasons).size).toBe(4);
  });

  it('compares the length with the page that is cited', () => {
    expect(skipReasons({ own: own({ words: 700 }), winner: { words: 2000, criteria: crit() }, match: 0.5, angleFits: 0.9 })).toContain('too_thin');
    expect(skipReasons({ own: own({ words: 1000 }), winner: { words: 1200, criteria: crit() }, match: 0.5, angleFits: 0.9 })).not.toContain('too_thin');
  });

  it('calls a page under 350 words thin even when there is nothing to compare it with', () => {
    expect(skipReasons({ own: own({ words: 300 }), winner: null, match: 0.5, angleFits: 0.9 })).toContain('too_thin');
    expect(skipReasons({ own: own({ words: 400 }), winner: null, match: 0.5, angleFits: 0.9 })).not.toContain('too_thin');
  });

  it('calls the angle wrong from Jev\'s reading below 0.4, not above', () => {
    expect(skipReasons({ own: own(), winner: null, match: 0.5, angleFits: 0.3 })[0]).toBe('wrong_angle');
    expect(skipReasons({ own: own(), winner: null, match: 0.5, angleFits: 0.45 })).not.toContain('wrong_angle');
  });

  it('flags old and untrustworthy pages and still says something when nothing is badly wrong', () => {
    expect(skipReasons({ own: own({ ageMonths: 20 }), winner: null, match: 0.5, angleFits: 0.9 })).toContain('outdated');
    expect(skipReasons({ own: own({ criteria: crit({ author: 0.1 }) }), winner: null, match: 0.5, angleFits: 0.9 })).toContain('weak_trust');
    const fine = skipReasons({ own: own({ criteria: crit({ facts: 0.5 }) }), winner: null, match: 0.7, angleFits: 0.9 });
    expect(fine).toHaveLength(1);
    expect(fine[0]).toBe('no_data'); // the weakest of answer / facts / sources
  });

  it('copes with a page that could not be judged', () => {
    expect(skipReasons({ own: own({ criteria: null, words: null, ageMonths: null }), winner: null, match: null, angleFits: null })).toEqual(['too_thin']);
  });

  it('creates a page for "no page" or a wrong angle with a poor match, and rewrites otherwise', () => {
    expect(actionFor(['no_page'], null)).toBe('create');
    expect(actionFor(['wrong_angle'], 0.3)).toBe('create');
    expect(actionFor(['wrong_angle'], 0.6)).toBe('rewrite');
    expect(actionFor(['too_thin'], 0.3)).toBe('rewrite');
  });
});

describe('whyCited', () => {
  it('names what the page does best, in plain words, and nothing it does not do', () => {
    const m = extractPage(buildHtml({ title: 'Т', h1: 'Т', paragraphs: ['текст'] }), { url: 'https://x.example/', keyword: '', now: NOW }).metrics;
    const out = whyCited(crit({ answer: 0.9, faq: 0.9, compare: 1, fresh: 1, sources: 0.8, facts: 0.9, author: 0.9 }), { ...m, externalDomains: 5, wordCount: 1500, schemaTypes: ['Article', 'FAQPage', 'Organization'] }, 2.4);
    expect(out.join(' | ')).toMatch(/първите изречения/);
    expect(out.join(' | ')).toMatch(/FAQPage/);
    expect(out.join(' | ')).toMatch(/Обновена преди 2 мес/);
    expect(out.join(' | ')).toMatch(/5 външни източника/);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(whyCited(crit({ answer: 0.1, faq: 0, compare: 0.1, fresh: 0.2, sources: 0.1, facts: 0.1, author: 0.1 }), { ...m, wordCount: 300, schemaTypes: [] }, 40)).toEqual([]);
    expect(whyCited(null, m, null)).toEqual([]);
  });
});

describe('clusterQuestions', () => {
  it('puts questions about the same thing together and keeps different things apart', () => {
    const clusters = clusterQuestions([
      'Колко струва изработката на онлайн магазин?',
      'Каква е цената на изработка на онлайн магазин?',
      'Как да избера фирма за SEO оптимизация?',
      'Колко време отнема изработката на онлайн магазин?',
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.length === 3)?.every((q) => /магазин/.test(q))).toBe(true);
  });
});

function skip(over: Partial<SkipAnalysis> & Pick<SkipAnalysis, 'question'>): SkipAnalysis {
  return {
    engine: 'openai',
    questionId: 'q1',
    ourPage: { url: null, exists: false, words: null, ageMonths: null, detail: null },
    winner: { domain: 'rival.example', url: 'https://rival.example/p', kind: 'guide' },
    reasons: ['no_page'],
    action: 'create',
    ...over,
  };
}
const page = (url: string, over: Partial<SitePage> = {}): SitePage =>
  ({
    url,
    path: new URL(url).pathname,
    fetch: { status: 'ok', httpStatus: 200, error: null, finalUrl: url, ttfbMs: 100, bytes: 1000, fromCache: false },
    metrics: { title: 'Цени за изработка на сайт' } as SitePage['metrics'],
    type: 'service_page',
    phrase: 'цени',
    rank: null,
    ageMonths: 20,
    words: 320,
    criteria: crit({ sources: 0.2 }),
    citability: { now: 0.4, after: 0.62, fixFirst: null },
    elementsToChange: 2,
    judgmentStatus: 'complete',
    ...over,
  }) as SitePage;
const winner = (over: Partial<WinnerPage> = {}): WinnerPage => ({ engine: 'openai', domain: 'rival.example', url: 'https://rival.example/p', title: 'x', kind: 'guide', citedIn: 3, whyCited: ['таблица'], radar: { answer: 0.8, entity: 0.8, faq: 0.8, author: 0.8, fresh: 0.8, sources: 0.8 }, score10: 8, words: 1400, ...over });

describe('baselineSteps', () => {
  it('gives a new page a reading step first and the publishing step last, with numbers from the analysis', () => {
    const steps = baselineSteps({ kind: 'create', title: 'Колко струва магазин', questions: ['Колко струва онлайн магазин?', 'Колко време отнема магазин?'], reasons: ['no_page'], page: null, winners: [winner()], domains: ['rival.example'] });
    expect(steps[0]?.text).toMatch(/rival\.example/);
    expect(steps.at(-1)?.text).toMatch(/индексиране/);
    expect(steps.some((s) => /1400/.test(s.text))).toBe(true);
    expect(steps.map((s) => s.id)).toEqual(steps.map((_, i) => `c${i + 1}`));
    expect(steps.length).toBeLessThanOrEqual(12);
  });

  it('gives a rewrite exactly the steps its reasons call for', () => {
    const steps = baselineSteps({ kind: 'rewrite', title: 'Цени', questions: ['Колко струва сайт?'], reasons: ['no_answer_first', 'too_thin', 'outdated'], page: page('https://x.example/tseni'), winners: [winner()], domains: [] });
    const text = steps.map((s) => s.text).join('\n');
    expect(text).toMatch(/първите 40 думи/);
    expect(text).toMatch(/до около 1400 думи \(сега 320\)/);
    expect(text).toMatch(/преди около 20 мес/);
    expect(text).not.toMatch(/Смени ъгъла/);
    expect(text).not.toMatch(/автор с квалификация/);
  });
});

describe('buildPlan', () => {
  const skips = [
    skip({ question: 'Колко струва онлайн магазин?', questionId: 'q1' }),
    skip({ question: 'Колко струва онлайн магазин?', questionId: 'q1', engine: 'gemini' }),
    skip({ question: 'Каква е цената на онлайн магазин?', questionId: 'q2' }),
    skip({ question: 'Колко струва сайт за фирма?', questionId: 'q3', ourPage: { url: 'https://x.example/tseni', exists: true, words: 320, ageMonths: 20, detail: null }, reasons: ['too_thin', 'outdated'], action: 'rewrite', engine: 'anthropic' }),
  ];
  const pages = [page('https://x.example/tseni')];

  it('groups the lost answers by page (or by topic for questions with no page) and orders by what is lost', async () => {
    const plan = await buildPlan({ business: 'Студио', market: 'bg', skips, pages, winners: [winner()], writer: rulesWriter });
    expect(plan).toHaveLength(2);
    const create = plan.find((p) => p.kind === 'create') as FixPlan;
    expect(create.url).toBeNull();
    expect(create.suggestedPath).toMatch(/^\/[a-z0-9-]+$/);
    expect(create.questions).toHaveLength(2);
    expect(create.engines).toEqual(['openai', 'gemini']);
    expect(create.priority).toBeCloseTo(3 / 4, 3);
    expect(create.writtenBy).toBe('rules');
    const rewrite = plan.find((p) => p.kind === 'rewrite') as FixPlan;
    expect(rewrite.url).toBe('https://x.example/tseni');
    expect(rewrite.citability).toEqual({ now: 0.4, after: 0.62 });
    expect(plan[0]).toBe(create); // three lost answers outweigh one
    expect(plan.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('lets a writer improve the checklist, and falls back to the rules when the writer fails or says nothing', async () => {
    const good: Writer = { ...rulesWriter, id: 'anthropic', model: 'x', checklist: async () => [{ text: 'Първо това, конкретно за страницата.', why: 'защото' }, { text: 'После онова.', why: '' }, { text: 'И накрая още нещо.', why: 'за пълнота' }] };
    const written = await buildPlan({ business: 'Студио', market: 'bg', skips, pages, winners: [winner()], writer: good });
    expect(written[0]?.writtenBy).toBe('llm');
    expect(written[0]?.checklist.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(written[0]?.checklist[1]?.why).toMatch(/.+/);

    for (const checklist of [async () => null, async () => { throw new Error('boom'); }]) {
      const fallback = await buildPlan({ business: 'Студио', market: 'bg', skips, pages, winners: [], writer: { ...good, checklist } });
      expect(fallback[0]?.writtenBy).toBe('rules');
      expect(fallback[0]?.checklist.length).toBeGreaterThan(3);
    }
  });

  it('produces nothing when nothing was lost', async () => {
    expect(await buildPlan({ business: 'Студио', market: 'bg', skips: [], pages, winners: [], writer: rulesWriter })).toEqual([]);
  });
});
