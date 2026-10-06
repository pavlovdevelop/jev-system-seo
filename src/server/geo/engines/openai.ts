import { ENGINE_LABELS } from '../../../shared/domain';
import { postJson, quoteVendor, VendorHttpError, type EngineHttpOptions } from './http';
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
  vendorLocation,
} from './types';

// ChatGPT, through the Responses API (https://platform.openai.com/docs/api-reference/responses) over plain fetch.
//   POST https://api.openai.com/v1/responses   headers: authorization: Bearer <key>
// ask() switches on the built-in `web_search` tool and reads the answer's url_citation annotations (what the answer
// relies on) and the sources the search returned (`action.sources`: consulted, whether or not cited).

const ENDPOINT = 'https://api.openai.com/v1/responses';
const LABEL = ENGINE_LABELS.openai;

/** Request fields a model may refuse; each one is dropped (once, for good) when the API says it does not accept it. */
type Droppable = 'reasoning' | 'include' | 'text';
const DROPPABLE: ReadonlyArray<readonly [Droppable, RegExp]> = [
  ['reasoning', /reasoning/i],
  ['include', /\binclude\b/i],
  ['text', /json_object|text\.format|response_format|\bjson\b/i],
];

export class OpenAiEngine implements AnswerEngine {
  readonly id = 'openai' as const;
  readonly label = LABEL;
  readonly model: string;
  private readonly apiKey: string;
  private readonly dropped = new Set<Droppable>();

  constructor(
    config: EngineConfig,
    private readonly options: EngineHttpOptions = {},
  ) {
    this.apiKey = config.apiKey.trim();
    this.model = config.model;
  }

  async ask(question: string, { location, signal }: AskOptions): Promise<EngineAnswer> {
    const started = performance.now();
    const raw = await this.send(
      {
        model: this.model,
        input: question,
        tools: [{ type: 'web_search', user_location: { type: 'approximate', ...vendorLocation(location) } }],
        tool_choice: 'auto',
        reasoning: { effort: 'low' },
        max_output_tokens: 4096,
        include: ['web_search_call.action.sources'],
        store: false,
      },
      this.options.timeoutMs ?? 90_000,
      signal,
    );
    const collector = new AnswerCollector();
    const read = this.read(raw, collector);
    if (!collector.hasText) this.failIfNoText(read);
    return collector.build({
      searched: read.searches > 0,
      latencyMs: elapsedMs(started),
      usage: { inputTokens: read.inputTokens, outputTokens: read.outputTokens, searches: read.searches },
      model: read.model ?? this.model,
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const raw = await this.send(
      {
        model: this.model,
        ...(request.system ? { instructions: request.system } : {}),
        input: request.prompt,
        max_output_tokens: request.maxTokens ?? 2000,
        reasoning: { effort: 'low' },
        store: false,
        ...(request.json ? { text: { format: { type: 'json_object' } } } : {}),
      },
      this.options.timeoutMs ?? 120_000,
      request.signal,
    );
    const collector = new AnswerCollector();
    const read = this.read(raw, collector);
    // A generation without text is of no use to the caller, so unlike ask() this does not return an empty result.
    if (!collector.hasText) this.failIfNoText(read, true);
    return { text: collector.fullText(), usage: { inputTokens: read.inputTokens, outputTokens: read.outputTokens } };
  }

  /** Sends the body; if the API answers 400 about a field a model may refuse, sends it again without that field (once per field). */
  private async send(full: Record<string, unknown>, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    for (;;) {
      const body = { ...full };
      for (const field of this.dropped) delete body[field];
      try {
        return await postJson(ENDPOINT, body, {
          vendor: LABEL,
          headers: { authorization: `Bearer ${this.apiKey}` },
          secrets: [this.apiKey],
          timeoutMs,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
          ...(this.options.retries !== undefined ? { retries: this.options.retries } : {}),
          ...(this.options.backoffBaseMs !== undefined ? { backoffBaseMs: this.options.backoffBaseMs } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        const said = err instanceof VendorHttpError && err.status === 400 ? `${err.detail.param} ${err.detail.message}` : '';
        const field = said === '' ? undefined : DROPPABLE.find(([name, hint]) => name in body && hint.test(said));
        if (!field) throw err;
        this.dropped.add(field[0]); // remembered for the rest of this engine's life
      }
    }
  }

  /** Reads whatever a Responses reply holds into the collector. Every field may be missing; nothing here throws on an odd shape. */
  private read(raw: unknown, out: AnswerCollector): Read {
    const root = isRecord(raw) ? raw : {};
    const read: Read = {
      model: asString(root.model).trim() || null,
      inputTokens: 0,
      outputTokens: 0,
      searches: 0,
      refusal: '',
      error: describeError(root.error, this.apiKey) || (root.error || root.status === 'failed' ? 'неизвестна грешка' : ''),
      incomplete: describeIncomplete(root.incomplete_details) || (root.status === 'incomplete' ? 'неизвестна причина' : ''),
    };
    const usage = isRecord(root.usage) ? root.usage : {};
    read.inputTokens = asCount(usage.input_tokens);
    read.outputTokens = asCount(usage.output_tokens);

    for (const item of asArray(root.output)) {
      if (!isRecord(item)) continue;
      if (item.type === 'web_search_call') {
        read.searches++;
        const action = isRecord(item.action) ? item.action : {};
        out.query(action.query);
        for (const q of asArray(action.queries)) out.query(q);
        for (const source of asArray(action.sources)) if (isRecord(source)) out.consult(source.url, source.title);
      } else if (item.type === 'message' && (item.role === undefined || item.role === 'assistant')) {
        let first = true;
        for (const part of asArray(item.content)) {
          if (!isRecord(part)) continue;
          if (part.type === 'output_text') {
            out.appendText(part.text, first);
            first = false;
            for (const note of asArray(part.annotations)) {
              if (!isRecord(note) || note.type !== 'url_citation') continue;
              // The Responses API puts url and title on the annotation itself; Chat Completions nests them under `url_citation`.
              const detail = isRecord(note.url_citation) ? note.url_citation : note;
              out.cite(detail.url, detail.title);
            }
          } else if (part.type === 'refusal') {
            read.refusal = asString(part.refusal) || 'отказ';
          }
        }
      }
    }
    // The SDKs add a convenience `output_text` to the object they hand out; take it when the output items gave no text.
    if (!out.hasText) out.appendText(root.output_text);
    return read;
  }

  /** The reply has no text: say why when the API did (error, refusal, incomplete), else report an empty reply when the caller needs text. */
  private failIfNoText(read: Read, needText = false): void {
    if (read.refusal) throw new EngineError('refused', `${LABEL} отказа да отговори на този въпрос.`);
    if (read.error) throw new EngineError('bad_response', `${LABEL} върна грешка: ${read.error}`);
    if (read.incomplete) throw new EngineError('bad_response', `${LABEL} не завърши отговора (${quoteVendor(read.incomplete, [this.apiKey], 80)}).`);
    if (needText) throw new EngineError('bad_response', `${LABEL} върна празен отговор.`);
  }
}

interface Read {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  refusal: string;
  /** The reply's own error message, credentials blanked ('' when there is none). */
  error: string;
  /** Why the reply stopped early ('' when it did not). */
  incomplete: string;
}

/** Why the reply stopped early, from `incomplete_details` ({ reason }); '' when the reply says nothing about it. */
function describeIncomplete(details: unknown): string {
  if (!details) return '';
  return (isRecord(details) ? asString(details.reason) : asString(details)) || 'неизвестна причина';
}

function describeError(error: unknown, apiKey: string): string {
  if (typeof error === 'string') return quoteVendor(error, [apiKey]);
  if (isRecord(error)) return quoteVendor(asString(error.message) || JSON.stringify(error), [apiKey]);
  return '';
}
