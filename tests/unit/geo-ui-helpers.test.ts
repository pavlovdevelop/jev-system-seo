import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerRecord, BuyerQuestion, EngineRun, FixPlan, SkipAnalysis, WinnerPage } from '../../src/shared/audit';
import {
  ageText,
  ANSWER_FILTERS,
  answersOf,
  arcDash,
  copyText,
  countByFilter,
  countPlans,
  criteriaRows,
  displayPath,
  domainRole,
  filterAnswers,
  formatCost,
  formatInterval,
  formatLatency,
  groupSkips,
  intervalParts,
  isOwnDomain,
  matchesFilter,
  mdText,
  mdUrl,
  parseDone,
  planMarkdown,
  planStorageKey,
  plansMarkdown,
  progressText,
  questionIndex,
  radarAngle,
  radarPoint,
  radarRuns,
  sampleRange,
  sampleText,
  score10Text,
  sortEngines,
  sortPlans,
  sortWinners,
  usageLine,
  winnerAxes,
  wordsText,
} from '../../src/web/lib/geo';
import { sampleSiteAudit } from '../helpers/site-audit-sample';

// The helpers behind the "ИИ видимост" and "План" tabs are pure functions, so every rule is tested here without a browser.

const ch = (n: number): string => String.fromCodePoint(n);

const answer = (over: Partial<AnswerRecord> = {}): AnswerRecord => ({
  engine: 'openai', questionId: 'q1', status: 'missing', latencyMs: 1200, position: null, share: 0, sentiment: null, citations: [], brands: [], excerpt: '', error: null, ...over,
});

const skip = (over: Partial<SkipAnalysis> = {}): SkipAnalysis => ({
  engine: 'openai',
  questionId: 'q1',
  question: 'Колко струва сайт?',
  ourPage: { url: 'https://my-studio.example/tsenoraz', exists: true, words: 520, ageMonths: 3, detail: null },
  winner: { domain: 'pixel-studio.example', url: 'https://pixel-studio.example/', kind: 'brand' },
  reasons: ['too_thin'],
  action: 'rewrite',
  ...over,
});

const detail = (score10: number): NonNullable<SkipAnalysis['ourPage']['detail']> => ({
  criteria: { answer: 0.5, faq: 0.2, author: null, fresh: 0.8, sources: 0.1, facts: 0.3, compare: 0, links: 1 },
  score10,
});

const plan = (over: Partial<FixPlan> = {}): FixPlan => ({
  id: 'p1', kind: 'create', url: null, suggestedPath: '/blog/nova', title: 'Нова страница', questions: ['Колко струва сайт?'], engines: ['openai'], priority: 0.5, citability: null,
  checklist: [{ id: 's1', text: 'Отговори в първите 40 думи', why: 'ИИ взима отговора от началото' }], writtenBy: 'rules', ...over,
});

describe('numbers as text', () => {
  it('prints the share with its 95% interval, as the brief shows it', () => {
    expect(formatInterval(0.29, 0.19, 0.41)).toBe('29% (95% интервал 19–41%)');
    expect(intervalParts(0.29, 0.19, 0.41)).toEqual({ value: '29%', note: '(95% интервал 19–41%)' });
  });

  it('prints one figure when both ends of the interval round to the same number, and never goes outside 0–100', () => {
    expect(formatInterval(0, 0, 0.004)).toBe('0% (95% интервал 0%)');
    expect(formatInterval(1, 0.86, 1.4)).toBe('100% (95% интервал 86–100%)');
  });

  it('says plainly when the price of the model is not known', () => {
    expect(formatCost(0.1234)).toBe('≈ $0.12');
    expect(formatCost(null)).toBe('цената не е известна');
    expect(formatCost(Number.NaN)).toBe('цената не е известна');
    expect(formatCost(0)).toBe('≈ $0');
    expect(formatCost(0.004)).toBe('под 1 цент');
  });

  it('formats a latency in ms below a second and in seconds above', () => {
    expect(formatLatency(840)).toBe('840 ms');
    expect(formatLatency(2340)).toBe('2.3 с');
    expect(formatLatency(0)).toBe('—');
    expect(formatLatency(Number.NaN)).toBe('—');
  });

  it('summarises the use of an engine with Bulgarian agreement', () => {
    expect(usageLine({ calls: 24, inputTokens: 10_000, outputTokens: 2_340, searches: 3, estimatedCostUsd: 0.12 })).toBe('24 заявки · 12 340 токена · 3 търсения · ≈ $0.12');
    expect(usageLine({ calls: 1, inputTokens: 1, outputTokens: 0, searches: 1, estimatedCostUsd: null })).toBe('1 заявка · 1 токен · 1 търсене · цената не е известна');
    expect(usageLine({ calls: 5, inputTokens: 0, outputTokens: 0, searches: 0, estimatedCostUsd: 0.5 })).toBe('5 заявки · 0 токена · ≈ $0.50');
  });

  it('writes the age of a page in months and the size in words', () => {
    expect(ageText(22.4)).toBe('променена преди 22 месеца');
    expect(ageText(1)).toBe('променена преди 1 месец');
    expect(ageText(0.2)).toBe('променена този месец');
    expect(ageText(null)).toBe('без дата');
    expect(wordsText(282)).toBe('282 думи');
    expect(wordsText(1)).toBe('1 дума');
    expect(wordsText(12_500)).toBe('12 500 думи');
    expect(wordsText(null)).toBeNull();
    expect(score10Text(2.84)).toBe('2.8');
  });

  it('counts the sample as the questions the engines were really asked', () => {
    const run = (asked: number): Pick<EngineRun, 'asked'> => ({ asked });
    expect(sampleRange([run(14), run(13), run(9)], 24)).toEqual({ min: 9, max: 14 });
    expect(sampleText({ min: 9, max: 14 })).toBe('9–14 въпроса');
    expect(sampleText({ min: 1, max: 1 })).toBe('1 въпрос');
    expect(sampleText(sampleRange([run(20), run(20)], 24))).toBe('20 въпроса');
    expect(sampleRange([], 24)).toEqual({ min: 24, max: 24 });
    expect(sampleRange([run(0)], 24)).toEqual({ min: 24, max: 24 });
  });

  it('shows the path of a page and leaves anything else as it is', () => {
    expect(displayPath('https://my-studio.example/blog/x/?a=1')).toBe('/blog/x/?a=1');
    expect(displayPath('/relative/path')).toBe('/relative/path');
  });
});

describe('which domain is ours', () => {
  const request = { domain: 'my-studio.example', brandNames: ['Моето студио', 'My Studio', 'studio.bg'], competitors: ['pixel-studio.example', 'digital-blog.example'] };

  it('recognises the site however the engine wrote it, and its subdomains', () => {
    for (const d of ['my-studio.example', 'www.my-studio.example', 'WWW.My-Studio.Example', 'https://my-studio.example/blog', 'blog.my-studio.example', 'my-studio.example:443']) {
      expect(isOwnDomain(d, request), d).toBe(true);
    }
  });

  it('does not take a look-alike or a longer domain for ours', () => {
    for (const d of ['evil-my-studio.example', 'my-studio.example.evil.com', 'xmy-studio.example', 'studio.example', '']) {
      expect(isOwnDomain(d, request), d).toBe(false);
    }
  });

  it('counts a brand name only when it is written as a domain itself', () => {
    expect(isOwnDomain('studio.bg', request)).toBe(true);
    expect(isOwnDomain('моето-студио.bg', request)).toBe(false);
    expect(isOwnDomain('mystudio.com', request)).toBe(false);
  });

  it('compares Cyrillic domains the way the rest of the app does (punycode)', () => {
    const bg = { domain: 'пример.бг', brandNames: [] };
    expect(isOwnDomain('пример.бг', bg)).toBe(true);
    expect(isOwnDomain('www.пример.бг', bg)).toBe(true);
    expect(isOwnDomain('друг.бг', bg)).toBe(false);
  });

  it('tells ours, a listed competitor and any other domain apart', () => {
    expect(domainRole('my-studio.example', request)).toBe('own');
    expect(domainRole('www.pixel-studio.example', request)).toBe('competitor');
    expect(domainRole('shop.digital-blog.example', request)).toBe('competitor');
    expect(domainRole('forum.example', request)).toBe('other');
  });
});

describe('the feed of answers', () => {
  const answers = [answer({ status: 'cited' }), answer({ status: 'named' }), answer({ status: 'missing' }), answer({ status: 'missing' }), answer({ status: 'failed' })];

  it('offers the three filters of the brief, in order', () => {
    expect(ANSWER_FILTERS.map((f) => f.label)).toEqual(['Всички', 'Цитирани и назовани', 'Липсваме']);
  });

  it('"won" is cited plus named; "lost" is only the answers that came back without us, never a failed call', () => {
    expect(filterAnswers(answers, 'all')).toHaveLength(5);
    expect(filterAnswers(answers, 'won').map((a) => a.status)).toEqual(['cited', 'named']);
    expect(filterAnswers(answers, 'lost').map((a) => a.status)).toEqual(['missing', 'missing']);
    expect(matchesFilter(answer({ status: 'failed' }), 'lost')).toBe(false);
    expect(matchesFilter(answer({ status: 'failed' }), 'won')).toBe(false);
    expect(matchesFilter(answer({ status: 'failed' }), 'all')).toBe(true);
  });

  it('counts each filter for the chips, and does not modify what it filters', () => {
    expect(countByFilter(answers)).toEqual({ all: 5, won: 2, lost: 2 });
    const copy = [...answers];
    filterAnswers(answers, 'won');
    expect(answers).toEqual(copy);
  });

  it('joins an answer to the text of its question, preferring the question list over a skip analysis', () => {
    const questions = [{ id: 'q1', text: 'Колко струва сайт?' }, { id: 'q2', text: '  ' }] as BuyerQuestion[];
    const index = questionIndex(questions, [skip({ questionId: 'q1', question: 'старо' }), skip({ questionId: 'q2', question: 'Само в анализа' }), skip({ questionId: 'q3', question: '' })]);
    expect(index.get('q1')).toBe('Колко струва сайт?');
    expect(index.get('q2')).toBe('Само в анализа');
    expect(index.has('q3')).toBe(false);
  });

  it('takes the answers of one engine', () => {
    expect(answersOf([answer({ engine: 'openai' }), answer({ engine: 'gemini' }), answer({ engine: 'openai' })], 'gemini')).toHaveLength(1);
  });

  it('puts the engines in their fixed order', () => {
    expect(sortEngines([{ engine: 'gemini' as const }, { engine: 'openai' as const }, { engine: 'anthropic' as const }]).map((e) => e.engine)).toEqual(['openai', 'anthropic', 'gemini']);
  });
});

describe('why the engines skip us', () => {
  it('groups the analyses per question, with the skipping engines in their fixed order', () => {
    const groups = groupSkips([skip({ engine: 'gemini' }), skip({ engine: 'openai' }), skip({ questionId: 'q2', question: 'Друг въпрос', engine: 'anthropic' })]);
    expect(groups).toHaveLength(2);
    const first = groups[0];
    expect(first?.questionId).toBe('q1');
    expect(first?.engines).toEqual(['openai', 'gemini']);
    expect(first?.items.map((i) => i.winner?.domain)).toEqual(['pixel-studio.example', 'pixel-studio.example']);
  });

  it('puts the worst first: the most engines, then the lowest score, a missing page counting as the lowest', () => {
    const groups = groupSkips([
      skip({ questionId: 'a', question: 'A', ourPage: { url: 'https://x.example/a', exists: true, words: 1, ageMonths: 1, detail: detail(6) } }),
      skip({ questionId: 'b', question: 'B', ourPage: { url: 'https://x.example/b', exists: true, words: 1, ageMonths: 1, detail: detail(2) } }),
      skip({ questionId: 'c', question: 'C', ourPage: { url: null, exists: false, words: null, ageMonths: null, detail: null }, action: 'create' }),
      skip({ questionId: 'd', question: 'D', engine: 'openai' }),
      skip({ questionId: 'd', question: 'D', engine: 'gemini' }),
    ]);
    expect(groups.map((g) => g.questionId)).toEqual(['d', 'c', 'b', 'a']);
    expect(groups.find((g) => g.questionId === 'c')?.score10).toBeNull();
    expect(groups.find((g) => g.questionId === 'b')?.score10).toBe(2);
  });

  it('merges the reasons of the engines, the most frequent first, and keeps the actions apart when they disagree', () => {
    const [g] = groupSkips([
      skip({ engine: 'openai', reasons: ['outdated', 'too_thin'] }),
      skip({ engine: 'anthropic', reasons: ['too_thin', 'weak_trust'] }),
      skip({ engine: 'gemini', reasons: ['too_thin'], action: 'create' }),
    ]);
    expect(g?.reasons).toEqual(['too_thin', 'weak_trust', 'outdated']); // too_thin ×3; the single mentions follow the order of the reasons themselves
    expect(g?.actions).toEqual(['rewrite', 'create']);
  });

  it('describes our page with the analysis that has a score, and keeps the lowest score of the engines', () => {
    const [g] = groupSkips([
      skip({ engine: 'openai', ourPage: { url: 'https://x.example/p', exists: true, words: 300, ageMonths: 4, detail: null } }),
      skip({ engine: 'anthropic', ourPage: { url: 'https://x.example/p', exists: true, words: 300, ageMonths: 4, detail: detail(3.4) } }),
      skip({ engine: 'gemini', ourPage: { url: 'https://x.example/p', exists: true, words: 300, ageMonths: 4, detail: detail(2.8) } }),
    ]);
    expect(g?.page.detail?.score10).toBe(3.4); // the first analysis that has a score describes the page…
    expect(g?.score10).toBe(2.8); // …and the card is ranked by the worst reading
  });

  it('keeps one analysis per engine and question, and takes the text of the question from the list when the analysis has none', () => {
    const [g] = groupSkips([skip({ question: '' }), skip({ question: '', reasons: ['outdated'] })], new Map([['q1', 'Текст от списъка']]));
    expect(g?.items).toHaveLength(1);
    expect(g?.question).toBe('Текст от списъка');
  });

  it('lists the eight criteria in their fixed order and keeps "could not be judged" as null', () => {
    const rows = criteriaRows(detail(3).criteria);
    expect(rows.map((r) => r.key)).toEqual(['answer', 'faq', 'author', 'fresh', 'sources', 'facts', 'compare', 'links']);
    expect(rows.find((r) => r.key === 'author')?.value).toBeNull();
    expect(rows.find((r) => r.key === 'compare')?.value).toBe(0);
    expect(rows[0]?.label).toBe('Отговор в началото');
  });
});

describe('pages the engines cite', () => {
  const win = (over: Partial<WinnerPage>): WinnerPage => ({
    engine: 'openai', domain: 'a.example', url: 'https://a.example/', title: 't', kind: 'brand', citedIn: 3, whyCited: [], radar: { answer: 1, entity: 0.5, faq: null, author: 0, fresh: 0.25, sources: 0.75 }, score10: 5, words: null, ...over,
  });

  it('sorts by how many answers cite the page, then by quality, then by domain', () => {
    const sorted = sortWinners([win({ domain: 'c.example', citedIn: 2 }), win({ domain: 'b.example', citedIn: 3, score10: 4 }), win({ domain: 'a.example', citedIn: 3, score10: 7 }), win({ domain: 'd.example', citedIn: 3, score10: 7 })]);
    expect(sorted.map((w) => w.domain)).toEqual(['a.example', 'd.example', 'b.example', 'c.example']);
  });

  it('maps the six radar axes to the criteria names, with "entity" being the concrete facts', () => {
    const axes = winnerAxes(win({}).radar);
    expect(axes.map((a) => a.short)).toEqual(['Отговор', 'Факти', 'FAQ', 'Автор', 'Актуалност', 'Източници']);
    expect(axes.map((a) => a.label)).toEqual(['Отговор в началото', 'Конкретни факти', 'FAQ и въпроси', 'Автор и доверие', 'Актуалност', 'Цитирани източници']);
    expect(axes.map((a) => a.value)).toEqual([1, 0.5, null, 0, 0.25, 0.75]);
  });
});

describe('chart geometry', () => {
  it('starts the first axis at twelve o\'clock and goes clockwise', () => {
    expect(radarAngle(0, 6)).toBeCloseTo(-Math.PI / 2);
    const top = radarPoint(0, 6, 100, 50, 50);
    expect(top.x).toBeCloseTo(50);
    expect(top.y).toBeCloseTo(-50);
    const right = radarPoint(3, 4, 10, 0, 0);
    expect(right.x).toBeCloseTo(-10); // the fourth of four axes points left
    expect(radarPoint(1, 4, 10, 0, 0).x).toBeCloseTo(10);
  });

  it('draws one closed outline when every axis has a value', () => {
    expect(radarRuns([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])).toEqual([{ indices: [0, 1, 2, 3, 4, 5], closed: true }]);
  });

  it('breaks the outline at an axis without a value instead of drawing it as zero', () => {
    expect(radarRuns([0.8, null, 0.5, 0.4, null, 0.3])).toEqual([
      { indices: [2, 3], closed: false },
      { indices: [5, 0], closed: false }, // the run wraps round the end of the list
    ]);
    expect(radarRuns([null, 0.5, 0.6, 0.7, 0.8, 0.9])).toEqual([{ indices: [1, 2, 3, 4, 5], closed: false }]);
    expect(radarRuns([0.5, null, null, null, null, null])).toEqual([{ indices: [0], closed: false }]);
    expect(radarRuns([null, null, null])).toEqual([]);
    expect(radarRuns([])).toEqual([]);
  });

  it('turns a share of a turn into a stroke dash, one dash and no repeat', () => {
    const r = 40;
    const c = 2 * Math.PI * r;
    expect(arcDash(0, 0.25, r)).toEqual({ dash: c * 0.25, gap: c, offset: -0 });
    const band = arcDash(0.25, 0.66, r);
    expect(band.dash).toBeCloseTo(c * 0.41);
    expect(band.offset).toBeCloseTo(-c * 0.25);
    expect(arcDash(0.9, 0.1, r).dash).toBeCloseTo(c * 0.8); // the ends may come in any order
    expect(arcDash(0, 2, r).dash).toBeCloseTo(c); // and never past a full turn
  });
});

describe('Markdown of text that a language model or a web page wrote', () => {
  /** What is left once the inert code spans are taken out: here no markup character may be live. */
  const live = (md: string): string => md.replace(/`[^`\n]*`/g, '').replace(/\\./g, '');

  it('turns markup into inert text', () => {
    const hostile = [
      '![](https://evil.example/pixel.png?viewer=report)',
      '[Free SEO audit — click here](https://evil.example/phish)',
      '<img src=x onerror=alert(1)>',
      '| a | b |',
      '# heading',
      '*bold* _em_ `code`',
      '- injected list item',
      'line one\nline two',
    ];
    for (const text of hostile) {
      const out = mdText(text);
      expect(live(out), text).not.toMatch(/[[\]<>*_|#]/);
      expect(out, text).not.toContain('\n');
    }
    expect(mdText('line one\r\n\r\nline two')).toBe('line one line two');
    expect(mdText('- item')).toBe('\\- item');
    expect(mdText('2. item')).toBe('\\2. item');
    expect(mdText(null)).toBe('');
    expect(mdText(42)).toBe('42');
  });

  it('keeps an ordinary Bulgarian sentence readable', () => {
    expect(mdText('Търсещите най-често са от тип „готов да поръча“ (≈65% от резултатите).')).toBe('Търсещите най-често са от тип „готов да поръча“ (≈65% от резултатите).');
    expect(mdText('Добави цена „от“ 990 лв. и срок 3–4 седмици')).toBe('Добави цена „от“ 990 лв. и срок 3–4 седмици');
  });

  it('shows a bare address or an e-mail as code, because GitHub-flavoured renderers link them without any bracket', () => {
    expect(mdText('Виж https://evil.example/x и www.evil.example/y.')).toBe('Виж `https://evil.example/x` и `www.evil.example/y`.');
    expect(mdText('Пиши на a.b@evil.example, моля')).toBe('Пиши на `a.b@evil.example`, моля');
    expect(mdText('http://evil.example/a_b*c')).toBe('`http://evil.example/a_b*c`');
    expect(mdText('![](https://evil.example/p.png)')).toBe('!\\[\\](`https://evil.example/p.png`)');
    expect(mdText('Версия 2.0 на schema.org')).toBe('Версия 2.0 на schema.org'); // not an address: no scheme, no "www."
  });

  it('removes characters that are invisible to a reader but not to a program', () => {
    const hidden = [0xad, 0x200b, 0x202e, 0x2028, 0xfeff, 0xe0041].map(ch).join('');
    expect(mdText(`сайт${hidden}ове`)).toBe('сайтове');
    expect(mdUrl(`https://a.example/${ch(0x202e)}x y\`z`)).toBe('`https://a.example/xyz`'); // no hidden character, no space, no backtick to end the span
    expect(mdUrl('')).toBe('—');
  });

  it('writes one plan with its heading, kind, address, engines, citability, questions and numbered steps', () => {
    const md = planMarkdown(
      plan({ title: 'Ценоразпис', kind: 'rewrite', url: 'https://my-studio.example/tsenoraz', suggestedPath: null, engines: ['gemini', 'openai'], citability: { now: 0.28, after: 0.61 }, questions: ['Колко струва?', 'Има ли такса?'], writtenBy: 'llm', checklist: [{ id: 'a', text: 'Първо', why: 'защото' }, { id: 'b', text: 'Второ', why: '  ' }] }),
      { level: 1 },
    );
    expect(md).toBe(
      [
        '# Ценоразпис',
        '',
        '- Вид: Пренапиши',
        '- Адрес: `https://my-studio.example/tsenoraz`',
        '- Важи за: ChatGPT, Gemini',
        '- Цитируемост: 28% → 61% (прогноза)',
        '',
        '## Въпроси, на които да отговаря',
        '',
        '- Колко струва?',
        '- Има ли такса?',
        '',
        '## Стъпки',
        '',
        '1. Първо',
        '   - Защо: защото',
        '2. Второ',
        '',
        '_Чеклист, написан от езиков модел._',
      ].join('\n'),
    );
  });

  it('writes a suggested address for a page that does not exist yet and leaves out what is missing', () => {
    const md = planMarkdown(plan({ questions: [], checklist: [], engines: [] }), { level: 2, index: 3 });
    expect(md).toContain('## 3. Нова страница');
    expect(md).toContain('- Вид: Създай нова страница');
    expect(md).toContain('- Предложен адрес: `/blog/nova`');
    expect(md).not.toContain('Важи за');
    expect(md).not.toContain('Цитируемост');
    expect(md).not.toContain('Стъпки');
    expect(md).toContain('_Чеклист от правила._');
  });

  it('writes the whole plan biggest loss first, with a count of new pages and rewrites', () => {
    const md = plansMarkdown([plan({ id: 'low', title: 'Ниско', priority: 0.1 }), plan({ id: 'high', title: 'Високо', priority: 0.9, kind: 'rewrite', url: 'https://x.example/p', suggestedPath: null })], { domain: 'my-studio.example' });
    expect(md.startsWith('# План за ИИ видимост: my-studio.example\n\n2 страници за работа (нови: 1, за пренаписване: 1), подредени по приоритет — започни от първата.\n\n## 1. Високо')).toBe(true);
    expect(md.indexOf('## 2. Ниско')).toBeGreaterThan(md.indexOf('## 1. Високо'));
    expect(md.endsWith('---\nИзготвено с Jev SEO Radar.')).toBe(true);
    expect(plansMarkdown([plan()], { domain: 'a.example' })).toContain('1 страница за работа');
  });

  it('keeps hostile plan text inert, in every field, in the single and the whole plan', () => {
    const payload = '![](https://evil.example/p.png) [x](https://evil.example/y) <img src=x onerror=alert(1)> https://evil.example/z';
    const hostile = plan({
      title: `# ${payload}`,
      url: 'https://my-studio.example/a`b)[c](d',
      suggestedPath: null,
      kind: 'rewrite',
      questions: [payload, '- пореден\nнов ред'],
      checklist: [{ id: 'a', text: payload, why: `${payload}${ch(0x202e)}` }, { id: 'b', text: '1. подвеждащ номер', why: '> цитат' }],
    });
    for (const md of [planMarkdown(hostile), plansMarkdown([hostile, hostile], { domain: `evil${ch(0x202e)}.example` })]) {
      expect(live(md)).not.toMatch(/[[\]<>]/); // no live link, image or tag
      expect(md).not.toContain(ch(0x202e));
      for (const line of md.split('\n')) expect(line, line).toMatch(/^(#{1,6} .+|- .+|   - .+|\d+\. .+|_.+_|---|Изготвено с Jev SEO Radar\.|\d+ страници.+|)$/);
      expect(md).toContain('evil.example'); // the text is still there, only inert
    }
  });
});

describe('plans in order, and how far through a checklist someone is', () => {
  it('sorts by priority, a new page before a rewrite among equals, then by title, and does not modify the list', () => {
    const list = [
      plan({ id: 'a', title: 'Б', priority: 0.5, kind: 'rewrite' }),
      plan({ id: 'b', title: 'Я', priority: 0.9 }),
      plan({ id: 'c', title: 'А', priority: 0.5, kind: 'create' }),
      plan({ id: 'd', title: 'А', priority: 0.5, kind: 'rewrite' }),
    ];
    const before = list.map((p) => p.id);
    expect(sortPlans(list).map((p) => p.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(list.map((p) => p.id)).toEqual(before);
    expect(countPlans(list)).toEqual({ total: 4, create: 2, rewrite: 2 });
    expect(countPlans([])).toEqual({ total: 0, create: 0, rewrite: 0 });
  });

  it('keeps the ticks of one plan of one audit under one key', () => {
    expect(planStorageKey('a_demo5kq2m7x9', 'prices')).toBe('radar.plan.a_demo5kq2m7x9.prices');
  });

  it('reads stored ticks defensively: only ids that are still in the checklist, each once', () => {
    const ids = ['s1', 's2', 's3'];
    expect(parseDone(['s1', 's3'], ids)).toEqual(['s1', 's3']);
    expect(parseDone(['s1', 's1', 'gone', 7, null, {}, 's2'], ids)).toEqual(['s1', 's2']);
    for (const junk of [null, undefined, 'text', 42, { s1: true }, true]) expect(parseDone(junk, ids)).toEqual([]);
  });

  it('writes the progress the way the brief shows it', () => {
    expect(progressText(3, 8)).toBe('3 от 8 готови');
    expect(progressText(0, 5)).toBe('0 от 5 готови');
    expect(progressText(1, 1)).toBe('1 от 1 готова');
  });
});

describe('copying to the clipboard', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A page with a text area that copies the way a browser does, when `execCommand` is allowed. */
  const fakeDocument = (copied: string[], allow = true) => {
    const area: { value: string; style: { cssText: string }; setAttribute: () => void; select: () => void; setSelectionRange: () => void; remove: () => void } = {
      value: '', style: { cssText: '' }, setAttribute: () => undefined, select: () => undefined, setSelectionRange: () => undefined, remove: () => undefined,
    };
    return {
      body: { appendChild: () => undefined },
      activeElement: { focus: vi.fn() },
      createElement: () => area,
      execCommand: (cmd: string) => {
        if (cmd === 'copy' && allow) copied.push(area.value);
        return cmd === 'copy' && allow;
      },
    };
  };

  it('uses the Clipboard API when the page may', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void written.push(t) } });
    expect(await copyText('план')).toBe(true);
    expect(written).toEqual(['план']);
  });

  it('falls back to selecting a hidden text area when there is no Clipboard API (an insecure address)', async () => {
    const copied: string[] = [];
    const doc = fakeDocument(copied);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', doc);
    expect(await copyText('план')).toBe(true);
    expect(copied).toEqual(['план']);
    expect(doc.activeElement.focus).toHaveBeenCalled(); // the focus goes back to the button that was pressed
  });

  it('falls back too when the Clipboard API refuses', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => Promise.reject(new Error('NotAllowedError')) } });
    vi.stubGlobal('document', fakeDocument(copied));
    expect(await copyText('x')).toBe(true);
    expect(copied).toEqual(['x']);
  });

  it('says no when nothing works, so the page can offer the text to select by hand', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', fakeDocument([], false));
    expect(await copyText('x')).toBe(false);
    vi.stubGlobal('document', undefined);
    expect(await copyText('x')).toBe(false);
  });
});

describe('on the sample audit', () => {
  const audit = sampleSiteAudit();
  const geo = audit.geo;

  it('has a geo section to work with', () => {
    expect(geo).not.toBeNull();
  });

  it('puts the text of a question on every answer', () => {
    const texts = questionIndex(audit.questions, geo?.skips ?? []);
    for (const a of geo?.answers ?? []) expect(texts.get(a.questionId), `${a.engine}/${a.questionId}`).toBeTruthy();
  });

  it('counts, per engine, the same "cited or named" answers as the engine summary says', () => {
    for (const run of geo?.engines ?? []) {
      const mine = answersOf(geo?.answers ?? [], run.engine);
      expect(countByFilter(mine).won, run.engine).toBe(run.citingUs);
      expect(countByFilter(mine).lost, run.engine).toBe(run.skippingUs);
      expect(mine.length - countByFilter(mine).all, run.engine).toBe(0);
    }
  });

  it('marks our own domain among the cited ones, and the competitors the request lists', () => {
    const roles = new Map<string, string>();
    for (const run of geo?.engines ?? []) for (const c of run.topCited) roles.set(c.domain, domainRole(c.domain, audit.request));
    expect(roles.get('my-studio.example')).toBe('own');
    expect(roles.get('pixel-studio.example')).toBe('competitor');
    expect(roles.get('top-agencii.example')).toBe('other');
  });

  it('groups the skip analyses of the sample, the worst first', () => {
    const groups = groupSkips(geo?.skips ?? []);
    expect(groups.length).toBe(new Set((geo?.skips ?? []).map((s) => s.questionId)).size);
    expect(groups.flatMap((g) => g.items)).toHaveLength(geo?.skips.length ?? -1);
    const noPage = groups.filter((g) => !g.page.exists);
    expect(noPage.length).toBeGreaterThan(0);
    expect(groups.slice(0, noPage.length).every((g) => !g.page.exists)).toBe(true); // a missing page counts as the lowest score
    for (const g of groups) expect(g.actions).toEqual([g.page.exists ? 'rewrite' : 'create']);
  });

  it('sorts the plan the way the screen does and turns all of it into safe Markdown', () => {
    const sorted = sortPlans(audit.plan);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1]?.priority).toBeGreaterThanOrEqual(sorted[i]?.priority ?? 0);
    const md = plansMarkdown(audit.plan, { domain: audit.request.domain });
    expect(md).toContain(`# План за ИИ видимост: ${audit.request.domain}`);
    for (const p of audit.plan) {
      expect(md).toContain(mdText(p.title));
      for (const [i, step] of p.checklist.entries()) expect(md).toContain(`${i + 1}. ${mdText(step.text)}`);
    }
    expect(live(md)).not.toMatch(/[[\]<>]/);

    function live(text: string): string {
      return text.replace(/`[^`\n]*`/g, '').replace(/\\./g, '');
    }
  });

  it('draws the radar of every cited page from six axes', () => {
    for (const w of geo?.winners ?? []) expect(winnerAxes(w.radar)).toHaveLength(6);
  });
});
