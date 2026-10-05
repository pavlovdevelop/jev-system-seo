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

export interface PageFetcher {
  fetchPage(url: string, options?: { signal?: AbortSignal }): Promise<FetchedPage>;
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
    let current = rawUrl;

    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      let url: URL;
      try {
        url = assertPublicUrl(current, { allowPrivateNetworks: this.options.allowPrivateNetworks ?? false });
      } catch (err) {
        return failure('error', err instanceof Error ? err.message : 'Невалиден URL');
      }

      const verdict = await this.robots.check(url);
      if (!verdict.allowed) return failure('blocked_robots', verdict.reason ?? 'robots.txt забранява достъпа');

      const started = performance.now();
      let response;
      try {
        response = await this.doFetch(url, {
          dispatcher: this.agent,
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': this.options.userAgent,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'accept-language': this.options.acceptLanguage ?? 'bg,en;q=0.8',
          },
        });
      } catch (err) {
        return failure('error', describeFetchError(err));
      }
      const ttfbMs = Math.round(performance.now() - started);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) return failure('http_error', `Пренасочване без Location (${response.status})`, { httpStatus: response.status, ttfbMs });
        try {
          current = new URL(location, url).toString();
        } catch {
          return failure('error', 'Невалидно пренасочване', { httpStatus: response.status, ttfbMs });
        }
        continue;
      }

      if (response.status >= 400) {
        await response.body?.cancel().catch(() => undefined);
        return failure('http_error', `HTTP ${response.status}`, { httpStatus: response.status, ttfbMs, finalUrl: url.toString() });
      }

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
    return failure('error', `Твърде много пренасочвания (над ${this.maxRedirects})`);
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
