import { z } from 'zod';
import type { EngineId, SeoElement } from '../../shared/audit';
import type { MarketId } from '../../shared/markets';
import type { AnswerEngine } from '../geo/engines/types';

// The "writer": a language model that turns Jev's verdicts into text — buyer questions, proposed titles, checklist
// wording. Jev only judges; it cannot write. Everything here is optional: without a writer the audit uses fixed
// rules and templates, and says so in the report.

export interface Writer {
  readonly id: EngineId | 'rules';
  readonly model: string | null;
  /** Calls made so far (for the usage line). */
  calls(): number;
  /** Realistic buyer questions, one per item; [] when nothing could be written. */
  questions(input: { business: string; market: MarketId; count: number; avoid: readonly string[]; signal?: AbortSignal }): Promise<string[]>;
  /** Replacement text for elements flagged "change"; only the requested elements, only when the model gave a usable text. */
  proposals(input: ProposalInput): Promise<Partial<Record<SeoElement, string>>>;
  /** Specific, ordered checklist steps for one page of the plan; null when nothing usable came back. */
  checklist(input: ChecklistInput): Promise<Array<{ text: string; why: string }> | null>;
}

export interface ProposalInput {
  url: string;
  business: string;
  market: MarketId;
  brand: string;
  phrase: string | null;
  current: { title: string; meta: string; h1: string; intro: string };
  /** The elements to rewrite, with Jev's or the rule's reason. */
  wanted: Array<{ element: 'title' | 'meta' | 'h1' | 'intro'; reason: string }>;
  signal?: AbortSignal;
}

export interface ChecklistInput {
  kind: 'create' | 'rewrite';
  business: string;
  market: MarketId;
  title: string;
  url: string | null;
  questions: readonly string[];
  /** What is wrong with the page, from the analysis, in plain Bulgarian. */
  findings: readonly string[];
  /** What the pages that AI assistants cite do better, in plain Bulgarian. */
  winners: readonly string[];
  /** The fixed steps the rules would give; the model improves and orders them but may not drop a needed one. */
  baseline: readonly string[];
  signal?: AbortSignal;
}

/** The writer that is always there: no model, so nothing is written and every caller falls back to its rules. */
export const rulesWriter: Writer = {
  id: 'rules',
  model: null,
  calls: () => 0,
  questions: async () => [],
  proposals: async () => ({}),
  checklist: async () => null,
};

const LANGUAGE: Record<MarketId, string> = { bg: 'Bulgarian', 'bg-en': 'English', gb: 'English', us: 'English' };

/** The first JSON value in a model's reply (models wrap JSON in prose or code fences). */
export function extractJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start] as string;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const QuestionsReply = z.object({ questions: z.array(z.string()) });
const ProposalReply = z.object({ title: z.string().optional(), meta: z.string().optional(), h1: z.string().optional(), intro: z.string().optional() });
const ChecklistReply = z.object({ steps: z.array(z.object({ text: z.string(), why: z.string().default('') })) });

const SYSTEM = 'You are a precise assistant for a website audit. Answer with JSON only, no prose, no code fences.';

/** A writer backed by one of the configured assistants (the same API key the visibility check uses). */
export function llmWriter(engine: AnswerEngine): Writer {
  let calls = 0;
  const ask = async (prompt: string, maxTokens: number, signal?: AbortSignal): Promise<unknown> => {
    calls++;
    const reply = await engine.generate({ system: SYSTEM, prompt, maxTokens, json: true, ...(signal ? { signal } : {}) });
    return extractJson(reply.text);
  };

  return {
    id: engine.id,
    model: engine.model,
    calls: () => calls,

    async questions({ business, market, count, avoid, signal }) {
      const language = LANGUAGE[market];
      const prompt =
        `A business describes itself like this: "${business}"\n` +
        `Write ${count} different, realistic questions that a potential customer would type to an AI assistant (ChatGPT, Claude, Gemini) while looking for this kind of business or deciding between providers.\n` +
        `Cover these intentions roughly evenly: finding providers; comparing options; price and what is included; trust (is it reliable, reviews, guarantees); how to do or choose something, or what something is; local (a city).\n` +
        `Rules: written in ${language}; natural wording a person would really use; specific; 6 to 16 words each; no names of real companies; no numbering; none of them may repeat or paraphrase these: ${JSON.stringify(avoid.slice(0, 30))}.\n` +
        `Return exactly: {"questions": ["...", "..."]}`;
      const parsed = QuestionsReply.safeParse(await ask(prompt, 2500, signal));
      return parsed.success ? parsed.data.questions.map((q) => q.trim()).filter((q) => q.length >= 10 && q.length <= 200) : [];
    },

    async proposals(input) {
      const wanted = input.wanted.map((w) => `- ${w.element}: ${w.reason}`).join('\n');
      const language = LANGUAGE[input.market];
      const prompt =
        `Business: "${input.business}"\nBrand name: ${input.brand}\nPage: ${input.url}\nMain phrase of the page: ${input.phrase ?? '(unknown)'}\n` +
        `Current title: ${input.current.title || '(none)'}\nCurrent meta description: ${input.current.meta || '(none)'}\nCurrent H1: ${input.current.h1 || '(none)'}\nCurrent first paragraph: ${input.current.intro || '(none)'}\n\n` +
        `Rewrite ONLY these elements, which an auditor flagged:\n${wanted}\n\n` +
        `Rules: write in ${language}; title at most 60 characters, contains the main phrase, may end with " | ${input.brand}" if it fits; meta description 120 to 155 characters, states the benefit and invites a click; H1 at most 70 characters in plain words; first paragraph at most 280 characters, states the answer or the offer in its first sentence. ` +
        `Do not invent facts: use only what the page text above supports; where a number or a name is needed and missing, write a placeholder in square brackets such as [цена]. ` +
        `Return JSON with only the requested keys among "title", "meta", "h1", "intro".`;
      const parsed = ProposalReply.safeParse(await ask(prompt, 1200, input.signal));
      const out: Partial<Record<SeoElement, string>> = {};
      if (!parsed.success) return out;
      for (const w of input.wanted) {
        const text = parsed.data[w.element]?.replace(/\s+/g, ' ').trim();
        if (text && text.length >= 8) out[w.element] = text.slice(0, 400);
      }
      return out;
    },

    async checklist(input) {
      const language = LANGUAGE[input.market];
      const prompt =
        `A website audit found that AI assistants do not cite this ${input.kind === 'create' ? 'missing page' : 'existing page'}: "${input.title}"${input.url ? ` (${input.url})` : ''}.\n` +
        `Business: "${input.business}"\nBuyer questions the page should answer: ${JSON.stringify(input.questions)}\n` +
        `What is wrong: ${JSON.stringify(input.findings)}\nWhat the pages that AI assistants cite do better: ${JSON.stringify(input.winners)}\n` +
        `Baseline steps (keep every one that applies, make them concrete for this page, put them in the best order): ${JSON.stringify(input.baseline)}\n\n` +
        `Write the checklist for the person who will ${input.kind === 'create' ? 'write the page' : 'rewrite the page'}: 5 to 9 steps, in the order to do them, each with a short "why". Write in ${language}. ` +
        `Do not invent facts about the business. Return exactly: {"steps": [{"text": "...", "why": "..."}]}`;
      const parsed = ChecklistReply.safeParse(await ask(prompt, 2200, input.signal));
      if (!parsed.success) return null;
      const steps = parsed.data.steps
        .map((s) => ({ text: s.text.replace(/\s+/g, ' ').trim().slice(0, 300), why: s.why.replace(/\s+/g, ' ').trim().slice(0, 240) }))
        .filter((s) => s.text.length >= 8)
        .slice(0, 12);
      return steps.length >= 3 ? steps : null;
    },
  };
}

