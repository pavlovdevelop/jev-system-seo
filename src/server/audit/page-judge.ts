import type { Question, Questions } from '@typesafe-ai/sdk';
import type { CriteriaScores } from '../../shared/audit';
import type { PageType } from '../../shared/domain';
import type { MarketId } from '../../shared/markets';
import type { FetchInfo, PageJudgments, PageMetrics } from '../../shared/schemas';
import { judgePage, type JudgmentStatus } from '../analysis/judge';
import type { PageExtractor } from '../crawl/extract-pool';
import type { PageFetcher } from '../crawl/fetcher';
import { toFetchInfo } from '../pipeline/crawl';
import type { Answers, Jev } from '../jev/client';
import type { ExtractedPage, PageContext } from '../jev/questions';
import type { Meter } from '../util/meter';
import { ageMonthsOf, criteriaScores } from './criteria';
import {
  citabilityQuestions,
  citabilityState,
  elementQuestions,
  elementState,
  faqQuestionSet,
  faqQuestionsOf,
  type SitePageContext,
} from './questions';

// Reading and judging one page — ours, a competitor's, or one an AI assistant cites. The same steps for all of them,
// so the numbers are comparable: fetch, extract, Jev's page slices, the SEO-element slice and the citability slice.

export type ElementAnswers = Partial<Answers<typeof elementQuestions>>;
export type FaqAnswers = Partial<Answers<typeof faqQuestionSet>>;
export type CitabilityAnswers = Partial<Answers<typeof citabilityQuestions>>;

export interface ReadPage {
  url: string;
  fetch: FetchInfo;
  extracted: ExtractedPage | null;
}

export interface ReadDeps {
  fetcher: PageFetcher;
  extractor: PageExtractor;
  meter: Meter;
  now: Date;
  signal?: AbortSignal;
}

/** Fetches a page and extracts its facts. A page that cannot be read is returned with its fetch status, never thrown. */
export async function readPage(url: string, deps: ReadDeps): Promise<ReadPage> {
  deps.signal?.throwIfAborted();
  const fetched = await deps.fetcher.fetchPage(url, deps.signal ? { signal: deps.signal } : undefined);
  if (fetched.fromCache) deps.meter.pageCacheHits++;
  else if (fetched.status === 'ok') deps.meter.pagesFetched++;
  else if (fetched.status === 'blocked_robots') deps.meter.pagesBlocked++;
  else deps.meter.pagesFailed++;
  const finalUrl = fetched.finalUrl ?? url;
  let fetch = toFetchInfo(fetched);
  let extracted: ExtractedPage | null = null;
  if (fetched.status === 'ok' && fetched.html) {
    try {
      extracted = await deps.extractor.extract(fetched.html, { url: finalUrl, keyword: '', now: deps.now });
    } catch (err) {
      fetch = { ...fetch, status: 'error', error: `Грешка при разбор на HTML: ${err instanceof Error ? err.message.slice(0, 120) : 'неизвестна'}` };
    }
  }
  return { url: finalUrl, fetch, extracted };
}

/** What a page is about: its H1, else its title without the site name — lower-cased, short enough to search for. */
export function phraseOf(m: PageMetrics): string | null {
  const h1 = (m.h1[0] ?? '').replace(/\s+/g, ' ').trim();
  const fromTitle = (m.title ?? '').split(/\s+[|–—·•-]\s+|\s*[|–—·•]\s*/)[0]?.trim() ?? '';
  const pick = [h1, fromTitle].find((c) => c.length >= 4 && c.length <= 90 && c.split(/\s+/).length <= 12) ?? '';
  return pick ? pick.toLowerCase() : null;
}

export interface JudgedPage {
  read: ReadPage;
  type: PageType | null;
  phrase: string | null;
  judgments: PageJudgments;
  status: JudgmentStatus;
  element: ElementAnswers | null;
  faq: FaqAnswers | null;
  citability: CitabilityAnswers | null;
  criteria: CriteriaScores | null;
  ageMonths: number | null;
}

export interface JudgeDeps {
  jev: Jev;
  now: Date;
  market: MarketId;
  business: string;
  /** SEO-element answers are only needed for the site's own pages. */
  withElements: boolean;
  signal?: AbortSignal;
}

/** The SEO-element questions that apply to this page: a missing title or meta description is a rule, not a question. */
export function elementQuestionSetFor(m: PageMetrics, intro: string, hasFaqQuestions: boolean): Questions {
  const q: Record<string, Question> = {};
  if (m.title) {
    q.title_clear = elementQuestions.title_clear;
    q.title_specific = elementQuestions.title_specific;
  }
  if (m.metaDescription) q.meta_inviting = elementQuestions.meta_inviting;
  if (m.h1.length > 0) q.h1_matches = elementQuestions.h1_matches;
  if (intro.trim().length >= 60) q.intro_direct = elementQuestions.intro_direct;
  if (m.wordCount >= 300 && m.h2Count > 0) q.outline_logical = elementQuestions.outline_logical;
  if (hasFaqQuestions) q.faq_useful = faqQuestionSet.faq_useful;
  return q as Questions;
}

export async function judgeSitePage(read: ReadPage, deps: JudgeDeps): Promise<JudgedPage> {
  const empty: JudgedPage = { read, type: null, phrase: null, judgments: {}, status: 'none', element: null, faq: null, citability: null, criteria: null, ageMonths: null };
  const page = read.extracted;
  if (!page) return empty;
  const m = page.metrics;
  const phrase = phraseOf(m);
  const ctx: SitePageContext = { url: read.url, market: deps.market, business: deps.business, phrase, page };

  let domain = '';
  try {
    domain = new URL(read.url).hostname;
  } catch {
    // keep the empty domain
  }
  const pageCtx: PageContext = { keyword: phrase ?? m.title ?? '', market: deps.market, url: read.url, domain, serpTitle: m.title ?? '', serpSnippet: m.metaDescription ?? '', page };
  const signal = deps.signal ? { signal: deps.signal } : {};

  const faqQs = deps.withElements ? faqQuestionsOf(page) : [];
  const [judged, elementRaw, citability] = await Promise.all([
    judgePage(deps.jev, pageCtx),
    deps.withElements ? deps.jev.tryAsk(elementState(ctx), elementQuestionSetFor(m, page.text.intro, faqQs.length >= 2), signal) : Promise.resolve(null),
    deps.jev.tryAsk(citabilityState(ctx), citabilityQuestions, signal),
  ]);

  const el = elementRaw as (ElementAnswers & FaqAnswers) | null;
  const element: ElementAnswers | null = el ? { ...el } : null;
  const faq: FaqAnswers | null = el?.faq_useful ? { faq_useful: el.faq_useful } : null;
  if (element) delete (element as Record<string, unknown>).faq_useful;
  const criteria = criteriaScores({ extracted: page, now: deps.now, judgments: judged.judgments, citability });

  return {
    read,
    type: (judged.judgments.pageType?.value as PageType | undefined) ?? null,
    phrase,
    judgments: judged.judgments,
    status: judged.status,
    element,
    faq,
    citability,
    criteria,
    ageMonths: ageMonthsOf(m, deps.now),
  };
}
