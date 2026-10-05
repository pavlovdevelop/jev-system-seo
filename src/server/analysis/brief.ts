import { INTENT_LABELS, PAGE_TYPE_LABELS, type Intent, type PageType } from '../../shared/domain';
import type { ContentBrief, PageAnalysis, SerpData } from '../../shared/schemas';
import type { ExtractedPage } from '../jev/questions';
import { keywordKey, keywordTerms, looksLikeQuestion, termSet } from '../nlp/bg';
import { clusterHeadings, minePhrases, pruneSubsumed } from '../nlp/terms';
import { median } from './scoring';

// A content brief is what you hand to a writer: how long, what shape, which subtopics, which questions and
// trust elements the top results share. It is built purely from measured evidence and Jev's typed judgments —
// no text is generated, so nothing in it can be invented.

export interface BriefInput {
  keyword: string;
  pages: readonly PageAnalysis[];
  /** Extracted page text by URL (server-side only; never persisted in reports). */
  extracted: ReadonlyMap<string, ExtractedPage>;
  serp: SerpData;
  intent: { dominantPageType: PageType | null; dominantIntent: Intent | null; dominantShare: number | null };
  ownPage: { analysis: PageAnalysis; extracted: ExtractedPage } | null;
}

const GENERIC_SCHEMA = new Set(['webpage', 'website', 'breadcrumblist', 'imageobject', 'sitenavigationelement', 'wpheader', 'wpfooter', 'searchaction', 'readaction']);

const TRUST: Array<{ id: 'statesPrices' | 'showsPortfolio' | 'showsReviews' | 'clearCta' | 'showsIdentity'; label: string }> = [
  { id: 'statesPrices', label: 'Цени или пакети' },
  { id: 'showsPortfolio', label: 'Портфолио и примери' },
  { id: 'showsReviews', label: 'Отзиви от клиенти' },
  { id: 'clearCta', label: 'Ясен призив за действие' },
  { id: 'showsIdentity', label: 'Кой стои зад сайта' },
];

const roundTo = (n: number, step: number): number => Math.round(n / step) * step;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const joinBg = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`);
const quote = (s: string): string => `„${s}“`;

const ADVICE: Partial<Record<PageType, string>> = {
  service_page: 'Създай специализирана страница за услугата, а не блог статия.',
  company_homepage: 'Водещите резултати са начални страници на фирми — силна, фокусирана начална или услугова страница има шанс.',
  blog_article: 'Тук печелят информационни статии — напиши подробно ръководство с отговори на въпросите.',
  comparison_listicle: 'Тук печелят класации и сравнения — помисли за сравнителна страница или честно ръководство за избор.',
  directory_marketplace: 'Резултатите са директории и платформи — специализирана страница за услуга с реални данни и примери има шанс да ги изпревари.',
  platform_or_tool: 'Резултатите са платформи и инструменти — подчертай разликата си: услуга „до ключ“ срещу „направи си сам“.',
  forum_or_social: 'Резултатите са форуми — подробна, авторитетна страница може да изземе търсенето.',
};

export function buildBrief(input: BriefInput): ContentBrief {
  const fetched = input.pages.filter((p) => p.metrics !== null);
  const N = fetched.length;
  const terms = new Set(keywordTerms(input.keyword));
  const extractedFor = (p: PageAnalysis): ExtractedPage | undefined => input.extracted.get(p.url);

  // ── length ────────────────────────────────────────────────────────────────────────────────
  const topWords = fetched
    .filter((p) => p.position !== null && p.position <= 5)
    .map((p) => p.metrics!.wordCount)
    .filter((w) => w >= 100);
  const med = topWords.length >= 3 ? median(topWords) : null;
  const length: ContentBrief['length'] = med
    ? { min: roundTo(med * 0.8, 50), target: roundTo(med * 1.15, 50), max: roundTo(med * 1.5, 50), medianTop: Math.round(med), basedOn: topWords.length }
    : null;

  // ── title patterns ────────────────────────────────────────────────────────────────────────
  const titled = fetched.filter((p) => p.metrics!.title);
  let titlePatterns: ContentBrief['titlePatterns'] = null;
  if (titled.length >= 3) {
    const mods = minePhrases(titled.map((p) => p.metrics!.title as string), { maxN: 1, minPages: 2 })
      .filter((m) => !terms.has(m.key) && m.display.length >= 4)
      .slice(0, 6)
      .map((m) => ({ term: m.display, share: Math.round((m.pages / titled.length) * 100) / 100 }));
    titlePatterns = {
      avgLength: Math.round(titled.reduce((s, p) => s + p.metrics!.titleLength, 0) / titled.length),
      startsWithKeywordShare: Math.round((titled.filter((p) => p.metrics!.keyword.startsTitleWithKeyword).length / titled.length) * 100) / 100,
      commonModifiers: mods,
    };
  }

  // ── terms & subtopics ─────────────────────────────────────────────────────────────────────
  const texts = fetched.map((p) => extractedFor(p)?.text.full ?? '').filter(Boolean);
  const minPages = Math.max(2, Math.ceil(texts.length * 0.4));
  const mustCover =
    texts.length >= 3
      ? pruneSubsumed(minePhrases(texts, { maxN: 3, minPages }))
          .filter((p) => !keywordTerms(p.display).every((t) => terms.has(t)))
          .slice(0, 15)
          .map((p) => ({ term: p.display, pages: p.pages, share: Math.round((p.pages / texts.length) * 100) / 100 }))
      : [];

  const headingSets = fetched.map((p) => p.metrics!.headings.filter((h) => h.level === 2 || h.level === 3).map((h) => h.text));
  const minClusterPages = Math.max(2, Math.ceil(N * 0.25));
  const clusters = N >= 3 ? clusterHeadings(headingSets, 0.4, terms).filter((c) => c.pages >= minClusterPages).slice(0, 12) : [];
  const subtopics = clusters.map((c) => ({ topic: c.topic, pages: c.pages, examples: c.examples }));

  // ── questions ─────────────────────────────────────────────────────────────────────────────
  const questions: ContentBrief['questions'] = [];
  const seenQ = new Set<string>();
  const addQ = (question: string, source: 'paa' | 'headings'): void => {
    const key = keywordKey(question);
    if (!key || seenQ.has(key) || questions.length >= 12) return;
    seenQ.add(key);
    questions.push({ question: question.trim(), source });
  };
  for (const q of input.serp.peopleAlsoAsk) addQ(q.question, 'paa');
  for (const p of fetched) for (const h of p.metrics!.headings) if (h.level >= 2 && looksLikeQuestion(h.text)) addQ(h.text, 'headings');

  // ── schema & trust elements ───────────────────────────────────────────────────────────────
  const schemaCount = new Map<string, number>();
  for (const p of fetched) for (const t of new Set(p.metrics!.schemaTypes)) if (!GENERIC_SCHEMA.has(t.toLowerCase())) schemaCount.set(t, (schemaCount.get(t) ?? 0) + 1);
  const schemaTypes = [...schemaCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([type, pages]) => ({ type, pages }));

  const trustElements: ContentBrief['trustElements'] = [];
  for (const t of TRUST) {
    const judged = fetched.filter((p) => p.judgments[t.id] !== undefined);
    if (judged.length === 0) continue;
    const pages = judged.filter((p) => (p.judgments[t.id]?.p ?? 0) >= 0.6).length;
    trustElements.push({ id: t.id, label: t.label, pages, share: Math.round((pages / judged.length) * 100) / 100 });
  }
  const faqPages = fetched.filter((p) => p.metrics!.hasFaqSection || p.metrics!.hasFaqSchema).length;
  if (N > 0) trustElements.push({ id: 'faq', label: 'FAQ секция', pages: faqPages, share: Math.round((faqPages / N) * 100) / 100 });
  const formPages = fetched.filter((p) => p.metrics!.hasContactForm).length;
  if (N > 0) trustElements.push({ id: 'contactForm', label: 'Контактна форма', pages: formPages, share: Math.round((formPages / N) * 100) / 100 });

  // ── gaps of the user's own page ───────────────────────────────────────────────────────────
  let ownGaps: ContentBrief['ownGaps'] = null;
  if (input.ownPage?.analysis.metrics) {
    const own = input.ownPage;
    const ownTerms = termSet(own.extracted.text.full);
    const gaps: NonNullable<ContentBrief['ownGaps']> = [];
    if (length && own.analysis.metrics!.wordCount < length.min) {
      gaps.push({ kind: 'length', label: 'Обем на съдържанието', detail: `Страницата ти има ${own.analysis.metrics!.wordCount} думи; препоръчителният минимум е ${length.min}` });
    }
    for (const t of mustCover.filter((m) => m.share >= 0.5)) {
      const words = keywordTerms(t.term);
      if (words.length > 0 && !words.every((w) => ownTerms.has(w))) {
        gaps.push({ kind: 'term', label: t.term, detail: `Използва се от ${t.pages} от ${texts.length} конкурентни страници` });
      }
      if (gaps.filter((g) => g.kind === 'term').length >= 8) break;
    }
    for (const c of clusters.filter((x) => x.pages >= Math.max(2, Math.ceil(N * 0.4)))) {
      const covered = c.terms.filter((t) => ownTerms.has(t)).length / Math.max(1, c.terms.length);
      if (covered < 0.6) gaps.push({ kind: 'subtopic', label: c.topic, detail: `Покрито от ${c.pages} от ${N} конкурентни страници; при теб липсва или е слабо` });
      if (gaps.filter((g) => g.kind === 'subtopic').length >= 6) break;
    }
    for (const t of TRUST) {
      const el = trustElements.find((x) => x.id === t.id);
      const mine = own.analysis.judgments[t.id]?.p;
      if (el && el.share >= 0.5 && mine !== undefined && mine < 0.5) gaps.push({ kind: 'element', label: t.label, detail: `Има го при ${pct(el.share)} от конкурентите; при теб не се забелязва` });
    }
    ownGaps = gaps;
  }

  // ── human-readable summary and checklist ─────────────────────────────────────────────────
  const { dominantPageType: type, dominantIntent: intent, dominantShare } = input.intent;
  const summary: string[] = [];
  if (type) {
    summary.push(`За ${quote(input.keyword)} Google показва предимно „${PAGE_TYPE_LABELS[type].toLowerCase()}“${dominantShare ? ` (≈${pct(dominantShare)} от резултатите)` : ''}.`);
    if (intent) summary.push(`Търсещите най-често са от тип „${INTENT_LABELS[intent].toLowerCase()}“.`);
    const advice = ADVICE[type];
    if (advice) summary.push(advice);
  } else {
    summary.push(N === 0 ? 'Няма достатъчно данни: не успяхме да изтеглим страниците от резултатите.' : 'Типът на водещите страници не можа да бъде определен със сигурност.');
  }
  if (length) summary.push(`Водещите страници са с около ${length.medianTop} думи.`);

  const checklist: string[] = [];
  if (type) checklist.push(`Тип страница: ${PAGE_TYPE_LABELS[type].toLowerCase()}.`);
  if (length) checklist.push(`Обем: около ${length.target} думи (в рамките на ${length.min}–${length.max}; медиана на топ 5: ${length.medianTop}).`);
  if (titlePatterns) {
    const mods = titlePatterns.commonModifiers.slice(0, 3).map((m) => quote(m.term));
    checklist.push(`Заглавие: около ${titlePatterns.avgLength} знака; ${titlePatterns.startsWithKeywordShare >= 0.5 ? 'започни с ключовата фраза' : 'включи ключовата фраза'}${mods.length ? `, добави думи като ${joinBg(mods)}` : ''}.`);
  }
  const h2Avg = N > 0 ? Math.round(fetched.reduce((s, p) => s + p.metrics!.h2Count, 0) / N) : 0;
  if (N > 0) checklist.push(`Структура: един H1 с ключовата фраза и около ${Math.max(3, h2Avg)} секции с H2 (при конкурентите средно ${h2Avg}).`);
  if (subtopics.length > 0) checklist.push(`Покрий подтемите: ${joinBg(subtopics.slice(0, 6).map((s) => quote(s.topic)))}.`);
  if (mustCover.length > 0) checklist.push(`Включи естествено термините: ${joinBg(mustCover.slice(0, 8).map((m) => quote(m.term)))}.`);
  if (questions.length > 0) checklist.push(`Отговори на въпросите: ${joinBg(questions.slice(0, 5).map((q) => quote(q.question)))}.`);
  const faq = trustElements.find((t) => t.id === 'faq');
  if (faq && faq.share >= 0.4) checklist.push('Добави FAQ секция с реални въпроси и FAQPage разметка.');
  const musts = trustElements.filter((t) => ['statesPrices', 'showsPortfolio', 'showsReviews', 'clearCta', 'showsIdentity'].includes(t.id) && t.share >= 0.5);
  if (musts.length > 0) checklist.push(`Покажи ясно: ${joinBg(musts.map((t) => t.label.toLowerCase()))} — при повечето конкуренти ги има.`);
  if (schemaTypes.length > 0) checklist.push(`Структурирани данни (schema.org): ${joinBg(schemaTypes.slice(0, 4).map((s) => s.type))}.`);
  checklist.push('Техническо: мета описание 120–160 знака с призив за действие, alt текстове на изображенията, мобилна версия и бързо зареждане.');

  return {
    keyword: input.keyword,
    pageType: type,
    intent,
    summary: summary.join(' '),
    length,
    titlePatterns,
    mustCover,
    subtopics,
    questions,
    schemaTypes,
    trustElements,
    ownGaps,
    checklist,
  };
}
