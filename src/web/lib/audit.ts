import type { EngineId } from '../../shared/domain';
import type { MarketId } from '../../shared/markets';
import {
  CRITERION_LABELS,
  ELEMENT_LABELS,
  NEXT_STEP_LABELS,
  QUESTION_STAGES,
  SEO_ELEMENTS,
  STAGE_LABELS,
  type BuyerQuestion,
  type CompetitorPage,
  type ElementVerdict,
  type FixPlan,
  type QuestionStage,
  type SeoElement,
  type SiteAuditRequestInput,
  type SitePage,
} from '../../shared/audit';
import { parseDomains } from './form';

// Pure helpers of the whole-site audit UI: the estimate, form parsing, filters, sorters and number formatting.
// No DOM and no Preact in here, so all of it is tested without a browser (tests/unit/audit-ui-helpers.test.ts).

// The runtime vocabulary the audit screens render comes through this one line. It currently lives next to the zod
// schemas in shared/audit.ts, which puts zod into the browser bundle; when it moves to a dependency-free module only
// this import changes.
export { CRITERION_LABELS, ELEMENT_LABELS, NEXT_STEP_LABELS, QUESTION_STAGES, SEO_ELEMENTS, STAGE_LABELS };

// ───────────────────────── words ─────────────────────────

export const ELEMENT_VERDICT_TEXT = { keep: 'Запази', change: 'Промени' } as const;
export const COMPETITOR_VERDICT_TEXT = { steal: 'Копирай', skip: 'Пропусни' } as const;
export const QUESTION_VERDICT_TEXT = { no_page: 'Няма страница', weak: 'Слаб отговор', answered: 'Отговорено' } as const;
export const PLAN_KIND_TEXT = { create: 'Нова страница', rewrite: 'Пренапиши' } as const;
export const SITE_SOURCE_TEXT = { sitemap: 'карта на сайта (sitemap)', links: 'връзки от началната страница', single: 'само една страница' } as const;

/** The five competitor scores in the order of panel 02. */
export const COMPETITOR_SCORES = [
  { key: 'answer', label: 'Отговор' },
  { key: 'depth', label: 'Дълбочина' },
  { key: 'proof', label: 'Доказателства' },
  { key: 'schema', label: 'Schema' },
  { key: 'fresh', label: 'Свежест' },
] as const;

/** The five criteria shown as pips in panel 04 (short header, full name from CRITERION_LABELS). */
export const CITABILITY_PIPS = [
  { key: 'answer', label: 'Отговор' },
  { key: 'facts', label: 'Факти' },
  { key: 'sources', label: 'Източници' },
  { key: 'faq', label: 'FAQ' },
  { key: 'fresh', label: 'Свежест' },
] as const;

// ───────────────────────── small helpers ─────────────────────────

/** The noun that goes with a count, without the number ("страница" for 1, "страници" otherwise). */
export const bgNoun = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** How many of `n` pips are filled; null when the value could not be judged. */
export function pipsFilled(value: number | null | undefined, n = 5): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(n, Math.max(0, Math.round(value * n)));
}

/** "https://site.bg/blog/a%20b?x=1" → "/blog/a b?x=1". An address that is not a URL is returned as it is. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const raw = `${u.pathname}${u.search}`;
    let text = raw;
    try {
      text = decodeURIComponent(raw);
    } catch {
      // a malformed escape: keep the encoded form
    }
    return text === '' ? '/' : text;
  } catch {
    return url;
  }
}

/** Seconds, or minutes and seconds once it is longer than a minute and a half. */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${Math.round(s - m * 60)} с`;
}

/** "29–55%" for a 95% interval given as fractions. */
export const intervalText = (low: number, high: number): string => `${Math.round(low * 100)}–${Math.round(high * 100)}%`;

/** Change in percentage points between two 0..1 shares, as it is shown ("+18", "−3", "0"). */
export function pointsGain(now: number, after: number): number {
  return Math.round(after * 100) - Math.round(now * 100);
}
export const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

// ───────────────────────── the estimate before a run ─────────────────────────

export const JEV_TOKENS_PER_REQUEST = 1500;
export const JEV_USD_PER_MILLION_TOKENS = 0.042;
/** Requests that do not depend on the options: the fixed Google lookups of the audit. */
const SERP_BASE_CALLS = 8;

export interface AuditEstimateInput {
  pages: number;
  questions: number;
  competitorPages: number;
  rankChecks: number;
  /** How many AI engines will be asked (0 = none configured or none chosen). */
  engines: number;
  /** The caps the server applies (status.audit): the estimate never promises more than it would do. */
  caps?: { maxPages: number; maxQuestions: number; maxEngineCalls: number };
  /** False without a SERP provider: there are no Google lookups then. */
  serp?: boolean;
}

export interface AuditEstimate {
  pages: number;
  questions: number;
  competitorPages: number;
  /** Pages that are read in all: the site's own and the competitors'. */
  pagesToRead: number;
  /** One question to one engine is one call. */
  engineCalls: number;
  jevRequests: number;
  jevInputTokens: number;
  jevCostUsd: number;
  serpCalls: number;
}

/**
 * Upper bounds taken from how the audit fans out (a ceiling, not a promise): per own page about 6 Jev requests, per
 * question 1 to write it and 3 to match it against the pages, per competitor page 5, plus one per answer to judge how
 * warmly it speaks about the business. Cached answers cost nothing, so the real figure is usually lower.
 */
export function estimateAudit(i: AuditEstimateInput): AuditEstimate {
  const cap = (n: number, max: number | undefined): number => Math.max(0, Math.min(Math.floor(n) || 0, max ?? Number.POSITIVE_INFINITY));
  const pages = cap(i.pages, i.caps?.maxPages);
  const questions = cap(i.questions, i.caps?.maxQuestions);
  const competitorPages = cap(i.competitorPages, undefined);
  const engines = cap(i.engines, undefined);
  const engineCalls = cap(questions * engines, i.caps?.maxEngineCalls);
  const jevRequests = pages * 6 + questions * (1 + 3) + competitorPages * 5 + engineCalls;
  const jevInputTokens = jevRequests * JEV_TOKENS_PER_REQUEST;
  return {
    pages,
    questions,
    competitorPages,
    pagesToRead: pages + competitorPages,
    engineCalls,
    jevRequests,
    jevInputTokens,
    jevCostUsd: (jevInputTokens / 1_000_000) * JEV_USD_PER_MILLION_TOKENS,
    serpCalls: i.serp === false ? 0 : cap(i.rankChecks, undefined) + SERP_BASE_CALLS,
  };
}

// ───────────────────────── the form that starts an audit ─────────────────────────

/** What the options start at (the server holds them to its own caps). */
export const AUDIT_DEFAULTS = { maxPages: 40, questions: 24, competitorPages: 12, rankChecks: 10 } as const;

export interface AuditBounds {
  maxPages: { min: number; max: number };
  questions: { min: number; max: number };
  competitorPages: { min: number; max: number };
  rankChecks: { min: number; max: number };
}

/** Allowed values of each option: the contract's range, further held to what the server says it will do (status.audit). */
export function auditBounds(caps: { maxPages: number; maxQuestions: number }): AuditBounds {
  return {
    maxPages: { min: 1, max: Math.max(1, Math.min(500, Math.floor(caps.maxPages))) },
    questions: { min: 0, max: Math.max(0, Math.min(200, Math.floor(caps.maxQuestions))) },
    competitorPages: { min: 0, max: 30 },
    rankChecks: { min: 0, max: 40 },
  };
}

export interface AuditFormValues {
  domain: string;
  market: MarketId;
  description: string;
  /** One name per line. */
  brands: string;
  /** Domains, one per line. */
  competitors: string;
  /** The engines that are ticked and configured. */
  engines: readonly EngineId[];
  /** How many engines are configured at all (zero: the AI part is skipped). */
  configuredEngines: number;
  maxPages: string;
  questions: string;
  competitorPages: string;
  rankChecks: string;
}

export type AuditRequestResult = { ok: true; body: SiteAuditRequestInput } | { ok: false; problem: string };

export const AUDIT_DESCRIPTION_MIN = 10;
export const AUDIT_DESCRIPTION_MAX = 600;
export const AUDIT_COMPETITORS_MAX = 30;

/** Checks the form and turns it into the request body, or says in words what to fix first. */
export function buildAuditRequest(v: AuditFormValues, bounds: AuditBounds): AuditRequestResult {
  const fail = (problem: string): AuditRequestResult => ({ ok: false, problem });
  if (v.domain.trim() === '') return fail('Въведи домейна на сайта, напр. mysite.bg.');
  const domain = parseDomains(v.domain);
  if (domain.bad.length > 0 || domain.ok.length !== 1) return fail('Домейнът трябва да е един и валиден, напр. mysite.bg.');

  const description = v.description.trim();
  if (description.length < AUDIT_DESCRIPTION_MIN) return fail(`Опиши с едно-две изречения какво предлага бизнесът (поне ${AUDIT_DESCRIPTION_MIN} знака).`);
  if (description.length > AUDIT_DESCRIPTION_MAX) return fail(`Описанието е най-много ${AUDIT_DESCRIPTION_MAX} знака.`);

  const brands = parseBrandNames(v.brands);
  if (brands.error) return fail(brands.error);

  const competitors = parseDomains(v.competitors);
  if (competitors.bad.length > 0) return fail(`Не разпознавам като домейн: ${competitors.bad.join(', ')}. Напиши ги като competitor.bg, по един на ред.`);
  if (competitors.ok.length > AUDIT_COMPETITORS_MAX) return fail(`Конкурентите са най-много ${AUDIT_COMPETITORS_MAX} (въведени са ${competitors.ok.length}).`);

  const questions = clampInt(v.questions, bounds.questions.min, bounds.questions.max, Math.min(AUDIT_DEFAULTS.questions, bounds.questions.max));
  if (questions > 0 && v.configuredEngines > 0 && v.engines.length === 0) return fail('Избери поне един ИИ двигател или задай 0 въпроса, ако не искаш проверка в ИИ.');

  return {
    ok: true,
    body: {
      domain: domain.ok[0] ?? v.domain.trim(),
      market: v.market,
      businessDescription: description,
      brandNames: brands.names,
      competitors: competitors.ok,
      options: {
        maxPages: clampInt(v.maxPages, bounds.maxPages.min, bounds.maxPages.max, Math.min(AUDIT_DEFAULTS.maxPages, bounds.maxPages.max)),
        competitorPages: clampInt(v.competitorPages, bounds.competitorPages.min, bounds.competitorPages.max, AUDIT_DEFAULTS.competitorPages),
        questions,
        engines: [...v.engines],
        rankChecks: clampInt(v.rankChecks, bounds.rankChecks.min, bounds.rankChecks.max, AUDIT_DEFAULTS.rankChecks),
      },
    },
  };
}

// ───────────────────────── form parsing ─────────────────────────

/** A whole number typed into a field: unreadable or empty gives `fallback`; everything is held to min..max. */
export function clampInt(text: string, min: number, max: number, fallback: number): number {
  const hi = Math.max(min, max);
  const n = Number.parseInt(text.trim(), 10);
  return Math.min(hi, Math.max(min, Number.isFinite(n) ? n : fallback));
}

export const BRAND_NAME_MIN = 2;
export const BRAND_NAME_MAX = 60;
export const BRAND_NAMES_MAX = 10;

export interface ParsedBrandNames {
  names: string[];
  /** The first thing that is wrong, in words for the user; null when the list is fine. */
  error: string | null;
}

/** One name per line (a name may contain spaces and commas). Blank lines and repeats are dropped. */
export function parseBrandNames(text: string): ParsedBrandNames {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLocaleLowerCase('bg');
    if (seen.has(key)) continue;
    if (name.length < BRAND_NAME_MIN) return { names, error: `„${name}“ е твърде късо — всяко име е от ${BRAND_NAME_MIN} до ${BRAND_NAME_MAX} знака.` };
    if (name.length > BRAND_NAME_MAX) return { names, error: `„${name.slice(0, 24)}…“ е твърде дълго — всяко име е от ${BRAND_NAME_MIN} до ${BRAND_NAME_MAX} знака.` };
    seen.add(key);
    names.push(name);
  }
  if (names.length > BRAND_NAMES_MAX) return { names, error: `Имената на марката са най-много ${BRAND_NAMES_MAX} (въведени са ${names.length}).` };
  return { names, error: null };
}

// ───────────────────────── panel 01: SEO elements ─────────────────────────

export type ElementSort = 'impact' | 'page';
export interface ElementFilter {
  verdict: 'all' | ElementVerdict['verdict'];
  element: 'all' | SeoElement;
  /** Part of the page's address, any case. */
  query: string;
}

const elementIndex = (e: SeoElement): number => SEO_ELEMENTS.indexOf(e);
const matchesQuery = (url: string, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q === '' || pathOf(url).toLowerCase().includes(q);
};

export function filterElements(rows: readonly ElementVerdict[], f: ElementFilter): ElementVerdict[] {
  return rows.filter((e) => (f.verdict === 'all' || e.verdict === f.verdict) && (f.element === 'all' || e.element === f.element) && matchesQuery(e.url, f.query));
}

/** By impact (the biggest fix first) or by page address; ties fall back to the page and the order of the elements. */
export function sortElements(rows: readonly ElementVerdict[], sort: ElementSort): ElementVerdict[] {
  const byPage = (a: ElementVerdict, b: ElementVerdict): number => pathOf(a.url).localeCompare(pathOf(b.url)) || elementIndex(a.element) - elementIndex(b.element);
  return [...rows].sort((a, b) => (sort === 'impact' ? b.impact - a.impact || byPage(a, b) : byPage(a, b) || (a.verdict === b.verdict ? 0 : a.verdict === 'change' ? -1 : 1)));
}

export interface ElementCounts {
  /** Rows the verdict chips would show, given the element and search filters. */
  verdict: Record<'all' | ElementVerdict['verdict'], number>;
  /** Rows each element chip would show, given the verdict and search filters. */
  element: Partial<Record<SeoElement, number>>;
  all: number;
}

/** Every chip shows how many rows it would give, so the numbers always match what appears after a click. */
export function elementCounts(rows: readonly ElementVerdict[], f: ElementFilter): ElementCounts {
  const byElement = filterElements(rows, { ...f, verdict: 'all' });
  const byVerdict = filterElements(rows, { ...f, element: 'all' });
  const element: Partial<Record<SeoElement, number>> = {};
  for (const e of byVerdict) element[e.element] = (element[e.element] ?? 0) + 1;
  return {
    verdict: { all: byElement.length, change: byElement.filter((e) => e.verdict === 'change').length, keep: byElement.filter((e) => e.verdict === 'keep').length },
    element,
    all: byVerdict.length,
  };
}

// ───────────────────────── panel 02: competitor pages ─────────────────────────

export type CompetitorFilter = 'all' | CompetitorPage['verdict'];

export const filterCompetitors = (rows: readonly CompetitorPage[], f: CompetitorFilter): CompetitorPage[] => rows.filter((c) => f === 'all' || c.verdict === f);

/** The strongest page first; a page that could not be scored goes last, ties by Google position and then domain. */
export function sortCompetitors(rows: readonly CompetitorPage[]): CompetitorPage[] {
  const rank = (c: CompetitorPage): number => c.googleRank ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1) || rank(a) - rank(b) || a.domain.localeCompare(b.domain) || a.url.localeCompare(b.url));
}

export function competitorCounts(rows: readonly CompetitorPage[]): Record<CompetitorFilter, number> {
  return { all: rows.length, steal: rows.filter((c) => c.verdict === 'steal').length, skip: rows.filter((c) => c.verdict === 'skip').length };
}

// ───────────────────────── panel 03: buyer questions ─────────────────────────

export interface QuestionFilter {
  stage: 'all' | QuestionStage;
  verdict: 'all' | BuyerQuestion['verdict'];
}

const VERDICT_ORDER: Record<BuyerQuestion['verdict'], number> = { no_page: 0, weak: 1, answered: 2 };

export const filterQuestions = (rows: readonly BuyerQuestion[], f: QuestionFilter): BuyerQuestion[] =>
  rows.filter((q) => (f.stage === 'all' || q.stage === f.stage) && (f.verdict === 'all' || q.verdict === f.verdict));

/** No page first, then a weak answer, then answered; inside a group the most asked first, then the worst match. */
export function sortQuestions(rows: readonly BuyerQuestion[]): BuyerQuestion[] {
  return [...rows].sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.volume ?? -1) - (a.volume ?? -1) || (a.match ?? -1) - (b.match ?? -1) || a.text.localeCompare(b.text),
  );
}

export interface QuestionCounts {
  verdict: Record<'all' | BuyerQuestion['verdict'], number>;
  stage: Record<'all' | QuestionStage, number>;
}

export function questionCounts(rows: readonly BuyerQuestion[], f: QuestionFilter): QuestionCounts {
  const byStage = filterQuestions(rows, { ...f, verdict: 'all' });
  const byVerdict = filterQuestions(rows, { ...f, stage: 'all' });
  const stage = { all: byVerdict.length } as Record<'all' | QuestionStage, number>;
  for (const s of QUESTION_STAGES) stage[s] = byVerdict.filter((q) => q.stage === s).length;
  return {
    verdict: { all: byStage.length, no_page: byStage.filter((q) => q.verdict === 'no_page').length, weak: byStage.filter((q) => q.verdict === 'weak').length, answered: byStage.filter((q) => q.verdict === 'answered').length },
    stage,
  };
}

/** Share of questions without a page (0..1); null when there are no questions. */
export const noPageShare = (f: { questionsNoPage: number; questionsTotal: number }): number | null => (f.questionsTotal > 0 ? f.questionsNoPage / f.questionsTotal : null);

// ───────────────────────── panel 04: citability ─────────────────────────

/** Worst first. A page that could not be judged has no number to sort by and goes to the end, by address. */
export function citabilityRows(pages: readonly SitePage[]): SitePage[] {
  const judged = pages.filter((p) => p.citability !== null).sort((a, b) => (a.citability?.now ?? 0) - (b.citability?.now ?? 0) || a.path.localeCompare(b.path));
  const rest = pages.filter((p) => p.citability === null).sort((a, b) => a.path.localeCompare(b.path));
  return [...judged, ...rest];
}

/** Why a page has no citability: it could not be read, or Jev did not answer. */
export function whyNotJudged(p: SitePage): string {
  if (p.fetch.status !== 'ok') return p.fetch.httpStatus ? `страницата върна грешка ${p.fetch.httpStatus}` : 'страницата не се зареди';
  return p.judgmentStatus === 'none' ? 'Jev не върна оценка' : 'няма достатъчно данни';
}

// ───────────────────────── the plan ─────────────────────────

/** The items that lose the most today, first. */
export const topPlan = (plan: readonly FixPlan[], n: number): FixPlan[] => [...plan].sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title)).slice(0, Math.max(0, n));

/** How many questions at least one engine was asked (the AI check may cover only the first questions). */
export const askedQuestionCount = (answers: ReadonlyArray<{ questionId: string }>): number => new Set(answers.map((a) => a.questionId)).size;
