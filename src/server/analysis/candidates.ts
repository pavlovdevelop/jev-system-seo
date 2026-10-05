import type { KeywordSource } from '../../shared/domain';
import type { MarketId } from '../../shared/markets';
import type { Heading, SerpData } from '../../shared/schemas';
import { keywordKey, keywordTerms, looksLikeQuestion } from '../nlp/bg';
import { clusterHeadings, minePhrases, pruneSubsumed } from '../nlp/terms';
import type { KeywordJudgment } from './judge';
import { modifiersFor } from './lexicon';

// Where do keyword ideas come from?
//  1. What Google itself offers for the seed: related searches, "people also ask", autocomplete.
//  2. What the top-ranking competitors write about: shared headings and title words.
//  3. Plain variations (price, city, "how much does … cost") of the seed.
// Real queries (1) are listed first so their natural wording wins when ideas collapse into one.

export interface Candidate {
  keyword: string;
  key: string;
  sources: Set<KeywordSource>;
  /** Competitor pages that use this phrase (competitor_terms only). */
  pages: number;
}

export interface CompetitorText {
  title: string;
  headings: readonly Heading[];
  text: string;
}

export interface CandidateInputs {
  seed: string;
  market: MarketId;
  serp: SerpData;
  competitors: readonly CompetitorText[];
  /** Hard cap on raw candidates before Jev screening. */
  maxRaw?: number;
}

const clean = (s: string): string =>
  s
    .replace(/[?!]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function generateCandidates(input: CandidateInputs): Candidate[] {
  const out = new Map<string, Candidate>();
  const seedKey = keywordKey(input.seed);
  const seedTerms = new Set(keywordTerms(input.seed));

  const add = (raw: string, source: KeywordSource, pages = 0): void => {
    const keyword = clean(raw);
    const words = keyword.split(' ').length;
    if (!keyword || words < 2 || words > 9 || keyword.length > 80) return;
    const key = keywordKey(keyword);
    if (!key || key === seedKey) return;
    const entry = out.get(key) ?? { keyword, key, sources: new Set<KeywordSource>(), pages: 0 };
    entry.sources.add(source);
    entry.pages = Math.max(entry.pages, pages);
    out.set(key, entry);
  };
  const touchesSeed = (phrase: string): boolean => keywordTerms(phrase).some((t) => seedTerms.has(t));
  // Phrases mined from running text are only usable as keywords when they contain the whole seed topic;
  // otherwise they are fragments ("цена на изработка") rather than something anyone would search for.
  const containsSeed = (phrase: string): boolean => {
    const have = new Set(keywordTerms(phrase));
    return [...seedTerms].every((t) => have.has(t)) && have.size > seedTerms.size;
  };

  // 1. Google's own suggestions
  for (const r of input.serp.relatedSearches) add(r, 'related');
  for (const p of input.serp.peopleAlsoAsk) add(p.question, 'people_also_ask');
  for (const s of input.serp.suggestions) add(s, 'autocomplete');

  // 2. What competitors write about
  const clusters = clusterHeadings(
    input.competitors.map((c) => c.headings.filter((h) => h.level === 2 || h.level === 3).map((h) => h.text)),
    0.4,
    seedTerms,
  );
  for (const c of clusters) {
    if (c.pages >= 2 && touchesSeed(c.topic)) add(c.topic, 'competitor_terms', c.pages);
  }
  const n = input.competitors.length;
  if (n >= 3) {
    const titleWords = minePhrases(input.competitors.map((c) => c.title), { maxN: 1, minPages: 2 });
    for (const w of titleWords) {
      if (seedTerms.has(w.key) || w.display.length < 4) continue;
      add(`${input.seed} ${w.display}`, 'competitor_terms', w.pages);
    }
    const phrases = pruneSubsumed(minePhrases(input.competitors.map((c) => c.text), { maxN: 3, minPages: Math.max(3, Math.ceil(n * 0.3)) }));
    for (const ph of phrases.filter((p) => p.n >= 2 && containsSeed(p.display)).slice(0, 10)) add(ph.display, 'competitor_terms', ph.pages);
  }

  // 3. Variations
  const mods = modifiersFor(input.market);
  for (const m of mods.suffix) add(`${input.seed} ${m}`, 'modifier');
  for (const m of mods.prefix) add(`${m} ${input.seed}`, 'modifier');

  return [...out.values()].slice(0, input.maxRaw ?? 80);
}

export interface Screened {
  candidate: Candidate;
  judgment: KeywordJudgment;
}

const REAL_QUERY: ReadonlySet<KeywordSource> = new Set(['related', 'people_also_ask', 'autocomplete']);

/**
 * Chooses which screened candidates deserve a SERP request. Relevance is a hard gate; the rest is a ranking
 * by "likely to matter to the business". Real queries get a boost over generated variations, and
 * variations are capped so they cannot crowd out everything else.
 */
export function pickForSerp(screened: readonly Screened[], max: number, minRelevance = 0.5): Screened[] {
  const prelim = (s: Screened): number => {
    const { relevance, commercial } = s.judgment;
    const boost = [...s.candidate.sources].some((x) => REAL_QUERY.has(x)) ? 0.12 : s.candidate.sources.has('competitor_terms') ? 0.04 : 0;
    return relevance * (0.55 + 0.45 * commercial) + boost;
  };
  const ranked = screened.filter((s) => s.judgment.relevance >= minRelevance).sort((a, b) => prelim(b) - prelim(a) || a.candidate.key.localeCompare(b.candidate.key));

  const generatedOnly = (s: Screened): boolean => s.candidate.sources.size === 1 && s.candidate.sources.has('modifier');
  const modifierCap = Math.ceil(max * 0.6);
  const picked: Screened[] = [];
  let modifiers = 0;
  for (const s of ranked) {
    if (picked.length >= max) break;
    if (generatedOnly(s)) {
      if (modifiers >= modifierCap) continue;
      modifiers++;
    }
    picked.push(s);
  }
  return picked;
}

export { looksLikeQuestion };
