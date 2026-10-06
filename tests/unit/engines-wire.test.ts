import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicEngine } from '../../src/server/geo/engines/anthropic';
import { GeminiEngine } from '../../src/server/geo/engines/gemini';
import { postJson } from '../../src/server/geo/engines/http';
import { OpenAiEngine } from '../../src/server/geo/engines/openai';
import type { EngineError } from '../../src/server/geo/engines/types';

// The other engine tests hand the adapters a fake fetch. These talk over a real socket to a server on this machine
// through the real global fetch, to check what a fake cannot: what actually goes over the wire, that a redirect is
// never followed (so a key can never reach a second host), and that timeouts and aborts end real connections.

const KEY = 'sk-wire-5d8b1e7a93c24f60';
const LOCATION = { country: 'BG', timezone: 'Europe/Sofia' };

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

let server: Server;
let thief: Server;
let base: string;
let thiefBase: string;
const seen: Seen[] = [];
const stolen: Seen[] = [];
let flaky = 0;

beforeAll(async () => {
  thief = createServer(async (req, res) => {
    stolen.push({ method: req.method, url: req.url, headers: req.headers, body: await readBody(req) });
    reply(res, 200, { stolen: true });
  });
  thiefBase = `http://127.0.0.1:${await listen(thief)}`;

  server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const path = (req.url ?? '').split('?')[0];
    switch (path) {
      case '/ok':
        return reply(res, 200, { ok: true, echoed: JSON.parse(body) as unknown });
      case '/redirect':
        res.writeHead(307, { location: `${thiefBase}/steal` });
        return res.end();
      case '/slow':
        return; // never answers
      case '/flaky':
        return flaky++ === 0 ? reply(res, 429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, { 'retry-after': '0' }) : reply(res, 200, { ok: true });
      case '/v1/responses':
        return reply(res, 200, { status: 'completed', model: 'gpt-6.1-sol', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Отговор от ChatGPT', annotations: [{ type: 'url_citation', url: 'https://a.example/x', title: 'A' }] }] }], usage: { input_tokens: 7, output_tokens: 3 } });
      case '/v1beta/interactions':
        return reply(res, 200, { status: 'completed', output_text: 'Отговор от Gemini', usage: { total_input_tokens: 5, total_output_tokens: 2 } });
      case '/v1/messages':
        if (req.headers['x-test-mode'] === 'redirect') {
          res.writeHead(307, { location: `${thiefBase}/steal` });
          return res.end();
        }
        return reply(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Отговор от Claude', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 9, output_tokens: 4 } });
      default:
        return reply(res, 404, { error: { message: 'not here' } });
    }
  });
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  for (const s of [server, thief]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** Sends what an adapter would send to its vendor to this machine instead. */
const via = (vendorHost: string, extra: Record<string, string> = {}) => (url: string, init?: RequestInit) =>
  fetch(url.replace(vendorHost, base), extra && Object.keys(extra).length > 0 ? { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...extra } } : init);

const fail = (promise: Promise<unknown>): Promise<EngineError> => promise.then(() => Promise.reject(new Error('expected a rejection')), (e: unknown) => e as EngineError);

describe('postJson over a real socket', () => {
  const options = { vendor: 'ChatGPT', headers: { authorization: `Bearer ${KEY}` }, secrets: [KEY], timeoutMs: 5_000, retries: 0, backoffBaseMs: 1 };

  it('puts the method, headers and JSON body on the wire', async () => {
    seen.length = 0;
    const out = await postJson(`${base}/ok`, { a: 1, text: 'здравей' }, options);
    expect(out).toEqual({ ok: true, echoed: { a: 1, text: 'здравей' } });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/ok' });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0]!.body)).toEqual({ a: 1, text: 'здравей' });
  });

  it('never follows a redirect: the key does not reach the second host', async () => {
    stolen.length = 0;
    const err = await fail(postJson(`${base}/redirect`, { secret: 'payload' }, options));
    expect(err).toMatchObject({ kind: 'unavailable' });
    expect(stolen).toHaveLength(0);
  });

  it('retries a real 429 and then succeeds', async () => {
    flaky = 0;
    await expect(postJson(`${base}/flaky`, {}, { ...options, retries: 2 })).resolves.toEqual({ ok: true });
  });

  it('times out a connection that never answers', async () => {
    const started = Date.now();
    const err = await fail(postJson(`${base}/slow`, {}, { ...options, timeoutMs: 150 }));
    expect(err).toMatchObject({ kind: 'unavailable' });
    expect(err.message).toContain('отговорът се забави');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('ends a connection that never answers when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = fail(postJson(`${base}/slow`, {}, { ...options, signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ kind: 'aborted', fatal: true });
  });

  it('reports a refused connection as unavailable', async () => {
    const unused = createServer();
    const port = await listen(unused);
    await new Promise<void>((resolve) => unused.close(() => resolve()));
    const err = await fail(postJson(`http://127.0.0.1:${port}/x`, {}, options));
    expect(err).toMatchObject({ kind: 'unavailable' });
    expect(err.message).not.toContain(KEY);
  });
});

describe('the adapters over a real socket', () => {
  it('ChatGPT: POST /v1/responses with the key in the Authorization header', async () => {
    seen.length = 0;
    const engine = new OpenAiEngine({ apiKey: KEY, model: 'gpt-6.1-sol' }, { fetchImpl: via('https://api.openai.com'), retries: 0 });
    const answer = await engine.ask('Как си?', { location: LOCATION });
    expect(answer).toMatchObject({ text: 'Отговор от ChatGPT', usage: { inputTokens: 7, outputTokens: 3 } });
    expect(answer.citations).toEqual([{ url: 'https://a.example/x', title: 'A', domain: 'a.example' }]);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/responses' });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ model: 'gpt-6.1-sol', input: 'Как си?', store: false });
  });

  it('Gemini: POST /v1beta/interactions with the key in x-goog-api-key and not in the URL', async () => {
    seen.length = 0;
    const engine = new GeminiEngine({ apiKey: KEY, model: 'gemini-3.8-flash' }, { fetchImpl: via('https://generativelanguage.googleapis.com'), retries: 0 });
    const answer = await engine.ask('Как си?', { location: LOCATION });
    expect(answer).toMatchObject({ text: 'Отговор от Gemini', usage: { inputTokens: 5, outputTokens: 2 } });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1beta/interactions' });
    expect(seen[0]?.headers['x-goog-api-key']).toBe(KEY);
    expect(seen[0]?.url).not.toContain(KEY);
  });

  it('Claude: POST /v1/messages through the SDK, with x-api-key and the API version', async () => {
    seen.length = 0;
    const engine = new AnthropicEngine({ apiKey: KEY, model: 'claude-opus-5-5' }, { fetchImpl: via('https://api.anthropic.com'), retries: 0 });
    const answer = await engine.ask('Как си?', { location: LOCATION });
    expect(answer).toMatchObject({ text: 'Отговор от Claude', usage: { inputTokens: 9, outputTokens: 4 }, model: 'claude-opus-5-5' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/messages' });
    expect(seen[0]?.headers['x-api-key']).toBe(KEY);
    expect(seen[0]?.headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 8000, messages: [{ role: 'user', content: 'Как си?' }] });
  });

  it('Claude: the SDK does not follow a redirect either, so the key stays on one host', async () => {
    stolen.length = 0;
    const engine = new AnthropicEngine({ apiKey: KEY, model: 'claude-opus-5-5' }, { fetchImpl: via('https://api.anthropic.com', { 'x-test-mode': 'redirect' }), retries: 0 });
    const err = await fail(engine.ask('Как си?', { location: LOCATION }));
    expect(err).toMatchObject({ kind: 'unavailable' });
    expect(err.message).not.toContain(KEY);
    expect(stolen).toHaveLength(0);
  });

  it('ChatGPT and Gemini do not follow a redirect from their endpoint', async () => {
    stolen.length = 0;
    const toRedirect = (host: string) => (url: string, init?: RequestInit) => fetch(url.replace(host, `${base}`).replace(/\/v1\/responses|\/v1beta\/interactions/, '/redirect'), init);
    const openai = new OpenAiEngine({ apiKey: KEY, model: 'gpt-6.1-sol' }, { fetchImpl: toRedirect('https://api.openai.com'), retries: 0 });
    const gemini = new GeminiEngine({ apiKey: KEY, model: 'gemini-3.8-flash' }, { fetchImpl: toRedirect('https://generativelanguage.googleapis.com'), retries: 0 });
    expect(await fail(openai.ask('q?', { location: LOCATION }))).toMatchObject({ kind: 'unavailable' });
    expect(await fail(gemini.ask('q?', { location: LOCATION }))).toMatchObject({ kind: 'unavailable' });
    expect(stolen).toHaveLength(0);
  });
});
