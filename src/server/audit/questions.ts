import { choice, noul, score, type EntryType } from '@typesafe-ai/sdk';
import { MARKETS, type MarketId } from '../../shared/markets';
import { clip, urlForJev, type ExtractedPage } from '../jev/questions';
import { coverage, looksLikeQuestion } from '../nlp/bg';
import { introProse } from './text';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Jev questions for the whole-site audit. The same rules as the keyword catalogue (src/server/jev/questions.ts):
// English instructions, Bulgarian content in `state`, one literal judgment per question, an explicit "other"
// option on every choice, numbers stay in code (Jev gets named buckets), a small focused state per request.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const FIVE_LEVELS = {
  answer_first: [
    'Not at all: the opening is a slogan, a greeting or unrelated text.',
    'Barely: the opening circles the topic without saying anything concrete.',
    'Partly: the answer comes, but only after a long introduction or without specifics.',
    'Mostly: the opening states the main answer with some specifics.',
    'Fully: the first sentences state the complete answer with concrete specifics.',
  ],
  specific_facts: [
    'None: only general statements.',
    'Very few concrete facts.',
    'Some concrete facts mixed with general statements.',
    'Many concrete facts: figures, prices, names, dates or specifications.',
    'Dense: nearly every paragraph carries concrete, checkable facts.',
  ],
  answers_question: [
    'Not at all: the page is about something else.',
    'It touches the topic but does not answer the question.',
    'Partly: some of the answer is there, vague or incomplete.',
    'Mostly: a clear answer with specifics, a detail or two missing.',
    'Fully: a complete, concrete answer to exactly this question.',
  ],
  outline: [
    'There is no usable outline, or it is unrelated to the topic.',
    'Thin: a few vague subheadings.',
    'Adequate: the main parts of the topic are there.',
    'Good: a logical order that covers the topic.',
    'Excellent: complete, logical and specific.',
  ],
} as const;

// ───────────────────────── SEO elements: title, meta, H1, first paragraph, outline ─────────────────────────

export const elementQuestions = {
  title_clear: noul('The title tells a visitor what the page offers, in words a buyer would search for.'),
  title_specific: noul('The title is specific to this page: it names the exact service, product or topic instead of a general company slogan.'),
  meta_inviting: noul('The meta description sums up what the page offers and gives a reason to click.'),
  h1_matches: noul('The H1 names the main topic of the page in plain words a visitor would use.'),
  intro_direct: noul('The first paragraph gets to the point at once: it states the answer, the offer or the main benefit without a warm-up.'),
  outline_logical: score('How clear and complete is the outline formed by the subheadings, for the topic of the page?', FIVE_LEVELS.outline),
};
export type ElementQuestionId = keyof typeof elementQuestions;

export const faqQuestionSet = {
  faq_useful: noul('The questions listed under `faq_questions` are ones that real buyers ask, and they are not filler.'),
};

// ───────────────────────── citability: what makes an AI assistant pick a page ─────────────────────────

export const citabilityQuestions = {
  answer_first: score('How directly do the opening paragraphs answer the question this page is about?', FIVE_LEVELS.answer_first),
  specific_facts: score(
    'How rich is the text in concrete, verifiable facts (specific numbers, prices, names, dates, specifications) rather than general statements?',
    FIVE_LEVELS.specific_facts,
  ),
  cites_sources: noul('The text backs its claims with named sources, studies, standards or references to other websites.'),
};

// ───────────────────────── does a page answer a buyer's question? ─────────────────────────

export const coverQuestions = {
  answers_question: score('How completely does the page answer the buyer question in `buyer_question`?', FIVE_LEVELS.answers_question),
  angle_fits: noul(
    'The page has the right angle for the question in `buyer_question`: a comparison for a question about which option is better, a price page for a question about cost, a step-by-step guide for a how-to question, a page about trust and proof for a question about reliability.',
  ),
};

// ───────────────────────── buyer questions: relevance and stage ─────────────────────────

export const STAGE_CRITERIA = {
  discover: 'Find out who offers a product or service, or what the options are.',
  compare: 'Compare providers or options, or decide between them.',
  price: 'Learn how much something costs or how the pricing works.',
  trust: 'Check whether a provider or option is reliable, safe or worth it.',
  howto: 'Learn how to do or choose something, or what something is.',
  local: 'Find a provider or a place in a specific city or area.',
  other: 'None of these fits, or it is unclear.',
} as const;

export const buyerQuestionQuestions = {
  relevant_to_business: noul(
    'The question in `buyer_question` is one that a customer of the business described in `business` would ask when looking for what it offers.',
  ),
  question_stage: choice('What is the person who asks the question in `buyer_question` trying to do?', STAGE_CRITERIA),
};

// ───────────────────────── how an AI answer treats the brand ─────────────────────────

export const sentimentQuestions = {
  recommendation: choice('How does the answer in `assistant_answer` treat the brand named in `brand`?', {
    recommended: 'The answer recommends the brand or presents it as a good choice.',
    mentioned_neutral: 'The answer mentions the brand without recommending or discouraging it.',
    discouraged: 'The answer advises against the brand or presents it as a poor choice.',
    not_mentioned: 'The answer does not mention the brand at all.',
  }),
};

// ───────────────────────── state builders ─────────────────────────

export interface SitePageContext {
  url: string;
  market: MarketId;
  business: string;
  /** What the page is about, when known (taken from its H1 or title). */
  phrase: string | null;
  page: ExtractedPage;
}

/** "none" / "few" / "several" / "many": Jev gets a bucket, never a raw count. */
export function bucketOf(n: number): 'none' | 'few' | 'several' | 'many' {
  return n <= 0 ? 'none' : n <= 2 ? 'few' : n <= 5 ? 'several' : 'many';
}

const subheadings = (outline: readonly string[], limit: number, max: number): string[] =>
  outline
    .filter((line) => /^H[23]:/.test(line))
    .slice(0, limit)
    .map((line) => clip(line.replace(/^H[23]:\s*/, ''), max));

/** The part of the text that is closest to the question, so a long page is judged on its relevant passage. */
export function bestExcerpt(text: string, question: string, max: number): string {
  const sentences = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20)
    .slice(0, 600);
  if (sentences.length === 0) return clip(text, max);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < sentences.length; i++) {
    const s = coverage(question, sentences[i] as string);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  // the best sentence and what follows it, which is usually where the answer continues
  return clip(sentences.slice(best, best + 4).join(' '), max);
}

export function elementState(ctx: SitePageContext): EntryType {
  const m = ctx.page.metrics;
  const faq = faqQuestionsOf(ctx.page);
  return {
    search_phrase: ctx.phrase ?? '',
    business: clip(ctx.business, 300),
    market: MARKETS[ctx.market].description,
    page: {
      url: urlForJev(ctx.url),
      title: clip(m.title, 200),
      meta_description: clip(m.metaDescription, 300),
      h1: clip(m.h1[0], 200),
      subheadings: subheadings(ctx.page.outline, 12, 100),
      first_paragraph: clip(introProse(ctx.page.text.intro, [m.h1[0], m.title]) || ctx.page.text.intro, 500),
    },
    ...(faq.length > 0 ? { faq_questions: faq } : {}),
  };
}

/** Question-like headings of the page (the FAQ), for judging whether they are real buyer questions. */
export function faqQuestionsOf(page: ExtractedPage): string[] {
  return page.outline
    .filter((line) => /^H[2-4]:/.test(line))
    .map((line) => line.replace(/^H[2-4]:\s*/, ''))
    .filter((text) => looksLikeQuestion(text))
    .slice(0, 8)
    .map((q) => clip(q, 120));
}

export function citabilityState(ctx: SitePageContext): EntryType {
  const m = ctx.page.metrics;
  return {
    topic: ctx.phrase ?? clip(m.title, 120),
    page: { title: clip(m.title, 160), h1: clip(m.h1[0], 160) },
    opening: clip(introProse(ctx.page.text.intro, [m.h1[0], m.title], 4) || ctx.page.text.intro, 900),
    sample_from_the_middle: clip(ctx.page.text.middle, 600),
    other_sites_linked: bucketOf(m.externalDomains),
  };
}

export function coverState(question: string, ctx: SitePageContext): EntryType {
  const m = ctx.page.metrics;
  return {
    buyer_question: clip(question, 200),
    market: MARKETS[ctx.market].description,
    page: {
      url: urlForJev(ctx.url),
      title: clip(m.title, 160),
      h1: clip(m.h1[0], 160),
      subheadings: subheadings(ctx.page.outline, 20, 90),
      first_paragraph: clip(introProse(ctx.page.text.intro, [m.h1[0], m.title]) || ctx.page.text.intro, 500),
      most_relevant_passage: bestExcerpt(ctx.page.text.full, question, 700),
    },
  };
}

export function buyerQuestionState(question: string, business: string, market: MarketId): EntryType {
  return { buyer_question: clip(question, 200), business: clip(business, 300), market: MARKETS[market].description };
}

export function sentimentState(brand: string, question: string, answer: string): EntryType {
  return { brand: clip(brand, 60), buyer_question: clip(question, 200), assistant_answer: clip(answer, 1500) };
}

/** Lexical overlap between a question and a page (title, H1, subheadings, intro), 0..1. Picks the pages worth asking Jev about. */
export function pageOverlap(question: string, page: ExtractedPage): number {
  const m = page.metrics;
  const head = `${m.title ?? ''} ${m.h1.join(' ')} ${subheadings(page.outline, 30, 120).join(' ')}`;
  const body = page.text.intro;
  return Math.min(1, 0.7 * coverage(question, head) + 0.3 * coverage(question, body));
}

