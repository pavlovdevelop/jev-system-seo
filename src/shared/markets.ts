// Search markets the platform supports. The NLP layer handles Bulgarian + English text,
// so only markets whose queries/pages are in those languages are offered.

export const MARKET_IDS = ['bg', 'bg-en', 'gb', 'us'] as const;
export type MarketId = (typeof MARKET_IDS)[number];

export interface Market {
  id: MarketId;
  label: string;
  /** Google `gl` (country) parameter. */
  gl: string;
  /** Google `hl` (interface language) parameter. */
  hl: string;
  /** DataForSEO location code (ISO 3166 numeric + 2000). */
  dfsLocationCode: number;
  /** DataForSEO language code. */
  dfsLanguageCode: string;
  /** Natural-language description handed to Jev as context. */
  description: string;
}

export const MARKETS: Record<MarketId, Market> = {
  bg: {
    id: 'bg',
    label: 'България · български',
    gl: 'bg',
    hl: 'bg',
    dfsLocationCode: 2100,
    dfsLanguageCode: 'bg',
    description: 'Bulgaria, Bulgarian-language Google results',
  },
  'bg-en': {
    id: 'bg-en',
    label: 'България · английски',
    gl: 'bg',
    hl: 'en',
    dfsLocationCode: 2100,
    dfsLanguageCode: 'en',
    description: 'Bulgaria, English-language Google results',
  },
  gb: {
    id: 'gb',
    label: 'Великобритания · английски',
    gl: 'gb',
    hl: 'en',
    dfsLocationCode: 2826,
    dfsLanguageCode: 'en',
    description: 'United Kingdom, English-language Google results',
  },
  us: {
    id: 'us',
    label: 'САЩ · английски',
    gl: 'us',
    hl: 'en',
    dfsLocationCode: 2840,
    dfsLanguageCode: 'en',
    description: 'United States, English-language Google results',
  },
};

export function isMarketId(value: unknown): value is MarketId {
  return typeof value === 'string' && (MARKET_IDS as readonly string[]).includes(value);
}
