import { describe, expect, it, vi } from 'vitest';
import { GeminiEngine, hostFromTitle, isGoogleRedirect, tokenCounts } from '../../src/server/geo/engines/gemini';
import type { AskOptions, EngineError } from '../../src/server/geo/engines/types';

const KEY = 'AIzaSyGemini0123456789abcdefghijk';
const MODEL = 'gemini-3.8-flash';
const URL_ = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const LOCATION: AskOptions['location'] = { country: 'BG', timezone: 'Europe/Sofia' };
const QUESTION = 'Колко струва изработката на онлайн магазин?';
const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recorder(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const call: Call = { url, init, headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {} };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}

const engine = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, over: { retries?: number; timeoutMs?: number } = {}) =>
  new GeminiEngine({ apiKey: KEY, model: MODEL }, { fetchImpl, retries: over.retries ?? 0, backoffBaseMs: 1, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}) });

const fail = (promise: Promise<unknown>): Promise<EngineError> => promise.then(() => Promise.reject(new Error('expected a rejection')), (e: unknown) => e as EngineError);

function everything(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e !== undefined && e !== null; e = e instanceof Error ? e.cause : undefined) {
    if (e instanceof Error) parts.push(e.name, e.message, e.stack ?? '');
    parts.push(JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
  }
  return parts.join('\n');
}

const note = (url: string, title: string) => ({ type: 'url_citation', url, title, start_index: 0, end_index: 5 });

/** An Interaction shaped like the documented one: the user's input, a thought, a search, its result, the answer. */
const INTERACTION = {
  id: 'int_0123',
  status: 'completed',
  model: 'gemini-3.8-flash-001',
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: QUESTION }] },
    { type: 'thought', signature: 'abc' },
    { type: 'google_search_call', id: 'call_1', queries: ['цена онлайн магазин', 'изработка онлайн магазин цена'] },
    { type: 'google_search_result', call_id: 'call_1', result: [{ search_suggestions: '<div class="chip">цена онлайн магазин</div>' }] },
    {
      type: 'model_output',
      content: [
        { type: 'text', text: 'Цената започва от ', annotations: [] },
        { type: 'text', text: 'около 1500 лв.', annotations: [note(`${REDIRECT}/AAA`, 'shop-agency.example'), note(`${REDIRECT}/BBB`, 'www.web-blog.example'), note(`${REDIRECT}/AAA`, 'shop-agency.example')] },
      ],
    },
  ],
  usage: { total_input_tokens: 900, total_output_tokens: 140, total_tokens: 1040 },
};

describe('GeminiEngine.ask: the request', () => {
  it('sends exactly the documented Interactions API request', async () => {
    const r = recorder(() => json(INTERACTION));
    await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.url).toBe(URL_);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(call.headers['x-goog-api-key']).toBe(KEY);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({ model: MODEL, input: QUESTION, tools: [{ type: 'google_search' }], store: false });
  });

  it('keeps the key out of the URL and the body', async () => {
    const r = recorder(() => json(INTERACTION));
    await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls[0]!.url).not.toContain(KEY);
    expect(r.calls[0]!.url).not.toContain('?');
    expect(JSON.stringify(r.calls[0]!.body)).not.toContain(KEY);
  });
});

describe('GeminiEngine.ask: the answer', () => {
  it('reads the text blocks, the cited sources (domain from the title), the searches and the usage', async () => {
    const r = recorder(() => json(INTERACTION));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toBe('Цената започва от около 1500 лв.');
    expect(answer.citations).toEqual([
      { url: `${REDIRECT}/AAA`, title: 'shop-agency.example', domain: 'shop-agency.example' },
      { url: `${REDIRECT}/BBB`, title: 'www.web-blog.example', domain: 'web-blog.example' },
    ]);
    expect(answer.consulted).toEqual([]);
    expect(answer.searched).toBe(true);
    expect(answer.queries).toEqual(['цена онлайн магазин', 'изработка онлайн магазин цена']);
    expect(answer.usage).toEqual({ inputTokens: 900, outputTokens: 140, searches: 1 });
    expect(answer.model).toBe('gemini-3.8-flash-001');
    expect(answer.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('counts one search per google_search_call step', async () => {
    const r = recorder(() =>
      json({
        steps: [
          { type: 'google_search_call', queries: ['a'] },
          { type: 'google_search_result' },
          { type: 'google_search_call', queries: ['b', 'c'] },
          { type: 'model_output', content: [{ type: 'text', text: 'x' }] },
        ],
      }),
    );
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.usage.searches).toBe(2);
    expect(answer.queries).toEqual(['a', 'b', 'c']);
    expect(answer.searched).toBe(true);
  });

  it('says searched = false when no search ran', async () => {
    const r = recorder(() => json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'По памет.' }] }] }));
    expect(await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).toMatchObject({ text: 'По памет.', searched: false, usage: { searches: 0 }, queries: [] });
  });

  it('prefers the top-level output_text, and still takes the citations from the blocks', async () => {
    const r = recorder(() => json({ ...INTERACTION, output_text: 'Това е целият отговор.' }));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toBe('Това е целият отговор.');
    expect(answer.citations).toHaveLength(2);
    // an empty or non-string output_text does not count
    for (const output_text of ['', '   ', 5, null]) {
      const again = recorder(() => json({ ...INTERACTION, output_text }));
      expect((await engine(again.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Цената започва от около 1500 лв.');
    }
  });

  it('works with the flat `outputs` list of the earlier API too', async () => {
    const r = recorder(() =>
      json({
        status: 'completed',
        outputs: [
          { type: 'google_search_call', queries: ['x'] },
          { type: 'text', text: 'Стар формат', annotations: [note('https://direct.example/page', 'Direct page')] },
        ],
      }),
    );
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer).toMatchObject({ text: 'Стар формат', searched: true });
    expect(answer.citations).toEqual([{ url: 'https://direct.example/page', title: 'Direct page', domain: 'direct.example' }]);
  });

  it('separates text blocks of different steps that would run together', async () => {
    const r = recorder(() =>
      json({
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: 'Първо.' }] },
          { type: 'google_search_call', queries: ['x'] },
          { type: 'model_output', content: [{ type: 'text', text: 'Второ ' }, { type: 'text', text: 'и трето.' }] },
        ],
      }),
    );
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Първо.\n\nВторо и трето.');
  });

  it('reads search queries from `arguments` and `query` too', async () => {
    const r = recorder(() =>
      json({ steps: [{ type: 'google_search_call', arguments: { queries: ['q1'] } }, { type: 'google_search_call', query: 'q2' }, { type: 'model_output', content: [{ type: 'text', text: 'x' }] }] }),
    );
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).queries).toEqual(['q1', 'q2']);
  });

  it('caps the text, the citations and the queries', async () => {
    const many = Array.from({ length: 45 }, (_v, i) => i);
    const r = recorder(() =>
      json({
        steps: [
          { type: 'google_search_call', queries: many.map((i) => `q${i}`) },
          { type: 'model_output', content: [{ type: 'text', text: 'z'.repeat(20_000), annotations: many.map((i) => note(`https://s${i}.example/`, `s${i}.example`)) }] },
        ],
      }),
    );
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toHaveLength(12_000);
    expect(answer.citations).toHaveLength(30);
    expect(answer.queries).toHaveLength(10);
  });
});

describe('Gemini citations: the domain behind a Google redirect', () => {
  const cite = async (url: string, title: string) => {
    const r = recorder(() => json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 't', annotations: [note(url, title)] }] }] }));
    return (await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).citations[0];
  };

  it.each([
    [`${REDIRECT}/x`, 'healthline.com', 'healthline.com'],
    [`${REDIRECT}/x`, 'www.healthline.com', 'healthline.com'],
    [`${REDIRECT}/x`, 'Healthline.COM', 'healthline.com'],
    [`${REDIRECT}/x`, '  healthline.com  ', 'healthline.com'],
    [`${REDIRECT}/x`, 'en.wikipedia.org', 'wikipedia.org'],
    [`${REDIRECT}/x`, 'my-studio.co.uk', 'my-studio.co.uk'],
    [`${REDIRECT}/x`, 'пример.бг', 'пример.бг'],
    ['https://www.google.com/grounding-api-redirect/x', 'healthline.com', 'healthline.com'],
    ['https://sub.vertexaisearch.cloud.google.com/grounding-api-redirect/x', 'healthline.com', 'healthline.com'],
  ])('%s with title %j gives the domain %s', async (url, title, domain) => {
    expect((await cite(url, title))?.domain).toBe(domain);
  });

  it.each([['Healthline - Dosage guide'], ['Какво е SEO?'], [''], ['localhost'], ['healthline'], ['a..b.com'], ['healthline.com/page']])(
    'falls back to the url\'s own domain when the title %j is not a host name',
    async (title) => {
      expect((await cite(`${REDIRECT}/x`, title))?.domain).toBe('google.com');
    },
  );

  it('keeps the redirect link as the url, and the title as it came', async () => {
    expect(await cite(`${REDIRECT}/AbC123`, 'www.healthline.com')).toEqual({ url: `${REDIRECT}/AbC123`, title: 'www.healthline.com', domain: 'healthline.com' });
  });

  it('takes the domain of an ordinary url from the url, whatever the title says', async () => {
    expect((await cite('https://www.real-site.example/page', 'other-site.example'))?.domain).toBe('real-site.example');
    expect((await cite('https://www.google.com/search?q=x', 'healthline.com'))?.domain).toBe('google.com'); // google.com, but not a grounding redirect
  });

  it('de-duplicates by domain and url: the same link twice is one citation, two links to one domain are two', async () => {
    const r = recorder(() =>
      json({
        steps: [
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: 't',
                annotations: [note(`${REDIRECT}/1`, 'a.example'), note(`${REDIRECT}/1`, 'a.example'), note(`${REDIRECT}/2`, 'a.example'), note(`${REDIRECT}/1`, 'b.example')],
              },
            ],
          },
        ],
      }),
    );
    const { citations } = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(citations.map((c) => [c.url, c.domain])).toEqual([
      [`${REDIRECT}/1`, 'a.example'],
      [`${REDIRECT}/2`, 'a.example'],
      [`${REDIRECT}/1`, 'b.example'],
    ]);
  });

  it('ignores annotations of another type and annotations without a usable url', async () => {
    const r = recorder(() =>
      json({
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'text', text: 't', annotations: [{ type: 'file_citation', url: 'https://x.example/' }, { type: 'url_citation' }, { type: 'url_citation', url: 'not a url' }, 'x', null, { url: 'https://untyped.example/p', title: 'Untyped' }] }],
          },
        ],
      }),
    );
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).citations.map((c) => c.domain)).toEqual(['untyped.example']);
  });

  it('knows a Google redirect when it sees one', () => {
    expect(isGoogleRedirect(`${REDIRECT}/x`)).toBe(true);
    expect(isGoogleRedirect('https://www.google.com/grounding-api-redirect/x')).toBe(true);
    expect(isGoogleRedirect('https://google.com/grounding-api-redirect')).toBe(true);
    expect(isGoogleRedirect('https://www.google.com/search?q=x')).toBe(false);
    expect(isGoogleRedirect('https://evil-google.com/grounding-api-redirect/x')).toBe(false);
    expect(isGoogleRedirect('https://example.com/')).toBe(false);
    expect(isGoogleRedirect('nonsense')).toBe(false);
  });

  it('reads a host name from a title only when it is one', () => {
    expect(hostFromTitle('www.healthline.com')).toBe('healthline.com');
    expect(hostFromTitle('x')).toBeNull();
    expect(hostFromTitle('two words.com')).toBeNull();
    expect(hostFromTitle('-bad.com')).toBeNull();
    expect(hostFromTitle('bad-.com')).toBeNull();
  });
});

describe('Gemini usage: field names and places', () => {
  const read = (box: Record<string, unknown>) => tokenCounts(box);

  it.each([
    [{ usage: { input_tokens: 11, output_tokens: 22 } }, 11, 22],
    [{ usage: { total_input_tokens: 12, total_output_tokens: 23 } }, 12, 23],
    [{ usage: { prompt_tokens: 13, completion_tokens: 24 } }, 13, 24],
    [{ usage: { prompt_tokens: 14, candidates_tokens: 25 } }, 14, 25],
    [{ usage_metadata: { promptTokenCount: 15, candidatesTokenCount: 26 } }, 15, 26],
    [{ usageMetadata: { promptTokenCount: 16, candidatesTokenCount: 27 } }, 16, 27],
    [{ usage_metadata: { total_input_tokens: 17, output_tokens: 28 } }, 17, 28],
  ])('reads %j', (box, input, output) => {
    expect(read(box)).toEqual({ inputTokens: input, outputTokens: output });
  });

  it('takes the first container and name that hold a number, and ignores everything else', () => {
    expect(read({ usage: { input_tokens: 1 }, usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 8 } })).toEqual({ inputTokens: 1, outputTokens: 8 });
    expect(read({ usage: { input_tokens: 5, total_input_tokens: 6 } }).inputTokens).toBe(5);
    expect(read({ usage: { input_tokens: '5', output_tokens: null } })).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(read({ usage: { input_tokens: -5, output_tokens: NaN } })).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(read({ usage: 'lots', usage_metadata: [1, 2] })).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(read({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('flows into the answer', async () => {
    const r = recorder(() => json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }] }], usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 45 } }));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).usage).toEqual({ inputTokens: 321, outputTokens: 45, searches: 0 });
  });
});

describe('GeminiEngine.ask: odd replies and incomplete ones', () => {
  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a string', 'x'],
    ['steps that are not a list', { steps: 'x' }],
    ['steps that are not objects', { steps: [1, null, 'x', []] }],
    ['a model_output without content', { steps: [{ type: 'model_output' }] }],
    ['content blocks that are not objects', { steps: [{ type: 'model_output', content: [null, 7, 'x'] }] }],
    ['a search call without queries', { steps: [{ type: 'google_search_call' }, { type: 'google_search_call', queries: 'x' }] }],
  ])('does not throw on %s: a reply with no error and no text is an empty answer', async (_name, body) => {
    const r = recorder(() => json(body));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer).toMatchObject({ text: '', citations: [], consulted: [], model: MODEL, usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('returns what it can read when only part of the shape is odd', async () => {
    const r = recorder(() =>
      json({
        steps: [
          { type: 'google_search_call', queries: 'not a list', arguments: 'nope' },
          { type: 'model_output', content: [{ type: 'text', text: 'Текст', annotations: 5 }, { type: 'text', text: ' още', annotations: [null, 'x'] }] },
        ],
        usage: 'lots',
      }),
    );
    expect(await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).toMatchObject({ text: 'Текст още', citations: [], queries: [], searched: true, usage: { inputTokens: 0, outputTokens: 0, searches: 1 } });
  });

  it('reports a failed interaction without text as bad_response, with its status and error', async () => {
    const status = recorder(() => json({ status: 'failed', steps: [] }));
    const a = await fail(engine(status.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(a).toMatchObject({ kind: 'bad_response' });
    expect(a.message).toContain('failed');
    const error = recorder(() => json({ status: 'failed', error: { code: 500, message: 'Internal error encountered.' }, steps: [] }));
    expect((await fail(engine(error.fetchImpl).ask(QUESTION, { location: LOCATION }))).message).toContain('Internal error encountered.');
    const stuck = recorder(() => json({ status: 'in_progress' }));
    expect((await fail(engine(stuck.fetchImpl).ask(QUESTION, { location: LOCATION }))).message).toContain('in_progress');
  });

  it.each([['completed'], ['succeeded'], ['done'], ['COMPLETED']])('accepts the status %s', async (status) => {
    const r = recorder(() => json({ status, output_text: 'Ето.' }));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Ето.');
  });

  it('returns text even when the status is not completed-like (what could be read is what is returned)', async () => {
    const r = recorder(() => json({ status: 'in_progress', output_text: 'Частичен отговор' }));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Частичен отговор');
  });

  it('does not let a key the reply echoes into a message', async () => {
    const r = recorder(() => json({ status: 'failed', error: { message: `denied for key=${KEY}` }, steps: [] }));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err.kind).toBe('bad_response');
    expect(everything(err)).not.toContain(KEY);
  });
});

describe('GeminiEngine: errors', () => {
  const ask = (e: GeminiEngine) => e.ask(QUESTION, { location: LOCATION });
  const google = (code: number, message: string, status: string) => json({ error: { code, message, status } }, code);

  it('maps a 404 about the model to model (fatal), quoting Google\'s message', async () => {
    const r = recorder(() => google(404, 'models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.', 'NOT_FOUND'));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 2 })));
    expect(err).toMatchObject({ kind: 'model', status: 404, fatal: true });
    expect(err.message).toContain('models/gemini-9 is not found');
    expect(r.calls).toHaveLength(1);
  });

  it('maps an invalid key (400 API_KEY_INVALID, 401, 403) to auth (fatal)', async () => {
    for (const reply of [
      google(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'),
      google(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED'),
      google(403, 'Your API key was reported as leaked. Please use another API key.', 'PERMISSION_DENIED'),
    ]) {
      const r = recorder(() => reply.clone());
      expect(await fail(ask(engine(r.fetchImpl, { retries: 2 })))).toMatchObject({ kind: 'auth', fatal: true });
      expect(r.calls).toHaveLength(1);
    }
  });

  it('maps a plain RESOURCE_EXHAUSTED 429 to rate_limit after the retries', async () => {
    const r = recorder(() => google(429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED'));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 2 })));
    expect(err).toMatchObject({ kind: 'rate_limit', status: 429 });
    expect(r.calls).toHaveLength(3);
  });

  it('maps an exhausted plan (billing wording, no retry hint) to quota, without retrying', async () => {
    const r = recorder(() => google(429, 'You exceeded your current quota, please check your plan and billing details.', 'RESOURCE_EXHAUSTED'));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 2 })));
    expect(err).toMatchObject({ kind: 'quota' });
    expect(r.calls).toHaveLength(1);
  });

  it('keeps retrying a per-minute limit that says when to come back', async () => {
    const r = recorder(() => google(429, 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: x, limit: 5\nPlease retry in 34.2s.', 'RESOURCE_EXHAUSTED'));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 1 })));
    expect(err).toMatchObject({ kind: 'rate_limit' });
    expect(r.calls).toHaveLength(2);
  });

  it('retries 503 UNAVAILABLE and succeeds', async () => {
    const r = recorder((_c, n) => (n === 1 ? google(503, 'The model is overloaded. Please try again later.', 'UNAVAILABLE') : json(INTERACTION)));
    expect((await ask(engine(r.fetchImpl, { retries: 2 }))).citations).toHaveLength(2);
    expect(r.calls).toHaveLength(2);
  });

  it('uses Google\'s message in the bad_response of any other 400', async () => {
    const r = recorder(() => google(400, 'Invalid JSON payload received. Unknown name "foo" at \'tools[0]\'.', 'INVALID_ARGUMENT'));
    const err = await fail(ask(engine(r.fetchImpl)));
    expect(err).toMatchObject({ kind: 'bad_response', status: 400 });
    expect(err.message).toContain('Invalid JSON payload received');
    expect(err.message).toMatch(/Gemini върна 400/);
  });

  it('maps network errors, timeouts, invalid JSON and aborts', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await fail(ask(engine(down)))).toMatchObject({ kind: 'unavailable' });

    const hang = (_url: string, init: RequestInit = {}) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('x', 'TimeoutError'))));
    expect(await fail(ask(engine(hang, { timeoutMs: 20 })))).toMatchObject({ kind: 'unavailable' });

    const garbage = recorder(() => new Response('not json', { status: 200 }));
    expect(await fail(ask(engine(garbage.fetchImpl)))).toMatchObject({ kind: 'bad_response' });

    const controller = new AbortController();
    controller.abort();
    const never = recorder(() => json(INTERACTION));
    expect(await fail(engine(never.fetchImpl).ask(QUESTION, { location: LOCATION, signal: controller.signal }))).toMatchObject({ kind: 'aborted', fatal: true });
    expect(never.calls).toHaveLength(0);
  });

  it('never lets the key into a message, even when Google echoes it', async () => {
    for (const status of [400, 403, 404, 429, 500]) {
      const r = recorder(() => google(status, `bad key ${KEY} in request`, 'INVALID_ARGUMENT'));
      expect(everything(await fail(ask(engine(r.fetchImpl))))).not.toContain(KEY);
    }
  });

  it('writes its messages in Bulgarian', async () => {
    const r = recorder(() => json({}, 401));
    expect((await fail(ask(engine(r.fetchImpl)))).message).toMatch(/Gemini.*отхвърли API ключа/);
  });
});

describe('GeminiEngine.generate', () => {
  it('sends the documented body: model, input, system_instruction and store, no tools', async () => {
    const r = recorder(() => json({ status: 'completed', output_text: 'Готово.', usage: { total_input_tokens: 30, total_output_tokens: 7 } }));
    const result = await engine(r.fetchImpl).generate({ system: 'Be brief.', prompt: 'Write a title.', maxTokens: 500 });
    expect(r.calls[0]!.url).toBe(URL_);
    expect(r.calls[0]!.headers['x-goog-api-key']).toBe(KEY);
    expect(r.calls[0]!.body).toEqual({ model: MODEL, input: 'Write a title.', system_instruction: 'Be brief.', store: false });
    expect(result).toEqual({ text: 'Готово.', usage: { inputTokens: 30, outputTokens: 7 } });
  });

  it('leaves out system_instruction without a system prompt, and relies on the prompt for JSON', async () => {
    const r = recorder(() => json({ output_text: '{"a":1}' }));
    await engine(r.fetchImpl).generate({ prompt: 'p', json: true });
    expect(r.calls[0]!.body).toEqual({ model: MODEL, input: 'p', store: false });
  });

  it('reads the text blocks when there is no output_text, and does not cap it at the answer limit', async () => {
    const r = recorder(() => json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'q'.repeat(15_000) }] }] }));
    expect((await engine(r.fetchImpl).generate({ prompt: 'p' })).text).toHaveLength(15_000);
  });

  it('throws bad_response for an empty generation, and passes the signal', async () => {
    const empty = recorder(() => json({ status: 'completed' }));
    expect(await fail(engine(empty.fetchImpl).generate({ prompt: 'p' }))).toMatchObject({ kind: 'bad_response' });
    const controller = new AbortController();
    controller.abort();
    expect(await fail(engine(empty.fetchImpl).generate({ prompt: 'p', signal: controller.signal }))).toMatchObject({ kind: 'aborted' });
  });
});

describe('GeminiEngine identity', () => {
  it('is Gemini, with the configured model', () => {
    expect(new GeminiEngine({ apiKey: KEY, model: 'gemini-3.1-pro' })).toMatchObject({ id: 'gemini', label: 'Gemini', model: 'gemini-3.1-pro' });
  });
});
