import { QUESTION_STAGES, type QuestionSource, type QuestionStage } from '../../shared/audit';
import { MARKETS, type MarketId } from '../../shared/markets';
import type { Jev } from '../jev/client';
import { keywordKey, looksLikeQuestion } from '../nlp/bg';
import { SerpError, type SerpProvider, type VolumeProvider } from '../providers/serp/types';
import { mapLimit } from '../util/limit';
import { buyerQuestionQuestions, buyerQuestionState } from './questions';
import type { Writer } from './writer';

// The questions a business's buyers ask an AI assistant. They come from four places — a language model asked to
// imagine them, Google's "people also ask", templates around the site's own phrases, and Google's suggestions —
// are de-duplicated, screened by Jev for relevance, labelled with the buyer's intention, and balanced across stages.

export interface RawQuestion {
  text: string;
  source: QuestionSource;
}

export interface ScreenedQuestion extends RawQuestion {
  stage: QuestionStage;
  relevance: number;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').replace(/^[\s\-–•\d.)]+/, '').trim();
const endWithQuestionMark = (s: string): string => {
  const withMark = /[?]$/.test(s) ? s : `${s}?`;
  return withMark.charAt(0).toUpperCase() + withMark.slice(1); // suggestions arrive in lower case
};

/** Phrases the site is about → a handful of plausible questions per phrase, in the market's language. */
export function templateQuestions(seeds: readonly string[], market: MarketId): RawQuestion[] {
  const out: RawQuestion[] = [];
  const bg = market === 'bg';
  for (const raw of seeds) {
    const x = raw.trim().toLowerCase();
    if (!x) continue;
    const list = bg
      ? [
          `Колко струва ${x}?`,
          `Кои са най-добрите фирми за ${x}?`,
          `Какво трябва да знам, преди да поръчам ${x}?`,
          `Как да разбера дали фирма за ${x} е надеждна?`,
          `Какво да сравня при избор на фирма за ${x}?`,
          `Коя фирма за ${x} в София препоръчвате?`,
        ]
      : [
          `How much does ${x} cost?`,
          `What are the best companies for ${x}?`,
          `What should I know before ordering ${x}?`,
          `How can I tell whether a company for ${x} is reliable?`,
          `What should I compare when choosing a provider for ${x}?`,
          `Which company for ${x} would you recommend?`,
        ];
    for (const text of list) out.push({ text, source: 'template' });
  }
  return out;
}

/** Everything the search provider and the writer can offer for these seed phrases. */
export async function collectQuestions(input: {
  business: string;
  market: MarketId;
  seeds: readonly string[];
  count: number;
  serp: SerpProvider | null;
  writer: Writer;
  signal?: AbortSignal;
}): Promise<RawQuestion[]> {
  const { serp, writer, market } = input;
  const raw: RawQuestion[] = [];
  const callOpts = input.signal ? { signal: input.signal } : undefined;

  if (serp) {
    for (const seed of input.seeds.slice(0, 3)) {
      try {
        const data = await serp.search({ keyword: seed, market: MARKETS[market], depth: 10 }, callOpts);
        for (const p of data.peopleAlsoAsk) raw.push({ text: endWithQuestionMark(clean(p.question)), source: 'paa' });
        for (const r of data.relatedSearches) if (looksLikeQuestion(r)) raw.push({ text: endWithQuestionMark(clean(r)), source: 'related' });
        const suggestions = serp.suggest ? await serp.suggest(seed, MARKETS[market], callOpts).catch(() => [] as string[]) : [];
        for (const s of suggestions) if (looksLikeQuestion(s)) raw.push({ text: endWithQuestionMark(clean(s)), source: 'suggest' });
      } catch (err) {
        if (err instanceof SerpError && err.fatal) throw err;
        // one seed that fails must not sink the question set
      }
    }
  }

  const avoid = raw.map((r) => r.text);
  const written = await writer.questions({ business: input.business, market, count: Math.ceil(input.count * 1.3), avoid, ...(input.signal ? { signal: input.signal } : {}) }).catch(() => [] as string[]);
  for (const text of written) raw.push({ text: endWithQuestionMark(clean(text)), source: 'llm' });

  raw.push(...templateQuestions(input.seeds.slice(0, 3), market));
  return raw;
}

const SOURCE_RANK: Record<QuestionSource, number> = { llm: 0, paa: 1, suggest: 2, related: 3, template: 4 };

/** De-duplicates (a question and its inflected twin count once), keeping the more trustworthy source. */
export function dedupe(raw: readonly RawQuestion[]): RawQuestion[] {
  const best = new Map<string, RawQuestion>();
  for (const q of raw) {
    if (q.text.length < 10 || q.text.length > 200) continue;
    const key = keywordKey(q.text);
    if (!key) continue;
    const have = best.get(key);
    if (!have || SOURCE_RANK[q.source] < SOURCE_RANK[have.source]) best.set(key, q);
  }
  return [...best.values()];
}

const STAGE_SET: ReadonlySet<string> = new Set(QUESTION_STAGES);

/** Asks Jev whether each question is one the business's buyers would ask, and what the asker is trying to do. */
export async function screenQuestions(raw: readonly RawQuestion[], business: string, market: MarketId, jev: Jev, signal?: AbortSignal): Promise<ScreenedQuestion[]> {
  const rows = await mapLimit(raw, 12, async (q): Promise<ScreenedQuestion | null> => {
    const a = await jev.tryAsk(buyerQuestionState(q.text, business, market), buyerQuestionQuestions, { shuffleChoices: true, ...(signal ? { signal } : {}) });
    if (!a) return { ...q, stage: 'discover', relevance: 0.5 }; // Jev did not answer: keep it, unlabelled
    const stage = STAGE_SET.has(a.question_stage.value) ? (a.question_stage.value as QuestionStage) : 'discover';
    return { ...q, stage, relevance: Math.round(a.relevant_to_business.p * 1000) / 1000 };
  });
  return rows.filter((r): r is ScreenedQuestion => r !== null && r.relevance >= 0.5);
}

/** At most `count` questions, taken round-robin over the stages (most relevant, most trustworthy source first). */
export function balance(questions: readonly ScreenedQuestion[], count: number): ScreenedQuestion[] {
  const byStage = new Map<QuestionStage, ScreenedQuestion[]>();
  for (const q of questions) byStage.set(q.stage, [...(byStage.get(q.stage) ?? []), q]);
  for (const list of byStage.values()) list.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.relevance - a.relevance);
  const out: ScreenedQuestion[] = [];
  const order = QUESTION_STAGES.filter((s) => byStage.has(s));
  for (let round = 0; out.length < count; round++) {
    let added = false;
    for (const stage of order) {
      const q = byStage.get(stage)?.[round];
      if (q && out.length < count) {
        out.push(q);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/** Monthly searches for the questions, when a provider has them (rarely: most questions are too specific). */
export async function questionVolumes(questions: readonly string[], market: MarketId, volume: VolumeProvider | null, signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!volume || questions.length === 0) return out;
  try {
    const map = await volume.volumes(questions.slice(0, 200), MARKETS[market], signal ? { signal } : undefined);
    for (const [k, v] of map) if (v.volume !== null) out.set(k.trim().toLowerCase(), v.volume);
  } catch {
    // volumes are a bonus
  }
  return out;
}
