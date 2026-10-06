import { z } from 'zod';
import {
  CONFIDENCE_LEVELS,
  ENGINE_IDS,
  INTENTS,
  KEYWORD_SOURCES,
  OPPORTUNITY_LABELS,
  PAGE_TYPES,
} from './domain';
import { MARKET_IDS } from './markets';
import { isValidHostname, normalizeDomainInput } from './urls';

// ───────────────────────── primitives ─────────────────────────

const unit = z.number().min(0).max(1);
const count = z.number().int().min(0);
const iso = z.string();

export const DomainSchema = z
  .string()
  .trim()
  .max(253)
  .transform(normalizeDomainInput)
  .refine(isValidHostname, { message: 'Невалиден домейн' });

export const HttpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Невалиден URL (допустими са само http/https)' },
  );

// ───────────────────────── Jev answer snapshots ─────────────────────────
// Reports keep a compact form of each Jev answer: the decision, how sure Jev was, nothing else.

export const NoulAnswerSchema = z.object({ p: unit });
export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;

export const ScoreAnswerSchema = z.object({
  /** Expected score normalised to 0..1 (raw / (levels - 1)). */
  value: unit,
  /** Expected score in rubric units, may fall between levels. */
  raw: z.number(),
  levels: z.number().int().min(2).max(10),
  confidence: unit,
});
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;

function choiceAnswer<const T extends readonly [string, ...string[]]>(values: T) {
  return z.object({
    value: z.enum(values),
    p: unit,
    confidence: unit,
    runnerUp: z.object({ value: z.enum(values), p: unit }).nullable(),
  });
}
export const PageTypeAnswerSchema = choiceAnswer(PAGE_TYPES);
export type PageTypeAnswer = z.infer<typeof PageTypeAnswerSchema>;
export const IntentAnswerSchema = choiceAnswer(INTENTS);
export type IntentAnswer = z.infer<typeof IntentAnswerSchema>;

// ───────────────────────── SERP ─────────────────────────

export const SerpResultSchema = z.object({
  position: z.number().int().min(1),
  url: z.string(),
  domain: z.string(),
  title: z.string(),
  snippet: z.string(),
});
export type SerpResult = z.infer<typeof SerpResultSchema>;

export const SerpDataSchema = z.object({
  keyword: z.string(),
  market: z.enum(MARKET_IDS),
  fetchedAt: iso,
  provider: z.string(),
  results: z.array(SerpResultSchema),
  peopleAlsoAsk: z.array(z.object({ question: z.string(), snippet: z.string().nullable() })),
  relatedSearches: z.array(z.string()),
  suggestions: z.array(z.string()),
});
export type SerpData = z.infer<typeof SerpDataSchema>;

// ───────────────────────── page evidence (measured, deterministic) ─────────────────────────

export const FetchInfoSchema = z.object({
  status: z.enum(['ok', 'blocked_robots', 'http_error', 'not_html', 'error', 'skipped']),
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  finalUrl: z.string().nullable(),
  ttfbMs: z.number().nullable(),
  bytes: z.number().nullable(),
  fromCache: z.boolean(),
});
export type FetchInfo = z.infer<typeof FetchInfoSchema>;

export const HeadingSchema = z.object({ level: z.number().int().min(1).max(4), text: z.string() });
export type Heading = z.infer<typeof HeadingSchema>;

export const PageMetricsSchema = z.object({
  title: z.string().nullable(),
  titleLength: count,
  metaDescription: z.string().nullable(),
  metaDescriptionLength: count,
  h1: z.array(z.string()),
  headings: z.array(HeadingSchema),
  h2Count: count,
  h3Count: count,
  wordCount: count,
  lang: z.string().nullable(),
  canonical: z.string().nullable(),
  canonicalIsSelf: z.boolean().nullable(),
  noindex: z.boolean(),
  hasViewport: z.boolean(),
  https: z.boolean(),
  schemaTypes: z.array(z.string()),
  hasFaqSchema: z.boolean(),
  hasFaqSection: z.boolean(),
  images: z.object({ total: count, withAlt: count }),
  links: z.object({ internal: count, external: count }),
  hasContactForm: z.boolean(),
  phones: count,
  emails: count,
  ctaTexts: z.array(z.string()),
  priceMentions: z.array(z.string()),
  socialProof: z.array(z.string()),
  navLabels: z.array(z.string()),
  latestYear: z.number().int().nullable(),
  /** ISO date the page says it was last changed (schema.org dateModified, article:modified_time, <time>), else null. */
  modifiedAt: z.string().nullable().default(null),
  /** ISO date the page says it was first published, else null. */
  publishedAt: z.string().nullable().default(null),
  tables: count.default(0),
  lists: count.default(0),
  /** Distinct other sites the page links to: a proxy for "cites its sources". */
  externalDomains: count.default(0),
  /** A byline, an author box or schema.org author markup. */
  hasAuthor: z.boolean().default(false),
  /** Question-and-answer pairs found in an FAQ section or FAQPage markup. */
  faqQuestions: count.default(0),
  keyword: z.object({
    inTitle: z.boolean(),
    inH1: z.boolean(),
    inUrl: z.boolean(),
    inMeta: z.boolean(),
    titleCoverage: unit,
    bodyCoverage: unit,
    startsTitleWithKeyword: z.boolean(),
  }),
});
export type PageMetrics = z.infer<typeof PageMetricsSchema>;

// ───────────────────────── Jev judgments on a page ─────────────────────────

export const PageJudgmentsSchema = z.object({
  pageType: PageTypeAnswerSchema.optional(),
  intentServed: IntentAnswerSchema.optional(),
  targetsQuery: NoulAnswerSchema.optional(),
  localToMarket: NoulAnswerSchema.optional(),
  topicDepth: ScoreAnswerSchema.optional(),
  needSatisfied: ScoreAnswerSchema.optional(),
  genericContent: NoulAnswerSchema.optional(),
  statesPrices: NoulAnswerSchema.optional(),
  showsPortfolio: NoulAnswerSchema.optional(),
  showsReviews: NoulAnswerSchema.optional(),
  clearCta: NoulAnswerSchema.optional(),
  showsIdentity: NoulAnswerSchema.optional(),
});
export type PageJudgments = z.infer<typeof PageJudgmentsSchema>;

export const CompositeScoresSchema = z.object({
  content: unit.nullable(),
  optimization: unit.nullable(),
  trust: unit.nullable(),
  conversion: unit.nullable(),
  overall: unit.nullable(),
});
export type CompositeScores = z.infer<typeof CompositeScoresSchema>;

export const SignalSchema = z.object({
  id: z.string(),
  kind: z.enum(['strength', 'weakness']),
  label: z.string(),
  evidence: z.string(),
  source: z.enum(['measured', 'jev']),
  confidence: z.enum(CONFIDENCE_LEVELS),
});
export type Signal = z.infer<typeof SignalSchema>;

export const PageAnalysisSchema = z.object({
  position: z.number().int().nullable(),
  url: z.string(),
  domain: z.string(),
  title: z.string(),
  snippet: z.string(),
  role: z.enum(['serp', 'own', 'tracked', 'manual']),
  fetch: FetchInfoSchema,
  metrics: PageMetricsSchema.nullable(),
  judgments: PageJudgmentsSchema,
  /** 'complete' = every Jev slice answered; 'partial' = some failed; 'none' = Jev unavailable for this page. */
  judgmentStatus: z.enum(['complete', 'partial', 'none']),
  composite: CompositeScoresSchema,
  signals: z.array(SignalSchema),
});
export type PageAnalysis = z.infer<typeof PageAnalysisSchema>;

// ───────────────────────── SERP assessment (how beatable is a results page?) ─────────────────────────

export const SerpResultStrengthSchema = z.object({
  position: z.number().int(),
  domain: z.string(),
  url: z.string(),
  title: z.string(),
  pageType: PageTypeAnswerSchema.nullable(),
  targetsQuery: unit.nullable(),
  titleMatch: unit,
  /** 0 = trivially beatable, 1 = very strong result. */
  strength: unit,
});
export type SerpResultStrength = z.infer<typeof SerpResultStrengthSchema>;

export const SerpAssessmentSchema = z.object({
  /** 0 = very strong SERP, 1 = very weak SERP (good for a newcomer). */
  weakness: unit,
  difficulty: z.enum(['easy', 'medium', 'hard']),
  dominantPageType: z.enum(PAGE_TYPES).nullable(),
  pageTypeShare: z.record(z.string(), z.number()),
  components: z.object({
    pageTypeMismatch: unit,
    notDedicated: unit,
    titleGap: unit,
    topicalDominance: unit,
    thinContent: unit.nullable(),
  }),
  results: z.array(SerpResultStrengthSchema),
});
export type SerpAssessment = z.infer<typeof SerpAssessmentSchema>;

// ───────────────────────── opportunities ─────────────────────────

export const OpportunitySchema = z.object({
  keyword: z.string(),
  normalized: z.string(),
  sources: z.array(z.enum(KEYWORD_SOURCES)),
  /** Monthly searches (Google Ads data via DataForSEO); null = unknown. */
  volume: z.number().nullable(),
  cpc: z.number().nullable(),
  competitionIndex: z.number().nullable(),
  relevance: unit,
  commercial: unit,
  intent: IntentAnswerSchema.nullable(),
  assessment: SerpAssessmentSchema.nullable(),
  specificity: unit,
  demand: unit.nullable(),
  /** 0..100 composite, see src/server/analysis/opportunities.ts for the formula. */
  score: z.number().min(0).max(100),
  label: z.enum(OPPORTUNITY_LABELS),
  reasons: z.array(z.string()),
  recommendedFormat: z.enum(PAGE_TYPES).nullable(),
  ownPosition: z.number().int().nullable(),
  /** True when the SERP was crawled and judged in depth (the seed keyword). */
  deep: z.boolean(),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

// ───────────────────────── competitors ─────────────────────────

export const CompetitorProfileSchema = z.object({
  domain: z.string(),
  role: z.enum(['own', 'tracked', 'discovered']),
  visibility: z.object({
    keywordsSeen: count,
    top3: count,
    top10: count,
    bestPosition: z.number().int().nullable(),
    avgPosition: z.number().nullable(),
    shareOfVoice: unit,
  }),
  seedPage: z.object({ url: z.string(), position: z.number().int().nullable(), title: z.string() }).nullable(),
  scorecard: CompositeScoresSchema.nullable(),
  strengths: z.array(SignalSchema),
  weaknesses: z.array(SignalSchema),
  vulnerableKeywords: z.array(
    z.object({ keyword: z.string(), position: z.number().int(), reason: z.string() }),
  ),
});
export type CompetitorProfile = z.infer<typeof CompetitorProfileSchema>;

// ───────────────────────── content brief ─────────────────────────

export const ContentBriefSchema = z.object({
  keyword: z.string(),
  pageType: z.enum(PAGE_TYPES).nullable(),
  intent: z.enum(INTENTS).nullable(),
  summary: z.string(),
  length: z
    .object({ min: count, target: count, max: count, medianTop: count, basedOn: count })
    .nullable(),
  titlePatterns: z
    .object({
      avgLength: z.number(),
      startsWithKeywordShare: unit,
      commonModifiers: z.array(z.object({ term: z.string(), share: unit })),
    })
    .nullable(),
  mustCover: z.array(z.object({ term: z.string(), pages: count, share: unit })),
  subtopics: z.array(z.object({ topic: z.string(), pages: count, examples: z.array(z.string()) })),
  questions: z.array(z.object({ question: z.string(), source: z.enum(['paa', 'headings']) })),
  schemaTypes: z.array(z.object({ type: z.string(), pages: count })),
  trustElements: z.array(z.object({ id: z.string(), label: z.string(), pages: count, share: unit })),
  /** Gaps of the user's own page vs. the SERP (null when no own page was analysed). */
  ownGaps: z
    .array(z.object({ kind: z.enum(['term', 'subtopic', 'element', 'length']), label: z.string(), detail: z.string() }))
    .nullable(),
  checklist: z.array(z.string()),
});
export type ContentBrief = z.infer<typeof ContentBriefSchema>;

// ───────────────────────── request / settings ─────────────────────────

export const AnalyzeOptionsSchema = z.object({
  /** How many top results to crawl and judge in depth (seed keyword only). */
  deepPages: z.number().int().min(1).max(15).default(10),
  /** Discover related keywords and rank them as opportunities. */
  expandKeywords: z.boolean().default(true),
  /** Max candidate keywords whose SERP is fetched and judged. */
  maxCandidates: z.number().int().min(0).max(40).default(20),
  /** Results per SERP request. */
  serpDepth: z.union([z.literal(10), z.literal(20)]).default(10),
});
export type AnalyzeOptions = z.infer<typeof AnalyzeOptionsSchema>;

export const AnalyzeRequestSchema = z.object({
  keyword: z.string().trim().min(2, 'Въведи ключова дума').max(120),
  market: z.enum(MARKET_IDS).default('bg'),
  ownDomain: DomainSchema.nullish().transform((v) => v ?? null),
  /** The user's own page targeting this keyword (optional; enables gap analysis). */
  ownUrl: HttpUrlSchema.nullish().transform((v) => v ?? null),
  /** Extra competitor domains that must always be reported on, even outside the top results. */
  competitors: z.array(DomainSchema).max(30).default([]),
  /** Competitor URLs to analyse directly (the only input in no-SERP "manual" mode). */
  manualUrls: z.array(HttpUrlSchema).max(15).default([]),
  businessDescription: z.string().trim().max(600).default(''),
  options: AnalyzeOptionsSchema.prefault({}),
});
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;
/** What a client may send (every defaulted field optional); the server parses it into AnalyzeRequest. */
export type AnalyzeRequestInput = z.input<typeof AnalyzeRequestSchema>;

export const TrackedCompetitorSchema = z.object({
  domain: DomainSchema,
  note: z.string().trim().max(200).default(''),
  addedAt: iso,
});
export type TrackedCompetitor = z.infer<typeof TrackedCompetitorSchema>;

export const BrandNameSchema = z.string().trim().min(2).max(60);

export const SettingsSchema = z.object({
  businessDescription: z.string().trim().max(600).default(''),
  ownDomain: DomainSchema.nullable().default(null),
  /** Names an AI answer may use for the business (so a mention is recognised). */
  brandNames: z.array(BrandNameSchema).max(10).default([]),
  market: z.enum(MARKET_IDS).default('bg'),
  competitors: z.array(TrackedCompetitorSchema).max(100).default([]),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = z.object({
  businessDescription: z.string().trim().max(600).optional(),
  ownDomain: DomainSchema.nullable().optional(),
  brandNames: z.array(BrandNameSchema).max(10).optional(),
  market: z.enum(MARKET_IDS).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

// ───────────────────────── report ─────────────────────────

export const UsageSchema = z.object({
  serpCalls: count,
  serpCacheHits: count,
  volumeCalls: count,
  jevRequests: count,
  jevInputTokens: count,
  jevOutputTokens: count,
  jevFailures: count,
  estimatedJevCostUsd: z.number(),
  pagesFetched: count,
  pagesBlocked: count,
  pagesFailed: count,
  durationMs: count,
});
export type Usage = z.infer<typeof UsageSchema>;

export const SeedAnalysisSchema = z.object({
  keyword: z.string(),
  serp: SerpDataSchema,
  pages: z.array(PageAnalysisSchema),
  ownPage: PageAnalysisSchema.nullable(),
  intent: z.object({
    dominantPageType: z.enum(PAGE_TYPES).nullable(),
    dominantIntent: z.enum(INTENTS).nullable(),
    pageTypeShare: z.record(z.string(), z.number()),
    intentShare: z.record(z.string(), z.number()),
    keywordIntent: IntentAnswerSchema.nullable(),
    /** Does Jev's reading of the query agree with what Google actually shows? null = unknown. */
    agreement: z.boolean().nullable(),
  }),
  assessment: SerpAssessmentSchema.nullable(),
  stats: z.object({
    pagesAnalysed: count,
    pagesFetched: count,
    medianWordCount: count.nullable(),
    p75WordCount: count.nullable(),
  }),
  ownRank: z.object({ position: z.number().int(), url: z.string() }).nullable(),
});
export type SeedAnalysis = z.infer<typeof SeedAnalysisSchema>;

export const ReportSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  status: z.enum(['complete', 'partial']),
  mode: z.enum(['live', 'demo']),
  createdAt: iso,
  finishedAt: iso,
  request: AnalyzeRequestSchema,
  providers: z.object({
    serp: z.string(),
    volume: z.string().nullable(),
    jev: z.object({ model: z.string(), endpoint: z.string() }),
  }),
  usage: UsageSchema,
  seed: SeedAnalysisSchema,
  opportunities: z.array(OpportunitySchema),
  competitors: z.array(CompetitorProfileSchema),
  brief: ContentBriefSchema,
  warnings: z.array(z.string()),
});
export type Report = z.infer<typeof ReportSchema>;

export const ReportSummarySchema = z.object({
  id: z.string(),
  keyword: z.string(),
  market: z.enum(MARKET_IDS),
  mode: z.enum(['live', 'demo']),
  status: z.enum(['complete', 'partial']),
  createdAt: iso,
  quickWins: count,
  opportunities: count,
  difficulty: z.enum(['easy', 'medium', 'hard']).nullable(),
  topDomain: z.string().nullable(),
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

// ───────────────────────── jobs / API ─────────────────────────

export const PIPELINE_STEPS = [
  'queued',
  'serp',
  'crawl',
  'judge',
  'expand',
  'candidates',
  'volumes',
  'score',
  'save',
  'done',
  // whole-site audit
  'discover',
  'elements',
  'competitors',
  'questions',
  'geo',
  'fixes',
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const ProgressEventSchema = z.object({
  jobId: z.string(),
  step: z.enum(PIPELINE_STEPS),
  pct: z.number().min(0).max(100),
  message: z.string(),
  at: iso,
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

export const JobStateSchema = z.object({
  id: z.string(),
  /** 'keyword' = the keyword analysis; 'site' = the whole-site audit. */
  kind: z.enum(['keyword', 'site']).default('keyword'),
  status: z.enum(['queued', 'running', 'done', 'error']),
  /** The keyword, or the domain for a site audit. */
  keyword: z.string(),
  createdAt: iso,
  last: ProgressEventSchema.nullable(),
  reportId: z.string().nullable(),
  error: z.string().nullable(),
});
export type JobState = z.infer<typeof JobStateSchema>;

/** One row of the cross-report competitor overview. */
export interface CompetitorOverviewRow {
  domain: string;
  tracked: boolean;
  own: boolean;
  reports: number;
  keywordsSeen: number;
  avgShareOfVoice: number;
  bestPosition: number | null;
  lastSeen: string;
}

export const EngineStatusSchema = z.object({
  id: z.enum(ENGINE_IDS),
  label: z.string(),
  configured: z.boolean(),
  model: z.string().nullable(),
});
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

export const StatusResponseSchema = z.object({
  version: z.string(),
  demo: z.boolean(),
  authRequired: z.boolean(),
  jev: z.object({
    configured: z.boolean(),
    flavor: z.enum(['typesafe', 'vercel', 'custom', 'demo', 'none']),
    model: z.string().nullable(),
    host: z.string().nullable(),
  }),
  serp: z.object({ provider: z.enum(['serper', 'dataforseo', 'demo', 'none']), configured: z.boolean() }),
  volume: z.object({ provider: z.enum(['dataforseo', 'demo', 'none']), configured: z.boolean() }),
  limits: z.object({ maxCandidates: z.number(), maxDeepPages: z.number() }),
  /** The AI assistants that can be asked (GEO). */
  engines: z.array(EngineStatusSchema),
  /** The language model that writes proposals and checklists; none = fixed rules only. */
  writer: z.object({ configured: z.boolean(), engine: z.enum(ENGINE_IDS).nullable() }),
  /** Caps for the whole-site audit. */
  audit: z.object({ maxPages: z.number(), maxQuestions: z.number(), maxEngineCalls: z.number() }),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
