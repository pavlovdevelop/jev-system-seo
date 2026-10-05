import { describe, expect, it } from 'vitest';
import { assessSerp, type ResultSignal } from '../../src/server/analysis/assessment';
import { buildBrief } from '../../src/server/analysis/brief';
import { generateCandidates, pickForSerp, type Screened } from '../../src/server/analysis/candidates';
import { buildCompetitorProfiles, CTR_CURVE } from '../../src/server/analysis/competitors';
import type { KeywordJudgment } from '../../src/server/analysis/judge';
import { demandOf, rankOpportunities, scoreOpportunity, specificityOf, type OpportunityInput } from '../../src/server/analysis/opportunities';
import type { ExtractedPage } from '../../src/server/jev/questions';
import type { PageAnalysis, PageTypeAnswer, SerpData } from '../../src/shared/schemas';
import { filler, makePage } from '../helpers/pages';

const KW = 'изработка на сайт';
const pt = (value: PageTypeAnswer['value'], p = 0.85): PageTypeAnswer => ({ value, p, confidence: 0.8, runnerUp: null });
const serp = (over: Partial<SerpData> = {}): SerpData => ({ keyword: KW, market: 'bg', fetchedAt: '2026-10-05T00:00:00Z', provider: 'test', results: [], peopleAlsoAsk: [], relatedSearches: [], suggestions: [], ...over });

// ─────────────────────────────────────────── candidates ───────────────────────────────────────────
describe('generateCandidates', () => {
  const competitors = [0, 1, 2, 3].map((i) => ({
    title: `Изработка на сайт – цени и срокове | Студио ${i}`,
    headings: [{ level: 2 as const, text: 'Колко струва изработката на сайт?' }, { level: 2 as const, text: 'Портфолио' }, { level: 2 as const, text: 'Как протича изработката на сайт' }],
    text: 'Изработка на сайт с WordPress. Изработка на сайт с поддръжка. Дизайн и програмиране на сайт.',
  }));

  it('lists Google-provided queries first and merges duplicates from several sources', () => {
    const c = generateCandidates({ seed: KW, market: 'bg', competitors: [], serp: serp({ relatedSearches: ['изработка на сайт цена', 'Изработка на уебсайт wordpress'], peopleAlsoAsk: [{ question: 'Колко струва изработката на сайт?', snippet: null }], suggestions: ['изработка на сайт за ресторант'] }) });
    expect(c.slice(0, 4).map((x) => x.keyword)).toEqual(['изработка на сайт цена', 'изработка на уебсайт wordpress', 'колко струва изработката на сайт', 'изработка на сайт за ресторант']);
    const price = c.find((x) => x.keyword === 'изработка на сайт цена')!;
    expect(price.sources).toEqual(new Set(['related', 'modifier'])); // also generated as a variation, but only listed once
    expect(c.filter((x) => x.key === price.key)).toHaveLength(1);
  });

  it('never returns the seed itself or an inflected/respelled copy of it', () => {
    const c = generateCandidates({ seed: KW, market: 'bg', competitors: [], serp: serp({ relatedSearches: ['изработка на уеб сайт', 'Изработка на сайтове', 'изработка на сайт'] }) });
    expect(c.map((x) => x.keyword)).not.toContain('изработка на уеб сайт');
    expect(c.every((x) => x.key !== 'изработк сайт')).toBe(true);
  });

  it('adds variations appropriate for the market', () => {
    const bg = generateCandidates({ seed: KW, market: 'bg', competitors: [], serp: serp() }).map((x) => x.keyword);
    expect(bg).toEqual(expect.arrayContaining(['изработка на сайт цена', 'изработка на сайт пловдив', 'колко струва изработка на сайт', 'фирма за изработка на сайт']));
    const en = generateCandidates({ seed: 'web design', market: 'us', competitors: [], serp: serp({ keyword: 'web design' }) }).map((x) => x.keyword);
    expect(en).toEqual(expect.arrayContaining(['web design price', 'web design agency', 'best web design']));
    expect(en).not.toContain('web design цена');
  });

  it('mines shared competitor headings and title words', () => {
    const c = generateCandidates({ seed: KW, market: 'bg', serp: serp(), competitors });
    const fromCompetitors = c.filter((x) => x.sources.has('competitor_terms')).map((x) => x.keyword);
    expect(fromCompetitors).toEqual(expect.arrayContaining(['колко струва изработката на сайт', 'как протича изработката на сайт']));
    expect(fromCompetitors).toContain('изработка на сайт срокове'); // title word shared by all pages
    expect(fromCompetitors).not.toContain('портфолио'); // does not touch the seed topic
  });

  it('respects the raw cap and drops overly long or single-word ideas', () => {
    const many = Array.from({ length: 200 }, (_, i) => `изработка на сайт вариант ${i}`);
    expect(generateCandidates({ seed: KW, market: 'bg', competitors: [], serp: serp({ relatedSearches: many }), maxRaw: 30 })).toHaveLength(30);
    const odd = generateCandidates({ seed: KW, market: 'bg', competitors: [], serp: serp({ relatedSearches: ['сайт', 'a b c d e f g h i j k'] }) });
    expect(odd.map((x) => x.keyword)).not.toContain('сайт');
    expect(odd.map((x) => x.keyword)).not.toContain('a b c d e f g h i j k');
  });
});

describe('pickForSerp', () => {
  const j = (relevance: number, commercial = 0.5): KeywordJudgment => ({ relevance, commercial, commercialConfidence: 0.6, intent: { value: 'transactional', p: 0.8, confidence: 0.7, runnerUp: null } });
  const s = (keyword: string, sources: Array<'related' | 'modifier' | 'competitor_terms' | 'autocomplete'>, judgment: KeywordJudgment): Screened => ({
    candidate: { keyword, key: keyword, sources: new Set(sources), pages: 0 },
    judgment,
  });

  it('gates on relevance and ranks by relevance × commercial value, favouring real queries', () => {
    const picked = pickForSerp([
      s('irrelevant', ['related'], j(0.2, 1)),
      s('generated', ['modifier'], j(0.8, 0.5)),
      s('real', ['related'], j(0.75, 0.5)), // slightly less relevant, but a real query: the boost lifts it above
      s('real low commercial', ['autocomplete'], j(0.8, 0.1)),
    ], 10);
    expect(picked.map((x) => x.candidate.keyword)).toEqual(['real', 'generated', 'real low commercial']);
  });

  it('caps pure variations so they cannot crowd out real ideas', () => {
    const list = [
      ...Array.from({ length: 10 }, (_, i) => s(`mod ${i}`, ['modifier'], j(0.95, 0.9))),
      ...Array.from({ length: 4 }, (_, i) => s(`real ${i}`, ['related'], j(0.6, 0.2))),
    ];
    const picked = pickForSerp(list, 10);
    expect(picked.filter((x) => x.candidate.sources.has('modifier'))).toHaveLength(6); // ceil(10 × 0.6)
    expect(picked.filter((x) => x.candidate.sources.has('related'))).toHaveLength(4);
  });
});

// ─────────────────────────────────────────── opportunities ───────────────────────────────────────────
describe('opportunity scoring', () => {
  const row = (i: number, over: Partial<ResultSignal> = {}): ResultSignal => ({ position: i, domain: `d${i}.example`, url: `https://d${i}.example/`, title: 't', pageType: pt('service_page'), targetsQuery: 0.9, titleMatch: 1, depth: null, ...over });
  const weakSerp = assessSerp(Array.from({ length: 10 }, (_, i) => row(i + 1, { pageType: pt(i % 2 ? 'forum_or_social' : 'directory_marketplace'), targetsQuery: 0.15, titleMatch: 0.3 })), { intent: 'transactional' })!;
  const strongSerp = assessSerp(Array.from({ length: 10 }, (_, i) => row(i + 1)), { intent: 'transactional' })!;
  const judgment = (relevance = 0.9, commercial = 0.8): KeywordJudgment => ({ relevance, commercial, commercialConfidence: 0.7, intent: { value: 'transactional', p: 0.8, confidence: 0.7, runnerUp: null } });
  const input = (over: Partial<OpportunityInput> = {}): OpportunityInput => ({ keyword: 'изработка на сайт за ресторант пловдив', sources: ['related'], judgment: judgment(), assessment: weakSerp, volume: null, ownPosition: null, deep: false, ...over });

  it('labels a relevant, commercial keyword with a weak SERP as a quick win and explains why', () => {
    const o = scoreOpportunity(input());
    expect(o.label).toBe('quick_win');
    expect(o.score).toBeGreaterThan(65);
    expect(o.reasons.join(' ')).toMatch(/форуми|директории/);
    expect(o.reasons.join(' ')).toMatch(/не са посветени|заглавия/);
    expect(o.recommendedFormat).toBe(weakSerp.dominantPageType);
  });

  it('does not call a keyword with a strong SERP a quick win', () => {
    const o = scoreOpportunity(input({ assessment: strongSerp }));
    expect(o.label).not.toBe('quick_win');
    expect(o.score).toBeLessThan(scoreOpportunity(input()).score);
    expect(o.reasons.join(' ')).toMatch(/специализирани и добре оптимизирани/);
  });

  it('skips irrelevant keywords no matter how weak the SERP is', () => {
    const o = scoreOpportunity(input({ judgment: judgment(0.3, 0.9) }));
    expect(o.label).toBe('skip');
  });

  it('caps keywords whose SERP was never checked and says so', () => {
    const o = scoreOpportunity(input({ assessment: null, judgment: judgment(1, 1), volume: { volume: 5000, cpc: 1, competitionIndex: 50 } }));
    expect(o.score).toBeLessThanOrEqual(55);
    expect(o.label).not.toBe('quick_win');
    expect(o.reasons.join(' ')).toMatch(/Няма данни за конкуренцията/);
  });

  it('uses volume when known, a neutral value when unknown', () => {
    expect(demandOf(null)).toBeNull();
    expect(demandOf(0)).toBe(0);
    expect(demandOf(3000)).toBeGreaterThan(0.95);
    const known = scoreOpportunity(input({ volume: { volume: 2400, cpc: 1.1, competitionIndex: 40 } }));
    expect(known.volume).toBe(2400);
    expect(known.reasons.join(' ')).toMatch(/2.?400 търсения/);
    expect(scoreOpportunity(input()).demand).toBeNull();
  });

  it('prefers long, local, specific phrases', () => {
    expect(specificityOf('сайт')).toBeLessThan(specificityOf('изработка на сайт'));
    expect(specificityOf('изработка на сайт')).toBeLessThan(specificityOf('изработка на сайт за ресторант'));
    expect(specificityOf('изработка на сайт пловдив')).toBeGreaterThan(specificityOf('изработка на сайт цена'));
  });

  it('mentions the current ranking of the user, and ranks quick wins first', () => {
    const mine = scoreOpportunity(input({ ownPosition: 7 }));
    expect(mine.reasons.join(' ')).toMatch(/позиция 7/);
    const list = [
      scoreOpportunity(input({ assessment: strongSerp, keyword: 'изработка на сайт за клиника' })),
      scoreOpportunity(input({ keyword: 'изработка на сайт за ресторант' })),
      scoreOpportunity(input({ judgment: judgment(0.2), keyword: 'безплатен сайт' })),
    ];
    const ranked = rankOpportunities(list);
    expect(ranked.map((o) => o.keyword)).toEqual(['изработка на сайт за ресторант', 'изработка на сайт за клиника', 'безплатен сайт']);
    expect(ranked[0]!.label).toBe('quick_win');
    expect(ranked[2]!.label).toBe('skip');
  });

  it('normalises equivalent spellings to the same key', () => {
    expect(scoreOpportunity(input({ keyword: 'изработка на уеб сайт цена' })).normalized).toBe(scoreOpportunity(input({ keyword: 'цени изработка на сайтове' })).normalized);
  });
});

// ─────────────────────────────────────────── competitors ───────────────────────────────────────────
describe('competitor profiles', () => {
  const res = (position: number, domain: string, over: Record<string, unknown> = {}) => ({ position, domain, url: `https://${domain}/`, title: 't', pageType: pt('service_page'), targetsQuery: 0.9, titleMatch: 1, strength: 0.8, ...over });
  const observations = [
    { keyword: 'k1', deep: true, results: [res(1, 'big.example'), res(2, 'mid.example'), res(3, 'forum.example', { pageType: pt('forum_or_social'), targetsQuery: 0.1, strength: 0.2 })] },
    { keyword: 'k2', deep: false, results: [res(1, 'big.example'), res(6, 'mid.example', { targetsQuery: 0.2, strength: 0.3 })] },
    { keyword: 'k3', deep: false, results: [res(2, 'big.example'), res(4, 'forum.example', { pageType: pt('forum_or_social'), strength: 0.25, targetsQuery: 0.8 })] },
  ];

  it('computes visibility with a click-through curve and orders by share of voice', () => {
    const profiles = buildCompetitorProfiles({ observations, seedPages: [], ownDomain: null, tracked: [] });
    expect(profiles.map((p) => p.domain)).toEqual(['big.example', 'mid.example', 'forum.example']);
    const big = profiles[0]!;
    expect(big.visibility).toMatchObject({ keywordsSeen: 3, top3: 3, top10: 3, bestPosition: 1 });
    expect(big.visibility.avgPosition).toBeCloseTo((1 + 1 + 2) / 3, 2);
    const total = CTR_CURVE[0] * 2 + CTR_CURVE[1] * 2 + CTR_CURVE[2] + CTR_CURVE[5] + CTR_CURVE[3];
    expect(big.visibility.shareOfVoice).toBeCloseTo((CTR_CURVE[0] * 2 + CTR_CURVE[1]) / total, 2);
    expect(profiles.reduce((s, p) => s + p.visibility.shareOfVoice, 0)).toBeCloseTo(1, 1);
  });

  it('finds keywords where a competitor is vulnerable, with a reason', () => {
    const forum = buildCompetitorProfiles({ observations, seedPages: [], ownDomain: null, tracked: [] }).find((p) => p.domain === 'forum.example')!;
    expect(forum.vulnerableKeywords.map((v) => [v.keyword, v.position])).toEqual([['k3', 4], ['k1', 3]]);
    expect(forum.vulnerableKeywords.map((v) => v.reason).join(' ')).toMatch(/форум/);
    const mid = buildCompetitorProfiles({ observations, seedPages: [], ownDomain: null, tracked: [] }).find((p) => p.domain === 'mid.example')!;
    expect(mid.vulnerableKeywords).toEqual([{ keyword: 'k2', position: 6, reason: 'страницата не е посветена на фразата' }]);
  });

  it('puts the user first, then tracked competitors (even invisible ones), then discovered ones', () => {
    const profiles = buildCompetitorProfiles({ observations, seedPages: [], ownDomain: 'me.example', tracked: ['mid.example', 'ghost.example'], maxDiscovered: 1 });
    expect(profiles.map((p) => [p.domain, p.role])).toEqual([['me.example', 'own'], ['mid.example', 'tracked'], ['ghost.example', 'tracked'], ['big.example', 'discovered']]);
    const ghost = profiles.find((p) => p.domain === 'ghost.example')!;
    expect(ghost.visibility).toMatchObject({ keywordsSeen: 0, shareOfVoice: 0, bestPosition: null, avgPosition: null });
  });

  it('attaches the scorecard, strengths and weaknesses of the seed page', () => {
    const { analysis } = makePage({ url: 'https://big.example/page', position: 1, title: 'Изработка на сайт', h1: 'Изработка на сайт', keyword: KW, paragraphs: ['кратък текст'], judgments: { statesPrices: { p: 0.9 } } });
    const profile = buildCompetitorProfiles({ observations, seedPages: [analysis], ownDomain: null, tracked: [] }).find((p) => p.domain === 'big.example')!;
    expect(profile.seedPage).toEqual({ url: 'https://big.example/page', position: 1, title: 'Изработка на сайт' });
    expect(profile.scorecard?.overall).not.toBeNull();
    expect(profile.strengths.map((s) => s.id)).toContain('pricing');
    expect(profile.weaknesses.map((s) => s.id)).toContain('thin_content');
  });
});

// ─────────────────────────────────────────── brief ───────────────────────────────────────────
describe('buildBrief', () => {
  const body = filler('Работим по ясен процес и предлагаме хостинг, домейн и поддръжка за вашия бизнес с адаптивен дизайн.', 12);
  const specs = [1, 2, 3, 4, 5].map((i) => ({
    url: `https://site${i}.example/izrabotka-na-sait`,
    position: i,
    title: `Изработка на сайт – цени и срокове | Студио ${i}`,
    h1: 'Изработка на сайт',
    h2s: ['Колко струва изработката на сайт?', 'Как протича изработката на сайт', 'Често задавани въпроси', ...(i <= 2 ? ['Нашето портфолио'] : [])],
    paragraphs: [body, body, 'Колко време отнема? Две седмици.', body],
    metaDescription: 'Изработка на сайт за вашия бизнес с ясна цена, срокове и примери от наши проекти.',
    extraHead: `<script type="application/ld+json">{"@type":"${i <= 3 ? 'Service' : 'Organization'}"}</script>`,
    keyword: KW,
    judgments: { statesPrices: { p: i <= 3 ? 0.9 : 0.1 }, showsPortfolio: { p: i <= 2 ? 0.9 : 0.2 }, clearCta: { p: 0.9 } },
  }));
  const built = specs.map(makePage);
  const pages: PageAnalysis[] = built.map((b) => b.analysis);
  const extracted = new Map<string, ExtractedPage>(built.map((b) => [b.analysis.url, b.extracted]));
  const base = {
    keyword: KW, pages, extracted,
    serp: serp({ peopleAlsoAsk: [{ question: 'Колко струва изработката на сайт?', snippet: null }, { question: 'Нужен ли е хостинг за сайт?', snippet: null }] }),
    intent: { dominantPageType: 'service_page' as const, dominantIntent: 'transactional' as const, dominantShare: 0.8 },
    ownPage: null,
  };

  it('derives length, title patterns, subtopics, questions and trust elements from the top results', () => {
    const b = buildBrief(base);
    expect(b.pageType).toBe('service_page');
    expect(b.length).not.toBeNull();
    expect(b.length!.basedOn).toBe(5);
    expect(b.length!.min).toBeLessThan(b.length!.target);
    expect(b.length!.target).toBeLessThan(b.length!.max);
    expect(b.length!.target % 50).toBe(0);
    expect(b.titlePatterns!.startsWithKeywordShare).toBe(1);
    expect(b.titlePatterns!.commonModifiers.map((m) => m.term)).toEqual(expect.arrayContaining(['цени', 'срокове']));
    expect(b.subtopics.map((s) => s.topic).join(' | ')).toMatch(/Колко струва/);
    // "Нашето портфолио" appears on 2 of 5 pages (40%) — above the 25% bar, so it is a subtopic too
    expect(b.subtopics.find((s) => /портфолио/i.test(s.topic))?.pages).toBe(2);
  });

  it('collects questions from People-also-ask and headings without duplicates', () => {
    const b = buildBrief(base);
    expect(b.questions[0]).toEqual({ question: 'Колко струва изработката на сайт?', source: 'paa' });
    expect(b.questions.filter((q) => /струва/.test(q.question))).toHaveLength(1);
    expect(b.questions.map((q) => q.question)).toContain('Нужен ли е хостинг за сайт?');
  });

  it('counts schema types and trust elements', () => {
    const b = buildBrief(base);
    expect(b.schemaTypes).toEqual([{ type: 'Service', pages: 3 }, { type: 'Organization', pages: 2 }]);
    const t = Object.fromEntries(b.trustElements.map((x) => [x.id, x]));
    expect(t.statesPrices).toMatchObject({ pages: 3, share: 0.6 });
    expect(t.showsPortfolio).toMatchObject({ pages: 2, share: 0.4 });
    expect(t.clearCta).toMatchObject({ pages: 5, share: 1 });
    expect(t.faq!.pages).toBe(5);
  });

  it('turns it into a plain-language summary and checklist', () => {
    const b = buildBrief(base);
    expect(b.summary).toMatch(/Google показва/);
    expect(b.summary).toMatch(/специализирана страница/);
    expect(b.checklist.join('\n')).toMatch(/Обем: около \d+ думи/);
    expect(b.checklist.join('\n')).toMatch(/Заглавие:/);
    expect(b.checklist.join('\n')).toMatch(/FAQ/);
    expect(b.checklist.join('\n')).toMatch(/Покажи ясно: .*цени/i);
  });

  it('finds what the user\'s own page is missing', () => {
    const mine = makePage({ url: 'https://me.example/sait', position: null, title: 'Нашата фирма', h1: 'Начало', h2s: ['За нас'], paragraphs: ['Малък текст за нас без нищо конкретно.'], keyword: KW, role: 'own', judgments: { statesPrices: { p: 0.1 }, showsPortfolio: { p: 0.1 }, clearCta: { p: 0.9 } } });
    const b = buildBrief({ ...base, ownPage: mine });
    expect(b.ownGaps).not.toBeNull();
    const kinds = new Set(b.ownGaps!.map((g) => g.kind));
    expect(kinds).toEqual(expect.objectContaining(new Set(['length', 'term', 'subtopic', 'element'])));
    expect(b.ownGaps!.find((g) => g.kind === 'element')!.label).toMatch(/Цени/);
    expect(b.ownGaps!.find((g) => g.kind === 'length')!.detail).toMatch(/минимум/);
  });

  it('does not crash without any crawled pages', () => {
    const b = buildBrief({ ...base, pages: [], extracted: new Map(), intent: { dominantPageType: null, dominantIntent: null, dominantShare: null } });
    expect(b.length).toBeNull();
    expect(b.mustCover).toEqual([]);
    expect(b.summary).toMatch(/Няма достатъчно данни/);
    expect(b.checklist.length).toBeGreaterThan(0);
  });
});
