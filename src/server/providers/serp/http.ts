import { sleep } from '../../util/limit';
import { SerpError } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PostJsonOptions {
  headers: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Retries after the first attempt, for 429/5xx and network errors. */
  retries?: number;
  signal?: AbortSignal;
  /** Human name of the vendor used in error messages. */
  vendor: string;
  /** Credentials to blank out of anything quoted from the vendor's reply (a vendor may echo request headers in an error). */
  secrets?: readonly string[];
}

/** POST a JSON body, retry transient failures with backoff, and map HTTP errors to SerpError. */
export async function postJson(url: string, body: unknown, options: PostJsonOptions): Promise<unknown> {
  const { fetchImpl = fetch, timeoutMs = 25_000, retries = 2, vendor } = options;
  let lastError: SerpError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw new SerpError('unavailable', `${vendor}: заявката е прекратена`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...options.headers },
        body: JSON.stringify(body),
        // The vendor's endpoint never needs to redirect, and fetch would forward the X-API-KEY header to wherever it pointed.
        redirect: 'error',
        signal,
      });
    } catch (err) {
      lastError = new SerpError('unavailable', `${vendor}: няма връзка (${err instanceof Error ? err.message : 'грешка'})`, undefined, { cause: err });
      if (options.signal?.aborted) throw lastError;
      if (attempt < retries) await sleep(backoff(attempt, null), options.signal).catch(() => undefined);
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch (err) {
        throw new SerpError('bad_response', `${vendor}: отговорът не е валиден JSON`, response.status, { cause: err });
      }
    }

    const text = redact((await response.text().catch(() => '')).slice(0, 300), options.secrets);
    const status = response.status;
    if (status === 401 || status === 403) throw new SerpError('auth', `${vendor} отхвърли API ключа (${status}). Провери данните за достъп.`, status);
    if (status === 402 || (status === 400 && /credit|balance|fund|quota/i.test(text))) {
      throw new SerpError('quota', `${vendor}: няма достатъчно кредити/баланс.`, status);
    }
    if (status === 429) lastError = new SerpError('rate_limit', `${vendor}: твърде много заявки (429)`, status);
    else if (status >= 500) lastError = new SerpError('unavailable', `${vendor} върна грешка ${status}`, status);
    else throw new SerpError('bad_response', `${vendor} върна ${status}: ${text}`, status);

    if (attempt < retries) await sleep(backoff(attempt, response.headers.get('retry-after')), options.signal).catch(() => undefined);
  }
  throw lastError ?? new SerpError('unavailable', `${vendor}: неуспешна заявка`);
}

/** Replaces every occurrence of a credential (and of its base64 form, as used in Basic auth) with ***. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue; // too short to be a credential; replacing it would mangle ordinary words
    for (const form of new Set([secret, Buffer.from(secret).toString('base64')])) out = out.split(form).join('***');
  }
  return out;
}

function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 10) * 1000;
  return 600 * 2 ** attempt + Math.floor(Math.random() * 200);
}
