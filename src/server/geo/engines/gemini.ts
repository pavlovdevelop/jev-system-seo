import { ENGINE_LABELS } from '../../../shared/domain';
import { domainOf } from '../../providers/serp/types';
import { postJson, quoteVendor, type EngineHttpOptions } from './http';
import {
  AnswerCollector,
  asArray,
  asCount,
  asString,
  elapsedMs,
  EngineError,
  isRecord,
  type AnswerEngine,
  type AskOptions,
  type EngineAnswer,
  type EngineConfig,
  type GenerateRequest,
  type GenerateResult,
} from './types';

// Gemini, through the Interactions API over plain fetch (the older generateContent is "legacy" and not used here).
//   POST https://generativelanguage.googleapis.com/v1beta/interactions   header: x-goog-api-key (never in the URL)
// ask() switches on the built-in `google_search` tool. The reply is an Interaction whose `steps` list the searches
// (`google_search_call`) and the answer (`model_output` with text blocks that carry `url_citation` annotations).
//
// Two quirks a caller must know about:
//   * A citation's url is a Google redirect link (vertexaisearch.cloud.google.com/grounding-api-redirect/...) and its
//     title is the source's domain name. EngineCitation.domain therefore comes from the title when the url is a redirect;
//     the url itself stays the redirect (resolving it would take a request per source).
//   * The documentation does not list the retrieved-but-uncited sources, so `consulted` is always empty here.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const LABEL = ENGINE_LABELS.gemini;
const DONE = new Set(['completed', 'succeeded', 'done']);

export class GeminiEngine implements AnswerEngine {
  readonly id = 'gemini' as const;
  readonly label = LABEL;
  readonly model: string;
  // A #private field, so that logging or inspecting an engine can never print the key.
  readonly #apiKey: string;

  constructor(
    config: EngineConfig,
    private readonly options: EngineHttpOptions = {},
  ) {
    this.#apiKey = config.apiKey.trim();
    this.model = config.model;
  }

  // Gemini has no documented way to steer the search toward a country, so `options.location` is not used.
  async ask(question: string, { signal }: AskOptions): Promise<EngineAnswer> {
    const started = performance.now();
    const raw = await this.send({ model: this.model, input: question, tools: [{ type: 'google_search' }], store: false }, this.options.timeoutMs ?? 90_000, signal);
    const collector = new AnswerCollector();
    const read = this.read(raw, collector);
    if (!collector.hasText) this.failNoText(read, false);
    return collector.build({
      searched: read.searches > 0,
      latencyMs: elapsedMs(started),
      usage: { inputTokens: read.inputTokens, outputTokens: read.outputTokens, searches: read.searches },
      model: read.model ?? this.model,
    });
  }

  // The documented body has no field for a token limit, so `maxTokens` is not sent; `json` relies on the prompt.
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const raw = await this.send(
      { model: this.model, input: request.prompt, ...(request.system ? { system_instruction: request.system } : {}), store: false },
      this.options.timeoutMs ?? 120_000,
      request.signal,
    );
    const collector = new AnswerCollector();
    const read = this.read(raw, collector);
    // A generation without text is of no use to the caller, so unlike ask() this does not return an empty result.
    if (!collector.hasText) this.failNoText(read, true);
    return { text: collector.fullText(), usage: { inputTokens: read.inputTokens, outputTokens: read.outputTokens } };
  }

  private send(body: Record<string, unknown>, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    return postJson(ENDPOINT, body, {
      vendor: LABEL,
      headers: { 'x-goog-api-key': this.#apiKey },
      secrets: [this.#apiKey],
      timeoutMs,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.retries !== undefined ? { retries: this.options.retries } : {}),
      ...(this.options.backoffBaseMs !== undefined ? { backoffBaseMs: this.options.backoffBaseMs } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /** Reads an Interaction into the collector. Every field may be missing; nothing here throws on an odd shape. */
  private read(raw: unknown, out: AnswerCollector): Read {
    const root = isRecord(raw) ? raw : {};
    const blocks = new AnswerCollector(); // the text of the model_output steps, used when there is no `output_text`
    let searches = 0;

    // `outputs` is the flat list of the earlier Interactions API; the steps of the current one carry the same items.
    for (const step of asArray(Array.isArray(root.steps) ? root.steps : root.outputs)) {
      if (!isRecord(step)) continue;
      if (step.type === 'google_search_call') {
        searches++;
        const args = isRecord(step.arguments) ? step.arguments : {};
        for (const q of [...asArray(step.queries), ...asArray(args.queries), step.query, args.query]) out.query(q);
      } else if (step.type === 'model_output') {
        let first = true;
        for (const block of asArray(step.content)) {
          if (this.readBlock(block, blocks, out, first)) first = false;
        }
      } else if (step.type === 'text') {
        this.readBlock(step, blocks, out, true);
      }
    }

    const outputText = asString(root.output_text);
    out.appendText(outputText.trim() !== '' ? outputText : blocks.fullText());

    const usage = tokenCounts(root);
    return {
      model: asString(root.model).trim() || null,
      status: asString(root.status).trim().toLowerCase(),
      error: describeError(root.error, this.#apiKey),
      searches,
      ...usage,
    };
  }

  /** Reads one text block: its text goes to `text`, its url_citation annotations to `out`. Returns whether it was a text block. */
  private readBlock(block: unknown, text: AnswerCollector, out: AnswerCollector, newBlock: boolean): boolean {
    if (!isRecord(block) || block.type !== 'text') return false;
    text.appendText(block.text, newBlock);
    for (const note of asArray(block.annotations)) {
      if (!isRecord(note) || (note.type !== undefined && note.type !== 'url_citation')) continue;
      const url = asString(note.url);
      const title = asString(note.title);
      out.cite(url, title, isGoogleRedirect(url) ? (hostFromTitle(title) ?? undefined) : undefined);
    }
    return true;
  }

  /** The reply has no text: say why when the API did (an error, a status that is not "done"); else report an empty reply when the caller needs text. */
  private failNoText(read: Read, needText: boolean): void {
    if (read.error) throw new EngineError('bad_response', `${LABEL} върна грешка: ${read.error}`);
    if (read.status !== '' && !DONE.has(read.status)) throw new EngineError('bad_response', `${LABEL} не завърши отговора (статус: ${quoteVendor(read.status, [this.#apiKey], 40)}).`);
    if (needText) throw new EngineError('bad_response', `${LABEL} върна празен отговор.`);
  }
}

interface Read {
  model: string | null;
  status: string;
  error: string;
  searches: number;
  inputTokens: number;
  outputTokens: number;
}

function describeError(error: unknown, apiKey: string): string {
  if (typeof error === 'string') return quoteVendor(error, [apiKey]);
  if (isRecord(error)) return quoteVendor(asString(error.message) || JSON.stringify(error), [apiKey]);
  return '';
}

const INPUT_TOKEN_KEYS = ['input_tokens', 'total_input_tokens', 'prompt_tokens', 'promptTokenCount'] as const;
const OUTPUT_TOKEN_KEYS = ['output_tokens', 'total_output_tokens', 'candidates_tokens', 'candidatesTokenCount', 'completion_tokens'] as const;

/** The documentation does not name the usage fields, so look in the places and under the names Google uses; numbers only, 0 when absent. */
export function tokenCounts(root: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const boxes = [root.usage, root.usage_metadata, root.usageMetadata].filter(isRecord);
  const find = (keys: readonly string[]): number => {
    for (const box of boxes) {
      for (const key of keys) {
        const n = asCount(box[key]);
        if (n > 0) return n;
      }
    }
    return 0;
  };
  return { inputTokens: find(INPUT_TOKEN_KEYS), outputTokens: find(OUTPUT_TOKEN_KEYS) };
}

/** True for the links Google puts in grounding citations: they lead to the real page only through a redirect. */
export function isGoogleRedirect(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'vertexaisearch.cloud.google.com' || host.endsWith('.vertexaisearch.cloud.google.com')) return true;
  return (host === 'google.com' || host.endsWith('.google.com')) && parsed.pathname.startsWith('/grounding-api-redirect');
}

// A host name: dot-separated labels of letters (any script: .бг exists), digits and hyphens, at least one dot.
const HOSTNAME = /^(?=.{3,253}$)(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;

/** The registrable domain a citation title names ("www.healthline.com" → "healthline.com"), or null when the title is not a host name. */
export function hostFromTitle(title: string): string | null {
  const host = title.trim().toLowerCase().replace(/^www\./, '');
  if (!HOSTNAME.test(host)) return null;
  return domainOf(`https://${host}`) || null;
}
