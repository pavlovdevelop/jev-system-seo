// Pure helpers behind the "ИИ видимост" and "План" tabs: wording, filtering, grouping, chart geometry and Markdown.
// Nothing here renders; the only function that touches the browser is `copyText`, and it degrades to `false` where
// there is no clipboard. That keeps every rule testable in Node.

import {
  CRITERIA,
  CRITERION_LABELS,
  ENGINE_IDS,
  ENGINE_LABELS,
  SKIP_REASONS,
  type AnswerRecord,
  type BuyerQuestion,
  type CriteriaScores,
  type Criterion,
  type EngineId,
  type EngineRun,
  type FixPlan,
  type SiteAuditRequest,
  type SkipAnalysis,
  type SkipReason,
  type WinnerPage,
} from '../../shared/audit';
import { bgCount } from '../../shared/plural';
import { stripInvisible } from '../../shared/text';
import { normalizeDomainInput } from '../../shared/urls';
import { clamp01, int, pct, seconds, usd } from './format';

// ───────────────────────── wording ─────────────────────────

export type AnswerStatus = AnswerRecord['status'];
export const ANSWER_STATUS_LABELS: Record<AnswerStatus, string> = { cited: 'Цитиран', named: 'Назован', missing: 'Липсва', failed: 'Неуспешен' };

export const PLAN_KIND_LABELS: Record<FixPlan['kind'], string> = { create: 'Създай нова страница', rewrite: 'Пренапиши' };
export const SKIP_ACTION_LABELS: Record<SkipAnalysis['action'], string> = { create: 'Създай страница', rewrite: 'Пренапиши страницата' };
export const WRITTEN_BY_LABELS: Record<FixPlan['writtenBy'], string> = { rules: 'Чеклист от правила', llm: 'Чеклист, написан от езиков модел' };

const engineRank = (engine: EngineId): number => ENGINE_IDS.indexOf(engine);

/** Engines in their fixed order (ChatGPT, Claude, Gemini), whatever order the server listed them in. */
export function sortEngines<T extends { engine: EngineId }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => engineRank(a.engine) - engineRank(b.engine));
}

export const sortEngineIds = (ids: readonly EngineId[]): EngineId[] => [...ids].sort((a, b) => engineRank(a) - engineRank(b));

// ───────────────────────── numbers as text ─────────────────────────

const whole = (x: number): number => Math.round(clamp01(x) * 100);

/** "19–41%" (one figure when both ends round to the same number). */
export function intervalRange(low: number, high: number): string {
  const lo = whole(low);
  const hi = whole(high);
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
}

/** The share and its interval as two pieces, so a layout can keep each on one line: "29%" and "(95% интервал 19–41%)". */
export function intervalParts(rate: number, low: number, high: number): { value: string; note: string } {
  return { value: pct(rate), note: `(95% интервал ${intervalRange(low, high)})` };
}

/** "29% (95% интервал 19–41%)": the Wilson interval is part of the figure, because a few dozen questions say little. */
export function formatInterval(rate: number, low: number, high: number): string {
  const { value, note } = intervalParts(rate, low, high);
  return `${value} ${note}`;
}

/** "≈ $0.12", or the plain fact that the model's price is not known. */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null || !Number.isFinite(costUsd)) return 'цената не е известна';
  if (costUsd <= 0) return '≈ $0';
  return costUsd < 0.01 ? usd(costUsd) : `≈ ${usd(costUsd)}`;
}

/** "840 ms" or "2.3 с"; an em dash when nothing was measured. */
export function formatLatency(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? seconds(Math.round(ms)) : '—';
}

/** What an engine's run used, in pieces: "24 заявки", "12 340 токена", "3 търсения", "≈ $0.12". */
export function usageParts(usage: EngineRun['usage']): string[] {
  const tokens = usage.inputTokens + usage.outputTokens;
  const parts = [bgCount(usage.calls, 'заявка', 'заявки'), `${int(tokens)} ${tokens === 1 ? 'токен' : 'токена'}`];
  if (usage.searches > 0) parts.push(bgCount(usage.searches, 'търсене', 'търсения'));
  parts.push(formatCost(usage.estimatedCostUsd));
  return parts;
}

/** The same as one line: "24 заявки · 12 340 токена · 3 търсения · ≈ $0.12". */
export const usageLine = (usage: EngineRun['usage']): string => usageParts(usage).join(' · ');

/** "преди 22 месеца" for a page's age; "без дата" when the page carries none. */
export function ageText(months: number | null | undefined): string {
  if (months === null || months === undefined || !Number.isFinite(months)) return 'без дата';
  const m = Math.round(months);
  return m < 1 ? 'променена този месец' : `променена преди ${bgCount(m, 'месец', 'месеца')}`;
}

export function wordsText(words: number | null | undefined): string | null {
  return words === null || words === undefined ? null : `${int(words)} ${words === 1 ? 'дума' : 'думи'}`;
}

/** 0..10 with one decimal: "2.8". */
export const score10Text = (score: number): string => (Number.isFinite(score) ? score.toFixed(1) : '—');

/** How many questions the engines were really asked: the fewest and the most over the engines (a stopped engine asks fewer). */
export function sampleRange(engines: readonly Pick<EngineRun, 'asked'>[], fallback: number): { min: number; max: number } {
  const asked = engines.map((e) => e.asked).filter((n) => n > 0);
  return asked.length > 0 ? { min: Math.min(...asked), max: Math.max(...asked) } : { min: fallback, max: fallback };
}

/** "20 въпроса", or "9–14 въпроса" when the engines were asked different numbers. */
export function sampleText(range: { min: number; max: number }): string {
  return range.min === range.max ? bgCount(range.max, 'въпрос', 'въпроса') : `${range.min}–${range.max} въпроса`;
}

/** The path of a page for display ("/blog/x/"), or the text itself when it is not an absolute URL. */
export function displayPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

// ───────────────────────── who is us ─────────────────────────

const looksLikeDomain = (s: string): boolean => /^[^\s/@]+\.[^\s/@.]{2,}$/.test(s.trim());

function isSiteOrSubdomain(domain: string, site: string): boolean {
  const d = normalizeDomainInput(domain);
  const s = normalizeDomainInput(site);
  return d !== '' && s !== '' && (d === s || d.endsWith(`.${s}`));
}

/** Is `domain` the audited site (or one of its subdomains)? A brand name only counts when it is itself written as a domain. */
export function isOwnDomain(domain: string, request: Pick<SiteAuditRequest, 'domain' | 'brandNames'>): boolean {
  if (isSiteOrSubdomain(domain, request.domain)) return true;
  return request.brandNames.some((name) => looksLikeDomain(name) && isSiteOrSubdomain(domain, name));
}

export type DomainRole = 'own' | 'competitor' | 'other';

/** Our site, a competitor the user listed, or any other domain an engine cited. */
export function domainRole(domain: string, request: Pick<SiteAuditRequest, 'domain' | 'brandNames' | 'competitors'>): DomainRole {
  if (isOwnDomain(domain, request)) return 'own';
  return request.competitors.some((c) => isSiteOrSubdomain(domain, c)) ? 'competitor' : 'other';
}

// ───────────────────────── the answer feed ─────────────────────────

export type AnswerFilter = 'all' | 'won' | 'lost';
export const ANSWER_FILTERS: ReadonlyArray<{ id: AnswerFilter; label: string }> = [
  { id: 'all', label: 'Всички' },
  { id: 'won', label: 'Цитирани и назовани' },
  { id: 'lost', label: 'Липсваме' },
];

export const isWon = (a: Pick<AnswerRecord, 'status'>): boolean => a.status === 'cited' || a.status === 'named';

/** "Липсваме" is only the answers that came back without us; a failed call says nothing about us. */
export function matchesFilter(a: Pick<AnswerRecord, 'status'>, filter: AnswerFilter): boolean {
  return filter === 'all' || (filter === 'won' ? isWon(a) : a.status === 'missing');
}

export function filterAnswers<T extends Pick<AnswerRecord, 'status'>>(answers: readonly T[], filter: AnswerFilter): T[] {
  return filter === 'all' ? [...answers] : answers.filter((a) => matchesFilter(a, filter));
}

export function countByFilter(answers: readonly Pick<AnswerRecord, 'status'>[]): Record<AnswerFilter, number> {
  return { all: answers.length, won: answers.filter((a) => matchesFilter(a, 'won')).length, lost: answers.filter((a) => matchesFilter(a, 'lost')).length };
}

/** The questions by id, to put the text of the question on an answer. */
export function questionIndex(questions: readonly BuyerQuestion[], skips: readonly SkipAnalysis[] = []): Map<string, string> {
  const index = new Map<string, string>();
  for (const s of skips) if (s.question.trim()) index.set(s.questionId, s.question);
  for (const q of questions) if (q.text.trim()) index.set(q.id, q.text); // the question list is the primary source
  return index;
}

export const NO_QUESTION_TEXT = 'Въпросът не е намерен в отчета';

export function answersOf(answers: readonly AnswerRecord[], engine: EngineId): AnswerRecord[] {
  return answers.filter((a) => a.engine === engine);
}

// ───────────────────────── why the engines skip us ─────────────────────────

export interface SkipGroup {
  questionId: string;
  question: string;
  /** One analysis per engine that skips us, in the engines' fixed order. */
  items: SkipAnalysis[];
  engines: EngineId[];
  /** Our page for the question, as the best-described analysis has it (one with a score, else one with a page). */
  page: SkipAnalysis['ourPage'];
  /** The reasons over all engines, the most frequent first. */
  reasons: SkipReason[];
  /** What to do: one action as a rule, two only when the engines' analyses disagree. */
  actions: Array<SkipAnalysis['action']>;
  /** The lowest citability (0..10) of our page; null when there is no page to score. */
  score10: number | null;
}

function pickPage(items: readonly SkipAnalysis[]): SkipAnalysis['ourPage'] {
  const best = items.find((i) => i.ourPage.detail) ?? items.find((i) => i.ourPage.exists) ?? items[0];
  return best ? best.ourPage : { url: null, exists: false, words: null, ageMonths: null, detail: null };
}

/**
 * One group per buyer question: which engines skip us there, what each cites instead and why. The worst first —
 * the question the most engines skip, then the one where our page scores lowest (no page at all counts as the lowest).
 */
export function groupSkips(skips: readonly SkipAnalysis[], texts: ReadonlyMap<string, string> = new Map()): SkipGroup[] {
  const byQuestion = new Map<string, SkipAnalysis[]>();
  for (const s of sortEngines(skips)) {
    const list = byQuestion.get(s.questionId) ?? [];
    if (!list.some((x) => x.engine === s.engine)) list.push(s); // one analysis per engine and question
    byQuestion.set(s.questionId, list);
  }

  const groups: SkipGroup[] = [];
  for (const [questionId, items] of byQuestion) {
    const counts = new Map<SkipReason, number>();
    for (const item of items) for (const r of item.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
    const reasons = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || SKIP_REASONS.indexOf(a) - SKIP_REASONS.indexOf(b));
    const scores = items.flatMap((i) => (i.ourPage.detail ? [i.ourPage.detail.score10] : []));
    groups.push({
      questionId,
      question: items.find((i) => i.question.trim())?.question ?? texts.get(questionId) ?? '',
      items,
      engines: items.map((i) => i.engine),
      page: pickPage(items),
      reasons,
      actions: [...new Set(items.map((i) => i.action))],
      score10: scores.length > 0 ? Math.min(...scores) : null,
    });
  }
  return groups.sort((a, b) => b.engines.length - a.engines.length || (a.score10 ?? -1) - (b.score10 ?? -1) || a.question.localeCompare(b.question, 'bg'));
}

/** Our page's eight criteria in their fixed order, with the label of each; null = could not be judged. */
export function criteriaRows(scores: CriteriaScores): Array<{ key: Criterion; label: string; value: number | null }> {
  return CRITERIA.map((key) => ({ key, label: CRITERION_LABELS[key], value: scores[key] }));
}

// ───────────────────────── pages the engines cite ─────────────────────────

/** The most cited first; among equals the better-built page, then the domain. */
export function sortWinners(winners: readonly WinnerPage[]): WinnerPage[] {
  return [...winners].sort((a, b) => b.citedIn - a.citedIn || b.score10 - a.score10 || a.domain.localeCompare(b.domain));
}

const WINNER_AXES: ReadonlyArray<{ key: keyof WinnerPage['radar']; criterion: Criterion; short: string }> = [
  { key: 'answer', criterion: 'answer', short: 'Отговор' },
  { key: 'entity', criterion: 'facts', short: 'Факти' },
  { key: 'faq', criterion: 'faq', short: 'FAQ' },
  { key: 'author', criterion: 'author', short: 'Автор' },
  { key: 'fresh', criterion: 'fresh', short: 'Актуалност' },
  { key: 'sources', criterion: 'sources', short: 'Източници' },
];

/** The six radar axes of a cited page: `label` is the full criterion name, `short` fits next to the chart. */
export function winnerAxes(radar: WinnerPage['radar']): Array<{ label: string; short: string; value: number | null }> {
  return WINNER_AXES.map((a) => ({ label: CRITERION_LABELS[a.criterion], short: a.short, value: radar[a.key] }));
}

// ───────────────────────── chart geometry ─────────────────────────

/** Angle (radians) of axis `i` of `n`, the first at twelve o'clock and the rest clockwise. */
export const radarAngle = (i: number, n: number): number => -Math.PI / 2 + (i * 2 * Math.PI) / n;

export function radarPoint(i: number, n: number, radius: number, cx: number, cy: number): { x: number; y: number } {
  const a = radarAngle(i, n);
  return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
}

/**
 * The stretches of neighbouring axes that have a value. An axis without one (null) breaks the outline: the drawing
 * leaves a gap there instead of pretending the value was zero. All axes known → one closed run.
 */
export function radarRuns(values: ReadonlyArray<number | null>): Array<{ indices: number[]; closed: boolean }> {
  const n = values.length;
  const known = (i: number): boolean => values[((i % n) + n) % n] !== null;
  if (n === 0 || values.every((v) => v === null)) return [];
  if (values.every((v) => v !== null)) return [{ indices: values.map((_, i) => i), closed: true }];
  const runs: Array<{ indices: number[]; closed: boolean }> = [];
  for (let start = 0; start < n; start++) {
    if (!known(start) || known(start - 1)) continue; // a run begins where the previous axis has no value
    const indices: number[] = [];
    for (let k = start; known(k); k++) indices.push(k % n);
    runs.push({ indices, closed: false });
  }
  return runs;
}

/** Stroke dash that draws the arc from `from` to `to` (0..1 of a full turn) on a circle of radius `r`, one dash and no repeat. */
export function arcDash(from: number, to: number, r: number): { dash: number; gap: number; offset: number } {
  const c = 2 * Math.PI * r;
  const a = clamp01(Math.min(from, to));
  const b = clamp01(Math.max(from, to));
  return { dash: c * (b - a), gap: c, offset: -c * a };
}

// ───────────────────────── Markdown (the plan, copied into a ticket or a document) ─────────────────────────

// Text in a plan comes from the web (page titles) and from language models (questions, steps): it must stay text when
// it is pasted into a document or a ticket — no links, no images, no raw HTML, no headings, no table breaks, no hidden
// characters. These are the rules of src/server/export.ts (mdText/mdUrl), plus one more: a bare web address, an e-mail
// or an @name in the text becomes a link (or a notification) in GitHub-flavoured renderers without any bracket, so it
// is shown as inert code.

/** A URL as inert text: inside a code span nothing is a link, and a backtick cannot end the span. */
export function mdUrl(url: string): string {
  const clean = stripInvisible(url).replace(/[`\s]/g, '');
  return clean ? `\`${clean}\`` : '—';
}

// scheme://…, www.…, name@host.tld and @name — what renderers turn into links or mentions on their own
const AUTOLINK = /(?:\b[a-z][a-z0-9+.-]{1,15}:\/\/|\bwww\.)[^\s<>"'`]+|[^\s<>"'`@()[\]\\]+@[^\s<>"'`@()[\]\\]+\.[a-z]{2,}|(?<![\p{L}\p{N}_@.+-])@[\p{L}\p{N}_][\p{L}\p{N}_-]*/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;

const mdEscape = (text: string): string => text.replace(/[\\`*_[\]<>#|]/g, '\\$&');

/** Text from the web or a model, as inert single-line Markdown. */
export function mdText(value: string | number | null | undefined): string {
  const text = stripInvisible(String(value ?? '')).replace(/\s*[\r\n]+\s*/g, ' ');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(AUTOLINK)) {
    const at = m.index ?? 0;
    const tail = m[0].match(TRAILING_PUNCTUATION)?.[0] ?? '';
    const link = m[0].slice(0, m[0].length - tail.length);
    out += mdEscape(text.slice(last, at)) + (link ? mdUrl(link) : '') + mdEscape(tail);
    last = at + m[0].length;
  }
  out += mdEscape(text.slice(last));
  return out.replace(/^([-+]|\d+[.)])/, '\\$1').trim();
}

/** Plans in the order to work on them: the biggest loss first; among equals a new page before a rewrite, then by title. */
export function sortPlans<T extends Pick<FixPlan, 'priority' | 'kind' | 'title'>>(plans: readonly T[]): T[] {
  return [...plans].sort((a, b) => b.priority - a.priority || (a.kind === b.kind ? 0 : a.kind === 'create' ? -1 : 1) || a.title.localeCompare(b.title, 'bg'));
}

export function countPlans(plans: readonly Pick<FixPlan, 'kind'>[]): { total: number; create: number; rewrite: number } {
  const create = plans.filter((p) => p.kind === 'create').length;
  return { total: plans.length, create, rewrite: plans.length - create };
}

/** One plan as Markdown. `level` is the heading level of its title; `index` numbers it inside a whole plan. */
export function planMarkdown(plan: FixPlan, opts: { level?: number; index?: number } = {}): string {
  const level = Math.min(5, Math.max(1, Math.round(opts.level ?? 2)));
  const head = '#'.repeat(level);
  const sub = '#'.repeat(level + 1);
  const lines: string[] = [`${head} ${opts.index === undefined ? '' : `${opts.index}. `}${mdText(plan.title)}`, ''];
  lines.push(`- Вид: ${PLAN_KIND_LABELS[plan.kind]}`);
  if (plan.url) lines.push(`- Адрес: ${mdUrl(plan.url)}`);
  else if (plan.suggestedPath) lines.push(`- Предложен адрес: ${mdUrl(plan.suggestedPath)}`);
  if (plan.engines.length > 0) lines.push(`- Важи за: ${sortEngineIds(plan.engines).map((e) => ENGINE_LABELS[e]).join(', ')}`);
  if (plan.citability) lines.push(`- Цитируемост: ${pct(plan.citability.now)} → ${pct(plan.citability.after)} (прогноза)`);
  if (plan.questions.length > 0) lines.push('', `${sub} Въпроси, на които да отговаря`, '', ...plan.questions.map((q) => `- ${mdText(q)}`));
  if (plan.checklist.length > 0) {
    lines.push('', `${sub} Стъпки`, '');
    plan.checklist.forEach((step, i) => {
      lines.push(`${i + 1}. ${mdText(step.text)}`);
      if (step.why.trim()) lines.push(`   - Защо: ${mdText(step.why)}`);
    });
  }
  lines.push('', `_${WRITTEN_BY_LABELS[plan.writtenBy]}._`);
  return lines.join('\n');
}

/** The whole plan, the biggest loss first. */
export function plansMarkdown(plans: readonly FixPlan[], opts: { domain: string }): string {
  const sorted = sortPlans(plans);
  const { total, create, rewrite } = countPlans(sorted);
  const lines = [
    `# План за ИИ видимост: ${mdText(opts.domain)}`,
    '',
    `${bgCount(total, 'страница', 'страници')} за работа (нови: ${create}, за пренаписване: ${rewrite}), подредени по приоритет — започни от първата.`,
    '',
  ];
  sorted.forEach((plan, i) => lines.push(planMarkdown(plan, { level: 2, index: i + 1 }), ''));
  lines.push('---', 'Изготвено с Jev SEO Radar.');
  return lines.join('\n');
}

// ───────────────────────── progress through a checklist ─────────────────────────

/** Where the ticks of one plan are kept in this browser. */
export const planStorageKey = (auditId: string, planId: string): string => `radar.plan.${auditId}.${planId}`;

/** What was stored, reduced to ids that still exist in the checklist (a stale or edited value never breaks the page). */
export function parseDone(raw: unknown, ids: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(ids);
  const out: string[] = [];
  for (const x of raw) if (typeof x === 'string' && valid.has(x) && !out.includes(x)) out.push(x);
  return out;
}

/** "3 от 8 готови". */
export function progressText(done: number, total: number): string {
  return `${done} от ${total} ${total === 1 ? 'готова' : 'готови'}`;
}

// ───────────────────────── the clipboard ─────────────────────────

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement as { focus?: () => void } | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus?.(); // selecting the text area took the focus; give it back to the button that was pressed
  }
}

/** Copies text to the clipboard: the Clipboard API where the page may use it, the old way otherwise. True when it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // not allowed here (an insecure address, a permission): try the old way
  }
  return legacyCopy(text);
}
