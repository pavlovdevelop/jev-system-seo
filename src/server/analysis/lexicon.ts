import type { MarketId } from '../../shared/markets';
import { analyze, normalizeText } from '../nlp/bg';

// Small, editable word lists. Everything here is a heuristic seed for *candidate* generation:
// candidates are always screened by Jev (relevance) and checked against the real SERP before they are
// ever recommended, so a silly combination costs one cheap request, not a wrong recommendation.

export const CITIES_BG = [
  'софия', 'пловдив', 'варна', 'бургас', 'русе', 'стара загора', 'плевен', 'добрич', 'сливен', 'шумен',
  'перник', 'хасково', 'ямбол', 'пазарджик', 'благоевград', 'велико търново', 'враца', 'габрово', 'видин', 'монтана',
] as const;

/** Cities used to build "<keyword> <city>" variations (the biggest markets only, to keep the SERP budget sane). */
export const CITY_MODIFIERS_BG = CITIES_BG.slice(0, 6);

export interface Modifiers {
  suffix: readonly string[];
  prefix: readonly string[];
}

const BG_MODIFIERS: Modifiers = {
  suffix: ['цена', 'цени', 'оферта', 'за малък бизнес', 'от нулата', 'отзиви', 'сравнение', 'евтино', 'онлайн', ...CITY_MODIFIERS_BG],
  prefix: ['колко струва', 'цена на', 'фирма за', 'агенция за', 'услуги за'],
};

const EN_MODIFIERS: Modifiers = {
  suffix: ['price', 'cost', 'agency', 'company', 'services', 'for small business', 'near me', 'quote', 'cheap', 'sofia'],
  prefix: ['best', 'cheap', 'hire'],
};

export function modifiersFor(market: MarketId): Modifiers {
  return market === 'bg' ? BG_MODIFIERS : EN_MODIFIERS;
}

/** Tokens like "цена"/"price" signal commercial intent and are worth noting in reasons. */
export function hasLocalModifier(keyword: string): boolean {
  const text = ` ${normalizeText(keyword).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const stems = new Set(analyze(keyword).map((t) => t.stem));
  return CITIES_BG.some((city) => {
    if (city.includes(' ')) return text.includes(` ${city} `);
    return text.includes(` ${city} `) || analyze(city).every((t) => stems.has(t.stem));
  });
}
