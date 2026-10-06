import {
  ENGINE_LABELS,
  SiteAuditReportSchema,
  type AnswerRecord,
  type BuyerQuestion,
  type CompetitorPage,
  type ElementVerdict,
  type EngineId,
  type EngineRun,
  type SitePage,
  type SiteAuditReport,
  type SiteAuditRequest,
  type SkipAnalysis,
  type WinnerPage,
} from '../../shared/audit';
import { bgCount } from '../../shared/plural';
import { MARKETS } from '../../shared/markets';
import type { PipelineStep, SerpData } from '../../shared/schemas';
import { PAGE_IMPORTANCE } from '../../shared/weights';
import type { PageExtractor } from '../crawl/extract-pool';
import type { PageFetcher } from '../crawl/fetcher';
import type { AnswerEngine } from '../geo/engines/types';
import type { Jev } from '../jev/client';
import { PipelineError } from '../pipeline/analyze';
import { domainOf, SerpError, type SerpProvider, type VolumeProvider } from '../providers/serp/types';
import { discoverSite } from '../site/discover';
import { mapLimit } from '../util/limit';
import type { Meter } from '../util/meter';
import { toCompetitorPage, readCompetitorPages, selectCompetitorPages, type PhraseTarget } from './competitor-pages';
import { citabilityOf } from './criteria';
import { judgeElements, normalizeForCompare } from './elements';
import { analyseAnswer, brandMatcher, readSentiment, runEngines, summarizeEngine, toRecord, type RawAnswer } from './geo';
import { judgeSitePage, readPage, type JudgedPage, type JudgeDeps, type ReadDeps } from './page-judge';
import { balance, collectQuestions, dedupe, questionVolumes, screenQuestions } from './buyer-questions';
import { buildPlan } from './plan';
import { checkCoverage, type CoverageResult, type CoveragePage } from './question-coverage';
import type { SitePageContext } from './questions';
import { actionFor, detailOf, skipReasons, sourceKindOf, winnerPageOf } from './skips';
import type { Writer } from './writer';

// The whole-site audit, end to end:
//   discover the pages → read them → Jev judges each one (type, depth, trust, SEO elements, citability) →
//   look up Google positions → imagine the buyers' questions and check which ones the site answers →
//   ask the AI assistants the same questions and see who gets cited → read the competitor pages and the pages the
//   assistants cite → say why we lose and what to do, page by page.
// Every number is computed here, in code; Jev supplies judgments, the assistants supply answers, the writer
// (optional) supplies wording.

export interface AuditDeps {
  jev: Jev;
  serp: SerpProvider | null;
  volume: VolumeProvider | null;
  fetcher: PageFetcher;
  extractor: PageExtractor;
  engines: readonly AnswerEngine[];
  writer: Writer;
  meter: Meter;
  limits: { maxPages: number; maxQuestions: number; maxEngineCalls: number };
  info: {
    mode: 'live' | 'demo';
    serp: string | null;
    jev: { model: string; endpoint: string };
  };
  /** Names competitors go by in prose (domain → names), when known. */
  brandHints?: Readonly<Record<string, readonly string[]>>;
  now?: () => Date;
}

export type Emit = (step: PipelineStep, pct: number, message: string) => void;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const titleCase = (label: string): string => label.split(/[-_.\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** An address in a form two spellings of the same page agree on (no scheme, no www, no trailing slash, no query). */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return u.toLowerCase();
  }
}

const pathOf = (u: string): string => {
  try {
    const url = new URL(u);
    return `${url.pathname}${url.search}` || '/';
  } catch {
    return u;
  }
};

function importanceOf(path: string, type: SitePage['type']): number {
  return path === '/' ? 1 : PAGE_IMPORTANCE[type ?? 'other'];
}

export async function runSiteAudit(
  input: { id: string; request: SiteAuditRequest; tracked: readonly string[] },
  deps: AuditDeps,
  emit: Emit,
  signal?: AbortSignal,
): Promise<SiteAuditReport> {
  try {
    return await run(input, deps, emit, signal);
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    if (err instanceof SerpError) throw new PipelineError(err.message, 'serp', { cause: err });
    if (err instanceof DOMException && err.name === 'AbortError') throw new PipelineError('Анализът е прекратен.', 'aborted', { cause: err });
    throw err;
  }
}

async function run(input: { id: string; request: SiteAuditRequest; tracked: readonly string[] }, deps: AuditDeps, emit: Emit, signal?: AbortSignal): Promise<SiteAuditReport> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const { request } = input;
  const market = MARKETS[request.market];
  const business = request.businessDescription;
  const warnings: string[] = [];
  const jevBefore = deps.jev.stats();
  const check = (): void => signal?.throwIfAborted();
  const sig = signal ? { signal } : {};
  const ownDomain = domainOf(`https://${request.domain}`);
  const brand = request.brandNames[0] ?? titleCase(ownDomain.split('.')[0] ?? ownDomain);
  const tracked = new Set([...input.tracked, ...request.competitors].map((d) => domainOf(`https://${d}`)).filter((d) => d && d !== ownDomain));
  const readDeps: ReadDeps = { fetcher: deps.fetcher, extractor: deps.extractor, meter: deps.meter, now, ...sig };
  const judgeDeps: Omit<JudgeDeps, 'withElements'> = { jev: deps.jev, now, market: request.market, business, ...sig };
  let serpStopped = false;

  // ───────────────────────── 1. discover ─────────────────────────
  emit('discover', 2, 'Откривам страниците на сайта…');
  const maxPages = Math.min(request.options.maxPages, deps.limits.maxPages);
  const discovery = await discoverSite({ domain: request.domain, fetcher: deps.fetcher, maxPages, ...sig, onProgress: (m) => emit('discover', 4, m) });
  warnings.push(...discovery.notes);
  if (discovery.urls.length === 0) {
    throw new PipelineError(`Не успях да отворя сайта ${request.domain}. ${discovery.notes[0] ?? 'Провери дали адресът е верен и дали сайтът е достъпен отвън.'}`, 'input');
  }
  if (discovery.truncated) warnings.push(`Сайтът има поне ${discovery.found} страници; проверени са първите ${discovery.urls.length} (най-важните по структура). Увеличи „страници“ в настройките на проверката, ако искаш повече.`);
  check();

  // ───────────────────────── 2. read the pages ─────────────────────────
  emit('crawl', 6, `Чета ${bgCount(discovery.urls.length, 'страница', 'страници')}…`);
  let readCount = 0;
  const reads = await mapLimit(discovery.urls, 4, async (url) => {
    const page = await readPage(url, readDeps);
    emit('crawl', 6 + Math.round((18 * ++readCount) / discovery.urls.length), `Прочетени страници: ${readCount} от ${discovery.urls.length}`);
    return page;
  });
  check();

  // ───────────────────────── 3. Jev judges every page ─────────────────────────
  emit('judge', 25, 'Jev оценява страниците (тип, дълбочина, доверие, елементи, цитируемост)…');
  let judgedCount = 0;
  const judged: JudgedPage[] = await mapLimit(reads, 6, async (read) => {
    const j = await judgeSitePage(read, { ...judgeDeps, withElements: true });
    emit('judge', 25 + Math.round((19 * ++judgedCount) / reads.length), `Оценени страници: ${judgedCount} от ${reads.length}`);
    return j;
  });
  check();

  // duplicates across the site (the same title or description on several pages)
  const countOf = (pick: (j: JudgedPage) => string | null): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const j of judged) {
      const key = normalizeForCompare(pick(j));
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const titleCounts = countOf((j) => j.read.extracted?.metrics.title ?? null);
  const metaCounts = countOf((j) => j.read.extracted?.metrics.metaDescription ?? null);
  const h1Counts = countOf((j) => j.read.extracted?.metrics.h1[0] ?? null);

  // Google positions for the most important pages
  const readable = judged.filter((j) => j.read.extracted && j.phrase && !j.read.extracted.metrics.noindex);
  const byImportance = [...readable].sort((a, b) => importanceOf(pathOf(b.read.url), b.type) - importanceOf(pathOf(a.read.url), a.type));
  const serpByPhrase = new Map<string, SerpData>();
  const rankOf = new Map<string, number>();
  if (deps.serp && request.options.rankChecks > 0) {
    emit('judge', 45, 'Проверявам позициите в Google…');
    let checked = 0;
    for (const j of byImportance) {
      if (checked >= request.options.rankChecks || serpStopped) break;
      const phrase = j.phrase as string;
      if (serpByPhrase.has(phrase)) continue;
      try {
        const data = await deps.serp.search({ keyword: phrase, market, depth: 20 }, sig);
        serpByPhrase.set(phrase, data);
        checked++;
        const hit = data.results.find((r) => normalizeUrl(r.url) === normalizeUrl(j.read.url));
        if (hit) rankOf.set(j.read.url, hit.position);
      } catch (err) {
        if (err instanceof SerpError && err.fatal) {
          serpStopped = true;
          warnings.push(`Проверката на позициите спря: ${err.message}`);
        } else if (!(err instanceof SerpError)) throw err;
      }
    }
  } else if (!deps.serp) {
    warnings.push('Няма настроен SERP доставчик (Serper или DataForSEO) — позициите в Google и конкурентните страници не са проверени.');
  }
  check();

  // ───────────────────────── 4. SEO elements ─────────────────────────
  emit('elements', 48, 'Оценявам SEO елементите на всяка страница…');
  const pages: SitePage[] = [];
  const elements: ElementVerdict[] = [];
  const judgedByUrl = new Map<string, JudgedPage>();
  for (const j of judged) {
    const m = j.read.extracted?.metrics ?? null;
    const url = j.read.url;
    judgedByUrl.set(normalizeUrl(url), j);
    let own: ElementVerdict[] = [];
    if (j.read.extracted && m) {
      own = judgeElements({
        url,
        extracted: j.read.extracted,
        phrase: j.phrase,
        type: j.type,
        rank: rankOf.get(url) ?? null,
        brand,
        jev: j.element,
        faqJev: j.faq,
        duplicates: {
          title: titleCounts.get(normalizeForCompare(m.title)) ?? 1,
          meta: metaCounts.get(normalizeForCompare(m.metaDescription)) ?? 1,
          h1: h1Counts.get(normalizeForCompare(m.h1[0])) ?? 1,
        },
      });
      elements.push(...own);
    }
    pages.push({
      url,
      path: pathOf(url),
      fetch: j.read.fetch,
      metrics: m,
      type: j.type,
      phrase: j.phrase,
      rank: rankOf.get(url) ?? null,
      ageMonths: j.ageMonths,
      words: m?.wordCount ?? 0,
      criteria: j.criteria ?? { answer: null, faq: null, author: null, fresh: null, sources: null, facts: null, compare: null, links: null },
      citability: j.criteria ? citabilityOf(j.criteria) : null,
      elementsToChange: own.filter((e) => e.verdict === 'change').length,
      judgmentStatus: j.status,
    });
  }

  // the writer rewrites what the rules and Jev flagged, for the pages where it matters most
  if (deps.writer.id !== 'rules') {
    emit('elements', 52, 'Езиков модел пише предложения за заглавия и описания…');
    const worth = new Map<string, number>();
    for (const e of elements) if (e.verdict === 'change' && (e.element === 'title' || e.element === 'meta' || e.element === 'h1' || e.element === 'intro')) worth.set(e.url, (worth.get(e.url) ?? 0) + e.impact);
    const top = [...worth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([url]) => url);
    await mapLimit(top, 3, async (url) => {
      const j = judgedByUrl.get(normalizeUrl(url));
      const m = j?.read.extracted?.metrics;
      if (!j || !m) return;
      const wanted = elements.filter((e) => e.url === url && e.verdict === 'change' && (e.element === 'title' || e.element === 'meta' || e.element === 'h1' || e.element === 'intro')).map((e) => ({ element: e.element as 'title' | 'meta' | 'h1' | 'intro', reason: e.reason }));
      if (wanted.length === 0) return;
      const written = await deps.writer
        .proposals({ url, business, market: request.market, brand, phrase: j.phrase, current: { title: m.title ?? '', meta: m.metaDescription ?? '', h1: m.h1[0] ?? '', intro: (j.read.extracted?.text.intro ?? '').slice(0, 400) }, wanted, ...sig })
        .catch(() => ({}));
      for (const e of elements) {
        const text = e.url === url && e.verdict === 'change' ? (written as Record<string, string | undefined>)[e.element] : undefined;
        if (text) {
          e.proposal = text.slice(0, 400);
          e.proposalBy = 'llm';
        }
      }
    });
  } else {
    warnings.push('Няма езиков модел (ключ за Claude, ChatGPT или Gemini) — предложенията и чеклистите са от фиксирани правила, а не написани за конкретната страница.');
  }
  check();

  // ───────────────────────── 5. buyer questions ─────────────────────────
  const questionCount = Math.min(request.options.questions, deps.limits.maxQuestions);
  let questions: BuyerQuestion[] = [];
  const coverageById = new Map<string, CoverageResult>();
  const pagesByUrl = new Map(pages.map((p) => [p.url, p]));
  if (questionCount > 0) {
    emit('questions', 55, 'Измислям въпросите на купувачите…');
    // seed phrases for the questions: short ones (a long H1 makes an awkward question), the most important pages first
    const seeds = [...new Set(byImportance.map((j) => j.phrase as string).filter((ph) => ph.split(/\s+/).length <= 5))].slice(0, 3);
    const raw = await collectQuestions({ business, market: request.market, seeds, count: questionCount, serp: deps.serp, writer: deps.writer, ...sig });
    const screened = await screenQuestions(dedupe(raw), business, request.market, deps.jev, signal);
    const chosen = balance(screened, questionCount);
    check();
    const volumes = await questionVolumes(chosen.map((c) => c.text), request.market, deps.volume, signal);

    emit('questions', 60, 'Проверявам кои въпроси имат страница на сайта…');
    const coveragePages: CoveragePage[] = readable.map((j) => ({
      url: j.read.url,
      answerFirst: j.criteria?.answer ?? null,
      ctx: { url: j.read.url, market: request.market, business, phrase: j.phrase, page: j.read.extracted as NonNullable<typeof j.read.extracted> } satisfies SitePageContext,
    }));
    const inputs = chosen.map((c, i) => ({ id: `q${i + 1}`, text: c.text, stage: c.stage }));
    for (const r of await checkCoverage(inputs, coveragePages, deps.jev, signal)) coverageById.set(r.id, r);
    questions = chosen.map((c, i) => {
      const cov = coverageById.get(`q${i + 1}`) as CoverageResult;
      return {
        id: `q${i + 1}`,
        text: c.text,
        stage: c.stage,
        source: c.source,
        volume: volumes.get(c.text.trim().toLowerCase()) ?? null,
        bestPage: cov.bestPage,
        match: cov.match === null ? null : r3(cov.match),
        verdict: cov.verdict,
        nextStep: cov.nextStep,
        aiCites: [],
        citedBy: [],
      };
    });
    if (questions.length < questionCount) warnings.push(`Събрах само ${questions.length} подходящи въпроса от поисканите ${questionCount}.`);
    if ([...coverageById.values()].some((c) => !c.judged)) warnings.push('За част от въпросите Jev не отговори: вердиктът „слаб отговор“ се базира само на съвпадение на думи.');
  }
  check();

  // ───────────────────────── 6. what the AI assistants say ─────────────────────────
  const wanted = request.options.engines;
  const engines = wanted.length > 0 ? deps.engines.filter((e) => wanted.includes(e.id)) : [...deps.engines];
  let records: AnswerRecord[] = [];
  let engineRuns: EngineRun[] = [];
  const matcher = brandMatcher({
    domain: ownDomain,
    brandNames: request.brandNames,
    competitors: [...new Set([...tracked, ...[...serpByPhrase.values()].flatMap((s) => s.results.map((r) => r.domain))])].map((d) => ({ domain: d, names: deps.brandHints?.[d] ?? [] })),
  });
  let raws: RawAnswer[] = [];
  let geoStopped = new Map<EngineId, string>();
  if (engines.length > 0 && questions.length > 0) {
    emit('geo', 63, `Питам ${engines.map((e) => ENGINE_LABELS[e.id]).join(', ')} (${questions.length} въпроса)…`);
    const result = await runEngines({
      engines,
      questions: questions.map((q) => ({ id: q.id, text: q.text })),
      market: request.market,
      maxCalls: deps.limits.maxEngineCalls,
      ...sig,
      onAnswer: (done, total) => emit('geo', 63 + Math.round((17 * done) / Math.max(1, total)), `Отговори от ИИ: ${done} от ${total}`),
    });
    raws = result.answers;
    geoStopped = result.stopped;
    if (result.skipped > 0) warnings.push(`Лимитът на заявките към ИИ (MAX_GEO_CALLS_PER_RUN) стигна само за част от въпросите; ${bgCount(result.skipped, 'заявка не е изпратена', 'заявки не са изпратени')}.`);
    for (const [id, why] of result.stopped) warnings.push(`${ENGINE_LABELS[id]} беше спрян: ${why}`);

    emit('geo', 80, 'Чета как ИИ говори за марката…');
    const questionText = new Map(questions.map((q) => [q.id, q.text]));
    records = await mapLimit(raws, 6, async (raw) => {
      if (!raw.answer) return toRecord(raw, null, null);
      const analysed = analyseAnswer(raw.answer, matcher);
      const sentiment = analysed.status === 'missing' ? null : await readSentiment(deps.jev, brand, questionText.get(raw.questionId) ?? '', raw.answer.text, signal);
      return toRecord(raw, analysed, sentiment);
    });
    engineRuns = engines.map((e) => summarizeEngine(e, records, raws, ownDomain));
    for (const q of questions) {
      const mine = records.filter((r) => r.questionId === q.id && r.status !== 'failed');
      const counts = new Map<string, number>();
      for (const r of mine) for (const d of new Set(r.citations.map((c) => c.domain))) if (d !== ownDomain) counts.set(d, (counts.get(d) ?? 0) + 1);
      q.aiCites = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([d]) => d);
      q.citedBy = [...new Set(mine.filter((r) => r.status !== 'missing').map((r) => r.engine))];
    }
  } else if (questions.length > 0) {
    warnings.push('ИИ двигателите не са питани: няма настроен ключ за ChatGPT, Claude или Gemini (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY).');
  }
  check();

  // ───────────────────────── 7. competitor pages worth copying ─────────────────────────
  const competitorPages: CompetitorPage[] = [];
  const competitorBudget = request.options.competitorPages;
  const answeredAll = records.filter((r) => r.status !== 'failed');
  const aiShareOf = (domain: string): number | null => (records.length === 0 || answeredAll.length === 0 ? null : r3(answeredAll.filter((r) => r.citations.some((c) => c.domain === domain)).length / answeredAll.length));
  if (competitorBudget > 0 && deps.serp) {
    emit('competitors', 82, 'Чета страниците на конкурентите, които са в Google за същите фрази…');
    // phrases of the most important pages; fetch the SERP for those not yet looked up
    const phraseTargets: PhraseTarget[] = [];
    const distinctPhrases = new Set<string>();
    const targetsPages = byImportance.filter((j) => (distinctPhrases.has(j.phrase as string) ? false : (distinctPhrases.add(j.phrase as string), true))).slice(0, 6);
    for (const j of targetsPages) {
      const phrase = j.phrase as string;
      let serp = serpByPhrase.get(phrase);
      if (!serp && !serpStopped) {
        try {
          serp = await deps.serp.search({ keyword: phrase, market, depth: 10 }, sig);
          serpByPhrase.set(phrase, serp);
        } catch (err) {
          if (err instanceof SerpError && err.fatal) serpStopped = true;
          else if (!(err instanceof SerpError)) throw err;
        }
      }
      if (serp) phraseTargets.push({ phrase, ourUrl: j.read.url, serp });
    }
    const selected = selectCompetitorPages(phraseTargets, ownDomain, tracked, competitorBudget);
    const read = await readCompetitorPages(selected, readDeps, judgeDeps);
    for (const c of read) {
      judgedByUrl.set(normalizeUrl(c.selection.result.url), c.judged);
      judgedByUrl.set(normalizeUrl(c.judged.read.url), c.judged);
      const ours = c.selection.ourUrl ? judgedByUrl.get(normalizeUrl(c.selection.ourUrl)) ?? null : null;
      competitorPages.push(toCompetitorPage(c, ours, aiShareOf(c.selection.result.domain)));
    }
    emit('competitors', 88, `Прочетени конкурентни страници: ${read.length}`);
    competitorPages.sort((a, b) => Number(b.verdict === 'steal') - Number(a.verdict === 'steal') || (b.overall ?? 0) - (a.overall ?? 0));
  }
  check();

  // ───────────────────────── 8. why we lose, and what to do ─────────────────────────
  emit('fixes', 90, 'Разбирам защо ИИ ни пропуска и какво да се направи…');
  const skips: SkipAnalysis[] = [];
  const winners: WinnerPage[] = [];
  let plan: SiteAuditReport['plan'] = [];
  if (records.length > 0) {
    const lost = records.filter((r) => r.status === 'missing');

    // read the pages the assistants cite instead of us (the most cited ones, per engine)
    const wantedWinners = new Map<string, { engine: EngineId; url: string; domain: string; title: string; n: number }>();
    for (const e of engines) {
      const counts = new Map<string, { url: string; domain: string; title: string; n: number }>();
      for (const r of lost.filter((x) => x.engine === e.id)) {
        for (const c of r.citations.filter((x) => x.domain !== ownDomain)) {
          const key = normalizeUrl(c.url);
          const have = counts.get(key);
          counts.set(key, have ? { ...have, n: have.n + 1 } : { url: c.url, domain: c.domain, title: c.title, n: 1 });
        }
      }
      for (const w of [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 3)) wantedWinners.set(`${e.id}|${normalizeUrl(w.url)}`, { engine: e.id, ...w });
    }
    const toRead = [...wantedWinners.values()].sort((a, b) => b.n - a.n).slice(0, 10);
    await mapLimit(toRead, 3, async (w) => {
      if (judgedByUrl.has(normalizeUrl(w.url))) return;
      const j = await judgeSitePage(await readPage(w.url, readDeps), { ...judgeDeps, withElements: false });
      judgedByUrl.set(normalizeUrl(w.url), j);
      judgedByUrl.set(normalizeUrl(j.read.url), j);
    });
    for (const w of toRead) winners.push(winnerPageOf({ engine: w.engine, domain: w.domain, url: w.url, title: w.title, citedIn: w.n, judged: judgedByUrl.get(normalizeUrl(w.url)) ?? null }));

    const questionById = new Map(questions.map((q) => [q.id, q]));
    for (const r of lost.slice(0, 150)) {
      const q = questionById.get(r.questionId);
      if (!q) continue;
      const cov = coverageById.get(q.id);
      const ownPage = cov && cov.verdict !== 'no_page' && cov.bestPage ? pagesByUrl.get(cov.bestPage) ?? null : null;
      const cited = r.citations.find((c) => c.domain !== ownDomain) ?? null;
      const winnerJudged = cited ? judgedByUrl.get(normalizeUrl(cited.url)) ?? null : null;
      const reasons = skipReasons({
        own: ownPage ? { url: ownPage.url, words: ownPage.words, ageMonths: ownPage.ageMonths, criteria: ownPage.criteria } : null,
        winner: winnerJudged ? { words: winnerJudged.read.extracted?.metrics.wordCount ?? null, criteria: winnerJudged.criteria } : null,
        match: cov?.match ?? null,
        angleFits: cov?.angleFits ?? null,
      });
      skips.push({
        engine: r.engine,
        questionId: q.id,
        question: q.text,
        ourPage: { url: ownPage?.url ?? null, exists: ownPage !== null, words: ownPage?.words ?? null, ageMonths: ownPage?.ageMonths ?? null, detail: ownPage ? detailOf(ownPage.criteria) : null },
        winner: cited ? { domain: cited.domain, url: cited.url, kind: sourceKindOf({ domain: cited.domain, type: winnerJudged?.type ?? null, criteria: winnerJudged?.criteria ?? null }) } : null,
        reasons,
        action: actionFor(reasons, cov?.match ?? null),
      });
    }
    emit('fixes', 93, 'Подготвям плана и чеклистите…');
    plan = await buildPlan({ business, market: request.market, skips, pages, winners, writer: deps.writer, ...sig });
  } else if (questions.length > 0) {
    // no AI answers: the plan still covers the questions the site does not answer
    const weak = questions.filter((q) => q.verdict !== 'answered');
    if (weak.length > 0) {
      const asSkips: SkipAnalysis[] = weak.map((q) => {
        const ownPage = q.bestPage ? pagesByUrl.get(q.bestPage) ?? null : null;
        const cov = coverageById.get(q.id);
        const reasons = skipReasons({ own: ownPage ? { url: ownPage.url, words: ownPage.words, ageMonths: ownPage.ageMonths, criteria: ownPage.criteria } : null, winner: null, match: cov?.match ?? null, angleFits: cov?.angleFits ?? null });
        return { engine: 'openai' as const, questionId: q.id, question: q.text, ourPage: { url: ownPage?.url ?? null, exists: ownPage !== null, words: ownPage?.words ?? null, ageMonths: ownPage?.ageMonths ?? null, detail: ownPage ? detailOf(ownPage.criteria) : null }, winner: null, reasons, action: actionFor(reasons, cov?.match ?? null) };
      });
      plan = (await buildPlan({ business, market: request.market, skips: asSkips, pages, winners: [], writer: deps.writer, ...sig })).map((p) => ({ ...p, engines: [] }));
    }
  }

  // ───────────────────────── 9. assemble ─────────────────────────
  emit('save', 96, 'Подготвям отчета…');
  const failedPages = pages.filter((p) => p.fetch.status !== 'ok').length;
  const blockedPages = pages.filter((p) => p.fetch.status === 'blocked_robots').length;
  if (blockedPages > 0) warnings.push(`${bgCount(blockedPages, 'страница е защитена', 'страници са защитени')} от robots.txt на сайта и не са прочетени.`);
  if (failedPages - blockedPages > 0) warnings.push(`${bgCount(failedPages - blockedPages, 'страница не се отвори', 'страници не се отвориха')} (грешка, изтекло време или не е HTML).`);
  const partialJudgments = pages.filter((p) => p.judgmentStatus !== 'complete' && p.fetch.status === 'ok').length;
  if (partialJudgments > 0) warnings.push(`За ${bgCount(partialJudgments, 'страница', 'страници')} Jev не върна всички оценки; показателите, които зависят от тях, липсват.`);
  if (request.market === 'bg') warnings.push('Jev е най-точен на английски; при български текст оценките за заглавия, въведения и цитируемост са по-малко сигурни — гледай индикаторите за сигурност.');

  const jevAfter = deps.jev.stats();
  const answered = records.filter((r) => r.status !== 'failed');
  const withCit = pages.filter((p) => p.citability);
  const costs = engineRuns.map((e) => e.usage.estimatedCostUsd);
  const figures = {
    elementsToChange: elements.filter((e) => e.verdict === 'change').length,
    elementsTotal: elements.length,
    pagesToSteal: competitorPages.filter((c) => c.verdict === 'steal').length,
    competitorPagesTotal: competitorPages.length,
    questionsNoPage: questions.filter((q) => q.verdict === 'no_page').length,
    questionsTotal: questions.length,
    citabilityNow: withCit.length > 0 ? r3(withCit.reduce((s, p) => s + (p.citability?.now ?? 0), 0) / withCit.length) : null,
    citabilityAfter: withCit.length > 0 ? r3(withCit.reduce((s, p) => s + (p.citability?.after ?? 0), 0) / withCit.length) : null,
    citationRate: engineRuns.length > 0 && answered.length > 0 ? r3(engineRuns.reduce((s, e) => s + e.rate, 0) / engineRuns.length) : null,
  };

  const report: SiteAuditReport = {
    version: 1,
    id: input.id,
    kind: 'site',
    status: jevAfter.failures - jevBefore.failures > 0 || geoStopped.size > 0 || serpStopped ? 'partial' : 'complete',
    mode: deps.info.mode,
    createdAt: now.toISOString(),
    finishedAt: (deps.now?.() ?? new Date()).toISOString(),
    request,
    providers: {
      serp: deps.info.serp,
      jev: deps.info.jev,
      engines: engines.map((e) => ({ engine: e.id, model: e.model, search: engineRuns.find((r) => r.engine === e.id)?.search ?? true })),
      writer: deps.writer.id === 'rules' ? null : `${ENGINE_LABELS[deps.writer.id]} (${deps.writer.model ?? '—'})`,
    },
    usage: {
      jevRequests: jevAfter.requests - jevBefore.requests,
      jevInputTokens: jevAfter.inputTokens - jevBefore.inputTokens,
      jevOutputTokens: jevAfter.outputTokens - jevBefore.outputTokens,
      jevFailures: jevAfter.failures - jevBefore.failures,
      estimatedJevCostUsd: Math.round((jevAfter.estimatedCostUsd - jevBefore.estimatedCostUsd) * 1_000_000) / 1_000_000,
      serpCalls: deps.meter.serpCalls,
      pagesFetched: deps.meter.pagesFetched + deps.meter.pageCacheHits,
      pagesFailed: deps.meter.pagesFailed + deps.meter.pagesBlocked,
      engineCalls: raws.length,
      estimatedEngineCostUsd: engineRuns.length > 0 && costs.every((c): c is number => c !== null) ? Math.round(costs.reduce((a, b) => a + b, 0) * 10_000) / 10_000 : null,
      writerCalls: deps.writer.calls(),
      durationMs: Date.now() - startedAt,
    },
    site: { domain: ownDomain, pagesFound: discovery.found, pagesAudited: pages.length, source: discovery.source, truncated: discovery.truncated },
    pages,
    elements: elements.sort((a, b) => b.impact - a.impact || b.confidence - a.confidence),
    competitorPages,
    questions,
    geo: engineRuns.length > 0 ? { engines: engineRuns, answers: records, skips, winners } : null,
    plan,
    figures,
    warnings,
  };

  const parsed = SiteAuditReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new PipelineError(`Вътрешна грешка: отчетът не отговаря на схемата (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}).`, 'internal', { cause: parsed.error });
  }
  return parsed.data;
}
