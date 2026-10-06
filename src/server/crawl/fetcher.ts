import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { Agent, fetch as undiciFetch } from 'undici';
import type { FetchInfo } from '../../shared/schemas';
import { RobotsChecker, type RobotsFetchResult } from './robots';
import { assertPublicUrl, SsrfError, ssrfLookup } from './ssrf';

export interface FetchedPage {
  status: FetchInfo['status'];
  httpStatus: number | null;
  finalUrl: string | null;
  html: string | null;
  error: string | null;
  ttfbMs: number | null;
  bytes: number | null;
  fromCache: boolean;
}

/** The answer to fetchText: a sitemap, robots.txt or any other XML / plain-text file. */
export interface TextResult {
  status: 'ok' | 'http_error' | 'not_text' | 'error';
  httpStatus: number | null;
  text: string | null;
  finalUrl: string | null;
  error: string | null;
}

export interface PageFetcher {
  fetchPage(url: string, options?: { signal?: AbortSignal }): Promise<FetchedPage>;
  /** XML / plain text (sitemaps, robots.txt). Optional so simple fakes need not implement it. */
  fetchText?(url: string, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<TextResult>;
}

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  allowPrivateNetworks?: boolean;
  /** Preferred languages sent as Accept-Language, e.g. "bg,en;q=0.8". */
  acceptLanguage?: string;
  maxRedirects?: number;
  /** Test seam: replaces the network transport (the production default is undici's fetch through the SSRF-safe agent). */
  fetchImpl?: typeof undiciFetch;
}

const failure = (status: FetchInfo['status'], error: string, extra: Partial<FetchedPage> = {}): FetchedPage => ({
  status,
  httpStatus: null,
  finalUrl: null,
  html: null,
  error,
  ttfbMs: null,
  bytes: null,
  fromCache: false,
  ...extra,
});

/** Reads at most `limit` bytes of a response body, then cancels the stream. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > limit) {
        chunks.push(value.subarray(0, limit - total));
        total = limit;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: out, truncated };
}

/** Picks the charset from the Content-Type header or an early <meta>, since many older Bulgarian sites use windows-1251. */
export function detectCharset(contentType: string | null, head: Uint8Array): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 4096));
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  const charset = detectCharset(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** How much of a sitemap (decoded) fetchText reads when the caller names no limit. */
export const DEFAULT_TEXT_MAX_BYTES = 5 * 1024 * 1024;
/** The most fetchText ever reads, whatever the caller asks for: the sitemap protocol itself stops at 50 MB. */
const HARD_TEXT_MAX_BYTES = 50 * 1024 * 1024;

const gunzipAsync = promisify(gunzip);

/** "Text/XML; charset=utf-8" → "text/xml"; '' when the header is missing. */
const mediaType = (contentType: string | null): string => (contentType?.split(';')[0] ?? '').trim().toLowerCase();
const isGzipType = (mime: string): boolean => mime === 'application/gzip' || mime === 'application/x-gzip';
const isTextType = (mime: string): boolean =>
  mime === 'text/xml' || mime === 'application/xml' || mime === 'text/plain' || (mime.startsWith('application/') && mime.endsWith('+xml'));

/**
 * Sitemaps and robots.txt are XML or plain text, possibly gzipped. An HTML answer (typically a soft-404 page served
 * for /sitemap.xml) is not one, whatever the URL says. A missing Content-Type is accepted, like fetchPage does; the
 * generic binary types only count for a .gz URL.
 */
function acceptsAsText(mime: string, pathname: string): boolean {
  if (isTextType(mime) || isGzipType(mime) || mime === '') return true;
  return (mime === 'application/octet-stream' || mime === 'binary/octet-stream') && pathname.toLowerCase().endsWith('.gz');
}

const hasGzipMagic = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** UTF-8 without a byte-order mark, whichever way the decoder treats it. */
function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const textFailure = (status: TextResult['status'], error: string, extra: Partial<TextResult> = {}): TextResult => ({
  status,
  httpStatus: null,
  text: null,
  finalUrl: null,
  error,
  ...extra,
});

/** The response at the end of a redirect chain, or the reason there is none. */
type Opened =
  | { ok: true; response: Awaited<ReturnType<typeof undiciFetch>>; url: URL; ttfbMs: number }
  | { ok: false; status: 'error' | 'http_error' | 'blocked_robots'; error: string; httpStatus: number | null; finalUrl: string | null; ttfbMs: number | null };

const refused = (status: 'error' | 'http_error' | 'blocked_robots', error: string, extra: Partial<Extract<Opened, { ok: false }>> = {}): Opened => ({
  ok: false,
  status,
  error,
  httpStatus: null,
  finalUrl: null,
  ttfbMs: null,
  ...extra,
});

/** RFC 9309 asks crawlers to follow at least five consecutive redirects for robots.txt. */
const ROBOTS_MAX_REDIRECTS = 5;

export class SafeFetcher implements PageFetcher {
  private readonly agent: Agent;
  private readonly robots: RobotsChecker;
  private readonly maxRedirects: number;
  private readonly doFetch: typeof undiciFetch;

  constructor(private readonly options: FetcherOptions) {
    this.doFetch = options.fetchImpl ?? undiciFetch;
    this.agent = new Agent({
      connect: { lookup: ssrfLookup(options.allowPrivateNetworks ?? false) as never, timeout: Math.min(options.timeoutMs, 10_000) },
      keepAliveTimeout: 5_000,
    });
    this.maxRedirects = options.maxRedirects ?? 5;
    this.robots = new RobotsChecker((robotsUrl) => this.fetchRobotsTxt(robotsUrl), options.userAgent);
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  async fetchPage(rawUrl: string, options: { signal?: AbortSignal } = {}): Promise<FetchedPage> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const opened = await this.open(rawUrl, signal, {
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-language': this.options.acceptLanguage ?? 'bg,en;q=0.8' },
      robots: true,
    });
    if (!opened.ok) return failure(opened.status, opened.error, { httpStatus: opened.httpStatus, finalUrl: opened.finalUrl, ttfbMs: opened.ttfbMs });
    const { response, url, ttfbMs } = opened;

    const contentType = response.headers.get('content-type');
    if (contentType && !/html|xml/i.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return failure('not_html', `Не е HTML (${contentType.split(';')[0]})`, { httpStatus: response.status, ttfbMs, finalUrl: url.toString() });
    }

    try {
      const { bytes } = await readCapped(response.body as ReadableStream<Uint8Array> | null, this.options.maxBytes);
      return {
        status: 'ok',
        httpStatus: response.status,
        finalUrl: url.toString(),
        html: decodeHtml(bytes, contentType),
        error: null,
        ttfbMs,
        bytes: bytes.byteLength,
        fromCache: false,
      };
    } catch (err) {
      return failure('error', describeFetchError(err), { httpStatus: response.status, ttfbMs, finalUrl: url.toString() });
    }
  }

  /**
   * Fetches an XML or plain-text file: a sitemap (possibly gzipped) or robots.txt. It has the protections of fetchPage —
   * it is the same code that follows redirects, so every hop is checked against the SSRF rules, and one deadline covers
   * the chain — with these differences. robots.txt is not consulted (sitemaps and robots.txt exist for crawlers).
   * Only XML, plain text and gzip are accepted; an HTML answer is `not_text`. `maxBytes` (default 5 MB) is the size of
   * the DECODED text: a gzip file that expands past it is refused while it is being unpacked, never held in memory.
   */
  async fetchText(rawUrl: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<TextResult> {
    const wanted = options.maxBytes;
    const limit = Math.min(HARD_TEXT_MAX_BYTES, typeof wanted === 'number' && Number.isFinite(wanted) && wanted >= 1 ? Math.floor(wanted) : DEFAULT_TEXT_MAX_BYTES);
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const opened = await this.open(rawUrl, signal, { headers: { accept: 'application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1' }, robots: false });
    if (!opened.ok) return textFailure(opened.status === 'blocked_robots' ? 'error' : opened.status, opened.error, { httpStatus: opened.httpStatus, finalUrl: opened.finalUrl });
    const { response, url } = opened;
    const finalUrl = url.toString();
    const httpStatus = response.status;

    const mime = mediaType(response.headers.get('content-type'));
    if (!acceptsAsText(mime, url.pathname)) {
      await response.body?.cancel().catch(() => undefined);
      return textFailure('not_text', `Не е XML или текст (${mime.slice(0, 80)})`, { httpStatus, finalUrl });
    }

    try {
      const { bytes, truncated } = await readCapped(response.body as ReadableStream<Uint8Array> | null, limit);
      if (truncated) return textFailure('error', 'Файлът е твърде голям', { httpStatus, finalUrl });
      let decoded: Uint8Array = bytes;
      if (hasGzipMagic(bytes)) {
        try {
          // The cap is on what comes OUT: zlib stops (and frees what it had) as soon as the output would pass it.
          decoded = await gunzipAsync(bytes, { maxOutputLength: limit });
        } catch (err) {
          const tooBig = (err as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE';
          return textFailure('error', tooBig ? 'Файлът е твърде голям' : 'Невалиден gzip файл', { httpStatus, finalUrl });
        }
      } else if (isGzipType(mime) && bytes.byteLength > 0) {
        return textFailure('error', 'Невалиден gzip файл', { httpStatus, finalUrl });
      }
      return { status: 'ok', httpStatus, text: decodeText(decoded), finalUrl, error: null };
    } catch (err) {
      return textFailure('error', describeFetchError(err), { httpStatus, finalUrl });
    }
  }

  /**
   * One request with everything that keeps this server from being turned against its own network: every hop of a
   * redirect chain is validated first (assertPublicUrl: protocol, port, host name, IP literals), redirects are followed
   * by hand up to a limit, one deadline covers the whole chain, and the connection goes through the agent whose DNS
   * lookup refuses internal addresses. Pages and sitemaps both go through here, so their protections cannot drift apart.
   * The caller reads (or cancels) the body of a successful response.
   */
  private async open(rawUrl: string, signal: AbortSignal, request: { headers: Record<string, string>; robots: boolean }): Promise<Opened> {
    let current = rawUrl;

    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      let url: URL;
      try {
        url = assertPublicUrl(current, { allowPrivateNetworks: this.options.allowPrivateNetworks ?? false });
      } catch (err) {
        return refused('error', err instanceof Error ? err.message : 'Невалиден URL');
      }

      if (request.robots) {
        let verdict: Awaited<ReturnType<RobotsChecker['check']>>;
        try {
          verdict = await this.robots.check(url);
        } catch {
          return refused('error', 'Грешка при проверка на robots.txt');
        }
        if (!verdict.allowed) return refused('blocked_robots', verdict.reason ?? 'robots.txt забранява достъпа');
      }

      const started = performance.now();
      let response;
      try {
        response = await this.doFetch(url, {
          dispatcher: this.agent,
          redirect: 'manual',
          signal,
          headers: { 'user-agent': this.options.userAgent, ...request.headers },
        });
      } catch (err) {
        return refused('error', describeFetchError(err));
      }
      const ttfbMs = Math.round(performance.now() - started);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) return refused('http_error', `Пренасочване без Location (${response.status})`, { httpStatus: response.status, ttfbMs });
        try {
          current = new URL(location, url).toString();
        } catch {
          return refused('error', 'Невалидно пренасочване', { httpStatus: response.status, ttfbMs });
        }
        continue;
      }

      if (response.status >= 400) {
        await response.body?.cancel().catch(() => undefined);
        return refused('http_error', `HTTP ${response.status}`, { httpStatus: response.status, ttfbMs, finalUrl: url.toString() });
      }

      return { ok: true, response, url, ttfbMs };
    }
    return refused('error', `Твърде много пренасочвания (над ${this.maxRedirects})`);
  }

  /**
   * robots.txt is fetched with the same rules as a page: redirects are followed by hand and every hop goes through
   * assertPublicUrl, otherwise a hostile site could answer /robots.txt with "302 → http://169.254.169.254/…" and make
   * this server send requests to internal addresses.
   */
  private async fetchRobotsTxt(robotsUrl: string): Promise<RobotsFetchResult | null> {
    const allowPrivateNetworks = this.options.allowPrivateNetworks ?? false;
    const signal = AbortSignal.timeout(Math.min(this.options.timeoutMs, 6_000));
    try {
      let current = robotsUrl;
      for (let hop = 0; hop <= ROBOTS_MAX_REDIRECTS; hop++) {
        const url = assertPublicUrl(current, { allowPrivateNetworks });
        const response = await this.doFetch(url, {
          dispatcher: this.agent,
          redirect: 'manual',
          signal,
          headers: { 'user-agent': this.options.userAgent, accept: 'text/plain,*/*;q=0.1' },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (!location) return null;
          current = new URL(location, url).toString();
          continue;
        }
        if (response.status >= 400) {
          await response.body?.cancel().catch(() => undefined);
          return { status: response.status, text: '' };
        }
        const { bytes } = await readCapped(response.body as ReadableStream<Uint8Array> | null, 512 * 1024);
        return { status: response.status, text: new TextDecoder('utf-8').decode(bytes) };
      }
      return null; // redirect chain too long: cannot tell, like an unreachable file
    } catch {
      return null;
    }
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof SsrfError) return err.message;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof SsrfError) return cause.message;
  const code = (cause as { code?: string } | undefined)?.code ?? (err as { code?: string } | null)?.code;
  if (code === 'ESSRF') return 'Хостът сочи към вътрешен адрес — отказан';
  if (code === 'ENOTFOUND') return 'Домейнът не е намерен (DNS)';
  if (code === 'ECONNREFUSED') return 'Връзката е отказана';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'Изтече времето за връзка';
  if ((err as { name?: string } | null)?.name === 'TimeoutError') return 'Изтече времето за изчакване';
  if ((err as { name?: string } | null)?.name === 'AbortError') return 'Заявката е прекратена';
  return err instanceof Error ? err.message.slice(0, 160) : 'Неизвестна грешка при изтегляне';
}
