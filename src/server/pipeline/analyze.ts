import { MARKETS } from '../../shared/markets';
import {
  ReportSchema,
  type AnalyzeRequest,
  type FetchInfo,
  type Opportunity,
  type PageAnalysis,
  type PageJudgments,
  type PipelineStep,
  type Report,
  type SerpData,
  type SerpResultStrength,
} from '../../shared/schemas';
import { assessSerp, type ResultSignal } from '../analysis/assessment';
import { buildBrief } from '../analysis/brief';
import { generateCandidates, pickForSerp, type Screened } from '../analysis/candidates';
import { buildCompetitorProfiles, type SerpObservation } from '../analysis/competitors';
import { judgeKeyword, judgePage, judgeShallowResult, type JudgmentStatus } from '../analysis/judge';
import { rankOpportunities, scoreOpportunity } from '../analysis/opportunities';
import { compositeScores, median, percentile } from '../analysis/scoring';
import { pageSignals, type PeerStats } from '../analysis/signals';
import type { PageFetcher } from '../crawl/fetcher';
import { JevError, type Jev } from '../jev/client';
import type { ExtractedPage, PageContext } from '../jev/questions';
import { coverage } from '../nlp/bg';
import { domainOf, SerpError, type KeywordVolume, type SerpProvider, type VolumeProvider } from '../providers/serp/types';
import { mapLimit } from '../util/limit';
import type { Meter } from '../util/meter';
import { crawlTargets } from './crawl';
import { voteIntent } from './intent';
import { selectTargets, type Target } from './targets';

export interface PipelineDeps {
  jev: Jev;
  /** null = manual mode: only the URLs the user supplied are analysed. */
  serp: SerpProvider | null;
  volume: VolumeProvider | null;
  fetcher: PageFetcher;
  meter: Meter;
  limits: { maxPagesPerRun: number; maxCandidates: number };
  info: { mode: 'live' | 'demo'; serp: string; volume: string | null; jev: { model: string; endpoint: string } };
  now?: () => Date;
}

export type Emit = (step: PipelineStep, pct: number, message: string) => void;

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly code: 'input' | 'serp' | 'jev' | 'aborted' | 'internal',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PipelineError';
  }
}

const TOP5 = 5;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function manualSerp(keyword: string, marketId: AnalyzeRequest['market'], urls: readonly string[], now: Date): SerpData {
  return {
    keyword,
    market: marketId,
    fetchedAt: now.toISOString(),
    provider: 'manual',
    results: urls.map((url, i) => ({ position: i + 1, url, domain: domainOf(url), title: '', snippet: '' })),
    peopleAlsoAsk: [],
    relatedSearches: [],
    suggestions: [],
  };
}

function toInfo(c: { fetch: FetchInfo }): FetchInfo {
  return c.fetch;
}

/** Converts failures of the underlying services into messages a person can act on. */
function wrap(err: unknown): never {
  if (err instanceof PipelineError) throw err;
  if (err instanceof JevError) {
    throw new PipelineError(err.kind === 'auth' ? err.message : `Jev: ${err.message}`, err.kind === 'aborted' ? 'aborted' : 'jev', { cause: err });
  }
  if (err instanceof SerpError) throw new PipelineError(err.message, 'serp', { cause: err });
  if (err instanceof DOMException && err.name === 'AbortError') throw new PipelineError('Анализът е прекратен.', 'aborted', { cause: err });
  throw err;
}

export async function runAnalysis(
  input: { id: string; request: AnalyzeRequest; tracked: readonly string[] },
  deps: PipelineDeps,
  emit: Emit,
  signal?: AbortSignal,
): Promise<Report> {
  try {
    return await run(input, deps, emit, signal);
  } catch (err) {
    return wrap(err);
  }
}

async function run(
  input: { id: string; request: AnalyzeRequest; tracked: readonly string[] },
  deps: PipelineDeps,
  emit: Emit,
  signal?: AbortSignal,
): Promise<Report> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const { request } = input;
  const market = MARKETS[request.market];
  const keyword = request.keyword.replace(/\s+/g, ' ').trim();
  const business = request.businessDescription;
  const warnings: string[] = [];
  const jevBefore = deps.jev.stats();
  const check = (): void => signal?.throwIfAborted();
  const callOpts = signal ? { signal } : undefined;

  const registrable = (d: string): string => domainOf(`https://${d}`);
  const ownDomain = request.ownDomain ? registrable(request.ownDomain) : null;
  const tracked = new Set([...input.tracked, ...request.competitors].map(registrable).filter((d) => d && d !== ownDomain));

  // ───────────────────────── 1. the seed SERP ─────────────────────────
  emit('serp', 3, 'Извличам водещите резултати в Google…');
  let serp: SerpData;
  if (deps.serp) {
    serp = await deps.serp.search({ keyword, market, depth: request.options.serpDepth }, callOpts);
    if (request.options.expandKeywords && deps.serp.suggest) {
      const suggestions = await deps.serp.suggest(keyword, market, callOpts).catch((err: unknown) => {
        if (err instanceof SerpError && err.fatal) throw err;
        return [] as string[];
      });
      serp = { ...serp, suggestions };
    }
    if (serp.results.length === 0 && request.manualUrls.length === 0) {
      throw new PipelineError('Google не върна резултати за тази фраза. Опитай с друга формулировка.', 'input');
    }
  } else {
    if (request.manualUrls.length === 0) {
      throw new PipelineError('Няма настроен SERP доставчик. Добави SERPER_API_KEY (или DataForSEO достъп) в .env или въведи URL адреси на конкуренти ръчно.', 'input');
    }
    serp = manualSerp(keyword, request.market, request.manualUrls, now);
    warnings.push('Няма настроен SERP доставчик — анализирани са само въведените от теб URL адреси. Класирането на фрази и конкурентната видимост не са изчислени.');
  }
  check();

  const ownRankHit = ownDomain ? serp.results.find((r) => r.domain === ownDomain) : undefined;
  const manualMode = deps.serp === null;

  // ───────────────────────── 2. choose and crawl pages ─────────────────────────
  const targets: Target[] = selectTargets({
    results: serp.results,
    deepPages: Math.min(request.options.deepPages, deps.limits.maxPagesPerRun),
    ownDomain,
    ownUrl: request.ownUrl,
    tracked,
    manualUrls: manualMode ? [] : request.manualUrls,
    maxPages: deps.limits.maxPagesPerRun,
  }).map((t) => (manualMode && t.role === 'serp' ? { ...t, role: 'manual' as const } : t));

  emit('crawl', 8, `Изтеглям ${targets.length} страници на конкурентите…`);
  const crawled = await crawlTargets(targets, {
    keyword,
    fetcher: deps.fetcher,
    meter: deps.meter,
    now,
    ...(signal ? { signal } : {}),
    onProgress: (done, total) => emit('crawl', 8 + Math.round((27 * done) / total), `Изтеглени страници: ${done} от ${total}`),
  });
  check();

  // ───────────────────────── 3. Jev judges every page ─────────────────────────
  emit('judge', 36, 'Jev оценява страниците (тип, намерение, дълбочина, доверие)…');
  let judgedCount = 0;
  const drafts = await Promise.all(
    crawled.map(async (c) => {
      const ctx: PageContext = {
        keyword,
        market: request.market,
        url: c.url,
        domain: c.target.domain,
        serpTitle: c.target.title,
        serpSnippet: c.target.snippet,
        page: c.extracted,
      };
      const { judgments, status } = await judgePage(deps.jev, ctx);
      emit('judge', 36 + Math.round((20 * ++judgedCount) / crawled.length), `Jev оценени страници: ${judgedCount} от ${crawled.length}`);
      return { c, judgments, status };
    }),
  );
  check();

  const seedKeywordJudgment = await judgeKeyword(deps.jev, keyword, business, request.market);

  // Draft analyses (without composites) so the SERP can vote on what it is.
  type Draft = (typeof drafts)[number];
  const draftPage = (d: Draft, composite: PageAnalysis['composite'], signals: PageAnalysis['signals']): PageAnalysis => ({
    position: d.c.target.position,
    url: d.c.target.url,
    domain: d.c.target.domain,
    title: d.c.target.title || d.c.extracted?.metrics.title || '',
    snippet: d.c.target.snippet,
    role: d.c.target.role,
    fetch: toInfo(d.c),
    metrics: d.c.extracted?.metrics ?? null,
    judgments: d.judgments,
    judgmentStatus: d.status satisfies JudgmentStatus,
    composite,
    signals,
  });
  const empty: PageAnalysis['composite'] = { content: null, optimization: null, trust: null, conversion: null, overall: null };
  const peerDrafts = drafts.filter((d) => d.c.target.role !== 'own').map((d) => draftPage(d, empty, []));
  const vote = voteIntent(peerDrafts);

  const peerWords = peerDrafts.map((p) => p.metrics?.wordCount ?? 0).filter((w) => w >= 100);
  const medianWords = peerWords.length >= 3 ? median(peerWords) : null;
  const fetchedPeers = peerDrafts.filter((p) => p.metrics);
  const peers: PeerStats = {
    pages: fetchedPeers.length,
    medianWords,
    faqShare: fetchedPeers.length > 0 ? fetchedPeers.filter((p) => p.metrics!.hasFaqSection || p.metrics!.hasFaqSchema).length / fetchedPeers.length : 0,
    dominantIntent: vote.dominantIntent,
    dominantPageType: vote.dominantPageType,
  };

  const analyses: PageAnalysis[] = drafts.map((d) => {
    const composite = compositeScores({ metrics: d.c.extracted?.metrics ?? null, judgments: d.judgments }, medianWords ? { targetWords: medianWords } : {});
    const base = draftPage(d, composite, []);
    return { ...base, signals: pageSignals({ metrics: base.metrics, judgments: base.judgments, fetch: base.fetch, composite }, peers, now) };
  });
  const extractedByUrl = new Map<string, ExtractedPage>();
  drafts.forEach((d, i) => {
    if (d.c.extracted) extractedByUrl.set((analyses[i] as PageAnalysis).url, d.c.extracted);
  });
  const ownAnalysis = analyses.find((a) => a.role === 'own') ?? null;
  const ownExtracted = ownAnalysis ? extractedByUrl.get(ownAnalysis.url) : undefined;
  const seedPages = analyses.filter((a) => !(a.role === 'own' && a.position === null));

  // ───────────────────────── 4. keyword ideas ─────────────────────────
  const competitorTexts = analyses
    .filter((a) => a.role !== 'own' && a.metrics && extractedByUrl.has(a.url))
    .map((a) => ({ title: a.metrics!.title ?? a.title, headings: a.metrics!.headings, text: extractedByUrl.get(a.url)!.text.full }));

  let screened: Screened[] = [];
  let picked: Screened[] = [];
  const maxPick = Math.min(request.options.maxCandidates, deps.limits.maxCandidates);
  if (request.options.expandKeywords && maxPick > 0) {
    emit('expand', 58, 'Търся свързани фрази и ги проверявам с Jev…');
    const raw = generateCandidates({ seed: keyword, market: request.market, serp, competitors: competitorTexts, maxRaw: 80 });
    const results = await Promise.all(
      raw.map(async (candidate) => {
        const judgment = await judgeKeyword(deps.jev, candidate.keyword, business, request.market);
        return judgment ? ({ candidate, judgment } satisfies Screened) : null;
      }),
    );
    screened = results.filter((r): r is Screened => r !== null);
    const budgetLeft = Math.max(0, deps.meter.limits.maxSerpCalls - deps.meter.serpCalls);
    picked = pickForSerp(screened, deps.serp ? Math.min(maxPick, budgetLeft) : maxPick);
    if (deps.serp && picked.length < Math.min(maxPick, screened.filter((s) => s.judgment.relevance >= 0.5).length)) {
      warnings.push(`Лимитът от ${deps.meter.limits.maxSerpCalls} SERP заявки ограничи броя на проверените фрази до ${picked.length}.`);
    }
  }
  check();

  // ───────────────────────── 5. SERPs of the candidates (+ shallow Jev judgments) ─────────────────────────
  interface CandidateObservation {
    screened: Screened;
    serp: SerpData;
    signals: ResultSignal[];
  }
  const slots: Array<CandidateObservation | null> = picked.map(() => null);
  let serpStopped = false;
  let serpFailures = 0;
  if (deps.serp && picked.length > 0) {
    emit('candidates', 62, `Проверявам конкуренцията за ${picked.length} фрази…`);
    let done = 0;
    const provider = deps.serp;
    await mapLimit(picked, 4, async (s, i) => {
      if (serpStopped) return;
      check();
      try {
        const res = await provider.search({ keyword: s.candidate.keyword, market, depth: 10 }, callOpts);
        const signals = await Promise.all(
          res.results.slice(0, 10).map(async (r): Promise<ResultSignal> => {
            const j = await judgeShallowResult(deps.jev, s.candidate.keyword, r);
            return { position: r.position, domain: r.domain, url: r.url, title: r.title, pageType: j?.pageType ?? null, targetsQuery: j?.targetsQuery ?? null, titleMatch: coverage(s.candidate.keyword, r.title), depth: null };
          }),
        );
        slots[i] = { screened: s, serp: res, signals };
      } catch (err) {
        if (!(err instanceof SerpError)) throw err;
        if (err.fatal) {
          if (!serpStopped) warnings.push(`SERP заявките бяха прекратени: ${err.message}`);
          serpStopped = true;
        } else serpFailures++;
      }
      emit('candidates', 62 + Math.round((23 * ++done) / picked.length), `Проверени фрази: ${done} от ${picked.length}`);
    });
    if (serpFailures > 0) warnings.push(`За ${serpFailures} фрази SERP заявката не успя и те са пропуснати.`);
  }
  const observed = slots.filter((s): s is CandidateObservation => s !== null);
  check();

  // ───────────────────────── 6. search volumes (optional) ─────────────────────────
  let volumes = new Map<string, KeywordVolume>();
  if (deps.volume) {
    emit('volumes', 86, 'Извличам месечните търсения…');
    const wanted = [keyword, ...(deps.serp ? observed.map((o) => o.screened.candidate.keyword) : picked.map((p) => p.candidate.keyword))];
    try {
      volumes = await deps.volume.volumes(wanted, market, callOpts);
    } catch (err) {
      if (err instanceof SerpError && err.fatal && err.kind === 'auth') warnings.push(`Обемът на търсенията не е наличен: ${err.message}`);
      else if (err instanceof SerpError) warnings.push(`Обемът на търсенията не е наличен: ${err.message}`);
      else throw err;
    }
  } else if (picked.length > 0 || deps.serp) {
    warnings.push('Няма настроен източник на месечни търсения (DataForSEO) — „Търсения/мес“ не се показват и не участват в оценката.');
  }
  const volumeOf = (kw: string): KeywordVolume | null => volumes.get(kw.trim().toLowerCase()) ?? null;

  // ───────────────────────── 7. assessment, opportunities, competitors ─────────────────────────
  emit('score', 90, 'Изчислявам възможностите и профилите на конкурентите…');

  // Topical dominance: domains that keep showing up in the top 5 across the whole cluster of related queries.
  const top5Lists: string[][] = [
    serp.results.filter((r) => r.position <= TOP5).map((r) => r.domain),
    ...observed.map((o) => o.serp.results.filter((r) => r.position <= TOP5).map((r) => r.domain)),
  ];
  const dominance = new Map<string, number>();
  if (top5Lists.length >= 3) {
    for (const list of top5Lists) for (const d of new Set(list)) dominance.set(d, (dominance.get(d) ?? 0) + 1);
    for (const [d, n] of dominance) dominance.set(d, round3(n / top5Lists.length));
  }

  // The seed SERP: deeply judged pages where we have them, shallow judgments for the rest of the results.
  const pageByUrl = new Map(analyses.map((a) => [a.url, a]));
  const resultLimit = request.options.serpDepth;
  const seedSignals: ResultSignal[] = await Promise.all(
    serp.results.slice(0, resultLimit).map(async (r): Promise<ResultSignal> => {
      const page = pageByUrl.get(r.url);
      if (page && page.judgments.pageType) {
        return {
          position: r.position,
          domain: r.domain,
          url: r.url,
          title: r.title || page.title,
          pageType: page.judgments.pageType,
          targetsQuery: page.judgments.targetsQuery?.p ?? null,
          titleMatch: page.metrics?.keyword.titleCoverage ?? coverage(keyword, r.title),
          depth: page.judgments.topicDepth?.value ?? null,
        };
      }
      const j = manualMode ? null : await judgeShallowResult(deps.jev, keyword, r);
      return { position: r.position, domain: r.domain, url: r.url, title: r.title, pageType: j?.pageType ?? null, targetsQuery: j?.targetsQuery ?? null, titleMatch: coverage(keyword, r.title), depth: null };
    }),
  );
  const seedAssessment = assessSerp(seedSignals, { intent: vote.dominantIntent, dominance });

  const opportunities: Opportunity[] = [];
  opportunities.push(
    scoreOpportunity({
      keyword,
      sources: ['seed'],
      judgment: seedKeywordJudgment ? { ...seedKeywordJudgment, relevance: 1 } : null,
      assessment: seedAssessment,
      volume: volumeOf(keyword),
      ownPosition: ownRankHit?.position ?? null,
      deep: true,
    }),
  );
  const candidateObservations: SerpObservation[] = [];
  for (const o of observed) {
    const assessment = assessSerp(o.signals, { intent: o.screened.judgment.intent.value, dominance });
    const own = ownDomain ? o.serp.results.find((r) => r.domain === ownDomain) : undefined;
    opportunities.push(
      scoreOpportunity({
        keyword: o.screened.candidate.keyword,
        sources: [...o.screened.candidate.sources],
        judgment: o.screened.judgment,
        assessment,
        volume: volumeOf(o.screened.candidate.keyword),
        ownPosition: own?.position ?? null,
        deep: false,
      }),
    );
    if (assessment) candidateObservations.push({ keyword: o.screened.candidate.keyword, deep: false, results: assessment.results });
  }
  if (!deps.serp) {
    // Manual mode: no SERPs exist, so these are relevance-screened ideas only (scores are capped and say so).
    for (const p of picked) {
      opportunities.push(
        scoreOpportunity({ keyword: p.candidate.keyword, sources: [...p.candidate.sources], judgment: p.judgment, assessment: null, volume: volumeOf(p.candidate.keyword), ownPosition: null, deep: false }),
      );
    }
  }
  const ranked = rankOpportunities(opportunities);

  const seedObservation: SerpObservation[] = seedAssessment ? [{ keyword, deep: true, results: seedAssessment.results as SerpResultStrength[] }] : [];
  const competitors = buildCompetitorProfiles({
    observations: [...seedObservation, ...candidateObservations],
    seedPages: analyses,
    ownDomain,
    tracked: [...tracked],
  });

  // ───────────────────────── 8. brief ─────────────────────────
  const briefPages = analyses.filter((a) => a.role !== 'own');
  const brief = buildBrief({
    keyword,
    pages: briefPages,
    extracted: extractedByUrl,
    serp,
    intent: { dominantPageType: vote.dominantPageType, dominantIntent: vote.dominantIntent, dominantShare: vote.dominantShare },
    ownPage: ownAnalysis && ownExtracted ? { analysis: ownAnalysis, extracted: ownExtracted } : null,
  });

  // ───────────────────────── 9. assemble ─────────────────────────
  emit('save', 96, 'Подготвям отчета…');
  const blocked = crawled.filter((c) => c.fetch.status === 'blocked_robots').length;
  const failed = crawled.filter((c) => !['ok', 'blocked_robots'].includes(c.fetch.status)).length;
  if (blocked > 0) warnings.push(`${blocked} страници са защитени от robots.txt и не са изтеглени — оценени са само по заглавие и описание в резултатите.`);
  if (failed > 0) warnings.push(`${failed} страници не успяха да се изтеглят (блокиране на ботове, грешка или изтекло време) — оценени са само по заглавие и описание.`);
  const partialJudgments = analyses.filter((a) => a.judgmentStatus !== 'complete' && a.fetch.status === 'ok').length;
  if (partialJudgments > 0) warnings.push(`За ${partialJudgments} страници Jev не върна всички оценки.`);
  const lowConfidence = analyses.filter((a) => a.judgments.pageType && a.judgments.pageType.confidence < 0.3).length;
  if (lowConfidence > 0 && request.market === 'bg') {
    warnings.push(`Jev е най-точен на английски; при ${lowConfidence} български страници типът е определен с ниска сигурност — виж индикаторите за сигурност.`);
  }

  const jevAfter = deps.jev.stats();
  const usage = {
    serpCalls: deps.meter.serpCalls,
    serpCacheHits: deps.meter.serpCacheHits,
    volumeCalls: deps.meter.volumeCalls,
    jevRequests: jevAfter.requests - jevBefore.requests,
    jevInputTokens: jevAfter.inputTokens - jevBefore.inputTokens,
    jevOutputTokens: jevAfter.outputTokens - jevBefore.outputTokens,
    jevFailures: jevAfter.failures - jevBefore.failures,
    estimatedJevCostUsd: Math.round((jevAfter.estimatedCostUsd - jevBefore.estimatedCostUsd) * 1_000_000) / 1_000_000,
    pagesFetched: deps.meter.pagesFetched + deps.meter.pageCacheHits,
    pagesBlocked: deps.meter.pagesBlocked,
    pagesFailed: deps.meter.pagesFailed,
    durationMs: Date.now() - startedAt,
  };

  const wordsAll = seedPages.map((p) => p.metrics?.wordCount ?? 0).filter((w) => w >= 100);
  const finishedAt = (deps.now?.() ?? new Date()).toISOString();
  const report: Report = {
    version: 1,
    id: input.id,
    status: usage.jevFailures > 0 || serpStopped || partialJudgments > 0 ? 'partial' : 'complete',
    mode: deps.info.mode,
    createdAt: now.toISOString(),
    finishedAt,
    request: { ...request, keyword },
    providers: { serp: deps.info.serp, volume: deps.info.volume, jev: deps.info.jev },
    usage,
    seed: {
      keyword,
      serp,
      pages: seedPages,
      ownPage: ownAnalysis,
      intent: {
        dominantPageType: vote.dominantPageType,
        dominantIntent: vote.dominantIntent,
        pageTypeShare: vote.pageTypeShare,
        intentShare: vote.intentShare,
        keywordIntent: seedKeywordJudgment?.intent ?? null,
        agreement: seedKeywordJudgment && vote.dominantIntent ? seedKeywordJudgment.intent.value === vote.dominantIntent : null,
      },
      assessment: seedAssessment,
      stats: {
        pagesAnalysed: seedPages.length,
        pagesFetched: seedPages.filter((p) => p.metrics).length,
        medianWordCount: wordsAll.length > 0 ? Math.round(median(wordsAll) as number) : null,
        p75WordCount: wordsAll.length > 0 ? Math.round(percentile(wordsAll, 0.75) as number) : null,
      },
      ownRank: ownRankHit ? { position: ownRankHit.position, url: ownRankHit.url } : null,
    },
    opportunities: ranked,
    competitors,
    brief,
    warnings,
  };

  const parsed = ReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new PipelineError(`Вътрешна грешка: отчетът не отговаря на схемата (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}).`, 'internal', { cause: parsed.error });
  }
  return parsed.data;
}
