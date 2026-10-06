import { describe, expect, it, vi } from 'vitest';
import { OpenAiEngine } from '../../src/server/geo/engines/openai';
import type { AskOptions, EngineError } from '../../src/server/geo/engines/types';

const KEY = 'sk-proj-OpenAI0123456789abcdef';
const MODEL = 'gpt-6.1-sol';
const URL_ = 'https://api.openai.com/v1/responses';
const LOCATION: AskOptions['location'] = { country: 'BG', timezone: 'Europe/Sofia' };
const QUESTION = 'Коя е най-добрата фирма за изработка на уебсайт в София?';

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

const engine = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, over: { retries?: number; timeoutMs?: number; model?: string } = {}) =>
  new OpenAiEngine({ apiKey: KEY, model: over.model ?? MODEL }, { fetchImpl, retries: over.retries ?? 0, backoffBaseMs: 1, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}) });

const fail = (promise: Promise<unknown>): Promise<EngineError> => promise.then(() => Promise.reject(new Error('expected a rejection')), (e: unknown) => e as EngineError);

function everything(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e !== undefined && e !== null; e = e instanceof Error ? e.cause : undefined) {
    if (e instanceof Error) parts.push(e.name, e.message, e.stack ?? '');
    parts.push(JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
  }
  return parts.join('\n');
}

/** A reply shaped like the Responses API's: a reasoning item, two searches with their sources, then the answer. */
const REPLY = {
  id: 'resp_0123',
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  error: null,
  incomplete_details: null,
  model: 'gpt-6.1-sol-2026-09-30',
  output: [
    { id: 'rs_1', type: 'reasoning', summary: [] },
    {
      id: 'ws_1',
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: 'най-добри фирми за изработка на уебсайт София',
        sources: [
          { type: 'url', url: 'https://www.a-studio.example/uslugi?utm_source=openai' },
          { type: 'url', url: 'https://b-agency.example/sait' },
          { type: 'url', url: 'https://c-web.example/' },
        ],
      },
    },
    {
      id: 'ws_2',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', queries: ['цена изработка уебсайт', 'уебсайт цена София'], sources: [{ url: 'https://b-agency.example/sait' }, { url: 'https://d-blog.example/post' }] },
    },
    {
      id: 'msg_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'Най-често препоръчват ', annotations: [] },
        {
          type: 'output_text',
          text: 'A Studio и B Agency.',
          annotations: [
            { type: 'url_citation', url: 'https://www.a-studio.example/uslugi?utm_source=openai', title: 'A Studio - услуги', start_index: 0, end_index: 8 },
            { type: 'url_citation', url: 'https://b-agency.example/sait', title: 'B Agency', start_index: 11, end_index: 20 },
            { type: 'url_citation', url: 'https://www.a-studio.example/uslugi?utm_source=openai', title: 'A Studio again', start_index: 0, end_index: 8 },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 4200, output_tokens: 510, total_tokens: 4710, output_tokens_details: { reasoning_tokens: 64 } },
};

const textReply = (text: string, extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  model: MODEL,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

describe('OpenAiEngine.ask: the request', () => {
  it('sends exactly the documented Responses API request', async () => {
    const r = recorder(() => json(REPLY));
    await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.url).toBe(URL_);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({
      model: MODEL,
      input: QUESTION, // the question exactly as typed: no instructions added
      tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'BG', timezone: 'Europe/Sofia' } }],
      tool_choice: 'auto',
      reasoning: { effort: 'low' },
      max_output_tokens: 4096,
      include: ['web_search_call.action.sources'],
      store: false,
    });
  });

  it('puts the asker\'s location and the configured model into the request', async () => {
    const r = recorder(() => json(REPLY));
    await engine(r.fetchImpl, { model: 'gpt-6-luna' }).ask('q?', { location: { country: 'US', timezone: 'America/New_York' } });
    expect(r.calls[0]!.body).toMatchObject({ model: 'gpt-6-luna', tools: [{ type: 'web_search', user_location: { country: 'US', timezone: 'America/New_York' } }] });
  });

  it('sends the country code in capitals even when it is handed in as a Google `gl`', async () => {
    const r = recorder(() => json(REPLY));
    await engine(r.fetchImpl).ask('q?', { location: { country: ' bg ', timezone: ' Europe/Sofia ' } });
    expect(r.calls[0]!.body.tools).toEqual([{ type: 'web_search', user_location: { type: 'approximate', country: 'BG', timezone: 'Europe/Sofia' } }]);
  });

  it('never puts the key in the body or the URL', async () => {
    const r = recorder(() => json(REPLY));
    await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(JSON.stringify(r.calls[0]!.body)).not.toContain(KEY);
    expect(r.calls[0]!.url).not.toContain(KEY);
  });

  it('passes the caller\'s signal on (aborting ends the call with aborted)', async () => {
    const controller = new AbortController();
    const hang = (_url: string, init: RequestInit = {}) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))));
    const pending = fail(engine(hang).ask(QUESTION, { location: LOCATION, signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toMatchObject({ kind: 'aborted', fatal: true });
  });
});

describe('OpenAiEngine.ask: the answer', () => {
  it('reads the text, the cited and the merely consulted sources, the searches and the usage', async () => {
    const r = recorder(() => json(REPLY));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toBe('Най-често препоръчват A Studio и B Agency.'); // the output_text parts, joined
    // cited: de-duplicated by url, in order of appearance; the domain is the registrable one
    expect(answer.citations).toEqual([
      { url: 'https://www.a-studio.example/uslugi?utm_source=openai', title: 'A Studio - услуги', domain: 'a-studio.example' },
      { url: 'https://b-agency.example/sait', title: 'B Agency', domain: 'b-agency.example' },
    ]);
    // consulted: what the searches returned and the answer did not cite
    expect(answer.consulted).toEqual([
      { url: 'https://c-web.example/', title: '', domain: 'c-web.example' },
      { url: 'https://d-blog.example/post', title: '', domain: 'd-blog.example' },
    ]);
    expect(answer.searched).toBe(true);
    expect(answer.queries).toEqual(['най-добри фирми за изработка на уебсайт София', 'цена изработка уебсайт', 'уебсайт цена София']);
    expect(answer.usage).toEqual({ inputTokens: 4200, outputTokens: 510, searches: 2 });
    expect(answer.model).toBe('gpt-6.1-sol-2026-09-30'); // the model that actually answered
    expect(answer.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(answer.latencyMs)).toBe(true);
  });

  it('measures the latency of the whole call', async () => {
    const slow = recorder(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return json(REPLY);
    });
    expect((await engine(slow.fetchImpl).ask(QUESTION, { location: LOCATION })).latencyMs).toBeGreaterThanOrEqual(25);
  });

  it('falls back to the configured model when the reply names none', async () => {
    const r = recorder(() => json({ ...textReply('Здравей'), model: undefined }));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).model).toBe(MODEL);
  });

  it('says searched = false (and 0 searches) when the model answered without searching', async () => {
    const r = recorder(() => json(textReply('Отговор по памет.')));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer).toMatchObject({ text: 'Отговор по памет.', searched: false, citations: [], consulted: [], queries: [], usage: { searches: 0 } });
  });

  it('accepts a top-level output_text when the output items hold no text', async () => {
    const r = recorder(() => json({ status: 'completed', output_text: 'Само текст', output: [], usage: { input_tokens: 3, output_tokens: 4 } }));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Само текст');
    // ...but the parts win when both are there
    const both = recorder(() => json({ ...textReply('От частите'), output_text: 'От горното поле' }));
    expect((await engine(both.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('От частите');
  });

  it('puts a paragraph break between separate messages that would run together, not inside one', async () => {
    const r = recorder(() =>
      json({
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ще проверя.' }] },
          { type: 'web_search_call', action: { type: 'search', query: 'x' } },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ето ' }, { type: 'output_text', text: 'отговорът.' }] },
        ],
      }),
    );
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Ще проверя.\n\nЕто отговорът.');
  });

  it('keeps answer text that is cut off by the token limit (incomplete, but readable)', async () => {
    const r = recorder(() => json(textReply('Начало на отговора', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Начало на отговора');
  });

  it('counts every web_search_call as one search, whatever its action', async () => {
    const r = recorder(() =>
      json({
        ...textReply('t'),
        output: [
          { type: 'web_search_call', action: { type: 'search', query: 'a' } },
          { type: 'web_search_call', action: { type: 'open_page', url: 'https://a.example/' } },
          { type: 'web_search_call' },
          { type: 'message', content: [{ type: 'output_text', text: 't' }] },
        ],
      }),
    );
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.usage.searches).toBe(3);
    expect(answer.queries).toEqual(['a']);
  });

  it('caps the text (12,000 characters), the citations (30), the consulted sources (30) and the queries (10)', async () => {
    const many = Array.from({ length: 45 }, (_v, i) => i);
    const r = recorder(() =>
      json({
        output: [
          { type: 'web_search_call', action: { type: 'search', queries: many.map((i) => `query ${i}`), sources: many.map((i) => ({ url: `https://src${i}.example/` })) } },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'x'.repeat(20_000), annotations: many.map((i) => ({ type: 'url_citation', url: `https://cite${i}.example/p`, title: `T${i}` })) }],
          },
        ],
      }),
    );
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toHaveLength(12_000);
    expect(answer.citations).toHaveLength(30);
    expect(answer.citations[0]?.domain).toBe('cite0.example');
    expect(answer.consulted).toHaveLength(30);
    expect(answer.queries).toHaveLength(10);
  });

  it('also reads a citation whose url and title are nested under `url_citation` (the Chat Completions layout)', async () => {
    const r = recorder(() =>
      json(textReply('t', { output: [{ type: 'message', content: [{ type: 'output_text', text: 't', annotations: [{ type: 'url_citation', url_citation: { url: 'https://nested.example/p', title: 'Nested', start_index: 0, end_index: 1 } }] }] }] })),
    );
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).citations).toEqual([{ url: 'https://nested.example/p', title: 'Nested', domain: 'nested.example' }]);
  });

  it('drops citations that are not http(s) urls, and cleans titles', async () => {
    const r = recorder(() =>
      json(
        textReply('t', {
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 't',
                  annotations: [
                    { type: 'url_citation', url: 'javascript:alert(1)', title: 'bad' },
                    { type: 'url_citation', url: 'https://ok.example/p', title: ' Хубаво​   заглавие ' },
                    { type: 'file_citation', file_id: 'f1', filename: 'x.pdf' },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).citations).toEqual([{ url: 'https://ok.example/p', title: 'Хубаво заглавие', domain: 'ok.example' }]);
  });
});

describe('OpenAiEngine.ask: odd replies', () => {
  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a string', 'hello'],
    ['an array', []],
    ['output that is not a list', { output: 'nope' }],
    ['items that are not objects', { output: [1, null, 'x', [], undefined] }],
    ['a message without content', { output: [{ type: 'message' }] }],
    ['content parts that are not objects', { output: [{ type: 'message', content: [null, 3, 'x'] }] }],
    ['annotations that are not a list', { output: [{ type: 'message', content: [{ type: 'output_text', text: 't', annotations: 'x' }] }] }],
    ['a search call with odd fields', { output: [{ type: 'web_search_call', action: 'x' }, { type: 'web_search_call', action: { sources: 'x', queries: 5, query: {} } }] }],
    ['usage of the wrong type', { output: [], usage: 'lots' }],
    ['text of the wrong type', { output: [{ type: 'message', content: [{ type: 'output_text', text: 42 }] }] }],
  ])('returns what it can read from %s, without throwing', async (_name, body) => {
    const r = recorder(() => json(body));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(typeof answer.text).toBe('string');
    expect(Array.isArray(answer.citations)).toBe(true);
    expect(answer.usage.inputTokens).toBe(0);
    expect(answer.model).toBe(MODEL);
  });

  it('reads usage numbers only', async () => {
    const r = recorder(() => json({ output: [], usage: { input_tokens: '5', output_tokens: -2 } }));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).usage).toEqual({ inputTokens: 0, outputTokens: 0, searches: 0 });
  });

  it('throws bad_response when there is no text and the reply carries an error', async () => {
    const r = recorder(() => json({ status: 'failed', error: { code: 'server_error', message: 'The model failed to generate a response.' }, output: [] }));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err).toMatchObject({ kind: 'bad_response', fatal: false });
    expect(err.message).toContain('The model failed to generate a response.');
  });

  it('throws bad_response when there is no text and the reply says it is incomplete', async () => {
    const r = recorder(() => json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [] }] }));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err).toMatchObject({ kind: 'bad_response' });
    expect(err.message).toContain('max_output_tokens');
  });

  it('treats a failed status without a message as an error too', async () => {
    const r = recorder(() => json({ status: 'failed', error: null, output: [] }));
    expect(await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }))).toMatchObject({ kind: 'bad_response' });
  });

  it('does not throw on an empty reply that claims no error: it returns an empty answer', async () => {
    const r = recorder(() => json({ status: 'completed', error: null, incomplete_details: null, output: [] }));
    expect(await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).toMatchObject({ text: '', citations: [], searched: false });
  });

  it('reports a refusal as refused', async () => {
    const r = recorder(() => json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: "I can't help with that." }] }] }));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err).toMatchObject({ kind: 'refused', fatal: false });
  });

  it('does not let a key the reply echoes into an error message', async () => {
    const r = recorder(() => json({ status: 'failed', error: { message: `bad Authorization: Bearer ${KEY}` }, output: [] }));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err.kind).toBe('bad_response');
    expect(everything(err)).not.toContain(KEY);
  });
});

describe('OpenAiEngine: fields a model may refuse', () => {
  const reasoningRefused = () => json({ error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_parameter' } }, 400);
  const includeRefused = () => json({ error: { message: "Invalid value: 'web_search_call.action.sources'. Supported values are: 'message.output_text.logprobs'.", type: 'invalid_request_error', param: 'include[0]', code: 'invalid_value' } }, 400);

  it('retries once without `reasoning` when the API refuses it, and remembers that for later calls', async () => {
    const r = recorder((call) => ('reasoning' in call.body ? reasoningRefused() : json(REPLY)));
    const e = engine(r.fetchImpl);
    const answer = await e.ask(QUESTION, { location: LOCATION });
    expect(answer.citations).toHaveLength(2);
    expect(r.calls).toHaveLength(2);
    const { reasoning, ...withoutReasoning } = r.calls[0]!.body;
    expect(reasoning).toEqual({ effort: 'low' });
    expect(r.calls[1]!.body).toEqual(withoutReasoning); // everything else is unchanged
    await e.ask('another question', { location: LOCATION });
    expect(r.calls).toHaveLength(3); // no second probe
    expect('reasoning' in r.calls[2]!.body).toBe(false);
    expect(r.calls[2]!.body.include).toEqual(['web_search_call.action.sources']);
  });

  it('retries once without `include` when the API refuses that', async () => {
    const r = recorder((call) => ('include' in call.body ? includeRefused() : json(REPLY)));
    const e = engine(r.fetchImpl);
    await e.ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(2);
    expect('include' in r.calls[1]!.body).toBe(false);
    expect(r.calls[1]!.body.reasoning).toEqual({ effort: 'low' });
    await e.ask(QUESTION, { location: LOCATION });
    expect('include' in r.calls[2]!.body).toBe(false);
  });

  it('can drop both, one after the other', async () => {
    const r = recorder((call) => ('reasoning' in call.body ? reasoningRefused() : 'include' in call.body ? includeRefused() : json(REPLY)));
    await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(3);
    expect(Object.keys(r.calls[2]!.body).sort()).toEqual(['input', 'max_output_tokens', 'model', 'store', 'tool_choice', 'tools']);
  });

  it('tries each field only once: a 400 that persists is reported', async () => {
    const r = recorder(() => reasoningRefused());
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err).toMatchObject({ kind: 'bad_response', status: 400 });
    expect(r.calls).toHaveLength(2);
  });

  it('does not retry a 400 that is about something else', async () => {
    const r = recorder(() => json({ error: { message: "Invalid value: 'auto'. tool_choice is not allowed here.", param: 'tool_choice' } }, 400));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err.kind).toBe('bad_response');
    expect(r.calls).toHaveLength(1);
  });

  it('does not treat other errors that mention the word as a refusal of the field', async () => {
    const r = recorder(() => json({ error: { message: 'reasoning is mentioned but the server is down' } }, 503));
    await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(r.calls).toHaveLength(1);
  });

  it('applies the same rule to generate(), including JSON mode', async () => {
    const r = recorder((call) => ('reasoning' in call.body ? reasoningRefused() : json(textReply('{"a":1}'))));
    const e = engine(r.fetchImpl);
    expect((await e.generate({ prompt: 'p', json: true })).text).toBe('{"a":1}');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.body.text).toEqual({ format: { type: 'json_object' } });

    const jsonRefused = recorder((call) =>
      'text' in call.body ? json({ error: { message: "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.", param: 'text.format' } }, 400) : json(textReply('{"b":2}')),
    );
    const g = engine(jsonRefused.fetchImpl);
    expect((await g.generate({ prompt: 'p', json: true })).text).toBe('{"b":2}');
    expect('text' in jsonRefused.calls[1]!.body).toBe(false);
    await g.generate({ prompt: 'p', json: true });
    expect('text' in jsonRefused.calls[2]!.body).toBe(false); // remembered
  });
});

describe('OpenAiEngine: errors', () => {
  const ask = (e: OpenAiEngine) => e.ask(QUESTION, { location: LOCATION });

  it('maps 401 to auth (fatal) without retrying', async () => {
    const r = recorder(() => json({ error: { message: `Incorrect API key provided: ${KEY}`, type: 'invalid_request_error', code: 'invalid_api_key' } }, 401));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 2 })));
    expect(err).toMatchObject({ kind: 'auth', status: 401, fatal: true });
    expect(r.calls).toHaveLength(1);
    expect(everything(err)).not.toContain(KEY);
  });

  it('maps 429 insufficient_quota to quota and does not retry it', async () => {
    const r = recorder(() => json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }, 429));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 2 })));
    expect(err).toMatchObject({ kind: 'quota', status: 429, fatal: false });
    expect(r.calls).toHaveLength(1);
  });

  it('maps a plain 429 to rate_limit once the retries are used up', async () => {
    const r = recorder(() => json({ error: { message: 'Rate limit reached for gpt-6.1-sol on requests per min.', type: 'requests', code: 'rate_limit_exceeded' } }, 429));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 2 })));
    expect(err).toMatchObject({ kind: 'rate_limit', status: 429 });
    expect(r.calls).toHaveLength(3);
  });

  it('maps a 404 about the model to model (fatal)', async () => {
    const r = recorder(() => json({ error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } }, 404));
    const err = await fail(ask(engine(r.fetchImpl, { model: 'gpt-9' })));
    expect(err).toMatchObject({ kind: 'model', fatal: true });
    expect(r.calls).toHaveLength(1);
  });

  it('retries a 500 and succeeds on the second try', async () => {
    const r = recorder((_c, n) => (n === 1 ? json({ error: { message: 'The server had an error while processing your request.' } }, 500) : json(REPLY)));
    const answer = await ask(engine(r.fetchImpl, { retries: 2 }));
    expect(answer.citations).toHaveLength(2);
    expect(r.calls).toHaveLength(2);
  });

  it('maps a network error to unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await fail(ask(engine(fetchImpl)))).toMatchObject({ kind: 'unavailable', fatal: false });
  });

  it('maps a timeout to unavailable', async () => {
    const hang = (_url: string, init: RequestInit = {}) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('x', 'TimeoutError'))));
    expect(await fail(ask(engine(hang, { timeoutMs: 20 })))).toMatchObject({ kind: 'unavailable' });
  });

  it('maps an invalid JSON body to bad_response', async () => {
    const r = recorder(() => new Response('<html>oops</html>', { status: 200 }));
    expect(await fail(ask(engine(r.fetchImpl)))).toMatchObject({ kind: 'bad_response' });
  });

  it('maps an aborted signal to aborted (fatal)', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = recorder(() => json(REPLY));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION, signal: controller.signal }));
    expect(err).toMatchObject({ kind: 'aborted', fatal: true });
    expect(r.calls).toHaveLength(0);
  });

  it('never lets the key into any message, even when the vendor echoes it', async () => {
    const bodies = [
      { error: { message: `Invalid request: authorization header "Bearer ${KEY}" rejected`, type: 'invalid_request_error' } },
      { error: { message: `bad param ${KEY}`, param: KEY, code: KEY } },
    ];
    for (const body of bodies) {
      const r = recorder(() => json(body, 400));
      const err = await fail(ask(engine(r.fetchImpl)));
      expect(err.kind).toBe('bad_response');
      expect(err.message).toContain('***');
      expect(everything(err)).not.toContain(KEY);
    }
    for (const status of [403, 404, 429, 500]) {
      const r = recorder(() => json({ error: { message: `echo ${KEY}` } }, status));
      expect(everything(await fail(ask(engine(r.fetchImpl))))).not.toContain(KEY);
    }
  });

  it('writes its messages in Bulgarian', async () => {
    const r = recorder(() => json({}, 401));
    expect((await fail(ask(engine(r.fetchImpl)))).message).toMatch(/ChatGPT.*отхвърли API ключа/);
  });
});

describe('OpenAiEngine.generate', () => {
  it('sends the documented body: instructions, input, max_output_tokens, reasoning and store', async () => {
    const r = recorder(() => json(textReply('Готово.')));
    const result = await engine(r.fetchImpl).generate({ system: 'Be brief.', prompt: 'Write a title.', maxTokens: 1200 });
    expect(r.calls[0]!.url).toBe(URL_);
    expect(r.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.calls[0]!.body).toEqual({ model: MODEL, instructions: 'Be brief.', input: 'Write a title.', max_output_tokens: 1200, reasoning: { effort: 'low' }, store: false });
    expect(result).toEqual({ text: 'Готово.', usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it('defaults to 2000 tokens, leaves out `instructions` without a system prompt, and uses no tools', async () => {
    const r = recorder(() => json(textReply('x')));
    await engine(r.fetchImpl).generate({ prompt: 'p' });
    expect(r.calls[0]!.body).toEqual({ model: MODEL, input: 'p', max_output_tokens: 2000, reasoning: { effort: 'low' }, store: false });
  });

  it('asks for JSON mode when the prompt wants JSON only', async () => {
    const r = recorder(() => json(textReply('{"ok":true}')));
    await engine(r.fetchImpl).generate({ prompt: 'p', json: true });
    expect(r.calls[0]!.body.text).toEqual({ format: { type: 'json_object' } });
    const plain = recorder(() => json(textReply('x')));
    await engine(plain.fetchImpl).generate({ prompt: 'p', json: false });
    expect('text' in plain.calls[0]!.body).toBe(false);
  });

  it('does not cap a long text at the answer limit', async () => {
    const r = recorder(() => json(textReply('y'.repeat(15_000))));
    expect((await engine(r.fetchImpl).generate({ prompt: 'p' })).text).toHaveLength(15_000);
  });

  it('throws bad_response for an empty generation, and says why when the API did', async () => {
    const empty = recorder(() => json({ status: 'completed', output: [] }));
    expect(await fail(engine(empty.fetchImpl).generate({ prompt: 'p' }))).toMatchObject({ kind: 'bad_response' });
    const cut = recorder(() => json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
    expect((await fail(engine(cut.fetchImpl).generate({ prompt: 'p' }))).message).toContain('max_output_tokens');
    const refusal = recorder(() => json({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }));
    expect(await fail(engine(refusal.fetchImpl).generate({ prompt: 'p' }))).toMatchObject({ kind: 'refused' });
  });

  it('passes the caller\'s signal and maps errors like ask()', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = recorder(() => json(textReply('x')));
    expect(await fail(engine(r.fetchImpl).generate({ prompt: 'p', signal: controller.signal }))).toMatchObject({ kind: 'aborted' });
    const unauthorized = recorder(() => json({}, 401));
    expect(await fail(engine(unauthorized.fetchImpl).generate({ prompt: 'p' }))).toMatchObject({ kind: 'auth' });
  });
});

describe('OpenAiEngine identity', () => {
  it('is ChatGPT, with the configured model', () => {
    const e = new OpenAiEngine({ apiKey: KEY, model: 'gpt-6-luna' });
    expect(e).toMatchObject({ id: 'openai', label: 'ChatGPT', model: 'gpt-6-luna' });
  });

  it('trims the key it is given (a pasted newline would make the header invalid)', async () => {
    const r = recorder(() => json(textReply('x')));
    await new OpenAiEngine({ apiKey: `  ${KEY}\n`, model: MODEL }, { fetchImpl: r.fetchImpl, retries: 0 }).generate({ prompt: 'p' });
    expect(r.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});
