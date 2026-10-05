import { INTENT_LABELS, PAGE_TYPE_LABELS, WEAK_COMMERCIAL_PAGE_TYPES, type ConfidenceLevel, type Intent, type PageType } from '../../shared/domain';
import type { CompositeScores, FetchInfo, PageJudgments, PageMetrics, ScoreAnswer, Signal } from '../../shared/schemas';

// Strengths and weaknesses of a page, as explicit rules. Every signal states its evidence and where it
// came from — measured in code, or judged by Jev with a probability — so the report can be audited.
// Jev-sourced signals are confidence-gated: an answer Jev is unsure about is not reported as a finding
// (docs.typesafe.ai/confidence).

export interface PeerStats {
  /** Pages with fetched content in the comparison set (the SERP's top results). */
  pages: number;
  medianWords: number | null;
  faqShare: number;
  dominantIntent: Intent | null;
  dominantPageType: PageType | null;
}

export interface SignalInput {
  metrics: PageMetrics | null;
  judgments: PageJudgments;
  fetch: FetchInfo;
  composite: CompositeScores;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const level = (c: number): ConfidenceLevel => (c >= 0.6 ? 'high' : c >= 0.3 ? 'medium' : 'low');
const noulLevel = (p: number): ConfidenceLevel => level(Math.abs(2 * p - 1));
const nbsp = (n: number): string => n.toLocaleString('bg-BG').replace(/\p{Zs}/gu, ' ');

function scoreNote(a: ScoreAnswer): string {
  return `Jev: ${a.raw.toFixed(1)} от ${a.levels - 1} · сигурност ${pct(a.confidence)}`;
}
const noulNote = (p: number): string => `Jev: вероятност ${pct(p)}`;

type Make = (
  kind: Signal['kind'],
  id: string,
  label: string,
  evidence: string,
  source: Signal['source'],
  confidence: ConfidenceLevel,
) => Signal;
const make: Make = (kind, id, label, evidence, source, confidence) => ({ id, kind, label, evidence, source, confidence });

const GENERIC_SCHEMA = new Set(['webpage', 'website', 'breadcrumblist', 'imageobject', 'sitenavigationelement', 'wpheader', 'wpfooter', 'searchaction', 'readaction']);

// What matters most when comparing providers comes first (content quality and conversion/trust elements before
// technical hygiene), so a capped list of signals keeps the decision-relevant ones.
const PRIORITY: readonly string[] = [
  'deep_content', 'pricing', 'portfolio', 'reviews', 'cta', 'identity', 'long_content', 'dedicated_to_query', 'keyword_in_title_h1', 'faq', 'schema_markup', 'fresh', 'image_alt', 'fast_response',
  'thin_content', 'shallow_topic', 'generic_text', 'not_dedicated', 'off_intent_type', 'keyword_missing_title', 'no_pricing', 'no_cta', 'no_portfolio', 'no_reviews', 'no_identity', 'below_median_length',
  'no_h1', 'multiple_h1', 'no_meta', 'meta_length', 'title_length', 'no_schema', 'no_faq', 'no_viewport', 'no_https', 'noindex', 'image_alt_missing', 'outdated', 'slow_response',
];
const rank = (id: string): number => {
  const i = PRIORITY.indexOf(id);
  return i === -1 ? PRIORITY.length : i;
};

export function pageSignals(input: SignalInput, peers: PeerStats, now: Date = new Date()): Signal[] {
  const { metrics: m, judgments: j, fetch } = input;
  const out: Signal[] = [];
  const add = (s: Signal | null): void => {
    if (s) out.push(s);
  };
  const year = now.getFullYear();

  // ───────────── strengths ─────────────
  if (j.topicDepth && j.topicDepth.value >= 0.7 && j.topicDepth.confidence >= 0.3) {
    add(make('strength', 'deep_content', 'Дълбоко и изчерпателно съдържание', scoreNote(j.topicDepth), 'jev', level(j.topicDepth.confidence)));
  }
  if (m && m.wordCount >= Math.max(1000, (peers.medianWords ?? 0) * 1.25)) {
    add(make('strength', 'long_content', 'Обемно съдържание', `${nbsp(m.wordCount)} думи${peers.medianWords ? ` (медиана в топ резултатите: ${nbsp(Math.round(peers.medianWords))})` : ''}`, 'measured', 'high'));
  }
  if (m && m.keyword.titleCoverage >= 0.999 && m.keyword.inH1) {
    add(make('strength', 'keyword_in_title_h1', 'Ключовата фраза е в заглавието и в H1', m.keyword.startsTitleWithKeyword ? 'Заглавието започва с фразата' : 'Фразата присъства и в двата елемента', 'measured', 'high'));
  }
  if (j.targetsQuery && j.targetsQuery.p >= 0.75) {
    add(make('strength', 'dedicated_to_query', 'Страницата е посветена на търсената фраза', noulNote(j.targetsQuery.p), 'jev', noulLevel(j.targetsQuery.p)));
  }
  if (m) {
    const useful = m.schemaTypes.filter((t) => !GENERIC_SCHEMA.has(t.toLowerCase()));
    if (useful.length > 0) add(make('strength', 'schema_markup', 'Структурирани данни (schema.org)', useful.slice(0, 5).join(', '), 'measured', 'high'));
    if (m.hasFaqSchema || m.hasFaqSection) {
      add(make('strength', 'faq', m.hasFaqSchema ? 'FAQ секция със schema разметка' : 'FAQ секция', m.hasFaqSchema ? 'Подходящо за разширени резултати в Google' : 'Отговаря директно на често задавани въпроси', 'measured', 'high'));
    }
    if (m.images.total >= 5 && m.images.withAlt / m.images.total >= 0.8) {
      add(make('strength', 'image_alt', 'Добри alt текстове на изображенията', `${m.images.withAlt} от ${m.images.total} със alt`, 'measured', 'high'));
    }
    if (m.latestYear !== null && m.latestYear >= year - 1) {
      add(make('strength', 'fresh', 'Актуално съдържание', `Споменава ${m.latestYear}`, 'measured', 'medium'));
    }
  }
  if (j.statesPrices && j.statesPrices.p >= 0.7) {
    add(make('strength', 'pricing', 'Показва цени', m?.priceMentions[0] ? `„${m.priceMentions[0]}“` : noulNote(j.statesPrices.p), m?.priceMentions.length ? 'measured' : 'jev', m?.priceMentions.length ? 'high' : noulLevel(j.statesPrices.p)));
  }
  if (j.showsPortfolio && j.showsPortfolio.p >= 0.7) add(make('strength', 'portfolio', 'Портфолио / примери от работата', noulNote(j.showsPortfolio.p), 'jev', noulLevel(j.showsPortfolio.p)));
  if (j.showsReviews && j.showsReviews.p >= 0.7) add(make('strength', 'reviews', 'Отзиви и социално доказателство', noulNote(j.showsReviews.p), 'jev', noulLevel(j.showsReviews.p)));
  if (j.clearCta && j.clearCta.p >= 0.7) {
    add(make('strength', 'cta', m?.hasContactForm ? 'Ясен призив за действие и контактна форма' : 'Ясен призив за действие', m?.ctaTexts.length ? `„${m.ctaTexts.slice(0, 2).join('“, „')}“` : noulNote(j.clearCta.p), m?.ctaTexts.length ? 'measured' : 'jev', noulLevel(j.clearCta.p)));
  }
  if (j.showsIdentity && j.showsIdentity.p >= 0.7) add(make('strength', 'identity', 'Показва кой стои зад сайта', noulNote(j.showsIdentity.p), 'jev', noulLevel(j.showsIdentity.p)));
  if (fetch.ttfbMs !== null && fetch.ttfbMs > 0 && fetch.ttfbMs < 400 && fetch.status === 'ok') {
    add(make('strength', 'fast_response', 'Бърз сървърен отговор', `${fetch.ttfbMs} ms (измерено от нашия сървър — ориентировъчно)`, 'measured', 'low'));
  }

  // ───────────── weaknesses ─────────────
  if (m) {
    if (m.wordCount < 300) {
      add(make('weakness', 'thin_content', 'Тънко съдържание', `${nbsp(m.wordCount)} думи${m.wordCount < 120 ? ' (възможно е съдържанието да се зарежда с JavaScript)' : ''}`, 'measured', 'high'));
    } else if (peers.medianWords && peers.pages >= 3 && m.wordCount < peers.medianWords * 0.5) {
      add(make('weakness', 'below_median_length', 'Съдържание значително под медианата', `${nbsp(m.wordCount)} думи срещу медиана ${nbsp(Math.round(peers.medianWords))}`, 'measured', 'high'));
    }
    if (m.keyword.titleCoverage < 0.5) {
      add(make('weakness', 'keyword_missing_title', 'Ключовата фраза липсва в заглавието', `Заглавие: „${m.title ?? '—'}“`, 'measured', 'high'));
    }
    if (m.h1.length === 0) add(make('weakness', 'no_h1', 'Няма H1 заглавие', 'Страницата няма основно заглавие', 'measured', 'high'));
    else if (m.h1.length > 1) add(make('weakness', 'multiple_h1', 'Повече от едно H1', `${m.h1.length} H1 елемента`, 'measured', 'high'));
    if (!m.metaDescription) add(make('weakness', 'no_meta', 'Няма мета описание', 'Google ще избере откъс сам', 'measured', 'high'));
    else if (m.metaDescriptionLength < 50 || m.metaDescriptionLength > 200) {
      add(make('weakness', 'meta_length', 'Мета описанието е с неподходяща дължина', `${m.metaDescriptionLength} знака`, 'measured', 'high'));
    }
    if (m.titleLength > 70 || (m.titleLength > 0 && m.titleLength < 20)) {
      add(make('weakness', 'title_length', m.titleLength > 70 ? 'Заглавието е твърде дълго' : 'Заглавието е твърде кратко', `${m.titleLength} знака`, 'measured', 'high'));
    }
    if (m.schemaTypes.filter((t) => !GENERIC_SCHEMA.has(t.toLowerCase())).length === 0) {
      add(make('weakness', 'no_schema', 'Няма структурирани данни', 'Не използва schema.org разметка', 'measured', 'high'));
    }
    if (!m.hasFaqSchema && !m.hasFaqSection && peers.faqShare >= 0.4 && peers.pages >= 3) {
      add(make('weakness', 'no_faq', 'Няма FAQ секция', `${pct(peers.faqShare)} от конкурентите имат`, 'measured', 'medium'));
    }
    if (!m.hasViewport) add(make('weakness', 'no_viewport', 'Не е оптимизиран за мобилни', 'Липсва viewport мета таг', 'measured', 'high'));
    if (!m.https) add(make('weakness', 'no_https', 'Няма HTTPS', 'Сайтът се зарежда по незащитена връзка', 'measured', 'high'));
    if (m.noindex) add(make('weakness', 'noindex', 'Страницата е със „noindex“', 'Google не бива да я индексира', 'measured', 'high'));
    if (m.images.total >= 5 && m.images.withAlt / m.images.total < 0.4) {
      add(make('weakness', 'image_alt_missing', 'Липсват alt текстове', `${m.images.withAlt} от ${m.images.total} със alt`, 'measured', 'high'));
    }
    if (m.latestYear !== null && m.latestYear <= year - 3) {
      add(make('weakness', 'outdated', 'Изглежда остаряло', `Последно споменатата година е ${m.latestYear}`, 'measured', 'medium'));
    }
  }
  if (j.topicDepth && j.topicDepth.value <= 0.4 && j.topicDepth.confidence >= 0.3) {
    add(make('weakness', 'shallow_topic', 'Повърхностно покритие на темата', scoreNote(j.topicDepth), 'jev', level(j.topicDepth.confidence)));
  }
  if (j.genericContent && j.genericContent.p >= 0.7) {
    add(make('weakness', 'generic_text', 'Общи фрази без конкретика', noulNote(j.genericContent.p), 'jev', noulLevel(j.genericContent.p)));
  }
  if (j.targetsQuery && j.targetsQuery.p <= 0.3) {
    add(make('weakness', 'not_dedicated', 'Не е посветена на търсената фраза', noulNote(j.targetsQuery.p), 'jev', noulLevel(j.targetsQuery.p)));
  }
  if (
    j.pageType &&
    j.pageType.confidence >= 0.3 &&
    WEAK_COMMERCIAL_PAGE_TYPES.includes(j.pageType.value) &&
    (peers.dominantIntent === 'transactional' || peers.dominantIntent === 'commercial_investigation')
  ) {
    add(make('weakness', 'off_intent_type', 'Типът страница не съвпада с намерението на търсещите', `${PAGE_TYPE_LABELS[j.pageType.value]} при търсене с намерение „${INTENT_LABELS[peers.dominantIntent]}“`, 'jev', level(j.pageType.confidence)));
  }
  if (j.statesPrices && j.statesPrices.p <= 0.25) add(make('weakness', 'no_pricing', 'Не показва цени', noulNote(j.statesPrices.p), 'jev', noulLevel(j.statesPrices.p)));
  if (j.showsPortfolio && j.showsPortfolio.p <= 0.25) add(make('weakness', 'no_portfolio', 'Няма портфолио или примери', noulNote(j.showsPortfolio.p), 'jev', noulLevel(j.showsPortfolio.p)));
  if (j.showsReviews && j.showsReviews.p <= 0.25) add(make('weakness', 'no_reviews', 'Няма отзиви или социално доказателство', noulNote(j.showsReviews.p), 'jev', noulLevel(j.showsReviews.p)));
  if (j.clearCta && j.clearCta.p <= 0.25) add(make('weakness', 'no_cta', 'Няма ясен призив за действие', noulNote(j.clearCta.p), 'jev', noulLevel(j.clearCta.p)));
  if (j.showsIdentity && j.showsIdentity.p <= 0.25) add(make('weakness', 'no_identity', 'Не показва кой стои зад сайта', noulNote(j.showsIdentity.p), 'jev', noulLevel(j.showsIdentity.p)));
  if (fetch.ttfbMs !== null && fetch.ttfbMs > 1500 && fetch.status === 'ok') {
    add(make('weakness', 'slow_response', 'Бавен сървърен отговор', `${nbsp(fetch.ttfbMs)} ms (измерено от нашия сървър — ориентировъчно)`, 'measured', 'low'));
  }
  return out.sort((a, b) => rank(a.id) - rank(b.id));
}
