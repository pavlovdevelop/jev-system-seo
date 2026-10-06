import type { CompetitorPage } from '../../shared/audit';
import type { SerpData, SerpResult } from '../../shared/schemas';
import { STEAL_AT, STEAL_MIN_RELEVANCE } from '../../shared/weights';
import { mapLimit } from '../util/limit';
import { competitorOverall, competitorScores } from './criteria';
import { judgeSitePage, readPage, type JudgedPage, type JudgeDeps, type ReadDeps } from './page-judge';

// "Pages and techniques to steal": for the phrases our own pages are about, the competitor pages that rank on Google,
// each read and judged like our own, then split into the ones worth copying and the ones to skip.

export interface PhraseTarget {
  phrase: string;
  ourUrl: string | null;
  serp: SerpData;
}

export interface Selection {
  phrase: string;
  ourUrl: string | null;
  result: SerpResult;
}

const SOCIAL = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|reddit|quora|wikipedia)\.[a-z.]+$/i;

/** Up to `budget` competitor results, taken round-robin over the phrases (tracked competitors and higher positions first). */
export function selectCompetitorPages(targets: readonly PhraseTarget[], ownDomain: string, tracked: ReadonlySet<string>, budget: number): Selection[] {
  const lists = targets.map((t) => ({
    t,
    results: t.serp.results
      .filter((r) => r.domain !== ownDomain && !SOCIAL.test(r.domain))
      .sort((a, b) => Number(tracked.has(b.domain)) - Number(tracked.has(a.domain)) || a.position - b.position)
      .slice(0, 5),
  }));
  const out: Selection[] = [];
  const seen = new Set<string>();
  for (let round = 0; out.length < budget; round++) {
    let added = false;
    for (const { t, results } of lists) {
      const r = results[round];
      if (!r || seen.has(r.url) || out.length >= budget) continue;
      seen.add(r.url);
      out.push({ phrase: t.phrase, ourUrl: t.ourUrl, result: r });
      added = true;
    }
    if (!added && round >= 5) break;
  }
  return out;
}

const round100 = (n: number): number => Math.round(n / 100) * 100;

/** What the competitor's page does that ours does not. */
export function techniquesOf(theirs: JudgedPage, ours: JudgedPage | null): string[] {
  const tm = theirs.read.extracted?.metrics;
  if (!tm) return [];
  const om = ours?.read.extracted?.metrics ?? null;
  const out: string[] = [];
  if (tm.hasFaqSchema && !om?.hasFaqSchema) out.push('Въпроси и отговори с FAQPage schema');
  if (tm.tables > 0 && !(om?.tables ?? 0)) out.push('Таблица за сравнение');
  if ((theirs.criteria?.answer ?? 0) >= 0.7 && (ours?.criteria?.answer ?? 0) < 0.5) out.push('Отговор в първите изречения');
  if (tm.priceMentions.length > 0 && (om?.priceMentions.length ?? 0) === 0) out.push('Конкретни цени на страницата');
  if ((theirs.judgments.showsReviews?.p ?? 0) >= 0.6 && (ours?.judgments.showsReviews?.p ?? 0) < 0.5) out.push('Отзиви от клиенти');
  if ((theirs.judgments.showsPortfolio?.p ?? 0) >= 0.6 && (ours?.judgments.showsPortfolio?.p ?? 0) < 0.5) out.push('Примери от проекти (портфолио)');
  if ((theirs.criteria?.fresh ?? 0) >= 0.9 && (ours?.criteria?.fresh ?? 1) < 0.6) out.push('Редовно обновявана, с дата на актуализация');
  if (tm.externalDomains >= 3 && (om?.externalDomains ?? 0) < 2) out.push('Цитира външни източници');
  if (tm.hasAuthor && !om?.hasAuthor) out.push('Посочен автор');
  if (tm.wordCount >= 800 && tm.wordCount >= 1.4 * (om?.wordCount ?? 0)) out.push(`По-подробна: около ${round100(tm.wordCount)} думи${om ? ` (нашата: около ${round100(om.wordCount)})` : ''}`);
  return out.slice(0, 6);
}

const NOT_COPYABLE = new Set(['forum_or_social', 'directory_marketplace', 'news_or_media']);
const pct = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);

export function verdictFor(theirs: JudgedPage, ours: JudgedPage | null): { verdict: 'steal' | 'skip'; why: string; overall: number | null; scores: CompetitorPage['scores'] } {
  const m = theirs.read.extracted?.metrics;
  if (!m || !theirs.criteria) return { verdict: 'skip', why: 'Страницата не можа да бъде прочетена и оценена.', overall: null, scores: { answer: null, depth: null, proof: null, schema: null, fresh: null } };
  const scores = competitorScores(theirs.judgments, theirs.criteria, m);
  const overall = competitorOverall(scores);
  const ourMetrics = ours?.read.extracted?.metrics;
  const ourOverall = ours && ours.criteria && ourMetrics ? competitorOverall(competitorScores(ours.judgments, ours.criteria, ourMetrics)) : null;
  const relevance = theirs.judgments.targetsQuery?.p ?? null;

  if (theirs.type && NOT_COPYABLE.has(theirs.type)) return { verdict: 'skip', why: 'Форум, каталог или новина — не е формат, който да копираш.', overall, scores };
  if (relevance !== null && relevance < STEAL_MIN_RELEVANCE) return { verdict: 'skip', why: 'Не е посветена на тази фраза — класира се по други причини.', overall, scores };
  if (overall === null) return { verdict: 'skip', why: 'Няма достатъчно оценки за тази страница.', overall, scores };
  if (overall < STEAL_AT) return { verdict: 'skip', why: `Слаба за копиране: обща оценка ${pct(overall)}.`, overall, scores };
  if (ourOverall !== null && overall <= ourOverall + 0.03) return { verdict: 'skip', why: `Нашата страница е на същото ниво или по-силна (${pct(ourOverall)} срещу ${pct(overall)}).`, overall, scores };
  return { verdict: 'steal', why: `Силна и по темата: отговор ${pct(scores.answer)}, дълбочина ${pct(scores.depth)}, доказателства ${pct(scores.proof)}.`, overall, scores };
}

export interface CompetitorRead {
  selection: Selection;
  judged: JudgedPage;
}

/** Reads and judges the selected pages, a few at a time. */
export async function readCompetitorPages(selected: readonly Selection[], read: ReadDeps, judge: Omit<JudgeDeps, 'withElements'>): Promise<CompetitorRead[]> {
  return mapLimit(selected, 3, async (selection) => {
    const page = await readPage(selection.result.url, read);
    return { selection, judged: await judgeSitePage(page, { ...judge, withElements: false }) };
  });
}

export function toCompetitorPage(
  c: CompetitorRead,
  ours: JudgedPage | null,
  aiShare: number | null,
): CompetitorPage {
  const { selection, judged } = c;
  const v = verdictFor(judged, ours);
  return {
    domain: selection.result.domain,
    url: judged.read.url,
    title: (judged.read.extracted?.metrics.title ?? selection.result.title ?? '').slice(0, 200),
    phrase: selection.phrase,
    ourUrl: selection.ourUrl,
    googleRank: selection.result.position,
    aiShare,
    type: judged.type,
    scores: v.scores,
    overall: v.overall,
    verdict: v.verdict,
    why: v.why.slice(0, 240),
    techniques: v.verdict === 'steal' ? techniquesOf(judged, ours) : [],
  };
}
