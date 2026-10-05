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
