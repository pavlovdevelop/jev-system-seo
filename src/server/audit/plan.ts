import { ENGINE_IDS, SKIP_REASON_LABELS, type EngineId, type FixPlan, type SitePage, type SkipAnalysis, type SkipReason, type WinnerPage } from '../../shared/audit';
import type { MarketId } from '../../shared/markets';
import { fileSlug, terms } from '../nlp/bg';
import { mapLimit } from '../util/limit';
import type { Writer } from './writer';

// The plan: which pages to write or rewrite, and in what order to do the work on each. Skips are grouped by the page
// they concern (or, for questions with no page at all, by topic); the checklist comes from fixed rules, and a language
// model — when there is one — makes it concrete for the page and puts it in the best order.

type Step = { id: string; text: string; why: string };

interface Group {
  kind: 'create' | 'rewrite';
  url: string | null;
  questions: string[];
  engines: Set<EngineId>;
  lost: number;
  reasons: Map<SkipReason, number>;
  winnerDomains: Set<string>;
}

const MAX_PLANS = 12;
const LLM_PLANS = 8;

/** Greedy clustering by shared words: questions about the same thing end up on one new page. */
export function clusterQuestions(texts: readonly string[]): string[][] {
  const clusters: Array<{ members: string[]; termSets: Array<Set<string>> }> = [];
  for (const text of texts) {
    const set = new Set(terms(text));
    if (set.size === 0) continue;
    let home = clusters.find((c) =>
      c.termSets.some((other) => {
        let shared = 0;
        for (const t of set) if (other.has(t)) shared++;
        return shared / Math.min(set.size, other.size) >= 0.5;
      }),
    );
    if (!home) {
      home = { members: [], termSets: [] };
      clusters.push(home);
    }
    home.members.push(text);
    home.termSets.push(set);
  }
  return clusters.map((c) => c.members);
}

const stripQuestionMark = (s: string): string => s.replace(/[?\s]+$/, '').trim();
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function titleFor(group: Group, pages: ReadonlyMap<string, SitePage>): string {
  if (group.kind === 'rewrite' && group.url) {
    const page = pages.get(group.url);
    return (page?.metrics?.title ?? page?.path ?? group.url).slice(0, 160);
  }
  const shortest = [...group.questions].sort((a, b) => a.length - b.length)[0] ?? 'Нова страница';
  return cap(stripQuestionMark(shortest)).slice(0, 160);
}

/** How long a page should be: as long as the pages that are cited, but never less than 600 words or half as long again as it is now. */
export function targetWords(typical: number | null | undefined, current: number): number {
  return Math.round(Math.max(typical ?? 0, current * 1.5, 600) / 100) * 100;
}

/** The fixed steps, most valuable first. Numbers in them come from the analysis, not from a model. */
export function baselineSteps(input: { kind: 'create' | 'rewrite'; title: string; questions: readonly string[]; reasons: readonly SkipReason[]; page: SitePage | null; winners: readonly WinnerPage[]; domains: readonly string[] }): Step[] {
  const { kind, reasons, page } = input;
  const steps: Array<Omit<Step, 'id'>> = [];
  const main = input.questions[0] ? `«${stripQuestionMark(input.questions[0])}»` : 'основния въпрос';
  const winnerWords = input.winners.map((w) => w.words).filter((w): w is number => w !== null && w > 0).sort((a, b) => a - b);
  const typicalWords = winnerWords.length > 0 ? winnerWords[Math.floor(winnerWords.length / 2)] : null;
  const has = (r: SkipReason): boolean => reasons.includes(r);

  if (kind === 'create') {
    steps.push({ text: `Прочети страниците, които ИИ цитира вместо теб${input.domains.length > 0 ? ` (${input.domains.slice(0, 3).join(', ')})` : ''}, и отбележи как отговарят на въпроса.`, why: 'Копирай структурата и пълнотата, не текста — така знаеш какво се очаква.' });
    steps.push({ text: `Определи един главен въпрос за страницата: ${main}, и формата ѝ (ръководство, сравнение или цена).`, why: 'Страница за един въпрос се цитира по-често от страница за „всичко“.' });
    steps.push({ text: 'Заглавие и H1 с основната фраза на въпроса, на нормален език.', why: 'ИИ и Google избират страница първо по заглавието и H1.' });
    steps.push({ text: 'Дай отговора в първите 40 думи, после го разгърни.', why: 'Асистентите цитират страници, които отговарят веднага.' });
    if (input.questions.length > 1) steps.push({ text: `Направи секция за всеки от другите въпроси: ${input.questions.slice(1, 5).map((q) => `«${stripQuestionMark(q)}»`).join(', ')}.`, why: 'Един материал, който покрива свързаните въпроси, е по-силен източник.' });
    steps.push({ text: `Добави конкретни факти: цени, срокове, числа, спецификации${`; цели около ${targetWords(typicalWords, 0)} думи`}.`, why: 'Конкретните факти се цитират; общите фрази — не.' });
  } else {
    if (has('wrong_angle')) steps.push({ text: `Смени ъгъла на страницата, за да отговаря точно на ${main}: сравнение, цена или ръководство според въпроса.`, why: 'Страница с грешен ъгъл не се избира, колкото и да е добра.' });
    if (has('no_answer_first')) steps.push({ text: 'Премести отговора в първите 40 думи на страницата.', why: 'Асистентите четат началото; отговор, скрит надолу, не се цитира.' });
    if (has('too_thin')) steps.push({ text: `Разшири текста до около ${targetWords(typicalWords, page?.words ?? 0)} думи (сега ${page?.words ?? 0}) с липсващите части на темата.`, why: 'Цитираните страници покриват темата по-пълно.' });
    if (has('no_data')) steps.push({ text: 'Добави конкретни факти: цени, срокове, числа, спецификации, примери.', why: 'Общите твърдения не могат да бъдат цитирани.' });
    steps.push({ text: `Приведи заглавието и H1 към въпроса ${main}.`, why: 'Заглавието и H1 са първото, по което страницата се свързва с въпроса.' });
  }

  steps.push({ text: 'Добави секция с въпросите на купувачите (виж по-горе) и FAQPage schema.', why: 'Блоковете „въпрос — отговор“ са най-често цитираните части.' });
  if (kind === 'create' || has('weak_trust')) steps.push({ text: 'Покажи автор с квалификация и данни за фирмата (ЕИК, адрес, контакт).', why: 'Асистентите предпочитат източници с ясно име зад тях.' });
  if (has('outdated')) steps.push({ text: `Обнови съдържанието и покажи дата на актуализация${page?.ageMonths ? ` (последна промяна преди около ${Math.round(page.ageMonths)} мес.)` : ''}.`, why: 'Остарялата страница губи от по-свежата.' });
  if (input.questions.some((q) => /сравн|разлика|срещу|\bvs\b|по-добър/i.test(q))) steps.push({ text: 'Добави таблица за сравнение с ясни критерии.', why: 'Таблицата е най-лесният за цитиране формат при сравнения.' });
  if (kind === 'create' || (page?.criteria.sources ?? 1) < 0.5) steps.push({ text: 'Цитирай 3–4 авторитетни източника с връзки.', why: 'Страница, която сама сочи източници, изглежда по-достоверна.' });
  steps.push({ text: kind === 'create' ? 'Свържи новата страница от 3–4 свързани страници на сайта.' : 'Добави вътрешни връзки от свързани страници с описателен текст.', why: 'Вътрешните връзки показват на ботовете, че страницата е важна.' });
  steps.push({ text: 'Подай адреса за индексиране (Search Console, IndexNow) и провери отново след 2–3 седмици.', why: 'Промяната има ефект едва когато страницата бъде прочетена наново.' });
  return steps.slice(0, 12).map((s, i) => ({ id: `c${i + 1}`, ...s }));
}

export interface PlanInput {
  business: string;
  market: MarketId;
  skips: readonly SkipAnalysis[];
  pages: readonly SitePage[];
  winners: readonly WinnerPage[];
  writer: Writer;
  signal?: AbortSignal;
}

export async function buildPlan(input: PlanInput): Promise<FixPlan[]> {
  const byUrl = new Map(input.pages.map((p) => [p.url, p]));
  const groups = new Map<string, Group>();
  const newPageQuestions: string[] = [];
  for (const s of input.skips) if (s.action === 'create' || !s.ourPage.url) newPageQuestions.push(s.question);
  const clusters = clusterQuestions([...new Set(newPageQuestions)]);
  const clusterOf = new Map<string, number>();
  clusters.forEach((members, i) => members.forEach((q) => clusterOf.set(q, i)));

  for (const s of input.skips) {
    const create = s.action === 'create' || !s.ourPage.url;
    const key = create ? `new:${clusterOf.get(s.question) ?? s.question}` : `page:${s.ourPage.url}`;
    const g = groups.get(key) ?? { kind: create ? ('create' as const) : ('rewrite' as const), url: create ? null : s.ourPage.url, questions: [], engines: new Set<EngineId>(), lost: 0, reasons: new Map<SkipReason, number>(), winnerDomains: new Set<string>() };
    if (!g.questions.includes(s.question)) g.questions.push(s.question);
    g.engines.add(s.engine);
    g.lost++;
    for (const r of s.reasons) g.reasons.set(r, (g.reasons.get(r) ?? 0) + 1);
    if (s.winner) g.winnerDomains.add(s.winner.domain);
    groups.set(key, g);
  }

  const totalLost = Math.max(1, input.skips.length);
  const ordered = [...groups.values()].sort((a, b) => b.lost - a.lost || b.questions.length - a.questions.length).slice(0, MAX_PLANS);

  const plans = await mapLimit(ordered, 3, async (g, index): Promise<FixPlan> => {
    const page = g.url ? byUrl.get(g.url) ?? null : null;
    const title = titleFor(g, byUrl);
    const reasons = [...g.reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
    const winners = input.winners.filter((w) => g.winnerDomains.has(w.domain));
    const baseline = baselineSteps({ kind: g.kind, title, questions: g.questions, reasons, page, winners, domains: [...g.winnerDomains] });

    let checklist: Step[] = baseline;
    let writtenBy: FixPlan['writtenBy'] = 'rules';
    if (index < LLM_PLANS && input.writer.id !== 'rules') {
      const written = await input.writer
        .checklist({
          kind: g.kind,
          business: input.business,
          market: input.market,
          title,
          url: g.url,
          questions: g.questions.slice(0, 8),
          findings: reasons.map((r) => SKIP_REASON_LABELS[r]),
          winners: winners.map((w) => `${w.domain}: ${w.whyCited.join('; ') || 'без отчетени причини'}`),
          baseline: baseline.map((b) => b.text),
          ...(input.signal ? { signal: input.signal } : {}),
        })
        .catch(() => null);
      if (written) {
        checklist = written.map((w, i) => ({ id: `c${i + 1}`, text: w.text, why: w.why || 'Подобрява шанса страницата да бъде цитирана.' }));
        writtenBy = 'llm';
      }
    }

    return {
      id: `p${index + 1}`,
      kind: g.kind,
      url: g.url,
      suggestedPath: g.kind === 'create' ? `/${fileSlug(title, 50)}` : null,
      title,
      questions: g.questions.slice(0, 8),
      engines: ENGINE_IDS.filter((e) => g.engines.has(e)),
      priority: Math.round((g.lost / totalLost) * 1000) / 1000,
      citability: page?.citability ? { now: page.citability.now, after: page.citability.after } : null,
      checklist: checklist.slice(0, 12).map((c) => ({ id: c.id, text: c.text.slice(0, 300), why: c.why.slice(0, 240) })),
      writtenBy,
    };
  });
  return plans;
}
