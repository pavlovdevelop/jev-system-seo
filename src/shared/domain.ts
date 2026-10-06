// Domain vocabulary shared by the server (analysis) and the web UI (rendering).
// Keep this file free of runtime dependencies so the browser bundle stays small.

export const PAGE_TYPES = [
  'service_page',
  'company_homepage',
  'blog_article',
  'comparison_listicle',
  'directory_marketplace',
  'platform_or_tool',
  'forum_or_social',
  'news_or_media',
  'ecommerce_product',
  'other',
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const INTENTS = [
  'informational',
  'commercial_investigation',
  'transactional',
  'navigational',
  'local',
  'other',
] as const;
export type Intent = (typeof INTENTS)[number];

export const OPPORTUNITY_LABELS = ['quick_win', 'good', 'hard', 'skip'] as const;
export type OpportunityLabel = (typeof OPPORTUNITY_LABELS)[number];

export const KEYWORD_SOURCES = ['seed', 'related', 'people_also_ask', 'autocomplete', 'competitor_terms', 'modifier'] as const;
export type KeywordSource = (typeof KEYWORD_SOURCES)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  service_page: 'Страница за услуга',
  company_homepage: 'Начална страница на фирма',
  blog_article: 'Блог статия / ръководство',
  comparison_listicle: 'Сравнение / класация',
  directory_marketplace: 'Директория / платформа за обяви',
  platform_or_tool: 'Платформа / конструктор / инструмент',
  forum_or_social: 'Форум / социална мрежа',
  news_or_media: 'Новина / медия',
  ecommerce_product: 'Продукт / категория в магазин',
  other: 'Друго',
};

export const INTENT_LABELS: Record<Intent, string> = {
  informational: 'Информационен',
  commercial_investigation: 'Сравнява преди покупка',
  transactional: 'Готов да поръча',
  navigational: 'Търси конкретна марка',
  local: 'Локален',
  other: 'Друго',
};

export const OPPORTUNITY_LABEL_TEXT: Record<OpportunityLabel, string> = {
  quick_win: 'Бърза победа',
  good: 'Добра възможност',
  hard: 'Трудна',
  skip: 'Пропусни',
};

export const KEYWORD_SOURCE_LABELS: Record<KeywordSource, string> = {
  seed: 'Основна фраза',
  related: 'Сродни търсения',
  people_also_ask: 'Хората питат също',
  autocomplete: 'Автоматични предложения',
  competitor_terms: 'Термини на конкурентите',
  modifier: 'Вариация (цена, град, …)',
};

/** Page types that are usually a weak match for a commercial "hire/buy" query. */
export const WEAK_COMMERCIAL_PAGE_TYPES: readonly PageType[] = [
  'forum_or_social',
  'news_or_media',
  'directory_marketplace',
  'blog_article',
  'other',
];

/** The AI assistants whose answers are checked for the business (GEO). */
export const ENGINE_IDS = ['openai', 'anthropic', 'gemini'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
export const ENGINE_LABELS: Record<EngineId, string> = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini' };
