import { stripInvisible } from '../../../shared/text';
import { redact } from '../../providers/serp/http';
import { sleep } from '../../util/limit';
import { asString, EngineError, isRecord, type EngineErrorKind, type EngineFactoryOptions, type FetchLike } from './types';

// A small POST-JSON helper for the adapters that talk to their vendor over plain fetch (OpenAI, Gemini).
// It owns everything that must behave the same for both: the timeout, never following a redirect (fetch would
// forward the API key to wherever it pointed), retries with backoff, and turning every failure into an EngineError
// whose message is Bulgarian and never contains a credential.

/** The factory options plus the one knob only tests need. */
export interface EngineHttpOptions extends EngineFactoryOptions {
  /** Base of the retry backoff in ms (600 by default). Tests pass 1 so that nothing sleeps. */
  backoffBaseMs?: number;
}

export interface PostJsonOptions {
  /** How the assistant is named in the messages a user sees ("ChatGPT"). */
  vendor: string;
  headers: Record<string, string>;
  /** Credentials to blank out of anything quoted from the vendor's reply or from a network error. */
  secrets: readonly string[];
  fetchImpl?: FetchLike;
  timeoutMs: number;
  /** Retries after the first attempt, for 429/5xx and network errors. Default 2. */
  retries?: number;
  backoffBaseMs?: number;
  /** The caller's signal; aborting it ends the call with kind 'aborted'. */
  signal?: AbortSignal;
}

/** What the vendor said about a failed request: the pieces an adapter may want to react to (credentials already blanked). */
export interface VendorDetail {
  message: string;
  code: string;
  type: string;
  param: string;
  /** Google's `error.status`, e.g. RESOURCE_EXHAUSTED. */
  status: string;
}

/** An HTTP error reply, as an EngineError that still carries what the vendor said. */
export class VendorHttpError extends EngineError {
  constructor(
    kind: EngineErrorKind,
    message: string,
    status: number,
    public readonly detail: VendorDetail,
  ) {
    super(kind, message, status);
  }
}

const MAX_RETRY_AFTER_MS = 10_000;

/** POSTs a JSON body and returns the parsed JSON reply. Transient failures are retried; everything else throws an EngineError. */
export async function postJson(url: string, body: unknown, options: PostJsonOptions): Promise<unknown> {
  const { vendor, secrets, timeoutMs, signal: caller } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = Math.max(0, Math.floor(options.retries ?? 2));
  const base = options.backoffBaseMs ?? 600;
  const payload = JSON.stringify(body);
  let last: EngineError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (caller?.aborted) throw aborted(vendor);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;

    let ok: boolean;
    let status: number;
    let headers: Headers;
    let text: string;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...options.headers },
        body: payload,
        // The endpoint never needs to redirect, and fetch would forward the API key header to wherever it pointed.
        redirect: 'error',
        signal,
      });
      ok = response.ok;
      status = response.status;
      headers = response.headers;
      // Reading the body is part of the attempt: a reply that stalls half-way is a timeout like any other.
      text = await response.text();
    } catch (err) {
      if (caller?.aborted) throw aborted(vendor, err, secrets);
      last = timeout.aborted
        ? new EngineError('unavailable', `${vendor}: отговорът се забави повече от ${Math.max(1, Math.round(timeoutMs / 1000))} с.`)
        : new EngineError('unavailable', `${vendor}: няма връзка (${describeNetworkError(err, secrets)})`, undefined, { cause: safeCause(err, secrets) });
      if (attempt < retries) await pause(retryDelayMs(null, attempt, base), caller);
      continue;
    }

    if (ok) {
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch (err) {
        throw new EngineError('bad_response', `${vendor}: отговорът не е валиден JSON`, status, { cause: safeCause(err, secrets) });
      }
    }

    const failure = failureFor(vendor, status, text, secrets);
    if (failure.kind !== 'rate_limit' && failure.kind !== 'unavailable') throw failure;
    last = failure;
    if (attempt < retries) await pause(retryDelayMs(headers, attempt, base), caller);
  }
  throw last ?? new EngineError('unavailable', `${vendor}: неуспешна заявка`);
}

/**
 * Vendor text for a message a user will see: credentials are blanked out of the whole text first and the cut comes
 * after (cutting first could leave half a key at the end), invisible characters go, whitespace collapses.
 */
export function quoteVendor(text: string, secrets: readonly string[], max = 300): string {
  return stripInvisible(redact(text.slice(0, 20_000), secrets)).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A copy of an error that can be attached as a `cause` without carrying a credential. */
export function safeCause(err: unknown, secrets: readonly string[]): Error | undefined {
  if (!(err instanceof Error)) return undefined;
  const copy = new Error(quoteVendor(err.message, secrets));
  copy.name = err.name;
  return copy;
}

const aborted = (vendor: string, cause?: unknown, secrets: readonly string[] = []): EngineError =>
  new EngineError('aborted', `${vendor}: заявката е прекратена.`, undefined, cause === undefined ? undefined : { cause: safeCause(cause, secrets) });

function describeNetworkError(err: unknown, secrets: readonly string[]): string {
  if (!(err instanceof Error)) return 'грешка';
  const inner = err.cause instanceof Error ? err.cause.message : '';
  return quoteVendor(inner && !err.message.includes(inner) ? `${err.message}: ${inner}` : err.message, secrets, 160) || 'грешка';
}

/** Sleeps; if the caller aborts meanwhile the loop's next check ends the call with 'aborted'. */
const pause = (ms: number, signal: AbortSignal | undefined): Promise<void> => sleep(ms, signal).catch(() => undefined);

/** How long to wait before the next attempt: the vendor's Retry-After (seconds, a date, or OpenAI's ms variant) up to 10 s, else exponential backoff. */
export function retryDelayMs(headers: Headers | null, attempt: number, base: number): number {
  const ms = headers?.get('retry-after-ms');
  if (ms != null && ms.trim() !== '' && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Math.min(Number(ms), MAX_RETRY_AFTER_MS);
  const after = headers?.get('retry-after');
  if (after != null && after.trim() !== '') {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return Math.min(base * 2 ** attempt + Math.floor(Math.random() * (base / 3 + 1)), MAX_RETRY_AFTER_MS);
}

// ───────────────────────── reading and classifying an error reply ─────────────────────────

// Machine-readable codes come first. Free text is only a fallback, and a careful one: OpenAI's plain rate-limit message
// (code rate_limit_exceeded) tells free accounts to add a payment method at ".../account/billing", and Google's
// per-minute limit says "exceeded your current quota ... billing details ... Please retry in 34s". Neither is an empty account.
const QUOTA_CODE = /^(?:insufficient_quota|billing_hard_limit_reached|billing_not_active|quota_exceeded|credit_balance_too_low)$/i;
const QUOTA_TEXT =
  /exceeded (?:your |the )?(?:current )?quota|quota (?:has been |is )?exceeded|insufficient[\s_-]*(?:quota|credits?|funds?|balance)|credit balance|out of credits?|payment required|billing hard limit|billing (?:account )?(?:is )?(?:not (?:active|enabled)|disabled)|enable billing/i;
const RATE_HINT = /please retry in|retrydelay|try again in \d/i;
const MODEL_CODE = /^(?:model_not_found|model_not_available)$/i;
const MODEL_TEXT =
  /\bmodel\b[^.\n]{0,120}?\b(?:does not exist|do not exist|is not found|was not found|not found)\b|\bmodels\/\S+ is not found|\b(?:unknown|invalid|unsupported) model\b|do not have access to (?:the )?model/i;
// Google answers an invalid key with 400 INVALID_ARGUMENT (reason API_KEY_INVALID), not 401.
const AUTH_TEXT = /API_KEY_INVALID|api key (?:is )?(?:not valid|invalid|expired)|invalid api key|incorrect api key/i;

function readDetail(text: string, secrets: readonly string[]): VendorDetail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const root = isRecord(parsed) ? parsed : {};
  const inner = isRecord(root.error) ? root.error : root;
  const short = (v: unknown): string => quoteVendor(typeof v === 'string' || typeof v === 'number' ? String(v) : '', secrets, 80);
  return {
    message: quoteVendor(asString(inner.message) || asString(root.error) || text, secrets),
    code: short(inner.code),
    type: short(inner.type),
    param: short(inner.param),
    status: short(inner.status),
  };
}

function classify(status: number, detail: VendorDetail, text: string): EngineErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 && AUTH_TEXT.test(text)) return 'auth';
  if (isQuota(status, detail, text)) return 'quota';
  if (status === 404 || ((status === 400 || status === 422) && (MODEL_CODE.test(detail.code) || MODEL_TEXT.test(detail.message)))) return 'model';
  if (status === 429) return 'rate_limit';
  if (status >= 500 || status === 408) return 'unavailable';
  return 'bad_response';
}

function isQuota(status: number, detail: VendorDetail, text: string): boolean {
  if (status === 402) return true;
  if (QUOTA_CODE.test(detail.code) || QUOTA_CODE.test(detail.type)) return true;
  if (/^rate_limit/i.test(detail.code)) return false; // the vendor itself calls this a plain rate limit
  if (status !== 400 && status !== 429) return false;
  if (RATE_HINT.test(text)) return false; // "retry in 34s" is a per-minute limit, not an empty account
  return QUOTA_TEXT.test(text);
}

function failureFor(vendor: string, status: number, text: string, secrets: readonly string[]): VendorHttpError {
  const detail = readDetail(text, secrets);
  const kind = classify(status, detail, text);
  const quote = detail.message === '' ? '' : ` ${detail.message}`;
  // Not quoted: a 401 message may echo part of the key ("sk-...abcd"), and a 5xx body is usually an HTML error page.
  const message = {
    auth: status === 403 ? `${vendor}: достъпът е отказан (403).${quote}` : `${vendor} отхвърли API ключа (${status}). Провери данните за достъп.`,
    quota: `${vendor}: няма достатъчно кредити или квота (${status}). Провери плана и баланса при доставчика.`,
    model: `${vendor}: моделът не е наличен (${status}).${quote}`,
    rate_limit: `${vendor}: твърде много заявки (${status}).`,
    unavailable: `${vendor} върна грешка ${status}.`,
    bad_response: `${vendor} върна ${status}:${quote || ' (без съобщение)'}`,
    refused: `${vendor} отказа заявката (${status}).`,
    aborted: `${vendor}: заявката е прекратена.`,
  }[kind];
  return new VendorHttpError(kind, message, status, detail);
}
