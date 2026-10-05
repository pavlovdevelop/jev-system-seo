import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeHtml, detectCharset, SafeFetcher } from '../../src/server/crawl/fetcher';
import { ssrfLookup } from '../../src/server/crawl/ssrf';

/** Minimal windows-1251 encoder for the characters used in tests (ASCII + basic Cyrillic). */
function cp1251(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c >= 0x410 && c <= 0x44f) bytes.push(c - 0x410 + 0xc0);
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

const html = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;

let server: Server;
let base: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/';
    hits.push(path);
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    switch (path) {
      case '/robots.txt':
        return send(200, 'text/plain', 'User-agent: *\nDisallow: /private');
      case '/ok':
        return send(200, 'text/html; charset=utf-8', html('<h1>Здравей</h1>'));
      case '/redirect':
        return send(302, 'text/plain', '', { location: '/ok' });
      case '/loop':
        return send(302, 'text/plain', '', { location: '/loop' });
      case '/cp1251-header':
        return send(200, 'text/html; charset=windows-1251', cp1251('<html><body>Изработка на сайт</body></html>'));
      case '/cp1251-meta':
        return send(200, 'text/html', cp1251('<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"></head><body>Изработка на сайт</body></html>'));
      case '/big':
        return send(200, 'text/html', `<html><body>${'x'.repeat(300_000)}</body></html>`);
      case '/json':
        return send(200, 'application/json', '{"a":1}');
      case '/missing':
        return send(404, 'text/html', 'nope');
      case '/forbidden':
        return send(403, 'text/html', 'bot blocked');
      case '/private/page':
        return send(200, 'text/html', html('<h1>secret</h1>'));
      case '/slow':
        return; // never answers
      default:
        return send(404, 'text/plain', 'not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const makeFetcher = (over: Partial<ConstructorParameters<typeof SafeFetcher>[0]> = {}) =>
  new SafeFetcher({ userAgent: 'JevSeoRadar/test', timeoutMs: 3000, maxBytes: 100_000, allowPrivateNetworks: true, ...over });

describe('SafeFetcher', () => {
  it('fetches HTML and reports timing and size', async () => {
    const f = makeFetcher();
    const page = await f.fetchPage(`${base}/ok`);
    expect(page).toMatchObject({ status: 'ok', httpStatus: 200, finalUrl: `${base}/ok` });
    expect(page.html).toContain('Здравей');
    expect(page.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(page.bytes).toBeGreaterThan(10);
    await f.close();
  });

  it('follows redirects, but not forever', async () => {
    const f = makeFetcher();
    expect((await f.fetchPage(`${base}/redirect`)).finalUrl).toBe(`${base}/ok`);
    const loop = await f.fetchPage(`${base}/loop`);
    expect(loop.status).toBe('error');
    expect(loop.error).toMatch(/пренасочвания/);
    await f.close();
  });

  it('decodes windows-1251 pages declared in the header or in a <meta> tag', async () => {
    const f = makeFetcher();
    expect((await f.fetchPage(`${base}/cp1251-header`)).html).toContain('Изработка на сайт');
    expect((await f.fetchPage(`${base}/cp1251-meta`)).html).toContain('Изработка на сайт');
    await f.close();
  });

  it('caps the body size', async () => {
    const f = makeFetcher({ maxBytes: 50_000 });
    const page = await f.fetchPage(`${base}/big`);
    expect(page.status).toBe('ok');
    expect(page.bytes).toBe(50_000);
    await f.close();
  });

  it('classifies non-HTML, HTTP errors and bot blocks', async () => {
    const f = makeFetcher();
    expect(await f.fetchPage(`${base}/json`)).toMatchObject({ status: 'not_html', html: null });
    expect(await f.fetchPage(`${base}/missing`)).toMatchObject({ status: 'http_error', httpStatus: 404 });
    expect(await f.fetchPage(`${base}/forbidden`)).toMatchObject({ status: 'http_error', httpStatus: 403 });
    await f.close();
  });

  it('honours robots.txt and never requests the disallowed page', async () => {
    const f = makeFetcher();
    hits.length = 0;
    const page = await f.fetchPage(`${base}/private/page`);
    expect(page).toMatchObject({ status: 'blocked_robots', html: null });
    expect(hits).not.toContain('/private/page');
    await f.close();
  });

  it('times out slow servers', async () => {
    const f = makeFetcher({ timeoutMs: 400 });
    const page = await f.fetchPage(`${base}/slow`);
    expect(page.status).toBe('error');
    expect(page.error).toMatch(/време|прекратена|Timeout/i);
    await f.close();
  });

  it('refuses private targets by default (127.0.0.1) without touching the network', async () => {
    const f = makeFetcher({ allowPrivateNetworks: false });
    hits.length = 0;
    const page = await f.fetchPage(`${base}/ok`);
    expect(page.status).toBe('error');
    expect(page.error).toMatch(/порт|частна|вътрешн/i);
    expect(hits).toHaveLength(0);
    await f.close();
  });

  it('is aborted by the caller signal', async () => {
    const f = makeFetcher({ timeoutMs: 10_000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const page = await f.fetchPage(`${base}/slow`, { signal: ctrl.signal });
    expect(page.status).toBe('error');
    await f.close();
  });
});

describe('DNS guard inside the real HTTP agent', () => {
  it('stops undici from connecting to a hostname that resolves to loopback', async () => {
    const port = new URL(base).port;
    const agent = new Agent({ connect: { lookup: ssrfLookup(false) as never } });
    hits.length = 0;
    const err = await undiciFetch(`http://localhost:${port}/ok`, { dispatcher: agent }).then(
      () => null,
      (e: unknown) => e as { cause?: { code?: string; message?: string } },
    );
    expect(err).not.toBeNull();
    expect(err?.cause?.code).toBe('ESSRF');
    expect(hits).toHaveLength(0);
    await agent.close();
  });
});

describe('charset helpers', () => {
  it('prefers the header, then <meta>, then utf-8', () => {
    expect(detectCharset('text/html; charset=Windows-1251', new Uint8Array())).toBe('windows-1251');
    expect(detectCharset('text/html', new TextEncoder().encode('<meta charset="koi8-r">'))).toBe('koi8-r');
    expect(detectCharset(null, new Uint8Array())).toBe('utf-8');
  });

  it('falls back to utf-8 for unknown encodings', () => {
    expect(decodeHtml(new TextEncoder().encode('Здравей'), 'text/html; charset=bogus-9000')).toBe('Здравей');
  });
});

describe('robots.txt redirects (SSRF)', () => {
  const html = '<html><body>ok</body></html>';
  /** A transport that answers from a table and records every URL it was asked for. */
  function transport(routes: Record<string, () => Response>) {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      return route ? route() : new Response('not found', { status: 404 });
    }) as never;
    return { requested, fetchImpl };
  }
  const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
  const page = () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const options = { userAgent: 'JevSeoRadar/0.1', timeoutMs: 5_000, maxBytes: 100_000 };

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:8080/admin'],
    ['a private network', 'http://10.0.0.5/robots.txt'],
    ['IPv4-mapped IPv6', 'http://[::ffff:7f00:1]/robots.txt'],
    ['a port that is not allowed', 'https://internal.example:6379/robots.txt'],
    ['an internal name', 'http://service.internal/robots.txt'],
  ])('does not follow a robots.txt redirect to %s', async (_label, target) => {
    const { requested, fetchImpl } = transport({
      'https://evil.example/robots.txt': redirect(target),
      'https://evil.example/page': page,
    });
    const fetcher = new SafeFetcher({ ...options, fetchImpl });
    const result = await fetcher.fetchPage('https://evil.example/page');
    // the redirect target was never requested; robots.txt could not be read, so (RFC 9309) the page is not fetched either
    expect(requested).toEqual(['https://evil.example/robots.txt']);
    expect(result.status).toBe('blocked_robots');
    await fetcher.close();
  });

  it('still follows an ordinary redirect to another public host, and applies the rules it finds there', async () => {
    const { requested, fetchImpl } = transport({
      'https://example.com/robots.txt': redirect('https://www.example.com/robots.txt'),
      'https://www.example.com/robots.txt': () => new Response('User-agent: *\nDisallow: /private', { status: 200 }),
      'https://example.com/private/x': page,
      'https://example.com/public': page,
    });
    const fetcher = new SafeFetcher({ ...options, fetchImpl });
    expect((await fetcher.fetchPage('https://example.com/private/x')).status).toBe('blocked_robots');
    expect((await fetcher.fetchPage('https://example.com/public')).status).toBe('ok');
    expect(requested).toContain('https://www.example.com/robots.txt');
    await fetcher.close();
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    const { requested, fetchImpl } = transport({
      'https://loop.example/robots.txt': redirect('https://loop.example/robots.txt'),
      'https://loop.example/page': page,
    });
    const fetcher = new SafeFetcher({ ...options, fetchImpl });
    expect((await fetcher.fetchPage('https://loop.example/page')).status).toBe('blocked_robots');
    expect(requested.filter((u) => u.endsWith('/robots.txt')).length).toBeLessThanOrEqual(6);
    expect(requested.filter((u) => u.endsWith('/page'))).toEqual([]);
    await fetcher.close();
  });
});
