import { QUESTION_WORDS, STOPWORDS } from './stopwords';

// Lightweight Bulgarian/English text normalisation. It is deliberately simple: the goal is that all
// inflected forms of a word (сайт, сайта, сайтът, сайтове, сайтовете) collapse to one key, so that
// "does this page mention the keyword?" and "which phrases do competitors share?" work on real Bulgarian
// text. It is a heuristic stemmer, not a linguistic one.

const WORD_RE = /[\p{L}\p{N}]+/gu;
const CYRILLIC_WORD = /^[Ѐ-ӿ]+$/;
const LATIN_WORD = /^[a-z]+$/;
const NUMERIC = /^\p{N}+$/u;

/** Lowercases, unifies dashes and collapses the many spellings of "website" into one canonical word. */
export function normalizeText(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[‐-―−]/g, '-')
      // "уеб сайт", "веб-сайт", "уебсайтове", "web site", "websites" → "сайт…"
      .replace(/(?<![\p{L}])(?:уеб|веб|web)[\s-]*(?:сайт|site)s?/gu, 'сайт')
  );
}

// Bulgarian definite-article / plural-definite endings, longest first. Bare "-та"/"-то"/"-те" are not
// listed: they would eat the final consonant of stems such as "сайта" (→ "сай").
const ARTICLE_SUFFIXES = ['овете', 'ите', 'ата', 'ята', 'ето', 'ото', 'ият', 'ът', 'ят'] as const;
// Two-letter -ия/-ии/-ие endings come first so that "оптимизация" and "оптимизации" reach the same stem.
const INFLECTION_SUFFIXES = ['ове', 'ия', 'ии', 'ие', 'и', 'а', 'я', 'е', 'о'] as const;
const MIN_STEM = 3;

function stemCyrillic(word: string): string {
  if (word.length < 4) return word;
  let s = word;
  for (const suffix of ARTICLE_SUFFIXES) {
    if (s.endsWith(suffix) && s.length - suffix.length >= MIN_STEM) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  for (const suffix of INFLECTION_SUFFIXES) {
    if (s.endsWith(suffix) && s.length - suffix.length >= MIN_STEM) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  // Mobile vowel in adjectives: безплатен / безплатна / безплатни → безплатн
  if (s.length >= 6 && s.endsWith('ен')) s = `${s.slice(0, -2)}н`;
  return s;
}

function stemLatin(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

// Spellings that mean the same thing for SEO purposes (applied to stems).
const SYNONYMS: Readonly<Record<string, string>> = {
  веб: 'уеб',
  web: 'уеб',
  online: 'онлайн',
  интернет: 'онлайн',
  site: 'сайт',
  website: 'сайт',
  design: 'дизайн',
};

export function stem(word: string): string {
  const w = word.toLowerCase();
  let s = w;
  if (CYRILLIC_WORD.test(w)) s = stemCyrillic(w);
  else if (LATIN_WORD.test(w)) s = stemLatin(w);
  return SYNONYMS[s] ?? s;
}

export interface Token {
  raw: string;
  stem: string;
  stop: boolean;
  numeric: boolean;
}

export function analyze(text: string): Token[] {
  const words = normalizeText(text).match(WORD_RE) ?? [];
  return words.map((raw) => ({
    raw,
    stem: stem(raw),
    stop: STOPWORDS.has(raw),
    numeric: NUMERIC.test(raw),
  }));
}

/** Stems of the content words in `text` (stopwords and bare numbers removed). */
export function terms(text: string): string[] {
  return analyze(text)
    .filter((t) => !t.stop && !t.numeric && t.raw.length >= 2)
    .map((t) => t.stem);
}

export const termSet = (text: string): Set<string> => new Set(terms(text));

/** Distinct content stems of a keyword, in order. Falls back to all tokens for keywords made only of function words. */
export function keywordTerms(keyword: string): string[] {
  const tokens = analyze(keyword);
  const content = tokens.filter((t) => !t.stop);
  const picked = content.length > 0 ? content : tokens;
  return [...new Set(picked.map((t) => t.stem))];
}

/** Order-insensitive identity of a keyword, used to deduplicate near-identical queries. */
export const keywordKey = (keyword: string): string => [...keywordTerms(keyword)].sort().join(' ');

/** Share (0..1) of the keyword's content terms that occur in `text`. */
export function coverage(keyword: string, text: string): number {
  const wanted = keywordTerms(keyword);
  if (wanted.length === 0) return 0;
  const have = termSet(text);
  return wanted.filter((t) => have.has(t)).length / wanted.length;
}

/** True when every content term of the keyword occurs in `text`. */
export const containsKeyword = (keyword: string, text: string): boolean => coverage(keyword, text) >= 0.999;

/** True when the first content words of `text` are the keyword's content words, in order. */
export function startsWithKeyword(text: string, keyword: string): boolean {
  const wanted = keywordTerms(keyword);
  if (wanted.length === 0) return false;
  const head = terms(text).slice(0, wanted.length);
  return head.length === wanted.length && head.every((t, i) => t === wanted[i]);
}

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const first = t.match(WORD_RE)?.[0];
  return first !== undefined && QUESTION_WORDS.has(first);
}

// ───────────────────────── URL slug matching ─────────────────────────
// Bulgarian sites often use transliterated slugs ("izrabotka-na-sait"), so Cyrillic keyword stems are
// compared with the slug in a deliberately loose Latin form.

const CYR_TO_LAT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'z', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', ш: 's', щ: 's', ъ: 'a', ь: '',
  ю: 'u', я: 'a',
};

export function looseLatin(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) out += CYR_TO_LAT[ch] ?? ch;
  return out
    .replace(/sht/g, 's')
    .replace(/zh/g, 'z')
    .replace(/ch/g, 'c')
    .replace(/sh/g, 's')
    .replace(/ts/g, 'c')
    .replace(/kh/g, 'h')
    .replace(/ya/g, 'a')
    .replace(/yu/g, 'u')
    .replace(/[yj]/g, 'i')
    .replace(/w/g, 'v')
    .replace(/(.)\1+/g, '$1');
}

/** True when at least half of the keyword's (long enough) terms appear in the URL path or host. */
export function slugMatchesKeyword(url: string, keyword: string): boolean {
  let haystack: string;
  try {
    const u = new URL(url);
    haystack = decodeURIComponent(`${u.hostname}${u.pathname}`);
  } catch {
    return false;
  }
  const slug = looseLatin(haystack.replace(/[^\p{L}\p{N}]+/gu, ''));

  // For each content term keep every spelling worth testing: the canonical stem and the raw words
  // (English "design" is not the transliteration of "дизайн", so the stem alone would miss it).
  const spellings = new Map<string, Set<string>>();
  for (const t of analyze(keyword)) {
    if (t.stop) continue;
    const forms = spellings.get(t.stem) ?? new Set<string>();
    forms.add(looseLatin(t.stem));
    forms.add(looseLatin(t.raw));
    spellings.set(t.stem, forms);
  }
  const testable = [...spellings.values()]
    .map((forms) => [...forms].filter((f) => f.length >= 4))
    .filter((forms) => forms.length > 0);
  if (testable.length === 0) return false;
  const hits = testable.filter((forms) => forms.some((f) => slug.includes(f))).length;
  return hits / testable.length >= 0.5;
}
