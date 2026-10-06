import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { ENGINE_LABELS } from '../../../shared/domain';
import { quoteVendor, safeCause } from './http';
import {
  AnswerCollector,
  asCount,
  asString,
  elapsedMs,
  EngineError,
  isRecord,
  type AnswerEngine,
  type AskOptions,
  type EngineAnswer,
  type EngineConfig,
  type EngineErrorKind,
  type EngineFactoryOptions,
  type GenerateRequest,
  type GenerateResult,
  vendorLocation,
} from './types';

// Claude, through the official SDK (https://github.com/anthropics/anthropic-sdk-typescript) and its Messages API.
// ask() gives the model the server-side web search tool; the answer's text blocks carry `web_search_result_location`
// citations (what the answer relies on) and each `web_search_tool_result` lists the pages the search returned (consulted).
//
// Server-tool failures (a search that errors, max_uses reached) do not throw: they arrive with HTTP 200 as an error
// object in place of the result list. A long turn may stop with `pause_turn` and has to be resumed.

const LABEL = ENGINE_LABELS.anthropic;
const API_URL = 'https://api.anthropic.com';
const ASK_MAX_TOKENS = 8000;
/** Models that think always count their thinking against max_tokens; generate() leaves room for it. */
const THINKING_HEADROOM = 4000;
const MAX_SEARCHES = 4;
const MAX_RESUMES = 3;

export interface AnthropicCaps {
  /** The web-search tool variant the model takes: the newer one for current models, the original for the rest. */
  searchTool: 'web_search_20260209' | 'web_search_20250305';
  /** The model accepts `output_config.effort` (and always thinks). Older models reject the field. */
  effort: boolean;
}

// Exact ids; a dated snapshot ("claude-opus-5-5-20261001") or "-latest" counts as the same model.
const CURRENT_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
];

/** What a model supports. Anything not known to be current gets the original tool and no `output_config`, which every model accepts. */
export function anthropicCaps(model: string): AnthropicCaps {
  const id = model.trim().toLowerCase();
  const current =
    id === 'claude-fable-5' ||
    id.startsWith('claude-fable-5-') ||
    CURRENT_MODELS.some((known) => id === known || (id.startsWith(`${known}-`) && /^(?:\d{8}|latest)$/.test(id.slice(known.length + 1))));
  return current ? { searchTool: 'web_search_20260209', effort: true } : { searchTool: 'web_search_20250305', effort: false };
}

function searchTool(caps: AnthropicCaps, location: AskOptions['location']): Anthropic.WebSearchTool20260209 | Anthropic.WebSearchTool20250305 {
  const common = {
    name: 'web_search',
    max_uses: MAX_SEARCHES,
    user_location: { type: 'approximate', ...vendorLocation(location) },
  } as const;
  return caps.searchTool === 'web_search_20260209' ? { ...common, type: 'web_search_20260209' } : { ...common, type: 'web_search_20250305' };
}

/** What the replies of one ask() add up to. */
interface Tally {
  inputTokens: number;
  outputTokens: number;
  /** web searches, as the API counts them (or as many as `server_tool_use` blocks, when it does not say) */
  searches: number;
  /** `server_tool_use` web_search blocks seen */
  issued: number;
  /** `web_search_tool_result` blocks: all, and those that carry results rather than an error */
  results: number;
  resultsOk: number;
  /** The last block read was a search block: the next text starts a new paragraph if it would otherwise run on from the last one. */
  afterTool: boolean;
}

const newTally = (): Tally => ({ inputTokens: 0, outputTokens: 0, searches: 0, issued: 0, results: 0, resultsOk: 0, afterTool: false });

export class AnthropicEngine implements AnswerEngine {
  readonly id = 'anthropic' as const;
  readonly label = LABEL;
  readonly model: string;
  private readonly apiKey: string;
  private readonly client: Anthropic;

  constructor(
    config: EngineConfig,
    private readonly options: EngineFactoryOptions = {},
  ) {
    this.apiKey = config.apiKey.trim();
    this.model = config.model;
    const fetchImpl = options.fetchImpl;
    this.client = new Anthropic({
      apiKey: this.apiKey,
      // Without these the SDK would also read ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL from the environment: a stray
      // variable could then send our key to another host or add a second credential to every request.
      authToken: null,
      baseURL: API_URL,
      maxRetries: Math.max(0, Math.floor(options.retries ?? 2)),
      timeout: options.timeoutMs ?? 90_000,
      // The API never redirects; fetch would forward the key header to the target.
      fetchOptions: { redirect: 'error' },
      ...(fetchImpl ? { fetch: (input: string | URL | Request, init?: RequestInit) => fetchImpl(urlOf(input), init) } : {}),
    });
  }

  async ask(question: string, { location, signal }: AskOptions): Promise<EngineAnswer> {
    const started = performance.now();
    const caps = anthropicCaps(this.model);
    const timeoutMs = this.options.timeoutMs ?? 90_000;
    const user: Anthropic.MessageParam = { role: 'user', content: question };
    // What the assistant has produced over paused turns. A paused turn is resumed by sending it back as an assistant turn
    // — and nothing after it: the model carries on from where it stopped.
    const produced: Anthropic.ContentBlockParam[] = [];
    const collector = new AnswerCollector();
    const tally = newTally();

    let message: Anthropic.Message;
    for (let resumes = 0; ; resumes++) {
      message = await this.create(
        {
          model: this.model,
          max_tokens: ASK_MAX_TOKENS,
          messages: produced.length === 0 ? [user] : [user, { role: 'assistant', content: produced }],
          tools: [searchTool(caps, location)],
          ...(caps.effort ? { output_config: { effort: 'low' as const } } : {}),
        },
        timeoutMs,
        signal,
      );
      this.read(message, collector, tally);
      if (message.stop_reason === 'refusal') throw refused();
      if (message.stop_reason !== 'pause_turn' || resumes >= MAX_RESUMES) break;
      produced.push(...message.content);
    }

    if (!collector.hasText) throw this.noText(message);
    return collector.build({
      // A search that only ever came back as an error did not give the answer anything from the web.
      searched: tally.resultsOk > 0 || (tally.issued > 0 && tally.results === 0),
      latencyMs: elapsedMs(started),
      usage: { inputTokens: tally.inputTokens, outputTokens: tally.outputTokens, searches: tally.searches },
      model: asString(message.model).trim() || this.model,
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const caps = anthropicCaps(this.model);
    // `json` has no vendor mode here (a prefilled "{" is rejected by current models): the prompt has to ask for it.
    const message = await this.create(
      {
        model: this.model,
        max_tokens: (request.maxTokens ?? 2000) + (caps.effort ? THINKING_HEADROOM : 0),
        messages: [{ role: 'user', content: request.prompt }],
        ...(request.system ? { system: request.system } : {}),
        ...(caps.effort ? { output_config: { effort: 'medium' as const } } : {}),
      },
      this.options.timeoutMs ?? 120_000,
      request.signal,
    );
    if (message.stop_reason === 'refusal') throw refused();
    const collector = new AnswerCollector();
    const tally = newTally();
    this.read(message, collector, tally);
    if (!collector.hasText) throw this.noText(message);
    return { text: collector.fullText(), usage: { inputTokens: tally.inputTokens, outputTokens: tally.outputTokens } };
  }

  private async create(params: Anthropic.MessageCreateParamsNonStreaming, timeoutMs: number, signal: AbortSignal | undefined): Promise<Anthropic.Message> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(params, { timeout: timeoutMs, ...(signal ? { signal } : {}) });
    } catch (err) {
      throw this.toEngineError(err, signal);
    }
    // A 2xx that is not a Message (the SDK hands back the text of a non-JSON body as it is).
    if (!isRecord(message) || !Array.isArray(message.content)) throw new EngineError('bad_response', `${LABEL}: неочакван формат на отговора`);
    return message;
  }

  /** Reads one reply into the collector and the tally. Never throws on an odd block. */
  private read(message: Anthropic.Message, out: AnswerCollector, tally: Tally): void {
    tally.inputTokens += asCount(message.usage?.input_tokens);
    tally.outputTokens += asCount(message.usage?.output_tokens);
    let issued = 0;

    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      switch (block.type) {
        case 'text':
          out.appendText(block.text, tally.afterTool);
          tally.afterTool = false;
          for (const citation of block.citations ?? []) {
            if (typeof citation === 'object' && citation !== null && citation.type === 'web_search_result_location') out.cite(citation.url, citation.title);
          }
          break;
        case 'server_tool_use':
          if (block.name !== 'web_search') break;
          issued++;
          if (isRecord(block.input)) out.query(block.input.query);
          tally.afterTool = true;
          break;
        case 'web_search_tool_result':
          tally.results++;
          tally.afterTool = true;
          // A list of results on success; on failure one error object (code max_uses_exceeded, unavailable, ...).
          if (Array.isArray(block.content)) {
            tally.resultsOk++;
            for (const result of block.content) if (typeof result === 'object' && result !== null) out.consult(result.url, result.title);
          }
          break;
        default:
          break; // thinking and every other block type carry nothing we report
      }
    }
    tally.issued += issued;
    const reported = message.usage?.server_tool_use?.web_search_requests;
    tally.searches += typeof reported === 'number' && Number.isFinite(reported) ? Math.max(0, Math.round(reported)) : issued;
  }

  private noText(message: Anthropic.Message): EngineError {
    if (message.stop_reason === 'max_tokens') return new EngineError('bad_response', `${LABEL}: отговорът свърши в лимита на токените, преди да има текст.`);
    if (message.stop_reason === 'pause_turn') return new EngineError('bad_response', `${LABEL} не завърши отговора навреме.`);
    return new EngineError('bad_response', `${LABEL} върна празен отговор.`);
  }

  /** SDK errors by class, never by message. */
  private toEngineError(err: unknown, signal: AbortSignal | undefined): EngineError {
    const secrets = [this.apiKey];
    const fail = (kind: EngineErrorKind, message: string, status?: number): EngineError => new EngineError(kind, message, status);

    if (err instanceof EngineError) return err;
    // These two are APIErrors without a status and come before the generic APIError branch.
    if (err instanceof APIUserAbortError) return fail('aborted', `${LABEL}: заявката е прекратена.`);
    if (err instanceof APIConnectionTimeoutError) return fail('unavailable', `${LABEL}: отговорът се забави твърде много.`);
    if (err instanceof APIConnectionError) {
      const cause = err.cause instanceof Error ? ` (${quoteVendor(err.cause.message, secrets, 160)})` : '';
      return new EngineError('unavailable', `${LABEL}: няма връзка${cause}`, undefined, { cause: safeCause(err.cause, secrets) });
    }
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
      return fail('auth', `${LABEL} отхвърли API ключа (${err.status}). Провери данните за достъп.`, err.status);
    }
    if (err instanceof APIError) {
      const said = bodyMessage(err, secrets);
      const status = err.status;
      const quote = said === '' ? '' : ` ${said}`;
      if (err instanceof NotFoundError) return fail('model', `${LABEL}: моделът не е наличен (404).${quote}`, status);
      // A 429 about credit or billing is an empty account, not a rate limit. (The API also words an empty account as a 400.)
      if ((err instanceof RateLimitError || err instanceof BadRequestError) && /credit|billing/i.test(said)) {
        return fail('quota', `${LABEL}: няма достатъчно кредити или квота (${status}). Провери плана и баланса при доставчика.`, status);
      }
      if (err instanceof RateLimitError) return fail('rate_limit', `${LABEL}: твърде много заявки (${status}).`, status);
      if (err instanceof InternalServerError || (typeof status === 'number' && (status >= 500 || status === 408))) {
        return fail('unavailable', `${LABEL} върна грешка ${status}.`, status);
      }
      return fail('bad_response', `${LABEL} върна ${status}:${quote || ' (без съобщение)'}`, status);
    }
    if (signal?.aborted) return fail('aborted', `${LABEL}: заявката е прекратена.`);
    // An invalid JSON body makes the SDK's parser throw a SyntaxError.
    if (err instanceof SyntaxError) return new EngineError('bad_response', `${LABEL}: отговорът не е валиден JSON`, undefined, { cause: safeCause(err, secrets) });
    const what = err instanceof Error ? quoteVendor(err.message, secrets, 160) : 'грешка';
    return new EngineError('unavailable', `${LABEL}: неочаквана грешка (${what})`, undefined, { cause: safeCause(err, secrets) });
  }
}

const refused = (): EngineError => new EngineError('refused', 'Claude отказа да отговори на този въпрос.');

const urlOf = (input: string | URL | Request): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** The API's own message from an error reply ({ type: 'error', error: { type, message } }), credentials blanked. */
function bodyMessage(err: APIError, secrets: readonly string[]): string {
  const body = isRecord(err.error) ? err.error : {};
  const inner = isRecord(body.error) ? body.error : body;
  return quoteVendor(asString(inner.message) || asString(body.message), secrets);
}
