import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGzip, gzipSync } from 'node:zlib';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeHtml, detectCharset, SafeFetcher, type PageFetcher } from '../../src/server/crawl/fetcher';
import { ssrfLookup } from '../../src/server/crawl/ssrf';
import { CachedFetcher, DiskCache } from '../../src/server/providers/cache';

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

// ───────────────────────────── fetchText: sitemaps and robots.txt ─────────────────────────────

/** gzip of `megabytes` MB of zeros, built as a stream so that the test itself never holds more than a megabyte of them. */
async function gzipOfZeros(megabytes: number): Promise<Buffer> {
  const gz = createGzip({ level: 9 });
  const chunks: Buffer[] = [];
  gz.on('data', (c: Buffer) => chunks.push(c));
  const finished = once(gz, 'end');
  const zeros = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < megabytes; i++) {
    if (!gz.write(zeros)) await once(gz, 'drain');
  }
  gz.end();
  await finished;
  return Buffer.concat(chunks);
}

describe('SafeFetcher.fetchText', () => {
  const BOMB_BYTES = 30 * 1024 * 1024;
  const HUGE_BOMB_MB = 256;
  let hugeBomb: Buffer;
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://example.com/услуги/</loc></url></urlset>';
  const bomb = gzipSync(Buffer.alloc(BOMB_BYTES, 0x41)); // 30 MB of "A" in about 30 KB
  const twoMegabytes = Buffer.alloc(2 * 1024 * 1024, 0x42);
  const hitsText: string[] = [];
  const headersSeen: Array<Record<string, string | string[] | undefined>> = [];
  let textServer: Server;
  let origin: string;

  beforeAll(async () => {
    hugeBomb = await gzipOfZeros(HUGE_BOMB_MB); // about 250 KB that unpack to 256 MB
    textServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? '/';
      hitsText.push(path);
      headersSeen.push(req.headers);
      const send = (status: number, type: string | null, body: string | Buffer, extra: Record<string, string> = {}) => {
        res.writeHead(status, { ...(type ? { 'content-type': type } : {}), ...extra });
        res.end(body);
      };
      switch (path) {
        case '/robots.txt':
          return send(200, 'text/plain', 'User-agent: *\nDisallow: /');
        case '/sitemap.xml':
          return send(200, 'application/xml; charset=utf-8', `﻿${sitemap}`);
        case '/text-xml.xml':
          return send(200, 'Text/XML', sitemap);
        case '/atom.xml':
          return send(200, 'application/atom+xml', sitemap);
        case '/plain.txt':
          return send(200, 'text/plain; charset=utf-8', 'https://example.com/a\nhttps://example.com/б\n');
        case '/no-type.xml':
          return send(200, null, sitemap);
        case '/soft404.xml':
          return send(200, 'text/html; charset=utf-8', '<html><body>Страницата не е намерена</body></html>');
        case '/soft404.txt':
          return send(200, 'text/html', '<html></html>');
        case '/data.json':
          return send(200, 'application/json', '{"a":1}');
        case '/missing.xml':
          return send(404, 'text/html', 'nope');
        case '/redirect.xml':
          return send(302, 'text/plain', '', { location: '/sitemap.xml' });
        case '/loop.xml':
          return send(302, 'text/plain', '', { location: '/loop.xml' });
        case '/sitemap.xml.gz':
          return send(200, 'application/gzip', gzipSync(sitemap));
        case '/x-gzip.xml.gz':
          return send(200, 'application/x-gzip', gzipSync(sitemap));
        case '/octet.xml.gz':
          return send(200, 'application/octet-stream', gzipSync(sitemap));
        case '/octet.bin':
          return send(200, 'application/octet-stream', gzipSync(sitemap));
        case '/gz-as-html.xml.gz':
          return send(200, 'text/html', gzipSync(sitemap));
        case '/gz-bytes-as-xml':
          return send(200, 'text/xml', gzipSync(sitemap)); // a server that forgot to say the file is compressed
        case '/gz-declared-but-plain':
          return send(200, 'application/gzip', sitemap);
        case '/gz-corrupt.xml.gz':
          return send(200, 'application/gzip', Buffer.concat([gzipSync(sitemap).subarray(0, 20), Buffer.from('corrupted')]));
        case '/bomb.xml.gz':
          return send(200, 'application/gzip', bomb);
        case '/huge-bomb.xml.gz':
          return send(200, 'application/gzip', hugeBomb);
        case '/bomb-transport.xml':
          return send(200, 'text/xml', bomb, { 'content-encoding': 'gzip' }); // compressed on the wire, not in the file
        case '/gz-transport.xml':
          return send(200, 'text/xml', gzipSync(sitemap), { 'content-encoding': 'gzip' });
        case '/two-mb.xml':
          return send(200, 'text/xml', twoMegabytes);
        case '/two-mb.xml.gz':
          return send(200, 'application/gzip', gzipSync(twoMegabytes));
        case '/six-mb.xml':
          return send(200, 'text/xml', Buffer.alloc(6 * 1024 * 1024, 0x43));
        case '/exact-1000.xml':
          return send(200, 'text/xml', Buffer.alloc(1000, 0x44));
        case '/accept':
          return send(200, 'text/plain', String(req.headers.accept));
        case '/slow.xml':
          return; // never answers
        default:
          return send(404, 'text/plain', 'not found');
      }
    });
    await new Promise<void>((r) => textServer.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(textServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    textServer.closeAllConnections();
    await new Promise((r) => textServer.close(r));
  });

  const make = (over: Partial<ConstructorParameters<typeof SafeFetcher>[0]> = {}) =>
    new SafeFetcher({ userAgent: 'JevSeoRadar/test', timeoutMs: 5_000, maxBytes: 100_000, allowPrivateNetworks: true, ...over });

  it('reads XML as UTF-8, strips the byte-order mark and reports the final address', async () => {
    const f = make();
    const result = await f.fetchText(`${origin}/sitemap.xml`);
    expect(result).toEqual({ status: 'ok', httpStatus: 200, text: sitemap, finalUrl: `${origin}/sitemap.xml`, error: null });
    expect(result.text?.charCodeAt(0)).not.toBe(0xfeff);
    await f.close();
  });

  it.each([
    ['text/xml in any case', '/text-xml.xml'],
    ['application/*+xml', '/atom.xml'],
    ['no Content-Type at all', '/no-type.xml'],
  ])('accepts %s', async (_label, path) => {
    const f = make();
    expect((await f.fetchText(`${origin}${path}`)).status).toBe('ok');
    await f.close();
  });

  it('reads plain text (the plain-text sitemap and robots.txt)', async () => {
    const f = make();
    expect(await f.fetchText(`${origin}/plain.txt`)).toMatchObject({ status: 'ok', text: 'https://example.com/a\nhttps://example.com/б\n' });
    await f.close();
  });

  it('does not take HTML or JSON for a sitemap, even at a .xml or .txt address, and does not read the body', async () => {
    const f = make();
    for (const path of ['/soft404.xml', '/soft404.txt', '/data.json', '/octet.bin']) {
      const result = await f.fetchText(`${origin}${path}`);
      expect(result, path).toMatchObject({ status: 'not_text', httpStatus: 200, text: null, finalUrl: `${origin}${path}` });
      expect(result.error, path).toMatch(/Не е XML или текст/);
    }
    await f.close();
  });

  it('reports HTTP errors and follows redirects, but not forever', async () => {
    const f = make();
    expect(await f.fetchText(`${origin}/missing.xml`)).toMatchObject({ status: 'http_error', httpStatus: 404, text: null, error: 'HTTP 404' });
    expect(await f.fetchText(`${origin}/redirect.xml`)).toMatchObject({ status: 'ok', finalUrl: `${origin}/sitemap.xml` });
    const loop = await f.fetchText(`${origin}/loop.xml`);
    expect(loop).toMatchObject({ status: 'error', text: null });
    expect(loop.error).toMatch(/пренасочвания/);
    await f.close();
  });

  it('does not consult robots.txt: sitemaps are for crawlers, so a robots.txt that forbids everything does not stop it', async () => {
    const f = make();
    hitsText.length = 0;
    expect((await f.fetchText(`${origin}/sitemap.xml`)).status).toBe('ok');
    expect(hitsText).toEqual(['/sitemap.xml']); // fetchPage would have asked for /robots.txt first (and been refused)
    expect((await f.fetchPage(`${origin}/sitemap.xml`)).status).toBe('blocked_robots');
    await f.close();
  });

  it('asks for XML and plain text', async () => {
    const f = make();
    headersSeen.length = 0;
    const result = await f.fetchText(`${origin}/accept`);
    expect(result.text).toBe('application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1');
    expect(headersSeen.at(-1)?.['user-agent']).toBe('JevSeoRadar/test');
    await f.close();
  });

  describe('gzip', () => {
    it.each([
      ['application/gzip', '/sitemap.xml.gz'],
      ['application/x-gzip', '/x-gzip.xml.gz'],
      ['a generic binary type at a .gz address', '/octet.xml.gz'],
      ['gzip bytes at a text type (the server forgot to say so)', '/gz-bytes-as-xml'],
      ['gzip of the transport (Content-Encoding), which the HTTP client unpacks', '/gz-transport.xml'],
    ])('unpacks %s', async (_label, path) => {
      const f = make();
      expect(await f.fetchText(`${origin}${path}`)).toMatchObject({ status: 'ok', text: sitemap });
      await f.close();
    });

    it('refuses a .gz address that answers with HTML, and a gzip type that is not gzip, and corrupt data', async () => {
      const f = make();
      expect((await f.fetchText(`${origin}/gz-as-html.xml.gz`)).status).toBe('not_text');
      expect(await f.fetchText(`${origin}/gz-declared-but-plain`)).toMatchObject({ status: 'error', error: 'Невалиден gzip файл' });
      expect(await f.fetchText(`${origin}/gz-corrupt.xml.gz`)).toMatchObject({ status: 'error', error: 'Невалиден gzip файл' });
      await f.close();
    });

    it('applies maxBytes to the DECODED size: a 30 KB file that unpacks to 30 MB is refused', async () => {
      const f = make();
      expect(await f.fetchText(`${origin}/bomb.xml.gz`, { maxBytes: 1024 * 1024 })).toMatchObject({ status: 'error', httpStatus: 200, text: null, error: 'Файлът е твърде голям' });
      // the same bomb with the default limit (5 MB) is refused too
      expect(await f.fetchText(`${origin}/bomb.xml.gz`)).toMatchObject({ status: 'error', error: 'Файлът е твърде голям' });
      await f.close();
    });

    it('does not unpack a bomb to find out how big it is: 256 MB behind 250 KB is refused quickly, in a few MB of memory', async () => {
      const f = make();
      const before = process.memoryUsage().rss;
      const started = performance.now();
      const result = await f.fetchText(`${origin}/huge-bomb.xml.gz`, { maxBytes: 1024 * 1024 });
      expect(result).toMatchObject({ status: 'error', text: null, error: 'Файлът е твърде голям' });
      expect(performance.now() - started).toBeLessThan(2_000);
      // unpacking it first and measuring afterwards would have held 256 MB at this point
      expect(process.memoryUsage().rss - before).toBeLessThan(80 * 1024 * 1024);
      await f.close();
    });

    it('applies maxBytes to what the transport unpacks as well (Content-Encoding: gzip)', async () => {
      const f = make();
      expect(await f.fetchText(`${origin}/bomb-transport.xml`, { maxBytes: 1024 * 1024 })).toMatchObject({ status: 'error', error: 'Файлът е твърде голям' });
      await f.close();
    });

    it('counts the decoded size, not the size on the wire: 2 MB packed small passes at 3 MB and fails at 1 MB', async () => {
      const f = make();
      const ok = await f.fetchText(`${origin}/two-mb.xml.gz`, { maxBytes: 3 * 1024 * 1024 });
      expect(ok.status).toBe('ok');
      expect(ok.text?.length).toBe(2 * 1024 * 1024);
      expect(await f.fetchText(`${origin}/two-mb.xml.gz`, { maxBytes: 1024 * 1024 })).toMatchObject({ status: 'error', error: 'Файлът е твърде голям' });
      await f.close();
    });
  });

  describe('size limit', () => {
    it('refuses what is bigger than 5 MB by default, and honours a larger or smaller limit', async () => {
      const f = make();
      expect(await f.fetchText(`${origin}/six-mb.xml`)).toMatchObject({ status: 'error', text: null, error: 'Файлът е твърде голям' });
      expect((await f.fetchText(`${origin}/six-mb.xml`, { maxBytes: 7 * 1024 * 1024 })).status).toBe('ok');
      expect((await f.fetchText(`${origin}/two-mb.xml`, { maxBytes: 1024 * 1024 })).status).toBe('error');
      await f.close();
    });

    it('lets a file of exactly maxBytes through and refuses one byte more', async () => {
      const f = make();
      expect((await f.fetchText(`${origin}/exact-1000.xml`, { maxBytes: 1000 })).status).toBe('ok');
      expect((await f.fetchText(`${origin}/exact-1000.xml`, { maxBytes: 999 })).status).toBe('error');
      await f.close();
    });

    it('falls back to the default for a limit that makes no sense instead of reading nothing or everything', async () => {
      const f = make();
      for (const maxBytes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect((await f.fetchText(`${origin}/two-mb.xml`, { maxBytes })).status, `2 MB with ${maxBytes}`).toBe('ok');
        expect(await f.fetchText(`${origin}/six-mb.xml`, { maxBytes }), `6 MB with ${maxBytes}`).toMatchObject({ status: 'error', error: 'Файлът е твърде голям' });
      }
      await f.close();
    });
  });

  it('times out slow servers and is stopped by the caller signal', async () => {
    const f = make({ timeoutMs: 400 });
    const slow = await f.fetchText(`${origin}/slow.xml`);
    expect(slow.status).toBe('error');
    expect(slow.error).toMatch(/време|прекратена/i);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const stopped = await make({ timeoutMs: 10_000 }).fetchText(`${origin}/slow.xml`, { signal: ctrl.signal });
    expect(stopped).toMatchObject({ status: 'error', text: null });
    await f.close();
  });

  it('refuses private targets by default without touching the network, like fetchPage', async () => {
    const f = make({ allowPrivateNetworks: false });
    hitsText.length = 0;
    const result = await f.fetchText(`${origin}/sitemap.xml`);
    expect(result).toMatchObject({ status: 'error', text: null });
    expect(result.error).toMatch(/порт|частна|вътрешн/i);
    expect(hitsText).toHaveLength(0);
    await f.close();
  });
});

describe('SafeFetcher.fetchText redirects (SSRF)', () => {
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
  const xml = () => new Response('<urlset></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } });
  const options = { userAgent: 'JevSeoRadar/0.1', timeoutMs: 5_000, maxBytes: 100_000 };

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:8080/admin'],
    ['a private network', 'http://10.0.0.5/sitemap.xml'],
    ['IPv4-mapped IPv6', 'http://[::ffff:7f00:1]/sitemap.xml'],
    ['a port that is not allowed', 'https://internal.example:6379/sitemap.xml'],
    ['an internal name', 'http://service.internal/sitemap.xml'],
    ['a scheme that is not http', 'ftp://example.com/sitemap.xml'],
  ])('does not follow a sitemap redirect to %s', async (_label, target) => {
    const { requested, fetchImpl } = transport({ 'https://evil.example/sitemap.xml': redirect(target) });
    const fetcher = new SafeFetcher({ ...options, fetchImpl });
    const result = await fetcher.fetchText('https://evil.example/sitemap.xml');
    expect(requested).toEqual(['https://evil.example/sitemap.xml']); // the target was never requested
    expect(result).toMatchObject({ status: 'error', text: null });
    expect(result.error).toMatch(/порт|частна|вътрешн|http|URL/i);
    await fetcher.close();
  });

  it('checks every hop, also the second one', async () => {
    const { requested, fetchImpl } = transport({
      'https://a.example/sitemap.xml': redirect('https://b.example/step'),
      'https://b.example/step': redirect('http://169.254.169.254/'),
    });
    const fetcher = new SafeFetcher({ ...options, fetchImpl });
    expect((await fetcher.fetchText('https://a.example/sitemap.xml')).status).toBe('error');
    expect(requested).toEqual(['https://a.example/sitemap.xml', 'https://b.example/step']);
    await fetcher.close();
  });

  it('refuses a private address given directly, without a request', async () => {
    const { requested, fetchImpl } = transport({});
    const fetcher = new SafeFetcher({ ...options, fetchImpl });
    for (const url of ['http://127.0.0.1/sitemap.xml', 'http://localhost/robots.txt', 'https://user:pass@example.com/sitemap.xml']) {
      expect((await fetcher.fetchText(url)).status, url).toBe('error');
    }
    expect(requested).toEqual([]);
    await fetcher.close();
  });

  it('still follows an ordinary redirect to another public host, and gives the same limit of redirects as pages', async () => {
    const { requested, fetchImpl } = transport({
      'https://example.com/sitemap.xml': redirect('https://www.example.com/sitemap.xml'),
      'https://www.example.com/sitemap.xml': xml,
      'https://loop.example/a': redirect('https://loop.example/b'),
      'https://loop.example/b': redirect('https://loop.example/a'),
    });
    const fetcher = new SafeFetcher({ ...options, fetchImpl, maxRedirects: 3 });
    expect(await fetcher.fetchText('https://example.com/sitemap.xml')).toMatchObject({ status: 'ok', finalUrl: 'https://www.example.com/sitemap.xml' });
    const loop = await fetcher.fetchText('https://loop.example/a');
    expect(loop.status).toBe('error');
    expect(requested.filter((u) => u.startsWith('https://loop.example')).length).toBe(4); // the first request and three redirects
    await fetcher.close();
  });

  it('never asks for robots.txt', async () => {
    const { requested, fetchImpl } = transport({ 'https://example.com/sitemap.xml': xml });
    const fetcher = new SafeFetcher({ ...options, fetchImpl });
    await fetcher.fetchText('https://example.com/sitemap.xml');
    expect(requested).toEqual(['https://example.com/sitemap.xml']);
    await fetcher.close();
  });
});

describe('CachedFetcher.fetchText', () => {
  const page = { status: 'ok', httpStatus: 200, finalUrl: 'https://x.example/', html: '<html></html>', error: null, ttfbMs: 1, bytes: 13, fromCache: false } as const;
  const noCache = new DiskCache('/nonexistent-cache-dir', 0);

  it('passes the call and its options on, without caching', async () => {
    const calls: Array<{ url: string; options: { maxBytes?: number } | undefined }> = [];
    const inner: PageFetcher = {
      fetchPage: async () => page,
      fetchText: async (url, options) => {
        calls.push({ url, options });
        return { status: 'ok', httpStatus: 200, text: `fresh ${calls.length}`, finalUrl: url, error: null };
      },
    };
    const cached = new CachedFetcher(inner, noCache);
    expect((await cached.fetchText('https://x.example/sitemap.xml', { maxBytes: 10 })).text).toBe('fresh 1');
    expect((await cached.fetchText('https://x.example/sitemap.xml')).text).toBe('fresh 2');
    expect(calls).toEqual([
      { url: 'https://x.example/sitemap.xml', options: { maxBytes: 10 } },
      { url: 'https://x.example/sitemap.xml', options: undefined },
    ]);
  });

  it('says so, in Bulgarian, when the fetcher underneath cannot read text', async () => {
    const cached = new CachedFetcher({ fetchPage: async () => page }, noCache);
    expect(await cached.fetchText('https://x.example/sitemap.xml')).toEqual({ status: 'error', httpStatus: null, text: null, finalUrl: null, error: 'Не се поддържа' });
  });
});
