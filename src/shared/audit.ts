import { z } from 'zod';
import { ENGINE_IDS, PAGE_TYPES } from './domain';
import { MARKET_IDS } from './markets';
import { DomainSchema, FetchInfoSchema, PageMetricsSchema } from './schemas';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Whole-site audit ("Мой сайт"): SEO elements judged one by one, competitor pages worth copying, buyer questions
// the site does not answer, how citable every page is for AI search — and what ChatGPT, Claude and Gemini actually
// say. Everything the server produces and the UI renders is described here, so both sides compile against one contract.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const unit = z.number().min(0).max(1);
const count = z.number().int().min(0);
const iso = z.string();

// ───────────────────────── vocabulary ─────────────────────────

export { ENGINE_IDS, ENGINE_LABELS, type EngineId } from './domain';

/** What makes an AI assistant pick a page as a source. Eight criteria, each 0..1 (null = could not be judged). */
export const CRITERIA = ['answer', 'faq', 'author', 'fresh', 'sources', 'facts', 'compare', 'links'] as const;
export type Criterion = (typeof CRITERIA)[number];
export const CRITERION_LABELS: Record<Criterion, string> = {
  answer: 'Отговор в началото',
  faq: 'FAQ и въпроси',
  author: 'Автор и доверие',
  fresh: 'Актуалност',
  sources: 'Цитирани източници',
  facts: 'Конкретни факти',
  compare: 'Таблица за сравнение',
  links: 'Вътрешни връзки',
};

export const SEO_ELEMENTS = ['url', 'title', 'meta', 'h1', 'h2', 'intro', 'faq', 'schema', 'canonical', 'links', 'images'] as const;
export type SeoElement = (typeof SEO_ELEMENTS)[number];
export const ELEMENT_LABELS: Record<SeoElement, string> = {
  url: 'URL',
  title: 'Заглавие (title)',
  meta: 'Мета описание',
  h1: 'H1',
  h2: 'Подзаглавия (H2)',
  intro: 'Въведение',
  faq: 'FAQ',
  schema: 'Schema.org',
  canonical: 'Canonical',
  links: 'Вътрешни връзки',
  images: 'Картинки (alt)',
};

/** What a buyer is trying to do when they ask the question. */
export const QUESTION_STAGES = ['discover', 'compare', 'price', 'trust', 'howto', 'local'] as const;
export type QuestionStage = (typeof QUESTION_STAGES)[number];
export const STAGE_LABELS: Record<QuestionStage, string> = {
  discover: 'Търси доставчик',
  compare: 'Сравнява',
  price: 'Пита за цена',
  trust: 'Проверява доверие',
  howto: 'Как се прави',
  local: 'Търси наблизо',
};

export const QUESTION_SOURCES = ['llm', 'paa', 'related', 'suggest', 'template'] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

export const NEXT_STEPS = ['write_guide', 'answer_at_top', 'write_versus', 'add_proof', 'add_prices', 'add_local', 'none'] as const;
export type NextStep = (typeof NEXT_STEPS)[number];
export const NEXT_STEP_LABELS: Record<NextStep, string> = {
  write_guide: 'Напиши ръководство',
  answer_at_top: 'Отговори в началото',
  write_versus: 'Напиши сравнение',
  add_proof: 'Добави доказателства',
  add_prices: 'Добави цени',
  add_local: 'Добави местна страница',
  none: '—',
};

/** Why a page is not picked by an AI engine. */
export const SKIP_REASONS = ['no_page', 'too_thin', 'wrong_angle', 'no_data', 'no_answer_first', 'weak_trust', 'outdated'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  no_page: 'Няма страница',
  too_thin: 'Твърде кратка',
  wrong_angle: 'Грешен ъгъл',
  no_data: 'Без конкретни данни',
  no_answer_first: 'Отговорът не е в началото',
  weak_trust: 'Слабо доверие и автор',
  outdated: 'Остаряла',
};

/** What kind of source an engine prefers for a question. */
export const SOURCE_KINDS = ['authority', 'compare', 'brand', 'community', 'media', 'guide', 'other'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  authority: 'Авторитетен източник',
  compare: 'Сравнение',
  brand: 'Страница на марка',
  community: 'Форум / общност',
  media: 'Медия',
  guide: 'Ръководство',
  other: 'Друго',
};

// ───────────────────────── request ─────────────────────────

export const SiteAuditOptionsSchema = z.object({
  /** How many pages of the site are audited (the server caps it further with MAX_AUDIT_PAGES). */
  maxPages: z.number().int().min(1).max(500).default(40),
  /** Competitor pages read in depth (for "pages to steal" and for "why the AI cites them"). */
  competitorPages: z.number().int().min(0).max(30).default(12),
  /** Buyer questions generated and checked (the server caps it with MAX_GEO_QUESTIONS). */
  questions: z.number().int().min(0).max(200).default(24),
  /** Engines to ask. Empty = every engine that is configured. */
  engines: z.array(z.enum(ENGINE_IDS)).max(3).default([]),
  /** Pages whose Google position is looked up (one SERP request each). */
  rankChecks: z.number().int().min(0).max(40).default(10),
});
export type SiteAuditOptions = z.infer<typeof SiteAuditOptionsSchema>;

export const SiteAuditRequestSchema = z.object({
  /** The site to audit. */
  domain: DomainSchema,
  market: z.enum(MARKET_IDS).default('bg'),
  /** What the business sells: needed to ask the questions its buyers ask. */
  businessDescription: z.string().trim().min(10, 'Опиши с едно-две изречения какво предлага бизнесът').max(600),
  /** Names an AI answer may use for the business (the brand, the legal name, the domain without the dot…). */
  brandNames: z.array(z.string().trim().min(2).max(60)).max(10).default([]),
  /** Competitor domains to recognise in AI answers and to read pages from. */
  competitors: z.array(DomainSchema).max(30).default([]),
  options: SiteAuditOptionsSchema.prefault({}),
});
export type SiteAuditRequest = z.infer<typeof SiteAuditRequestSchema>;
export type SiteAuditRequestInput = z.input<typeof SiteAuditRequestSchema>;

// ───────────────────────── pages ─────────────────────────

export const CriteriaScoresSchema = z.object({
  answer: unit.nullable(),
  faq: unit.nullable(),
  author: unit.nullable(),
  fresh: unit.nullable(),
  sources: unit.nullable(),
  facts: unit.nullable(),
  compare: unit.nullable(),
  links: unit.nullable(),
});
export type CriteriaScores = z.infer<typeof CriteriaScoresSchema>;

export const CitabilitySchema = z.object({
  /** 0..1 index of how likely an AI assistant is to pick the page, from the eight criteria (see weights.ts). */
  now: unit,
  /** The same index if the first fix were made (a projection, not a measurement). */
  after: unit,
  /** The criterion with the biggest weighted gap, and what to do about it. */
  fixFirst: z.object({ criterion: z.enum(CRITERIA), action: z.string() }).nullable(),
});
export type Citability = z.infer<typeof CitabilitySchema>;

export const SitePageSchema = z.object({
  url: z.string(),
  path: z.string(),
  fetch: FetchInfoSchema,
  metrics: PageMetricsSchema.nullable(),
  /** Jev's reading of what kind of page this is. */
  type: z.enum(PAGE_TYPES).nullable(),
  /** The phrase the page is about (taken from its H1/title); used for the Google position lookup. */
  phrase: z.string().nullable(),
  /** Google position of this page for `phrase`; null = not looked up or not in the results. */
  rank: z.number().int().nullable(),
  /** Months since the page was last changed or published; null = no date on the page. */
  ageMonths: z.number().nullable(),
  words: count,
  criteria: CriteriaScoresSchema,
  citability: CitabilitySchema.nullable(),
  /** How many of the page's SEO elements Jev would change. */
  elementsToChange: count,
  judgmentStatus: z.enum(['complete', 'partial', 'none']),
});
export type SitePage = z.infer<typeof SitePageSchema>;

// ───────────────────────── panel 01: SEO elements ─────────────────────────

export const ElementVerdictSchema = z.object({
  url: z.string(),
  element: z.enum(SEO_ELEMENTS),
  /** The current value, shortened ("липсва" when there is none). */
  now: z.string().max(200),
  verdict: z.enum(['keep', 'change']),
  /** How sure the verdict is: 1 for an objective rule, Jev's confidence for a judgement. */
  confidence: unit,
  /** Why, in a sentence. */
  reason: z.string().max(240),
  /** What to change it to (text) or do (action); null when the verdict is keep. */
  proposal: z.string().max(400).nullable(),
  source: z.enum(['rule', 'jev']),
  /** Who wrote the proposal: a fixed rule, or a language model. */
  proposalBy: z.enum(['rule', 'llm']).nullable(),
  /** 0..1 — how much the fix matters (page weight × how far the page is from the top). Used for sorting. */
  impact: unit,
});
export type ElementVerdict = z.infer<typeof ElementVerdictSchema>;

// ───────────────────────── panel 02: competitor pages ─────────────────────────

export const CompetitorPageSchema = z.object({
  domain: z.string(),
  url: z.string(),
  title: z.string(),
  /** The phrase whose results it came from. */
  phrase: z.string(),
  /** Our page that competes for the same phrase, when there is one. */
  ourUrl: z.string().nullable(),
  googleRank: z.number().int().nullable(),
  /** Share of AI answers (all engines) that cite this page's domain; null = no AI check ran. */
  aiShare: unit.nullable(),
  type: z.enum(PAGE_TYPES).nullable(),
  scores: z.object({ answer: unit.nullable(), depth: unit.nullable(), proof: unit.nullable(), schema: unit.nullable(), fresh: unit.nullable() }),
  overall: unit.nullable(),
  verdict: z.enum(['steal', 'skip']),
  why: z.string().max(240),
  /** Concrete things the page does that ours does not. */
  techniques: z.array(z.string().max(160)).max(6),
});
export type CompetitorPage = z.infer<typeof CompetitorPageSchema>;

// ───────────────────────── panel 03: buyer questions ─────────────────────────

export const BuyerQuestionSchema = z.object({
  id: z.string(),
  text: z.string().max(200),
  stage: z.enum(QUESTION_STAGES),
  source: z.enum(QUESTION_SOURCES),
  /** Monthly searches when a volume source exists; null = unknown. */
  volume: z.number().nullable(),
  /** The page of ours that answers it best; null = none came close. */
  bestPage: z.string().nullable(),
  /** 0..1 — how fully that page answers the question (Jev). */
  match: unit.nullable(),
  verdict: z.enum(['no_page', 'weak', 'answered']),
  nextStep: z.enum(NEXT_STEPS),
  /** Domains the AI engines cite for this question, most frequent first (empty when no AI check ran). */
  aiCites: z.array(z.string()).max(4),
  /** Engines whose answer cites or names us. */
  citedBy: z.array(z.enum(ENGINE_IDS)),
});
export type BuyerQuestion = z.infer<typeof BuyerQuestionSchema>;

// ───────────────────────── GEO: what the AI engines say ─────────────────────────

export const EngineRunSchema = z.object({
  engine: z.enum(ENGINE_IDS),
  label: z.string(),
  model: z.string(),
  /** True when the engine had its web search tool (so its answers carry sources). */
  search: z.boolean(),
  asked: count,
  answered: count,
  failed: count,
  citingUs: count,
  skippingUs: count,
  /** Share of answered questions in which we are cited or named, with a 95% Wilson interval. */
  rate: unit,
  rateLow: unit,
  rateHigh: unit,
  citedInstead: z.object({ domain: z.string(), answers: count }).nullable(),
  topCited: z.array(z.object({ domain: z.string(), answers: count, share: unit })).max(10),
  usage: z.object({
    calls: count,
    inputTokens: count,
    outputTokens: count,
    searches: count,
    /** Approximate (token prices plus a per-search fee); null when the model's price is unknown. */
    estimatedCostUsd: z.number().nullable(),
  }),
});
export type EngineRun = z.infer<typeof EngineRunSchema>;

export const AnswerRecordSchema = z.object({
  engine: z.enum(ENGINE_IDS),
  questionId: z.string(),
  /** cited = our domain is among the sources; named = our brand is in the text; missing = neither; failed = no answer. */
  status: z.enum(['cited', 'named', 'missing', 'failed']),
  latencyMs: count,
  /** Our place among the cited sources (1 = first); null when not cited. */
  position: z.number().int().nullable(),
  /** Our share of the cited sources (0..1). */
  share: unit,
  /** How warmly the answer speaks about us when it names us (Jev); null when it does not. */
  sentiment: unit.nullable(),
  citations: z.array(z.object({ domain: z.string(), url: z.string(), title: z.string() })).max(12),
  /** Known competitors named in the text. */
  brands: z.array(z.string()).max(10),
  /** The start of the answer. */
  excerpt: z.string().max(500),
  error: z.string().nullable(),
});
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>;

export const CriteriaDetailSchema = z.object({
  criteria: CriteriaScoresSchema,
  /** The eight criteria combined, 0..10. */
  score10: z.number().min(0).max(10),
});

/** Why one engine skips us for one question, and what it cites instead. */
export const SkipAnalysisSchema = z.object({
  engine: z.enum(ENGINE_IDS),
  questionId: z.string(),
  question: z.string(),
  ourPage: z.object({
    url: z.string().nullable(),
    exists: z.boolean(),
    words: count.nullable(),
    ageMonths: z.number().nullable(),
    detail: CriteriaDetailSchema.nullable(),
  }),
  winner: z.object({ domain: z.string(), url: z.string().nullable(), kind: z.enum(SOURCE_KINDS) }).nullable(),
  reasons: z.array(z.enum(SKIP_REASONS)).max(4),
  action: z.enum(['create', 'rewrite']),
});
export type SkipAnalysis = z.infer<typeof SkipAnalysisSchema>;

/** A page an engine cites, read to learn why. */
export const WinnerPageSchema = z.object({
  engine: z.enum(ENGINE_IDS),
  domain: z.string(),
  url: z.string(),
  title: z.string(),
  kind: z.enum(SOURCE_KINDS),
  /** How many of the lost answers cite it. */
  citedIn: count,
  /** Plain reasons it is cited ("отговор в първите 40 думи", "таблица за сравнение", …). */
  whyCited: z.array(z.string().max(160)).max(6),
  /** Six axes for the radar: answer, entity (facts), faq, author, fresh, sources. */
  radar: z.object({ answer: unit.nullable(), entity: unit.nullable(), faq: unit.nullable(), author: unit.nullable(), fresh: unit.nullable(), sources: unit.nullable() }),
  score10: z.number().min(0).max(10),
  words: count.nullable(),
});
export type WinnerPage = z.infer<typeof WinnerPageSchema>;

export const GeoSchema = z.object({
  engines: z.array(EngineRunSchema),
  answers: z.array(AnswerRecordSchema),
  skips: z.array(SkipAnalysisSchema),
  winners: z.array(WinnerPageSchema),
});
export type Geo = z.infer<typeof GeoSchema>;

// ───────────────────────── the plan ─────────────────────────

export const FixPlanSchema = z.object({
  id: z.string(),
  kind: z.enum(['create', 'rewrite']),
  /** The page to rewrite; null when the page does not exist yet. */
  url: z.string().nullable(),
  /** Where a new page could live (a slug under the site's own pattern). */
  suggestedPath: z.string().nullable(),
  title: z.string().max(160),
  /** The buyer questions this page should answer. */
  questions: z.array(z.string().max(200)).max(8),
  engines: z.array(z.enum(ENGINE_IDS)),
  /** 0..1 — how much is lost today (share of lost answers × how many engines). Used for sorting. */
  priority: unit,
  citability: z.object({ now: unit, after: unit }).nullable(),
  /** Steps in the order to do them. */
  checklist: z.array(z.object({ id: z.string(), text: z.string().max(300), why: z.string().max(240) })).max(12),
  writtenBy: z.enum(['rules', 'llm']),
});
export type FixPlan = z.infer<typeof FixPlanSchema>;

// ───────────────────────── the report ─────────────────────────

export const SiteUsageSchema = z.object({
  jevRequests: count,
  jevInputTokens: count,
  jevOutputTokens: count,
  jevFailures: count,
  estimatedJevCostUsd: z.number(),
  serpCalls: count,
  pagesFetched: count,
  pagesFailed: count,
  engineCalls: count,
  /** null when no engine ran or a model's price is unknown. */
  estimatedEngineCostUsd: z.number().nullable(),
  writerCalls: count,
  durationMs: count,
});
export type SiteUsage = z.infer<typeof SiteUsageSchema>;

export const SiteAuditSummaryFigures = z.object({
  elementsToChange: count,
  elementsTotal: count,
  pagesToSteal: count,
  competitorPagesTotal: count,
  questionsNoPage: count,
  questionsTotal: count,
  /** Mean citability index over the audited pages; null when none could be judged. */
  citabilityNow: unit.nullable(),
  citabilityAfter: unit.nullable(),
  /** Mean share of answers that cite or name us over the engines that ran; null when no engine ran. */
  citationRate: unit.nullable(),
});
export type SiteAuditFigures = z.infer<typeof SiteAuditSummaryFigures>;

export const SiteAuditReportSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  kind: z.literal('site'),
  status: z.enum(['complete', 'partial']),
  mode: z.enum(['live', 'demo']),
  createdAt: iso,
  finishedAt: iso,
  request: SiteAuditRequestSchema,
  providers: z.object({
    serp: z.string().nullable(),
    jev: z.object({ model: z.string(), endpoint: z.string() }),
    engines: z.array(z.object({ engine: z.enum(ENGINE_IDS), model: z.string(), search: z.boolean() })),
    /** The language model that wrote proposals and checklists; null = fixed rules only. */
    writer: z.string().nullable(),
  }),
  usage: SiteUsageSchema,
  site: z.object({
    domain: z.string(),
    pagesFound: count,
    pagesAudited: count,
    /** Where the page list came from. */
    source: z.enum(['sitemap', 'links', 'single']),
    truncated: z.boolean(),
  }),
  pages: z.array(SitePageSchema),
  elements: z.array(ElementVerdictSchema),
  competitorPages: z.array(CompetitorPageSchema),
  questions: z.array(BuyerQuestionSchema),
  geo: GeoSchema.nullable(),
  plan: z.array(FixPlanSchema),
  figures: SiteAuditSummaryFigures,
  warnings: z.array(z.string()),
});
export type SiteAuditReport = z.infer<typeof SiteAuditReportSchema>;

export const SiteAuditListItemSchema = z.object({
  id: z.string(),
  domain: z.string(),
  market: z.enum(MARKET_IDS),
  mode: z.enum(['live', 'demo']),
  status: z.enum(['complete', 'partial']),
  createdAt: iso,
  pagesAudited: count,
  figures: SiteAuditSummaryFigures,
});
export type SiteAuditListItem = z.infer<typeof SiteAuditListItemSchema>;
