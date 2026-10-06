import { afterEach, describe, expect, it, vi } from 'vitest';
import { postJson, quoteVendor, retryDelayMs, VendorHttpError, type PostJsonOptions } from '../../src/server/geo/engines/http';
import { EngineError } from '../../src/server/geo/engines/types';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const call: Call = { url, init, headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}

const KEY = 'sk-test-9f3a7c21b8d44e';
const URL_ = 'https://vendor.test/v1/things';
const base = (over: Partial<PostJsonOptions> = {}): PostJsonOptions => ({ vendor: 'ChatGPT', headers: { authorization: `Bearer ${KEY}` }, secrets: [KEY], timeoutMs: 5_000, retries: 0, backoffBaseMs: 1, ...over });
const fail = (promise: Promise<unknown>): Promise<EngineError> => promise.then(() => Promise.reject(new Error('expected a rejection')), (e: unknown) => e as EngineError);

/** Everything a logger could print about an error: message, stack, own properties and the whole cause chain. */
function everything(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e !== undefined && e !== null; e = e instanceof Error ? e.cause : undefined) {
    if (e instanceof Error) parts.push(e.name, e.message, e.stack ?? '');
    parts.push(JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
  }
  return parts.join('\n');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('postJson: the request', () => {
  it('POSTs the JSON body with the caller headers, never follows a redirect and carries a timeout signal', async () => {
    const r = recorder(() => json({ ok: true }));
    const out = await postJson(URL_, { a: 1, b: ['x'] }, base({ fetchImpl: r.fetchImpl, headers: { authorization: 'Bearer k', 'x-extra': '1' } }));
    expect(out).toEqual({ ok: true });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.url).toBe(URL_);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.headers).toMatchObject({ 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer k', 'x-extra': '1' });
    expect(call.body).toEqual({ a: 1, b: ['x'] });
  });
});

describe('postJson: retries', () => {
  it('retries a 5xx and then succeeds', async () => {
    const r = recorder((_c, n) => (n === 1 ? json({ error: { message: 'overloaded' } }, 503) : json({ ok: 1 })));
    await expect(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, retries: 2 }))).resolves.toEqual({ ok: 1 });
    expect(r.calls).toHaveLength(2);
  });

  it('gives up after the retries and reports the last error', async () => {
    const r = recorder(() => json({}, 502));
    const err = await fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, retries: 2 })));
    expect(err).toMatchObject({ kind: 'unavailable', status: 502 });
    expect(r.calls).toHaveLength(3);
  });

  it('retries a plain 429 and reports rate_limit when the retries run out', async () => {
    const r = recorder(() => json({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, 429));
    const err = await fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, retries: 2 })));
    expect(err).toMatchObject({ kind: 'rate_limit', status: 429, fatal: false });
    expect(r.calls).toHaveLength(3);
  });

  it('retries network errors, then reports unavailable', async () => {
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      return json({ ok: true });
    };
    await expect(postJson(URL_, {}, base({ fetchImpl: flaky, retries: 1 }))).resolves.toEqual({ ok: true });
    const dead = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.1:443') });
    });
    const err = await fail(postJson(URL_, {}, base({ fetchImpl: dead, retries: 1 })));
    expect(err).toMatchObject({ kind: 'unavailable' });
    expect(err.message).toContain('ECONNREFUSED');
    expect(dead).toHaveBeenCalledTimes(2);
  });

  it('retries a 408 like any transient failure', async () => {
    const r = recorder((_c, n) => (n === 1 ? json({}, 408) : json({ ok: true })));
    await expect(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, retries: 1 }))).resolves.toEqual({ ok: true });
  });

  it('does not retry a 400', async () => {
    const r = recorder(() => json({ error: { message: 'bad field' } }, 400));
    await fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, retries: 3 })));
    expect(r.calls).toHaveLength(1);
  });
});

describe('postJson: how long it waits between attempts', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it('honours Retry-After (seconds, a date, or the millisecond variant) up to 10 seconds', () => {
    expect(retryDelayMs(h({ 'retry-after': '2' }), 0, 600)).toBe(2000);
    expect(retryDelayMs(h({ 'retry-after': '0' }), 3, 600)).toBe(0);
    expect(retryDelayMs(h({ 'retry-after': '3600' }), 0, 600)).toBe(10_000);
    expect(retryDelayMs(h({ 'retry-after-ms': '250' }), 0, 600)).toBe(250);
    expect(retryDelayMs(h({ 'retry-after-ms': '900000' }), 0, 600)).toBe(10_000);
    const soon = new Date(Date.now() + 4_000).toUTCString();
    const wait = retryDelayMs(h({ 'retry-after': soon }), 0, 600);
    expect(wait).toBeGreaterThan(2_000);
    expect(wait).toBeLessThanOrEqual(4_000);
    expect(retryDelayMs(h({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() }), 0, 600)).toBe(0);
  });

  it('backs off exponentially from an injectable base when there is no usable header', () => {
    for (const headers of [null, h({}), h({ 'retry-after': 'soon' }), h({ 'retry-after': '' })]) {
      expect(retryDelayMs(headers, 0, 600)).toBeGreaterThanOrEqual(600);
      expect(retryDelayMs(headers, 0, 600)).toBeLessThan(600 + 201);
      expect(retryDelayMs(headers, 2, 600)).toBeGreaterThanOrEqual(2400);
      expect(retryDelayMs(headers, 10, 600)).toBe(10_000);
    }
    expect(retryDelayMs(null, 3, 1)).toBeLessThanOrEqual(9);
  });

  it('actually waits for a Retry-After, but never longer than 10 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = recorder((_c, n) => (n === 1 ? json({ error: { message: 'slow down', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '3600' }) : json({ ok: true })));
    const done = postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, retries: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(r.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ ok: true });
    expect(r.calls).toHaveLength(2);
  });
});

describe('postJson: HTTP errors', () => {
  const run = (status: number, body: unknown, over: Partial<PostJsonOptions> = {}) => {
    const r = recorder(() => (typeof body === 'string' ? new Response(body, { status }) : json(body, status)));
    return { r, error: fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, retries: 2, ...over }))) };
  };

  it.each([[401], [403]] as const)('maps %i to auth (fatal) without retrying', async (status) => {
    const { r, error } = run(status, { error: { message: 'nope' } });
    expect(await error).toMatchObject({ kind: 'auth', status, fatal: true });
    expect(r.calls).toHaveLength(1);
  });

  it('maps Google\'s 400 API_KEY_INVALID to auth', async () => {
    const { error } = run(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
    expect(await error).toMatchObject({ kind: 'auth', fatal: true });
  });

  it('maps 402 to quota without retrying', async () => {
    const { r, error } = run(402, { error: { message: 'payment required' } });
    expect(await error).toMatchObject({ kind: 'quota', status: 402, fatal: false });
    expect(r.calls).toHaveLength(1);
  });

  it('maps OpenAI\'s 429 insufficient_quota to quota, not rate_limit, and does not retry it', async () => {
    const { r, error } = run(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } });
    expect(await error).toMatchObject({ kind: 'quota', status: 429 });
    expect(r.calls).toHaveLength(1);
  });

  it('goes by the machine-readable code when the wording says nothing about quota', async () => {
    for (const [code, type] of [['insufficient_quota', 'insufficient_quota'], ['billing_hard_limit_reached', 'billing_error'], ['x', 'insufficient_quota']] as const) {
      const { r, error } = run(429, { error: { message: 'Request rejected.', type, code } });
      expect(await error).toMatchObject({ kind: 'quota' });
      expect(r.calls).toHaveLength(1);
    }
  });

  it('lets an explicit rate_limit code win over wording that sounds like an empty account', async () => {
    const { r, error } = run(429, { error: { message: 'You exceeded your current quota of tokens per minute.', type: 'tokens', code: 'rate_limit_exceeded' } });
    expect(await error).toMatchObject({ kind: 'rate_limit' });
    expect(r.calls).toHaveLength(3);
  });

  it('recognises an exhausted quota from the message alone when the vendor sends no code', async () => {
    const { r, error } = run(429, { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } });
    expect(await error).toMatchObject({ kind: 'quota' });
    expect(r.calls).toHaveLength(1);
    const credit = run(400, { error: { message: 'Your credit balance is too low to access the API.' } });
    expect(await credit.error).toMatchObject({ kind: 'quota' });
  });

  it('does not take a plain rate limit for an empty account just because its message mentions billing', async () => {
    // OpenAI tells free accounts to add a payment method at .../account/billing, with code rate_limit_exceeded.
    const free = run(429, {
      error: {
        message: 'Rate limit reached for gpt in organization org-1 on requests per min (RPM): Limit 3, Used 3. Please try again in 20s. You can increase your rate limit by adding a payment method at https://platform.openai.com/account/billing.',
        type: 'requests',
        code: 'rate_limit_exceeded',
      },
    });
    expect(await free.error).toMatchObject({ kind: 'rate_limit' });
    expect(free.r.calls).toHaveLength(3);
    // Google's per-minute limit uses the empty-account wording but says when to come back.
    const perMinute = run(429, { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: x, limit: 5\nPlease retry in 34.2s.', status: 'RESOURCE_EXHAUSTED' } });
    expect(await perMinute.error).toMatchObject({ kind: 'rate_limit' });
    expect(perMinute.r.calls).toHaveLength(3);
    // Google's bare wording is a rate limit too.
    const bare = run(429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });
    expect(await bare.error).toMatchObject({ kind: 'rate_limit' });
  });

  it('maps a 404 to model (fatal), and a 400 that says the model does not exist too', async () => {
    const missing = run(404, { error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } });
    expect(await missing.error).toMatchObject({ kind: 'model', status: 404, fatal: true });
    expect(missing.r.calls).toHaveLength(1);
    const text = run(400, { error: { message: 'The model `gpt-9` does not exist.' } });
    expect(await text.error).toMatchObject({ kind: 'model', status: 400 });
    const code = run(400, { error: { message: 'whatever', code: 'model_not_found' } });
    expect(await code.error).toMatchObject({ kind: 'model' });
    const google = run(404, { error: { code: 404, message: 'models/gemini-9 is not found for API version v1beta', status: 'NOT_FOUND' } });
    const g = await google.error;
    expect(g).toMatchObject({ kind: 'model' });
    expect(g.message).toContain('models/gemini-9 is not found');
  });

  it('keeps an unsupported-parameter 400 apart from a missing model', async () => {
    const { error } = run(400, { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_parameter' } });
    const err = await error;
    expect(err).toMatchObject({ kind: 'bad_response', status: 400 });
    expect(err).toBeInstanceOf(VendorHttpError);
    expect((err as VendorHttpError).detail).toMatchObject({ param: 'reasoning.effort', code: 'unsupported_parameter' });
  });

  it('quotes the vendor message of another 4xx (first 300 characters) in a bad_response', async () => {
    const { r, error } = run(422, { error: { message: `Invalid field ${'x'.repeat(500)}` } });
    const err = await error;
    expect(err).toMatchObject({ kind: 'bad_response', status: 422 });
    expect(err.message).toContain('ChatGPT върна 422: Invalid field xxx');
    expect(err.message.length).toBeLessThan(340);
    expect(r.calls).toHaveLength(1);
  });

  it('reads plain-text and message-less bodies too', async () => {
    expect((await run(418, 'I am a teapot').error).message).toContain('I am a teapot');
    expect((await run(418, { foo: 'bar' }).error).message).toContain('"foo":"bar"');
    expect((await run(418, '').error).message).toContain('(без съобщение)');
  });

  it('says what happened in Bulgarian', async () => {
    for (const [status, body, expected] of [
      [401, {}, 'отхвърли API ключа'],
      [429, {}, 'твърде много заявки'],
      [503, {}, 'върна грешка 503'],
      [402, {}, 'кредити'],
    ] as const) {
      expect((await run(status, body, { retries: 0 }).error).message).toContain(expected);
    }
  });
});

describe('postJson: bad bodies and the network', () => {
  it('reports an invalid JSON body (and an empty one) as bad_response', async () => {
    for (const body of ['<html>nope</html>', '']) {
      const r = recorder(() => new Response(body, { status: 200 }));
      const err = await fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, retries: 2 })));
      expect(err).toMatchObject({ kind: 'bad_response', status: 200 });
      expect(r.calls).toHaveLength(1);
    }
  });

  it('does not mistake a 5xx page for something to quote', async () => {
    const r = recorder(() => new Response('<html><h1>Bad gateway</h1></html>', { status: 502 }));
    const err = await fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl })));
    expect(err.kind).toBe('unavailable');
    expect(err.message).not.toContain('<html>');
  });

  it('ends with aborted (fatal) when the caller aborts: before the call, during it, and while waiting to retry', async () => {
    const before = new AbortController();
    before.abort();
    const never = vi.fn(async () => json({}));
    expect(await fail(postJson(URL_, {}, base({ fetchImpl: never, signal: before.signal })))).toMatchObject({ kind: 'aborted', fatal: true });
    expect(never).not.toHaveBeenCalled();

    const during = new AbortController();
    const hang = (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = fail(postJson(URL_, {}, base({ fetchImpl: hang, signal: during.signal, retries: 2 })));
    setTimeout(() => during.abort(), 10);
    expect(await pending).toMatchObject({ kind: 'aborted' });

    const waiting = new AbortController();
    const r = recorder(() => json({}, 503, { 'retry-after': '5' }));
    const sleeping = fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl, signal: waiting.signal, retries: 2 })));
    setTimeout(() => waiting.abort(), 20);
    const started = Date.now();
    expect(await sleeping).toMatchObject({ kind: 'aborted' });
    expect(Date.now() - started).toBeLessThan(2_000); // did not sit out the 5 seconds
    expect(r.calls).toHaveLength(1);
  });

  it('times out a request that never answers and calls it unavailable (not aborted)', async () => {
    const hang = (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))));
    const err = await fail(postJson(URL_, {}, base({ fetchImpl: hang, timeoutMs: 25 })));
    expect(err).toMatchObject({ kind: 'unavailable', fatal: false });
    expect(err.message).toContain('отговорът се забави');
  });

  it('counts a body that stalls after the headers as a timeout too', async () => {
    const stalled = (_url: string, init: RequestInit = {}) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('timed out', 'TimeoutError')));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    expect(await fail(postJson(URL_, {}, base({ fetchImpl: stalled, timeoutMs: 25 })))).toMatchObject({ kind: 'unavailable' });
  });
});

describe('postJson: credentials never reach a message or a thrown object', () => {
  it('blanks the key a vendor echoes in a quoted error body, including in the details kept for adapters', async () => {
    const r = recorder(() => json({ error: { message: `Invalid request. Headers: authorization=Bearer ${KEY}`, param: `key=${KEY}`, type: 'invalid_request_error' } }, 400));
    const err = await fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl })));
    expect(err.message).toContain('Invalid request');
    expect(err.message).toContain('***');
    expect(everything(err)).not.toContain(KEY);
    expect(JSON.stringify((err as VendorHttpError).detail)).not.toContain(KEY);
  });

  it('blanks the key even when it sits across the 300-character cut', async () => {
    const message = `${'a'.repeat(280)}${KEY}${'b'.repeat(100)}`;
    const r = recorder(() => json({ error: { message } }, 400));
    const err = await fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl })));
    const quoted = err.message.slice(err.message.indexOf('aaa'));
    expect(quoted.length).toBeLessThanOrEqual(300);
    expect(err.message).not.toContain(KEY.slice(0, 10)); // not even the start of it
    expect(err.message).toContain('***');
  });

  it('blanks the key in plain-text bodies, 403 messages, network errors and JSON parse errors', async () => {
    const text = recorder(() => new Response(`gateway says ${KEY}`, { status: 400 }));
    expect(everything(await fail(postJson(URL_, {}, base({ fetchImpl: text.fetchImpl }))))).not.toContain(KEY);

    const forbidden = recorder(() => json({ error: { message: `region blocked for ${KEY}` } }, 403));
    const f = await fail(postJson(URL_, {}, base({ fetchImpl: forbidden.fetchImpl })));
    expect(f.kind).toBe('auth');
    expect(everything(f)).not.toContain(KEY);

    const network = async () => {
      throw new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value`, { cause: new Error(`inner ${KEY}`) });
    };
    const n = await fail(postJson(URL_, {}, base({ fetchImpl: network })));
    expect(n.kind).toBe('unavailable');
    expect(everything(n)).not.toContain(KEY);

    const garbage = recorder(() => new Response(`{"a": ${KEY}`, { status: 200 }));
    const g = await fail(postJson(URL_, {}, base({ fetchImpl: garbage.fetchImpl })));
    expect(g.kind).toBe('bad_response');
    expect(everything(g)).not.toContain(KEY);
  });

  it('does not quote a 401 body at all (it may echo part of the key)', async () => {
    const r = recorder(() => json({ error: { message: 'Incorrect API key provided: sk-test-****4e. You can find your key at https://platform.openai.com/account/api-keys.' } }, 401));
    const err = await fail(postJson(URL_, {}, base({ fetchImpl: r.fetchImpl })));
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('sk-test');
  });
});

describe('quoteVendor', () => {
  it('collapses whitespace, drops invisible characters and cuts after blanking', () => {
    expect(quoteVendor('  a \n\n b​ c  ', [])).toBe('a b c');
    expect(quoteVendor('x'.repeat(400), [])).toHaveLength(300);
    expect(quoteVendor(`say ${KEY}`, [KEY])).toBe('say ***');
  });
});
