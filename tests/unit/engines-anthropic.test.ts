import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicCaps, AnthropicEngine } from '../../src/server/geo/engines/anthropic';
import type { AskOptions, EngineError } from '../../src/server/geo/engines/types';

const KEY = 'sk-ant-api03-Anthropic0123456789abcdef';
const URL_ = 'https://api.anthropic.com/v1/messages';
const LOCATION: AskOptions['location'] = { country: 'BG', timezone: 'Europe/Sofia' };
const QUESTION = 'Кои са най-добрите фирми за изработка на уебсайт?';
const SOFIA_TOOL = { name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'BG', timezone: 'Europe/Sofia' } };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A reply to a failed request, in the shape the Messages API uses. `retry-after-ms: 1` keeps the SDK's own retries from sleeping. */
const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  json({ type: 'error', error: { type, message } }, status, { 'retry-after-ms': '1', ...headers });

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
  new AnthropicEngine({ apiKey: KEY, model: over.model ?? 'claude-opus-5-5' }, { fetchImpl, retries: over.retries ?? 0, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}) });

const fail = (promise: Promise<unknown>): Promise<EngineError> => promise.then(() => Promise.reject(new Error('expected a rejection')), (e: unknown) => e as EngineError);

function everything(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e !== undefined && e !== null; e = e instanceof Error ? e.cause : undefined) {
    if (e instanceof Error) parts.push(e.name, e.message, e.stack ?? '');
    parts.push(JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
  }
  return parts.join('\n');
}

// ───────────────────────── replies, shaped like the Messages API's ─────────────────────────

const usage = (input = 100, output = 50, searches?: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...(searches === undefined ? {} : { server_tool_use: { web_search_requests: searches } }),
});

function message(content: unknown[], over: Record<string, unknown> = {}) {
  return { id: 'msg_01Abc', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: 'end_turn', stop_sequence: null, usage: usage(), ...over };
}

const text = (t: string, citations: unknown[] | null = null) => ({ type: 'text', text: t, citations });
const cites = (url: string, title: string | null) => ({ type: 'web_search_result_location', url, title, cited_text: 'a quote from the page', encrypted_index: 'idx' });
const search = (id: string, query: string) => ({ type: 'server_tool_use', id, name: 'web_search', input: { query }, caller: { type: 'direct' } });
const found = (id: string, pages: Array<[string, string]>) => ({
  type: 'web_search_tool_result',
  tool_use_id: id,
  content: pages.map(([url, title]) => ({ type: 'web_search_result', url, title, page_age: null, encrypted_content: 'ZW5j' })),
  caller: { type: 'direct' },
});
const searchFailed = (id: string, code: string) => ({ type: 'web_search_tool_result', tool_use_id: id, content: { type: 'web_search_tool_result_error', error_code: code }, caller: { type: 'direct' } });
const thinking = { type: 'thinking', thinking: 'The user wants agencies. Let me search.', signature: 'c2ln' };

/** A whole answer: thinking, a search with two results, and text whose citations point at the first. */
const ANSWER = message(
  [
    thinking,
    text('Ще потърся.'),
    search('srvtoolu_1', 'най-добри фирми за уебсайт'),
    found('srvtoolu_1', [
      ['https://a-studio.example/uslugi', 'A Studio - услуги'],
      ['https://b-agency.example/', 'B Agency'],
    ]),
    text('Според '),
    text('A Studio', [cites('https://a-studio.example/uslugi', 'A Studio - услуги')]),
    text(' и '),
    text('A Studio отново', [cites('https://a-studio.example/uslugi', 'A Studio - услуги'), cites('https://c-guide.example/post', 'Ръководство')]),
    text(' най-добри са те.'),
  ],
  { model: 'claude-opus-5-5-20261001', usage: usage(1000, 300, 1) },
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('anthropicCaps', () => {
  it.each([
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-fable-5-20260801',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-opus-5-5-20261001', // a dated snapshot of a current model
    'claude-sonnet-5-latest',
    'CLAUDE-OPUS-5-5',
    ' claude-opus-5-5 ',
  ])('%s takes the newer web search tool and output_config.effort', (model) => {
    expect(anthropicCaps(model)).toEqual({ searchTool: 'web_search_20260209', effort: true });
  });

  it.each([
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5',
    'claude-opus-4-1',
    'claude-opus-50', // not claude-opus-5
    'claude-opus-5-6', // an unknown newcomer gets the conservative treatment
    'claude-fable-50',
    'claude-mythos-5',
    'claude-3-5-sonnet-latest',
    'gpt-6.1-sol',
    '',
  ])('%s takes the original tool and no output_config', (model) => {
    expect(anthropicCaps(model)).toEqual({ searchTool: 'web_search_20250305', effort: false });
  });
});

describe('AnthropicEngine.ask: the request', () => {
  it('sends the documented Messages request for a current model: the newer tool, the location and effort low', async () => {
    const r = recorder(() => json(ANSWER));
    await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.url).toBe(URL_);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(call.headers['x-api-key']).toBe(KEY);
    expect(call.headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: QUESTION }], // the question exactly as typed, nothing else
      tools: [{ type: 'web_search_20260209', ...SOFIA_TOOL }],
      output_config: { effort: 'low' },
    });
  });

  it('uses the original tool and no output_config for a model that does not take them', async () => {
    const r = recorder(() => json(ANSWER));
    await engine(r.fetchImpl, { model: 'claude-haiku-4-5' }).ask(QUESTION, { location: { country: 'GB', timezone: 'Europe/London' } });
    expect(r.calls[0]!.body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: QUESTION }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'GB', timezone: 'Europe/London' } }],
    });
    expect('output_config' in r.calls[0]!.body).toBe(false);
  });

  it.each([
    ['claude-fable-5', 'web_search_20260209', true],
    ['claude-opus-4-6', 'web_search_20260209', true],
    ['claude-sonnet-4-6', 'web_search_20260209', true],
    ['claude-sonnet-4-5', 'web_search_20250305', false],
    ['claude-haiku-4-5-20251001', 'web_search_20250305', false],
  ])('%s: tool %s, effort %s', async (model, tool, effort) => {
    const r = recorder(() => json(ANSWER));
    await engine(r.fetchImpl, { model }).ask(QUESTION, { location: LOCATION });
    expect((r.calls[0]!.body.tools as Array<{ type: string }>)[0]?.type).toBe(tool);
    expect('output_config' in r.calls[0]!.body).toBe(effort);
  });

  it('never sends what newer models reject: thinking, sampling parameters, a forced tool_choice, a prefill or a system prompt', async () => {
    for (const model of ['claude-opus-5-5', 'claude-haiku-4-5']) {
      const r = recorder(() => json(ANSWER));
      await engine(r.fetchImpl, { model }).ask(QUESTION, { location: LOCATION });
      const body = r.calls[0]!.body;
      for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'system', 'stop_sequences', 'metadata']) expect(key in body).toBe(false);
      const messages = body.messages as Array<{ role: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user'); // no assistant turn to prefill
    }
  });

  it('sends the country code in capitals even when it is handed in as a Google `gl`', async () => {
    const r = recorder(() => json(ANSWER));
    await engine(r.fetchImpl).ask(QUESTION, { location: { country: 'bg', timezone: 'Europe/Sofia' } });
    expect((r.calls[0]!.body.tools as Array<{ user_location: unknown }>)[0]?.user_location).toEqual({ type: 'approximate', country: 'BG', timezone: 'Europe/Sofia' });
  });

  it('ignores ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from the environment', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token-123456');
    const r = recorder(() => json(ANSWER));
    await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls[0]!.url).toBe(URL_);
    expect('authorization' in r.calls[0]!.headers).toBe(false);
    expect(r.calls[0]!.headers['x-api-key']).toBe(KEY);
  });

  it('trims the key it is given', async () => {
    const r = recorder(() => json(ANSWER));
    await new AnthropicEngine({ apiKey: `  ${KEY}\n`, model: 'claude-opus-5-5' }, { fetchImpl: r.fetchImpl, retries: 0 }).ask(QUESTION, { location: LOCATION });
    expect(r.calls[0]!.headers['x-api-key']).toBe(KEY);
  });
});

describe('AnthropicEngine.ask: the answer', () => {
  it('reads the text, the cited and the merely consulted sources, the queries and the usage', async () => {
    const r = recorder(() => json(ANSWER));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toBe('Ще потърся.\n\nСпоред A Studio и A Studio отново най-добри са те.'); // the narration before the search is kept apart
    expect(answer.citations).toEqual([
      { url: 'https://a-studio.example/uslugi', title: 'A Studio - услуги', domain: 'a-studio.example' },
      { url: 'https://c-guide.example/post', title: 'Ръководство', domain: 'c-guide.example' },
    ]);
    // consulted: retrieved, not cited (a-studio was cited, so only b-agency is left)
    expect(answer.consulted).toEqual([{ url: 'https://b-agency.example/', title: 'B Agency', domain: 'b-agency.example' }]);
    expect(answer.searched).toBe(true);
    expect(answer.queries).toEqual(['най-добри фирми за уебсайт']);
    expect(answer.usage).toEqual({ inputTokens: 1000, outputTokens: 300, searches: 1 });
    expect(answer.model).toBe('claude-opus-5-5-20261001');
    expect(answer.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(answer.latencyMs)).toBe(true);
  });

  it('ignores thinking blocks (their text never reaches the answer)', async () => {
    const r = recorder(() => json(message([thinking, { type: 'redacted_thinking', data: 'ZGF0YQ==' }, text('Само отговорът.')])));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Само отговорът.');
  });

  it('counts searches from usage.server_tool_use, and from the blocks when usage does not say', async () => {
    const blocks = [search('s1', 'a'), found('s1', [['https://a.example/', 'A']]), search('s2', 'b'), found('s2', [['https://b.example/', 'B']]), text('t')];
    const said = recorder(() => json(message(blocks, { usage: usage(10, 5, 7) })));
    expect((await engine(said.fetchImpl).ask(QUESTION, { location: LOCATION })).usage.searches).toBe(7);
    const silent = recorder(() => json(message(blocks, { usage: usage(10, 5) })));
    const answer = await engine(silent.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.usage).toEqual({ inputTokens: 10, outputTokens: 5, searches: 2 });
    expect(answer.queries).toEqual(['a', 'b']);
  });

  it('says searched = false (and no queries) when the model answered without searching', async () => {
    const r = recorder(() => json(message([text('Отговор по памет.')], { usage: usage(10, 5, 0) })));
    expect(await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).toMatchObject({ text: 'Отговор по памет.', searched: false, citations: [], consulted: [], queries: [], usage: { searches: 0 } });
  });

  it('does not count other server tools as searches', async () => {
    const other = { type: 'server_tool_use', id: 'x', name: 'code_execution', input: { code: 'print(1)' }, caller: { type: 'direct' } };
    const r = recorder(() => json(message([other, text('t')], { usage: usage(1, 1) })));
    expect(await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).toMatchObject({ searched: false, queries: [], usage: { searches: 0 } });
  });

  it('keeps citations that point at documents (not the web) out of the answer', async () => {
    const r = recorder(() => json(message([text('t', [{ type: 'char_location', cited_text: 'x', document_index: 0, document_title: 'Doc', start_char_index: 0, end_char_index: 1 }, cites('https://ok.example/', null)])])));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.citations).toEqual([{ url: 'https://ok.example/', title: '', domain: 'ok.example' }]);
  });

  it('caps the text, the citations, the consulted sources and the queries', async () => {
    const many = Array.from({ length: 45 }, (_v, i) => i);
    const blocks = [
      ...many.flatMap((i) => (i < 12 ? [search(`s${i}`, `query ${i}`)] : [])),
      found('s0', many.map((i) => [`https://src${i}.example/`, `S${i}`] as [string, string])),
      text('x'.repeat(20_000), many.map((i) => cites(`https://cite${i}.example/p`, `C${i}`))),
    ];
    const r = recorder(() => json(message(blocks)));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toHaveLength(12_000);
    expect(answer.citations).toHaveLength(30);
    expect(answer.consulted).toHaveLength(30);
    expect(answer.queries).toHaveLength(10);
  });

  it('puts a paragraph break only where text would otherwise run on from before a search', async () => {
    const r = recorder(() => json(message([text('Първо изречение.'), search('s', 'q'), found('s', []), text('Второ изречение.'), text(' Трето.')])));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Първо изречение.\n\nВторо изречение. Трето.');
    const spaced = recorder(() => json(message([text('Ще проверя: '), search('s', 'q'), found('s', []), text('ето.')])));
    expect((await engine(spaced.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Ще проверя: ето.');
  });
});

describe('AnthropicEngine.ask: a search that failed', () => {
  it('does not crash on a web_search_tool_result_error: it arrives with HTTP 200, as an object instead of the result list', async () => {
    const r = recorder(() => json(message([search('s1', 'q'), searchFailed('s1', 'max_uses_exceeded'), text('Отговор без резултати.')], { usage: usage(10, 5, 1) })));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toBe('Отговор без резултати.');
    expect(answer.consulted).toEqual([]);
    expect(answer.queries).toEqual(['q']);
    expect(answer.usage.searches).toBe(1);
    expect(answer.searched).toBe(false); // the only search came back as an error: nothing from the web went into the answer
  });

  it.each(['max_uses_exceeded', 'too_many_requests', 'unavailable', 'invalid_tool_input', 'query_too_long', 'request_too_large', 'some_new_code'])('carries on after the error code %s', async (code) => {
    const r = recorder(() => json(message([search('s1', 'ok'), found('s1', [['https://a.example/', 'A']]), search('s2', 'bad'), searchFailed('s2', code), text('Готово.', [cites('https://a.example/', 'A')])])));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer).toMatchObject({ text: 'Готово.', searched: true, queries: ['ok', 'bad'] });
    expect(answer.citations).toHaveLength(1);
  });

  it('counts a search with an empty result list as a search that ran', async () => {
    const r = recorder(() => json(message([search('s1', 'q'), found('s1', []), text('Нищо не се намери.')])));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).searched).toBe(true);
  });
});

describe('AnthropicEngine.ask: a turn that pauses (pause_turn)', () => {
  const first = message([text('Търся… '), search('s1', 'цена уебсайт'), found('s1', [['https://a.example/x', 'A'], ['https://c.example/z', 'C']])], {
    stop_reason: 'pause_turn',
    usage: usage(500, 80, 1),
  });
  const second = message([text('Според '), text('A', [cites('https://a.example/x', 'A')]), text(' е така.', [cites('https://b.example/y', 'B')])], { usage: usage(700, 120, 0) });

  it('resumes by sending the paused turn back as an assistant turn — and no extra user turn — then merges everything', async () => {
    const r = recorder((_c, n) => json(n === 1 ? first : second));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(2);
    const [one, two] = [r.calls[0]!.body, r.calls[1]!.body];
    expect(one.messages).toEqual([{ role: 'user', content: QUESTION }]);
    // the second request: the user's question, then the paused turn as it came — and nothing after it
    expect(two.messages).toEqual([
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: JSON.parse(JSON.stringify(first.content)) },
    ]);
    expect((two.messages as unknown[]).length).toBe(2);
    expect({ ...two, messages: undefined }).toEqual({ ...one, messages: undefined }); // same model, tools and limits
    // merged
    expect(answer.text).toBe('Търся… Според A е така.');
    expect(answer.citations.map((c) => c.domain)).toEqual(['a.example', 'b.example']);
    expect(answer.consulted.map((c) => c.domain)).toEqual(['c.example']);
    expect(answer.usage).toEqual({ inputTokens: 1200, outputTokens: 200, searches: 1 });
    expect(answer.queries).toEqual(['цена уебсайт']);
    expect(answer.searched).toBe(true);
  });

  it('keeps accumulating what the assistant produced when the turn pauses more than once', async () => {
    const one = message([text('Едно. '), search('s1', 'a'), found('s1', [['https://a.example/', 'A']])], { stop_reason: 'pause_turn', usage: usage(10, 1, 1) });
    const two = message([text('Две. '), search('s2', 'b'), found('s2', [['https://b.example/', 'B']])], { stop_reason: 'pause_turn', usage: usage(20, 2, 1) });
    const three = message([text('Три.')], { usage: usage(30, 3, 0) });
    const r = recorder((_c, n) => json([one, two, three][n - 1]));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(3);
    const third = r.calls[2]!.body.messages as Array<{ role: string; content: unknown[] }>;
    expect(third).toHaveLength(2);
    expect(third[1]?.role).toBe('assistant');
    expect(third[1]?.content).toEqual(JSON.parse(JSON.stringify([...one.content, ...two.content])));
    expect(answer.text).toBe('Едно. Две. Три.');
    expect(answer.usage).toEqual({ inputTokens: 60, outputTokens: 6, searches: 2 });
    expect(answer.queries).toEqual(['a', 'b']);
  });

  it('keeps a paragraph break across the pause when the turn stopped right after a search', async () => {
    const stopped = message([text('Ще проверя.'), search('s1', 'a'), found('s1', [])], { stop_reason: 'pause_turn' });
    const done = message([text('Ето отговора.')]);
    const r = recorder((_c, n) => json(n === 1 ? stopped : done));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Ще проверя.\n\nЕто отговора.');
  });

  it('resumes at most three times, then returns what it has', async () => {
    const r = recorder(() => json(message([text('Още. ')], { stop_reason: 'pause_turn' })));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(4); // the first request and three resumes
    expect(answer.text).toBe('Още. Още. Още. Още.');
  });

  it('reports a bad_response when it is still paused after the last resume and has no text', async () => {
    const r = recorder(() => json(message([search('s', 'q'), found('s', [])], { stop_reason: 'pause_turn' })));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err).toMatchObject({ kind: 'bad_response' });
    expect(r.calls).toHaveLength(4);
  });

  it('does not resume a turn that ended normally', async () => {
    const r = recorder(() => json(ANSWER));
    await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(r.calls).toHaveLength(1);
  });

  it('passes the signal and the timeout to every leg, and fails the whole call if a later leg fails', async () => {
    const r = recorder((_c, n) => (n === 1 ? json(first) : apiError(401, 'authentication_error', 'invalid x-api-key')));
    expect(await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }))).toMatchObject({ kind: 'auth' });
    expect(r.calls).toHaveLength(2);
  });
});

describe('AnthropicEngine.ask: stops that are not a normal ending', () => {
  it('reports a refusal as refused, with the message the pipeline shows', async () => {
    const r = recorder(() => json(message([text('')], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null } })));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err).toMatchObject({ kind: 'refused', fatal: false, message: 'Claude отказа да отговори на този въпрос.' });
  });

  it('reports a refusal even when some text came before it, and one that comes after a pause', async () => {
    const partial = recorder(() => json(message([text('Начало')], { stop_reason: 'refusal' })));
    expect(await fail(engine(partial.fetchImpl).ask(QUESTION, { location: LOCATION }))).toMatchObject({ kind: 'refused' });
    const later = recorder((_c, n) => json(n === 1 ? message([text('a')], { stop_reason: 'pause_turn' }) : message([], { stop_reason: 'refusal' })));
    expect(await fail(engine(later.fetchImpl).ask(QUESTION, { location: LOCATION }))).toMatchObject({ kind: 'refused' });
  });

  it('reports max_tokens without any text as bad_response (thinking used up the budget)', async () => {
    const r = recorder(() => json(message([thinking], { stop_reason: 'max_tokens' })));
    const err = await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }));
    expect(err).toMatchObject({ kind: 'bad_response', fatal: false });
    expect(err.message).toContain('токените');
  });

  it('keeps the text of an answer that was cut off by max_tokens', async () => {
    const r = recorder(() => json(message([text('Началото на отговора')], { stop_reason: 'max_tokens' })));
    expect((await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION })).text).toBe('Началото на отговора');
  });

  it('reports a reply with no text at all as bad_response, and an odd 200 that is not a message', async () => {
    const empty = recorder(() => json(message([])));
    expect(await fail(engine(empty.fetchImpl).ask(QUESTION, { location: LOCATION }))).toMatchObject({ kind: 'bad_response' });
    for (const odd of [{}, { content: 'nope' }, [], 'text', null]) {
      const r = recorder(() => json(odd));
      expect(await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION }))).toMatchObject({ kind: 'bad_response' });
    }
    const plain = recorder(() => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    expect(await fail(engine(plain.fetchImpl).ask(QUESTION, { location: LOCATION }))).toMatchObject({ kind: 'bad_response' });
  });

  it('skips entries that are not objects: blocks, citations, search results', async () => {
    const r = recorder(() =>
      json({
        type: 'message',
        role: 'assistant',
        content: [null, 7, 'x', text('Текст', [null, 'x', cites('https://ok.example/', 'OK')]), { type: 'web_search_tool_result', content: [null, 3, { type: 'web_search_result', url: 'https://found.example/', title: 'F' }] }],
      }),
    );
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toBe('Текст');
    expect(answer.citations.map((c) => c.domain)).toEqual(['ok.example']);
    expect(answer.consulted.map((c) => c.domain)).toEqual(['found.example']);
  });

  it('tolerates blocks it does not know and fields that are missing', async () => {
    const r = recorder(() => json({ type: 'message', role: 'assistant', content: [{ type: 'brand_new_block', x: 1 }, { type: 'text', text: 'Текст' }, { type: 'server_tool_use', name: 'web_search' }, { type: 'web_search_tool_result' }] }));
    const answer = await engine(r.fetchImpl).ask(QUESTION, { location: LOCATION });
    expect(answer.text).toBe('Текст');
    expect(answer.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(answer.model).toBe('claude-opus-5-5');
  });
});

describe('AnthropicEngine: errors, mapped by the SDK\'s error classes', () => {
  const ask = (e: AnthropicEngine) => e.ask(QUESTION, { location: LOCATION });

  it.each([
    [401, 'authentication_error', 'invalid x-api-key'],
    [403, 'permission_error', 'Your API key does not have permission to use the specified resource.'],
  ])('maps %i to auth (fatal) without retrying', async (status, type, said) => {
    const r = recorder(() => apiError(status, type, said));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 2 })));
    expect(err).toMatchObject({ kind: 'auth', status, fatal: true });
    expect(r.calls).toHaveLength(1);
  });

  it('maps 404 to model (fatal)', async () => {
    const r = recorder(() => apiError(404, 'not_found_error', 'model: claude-nope'));
    const err = await fail(ask(engine(r.fetchImpl, { model: 'claude-nope' })));
    expect(err).toMatchObject({ kind: 'model', status: 404, fatal: true });
    expect(err.message).toContain('claude-nope');
  });

  it('maps 429 to rate_limit once the SDK\'s retries are used up', async () => {
    const r = recorder(() => apiError(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit.'));
    const err = await fail(ask(engine(r.fetchImpl, { retries: 2 })));
    expect(err).toMatchObject({ kind: 'rate_limit', status: 429, fatal: false });
    expect(r.calls).toHaveLength(3);
  });

  it('maps a 429 about credit or billing to quota', async () => {
    const r = recorder(() => apiError(429, 'rate_limit_error', 'Your account has insufficient credit. Please add credit under Plans & Billing.'));
    expect(await fail(ask(engine(r.fetchImpl)))).toMatchObject({ kind: 'quota', status: 429, fatal: false });
  });

  it('maps the 400 the API uses for an empty account to quota as well', async () => {
    const r = recorder(() => apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'));
    expect(await fail(ask(engine(r.fetchImpl)))).toMatchObject({ kind: 'quota', status: 400 });
  });

  it('maps any other 400 to bad_response, quoting the API\'s message', async () => {
    const r = recorder(() => apiError(400, 'invalid_request_error', 'tools.0.web_search_20260209.max_uses: Input should be a valid integer'));
    const err = await fail(ask(engine(r.fetchImpl)));
    expect(err).toMatchObject({ kind: 'bad_response', status: 400 });
    expect(err.message).toContain('Claude върна 400: tools.0.web_search_20260209.max_uses');
  });

  it.each([
    [500, 'api_error', 'Internal server error'],
    [502, 'api_error', 'Bad gateway'],
    [529, 'overloaded_error', 'Overloaded'],
  ])('maps %i to unavailable', async (status, type, said) => {
    const r = recorder(() => apiError(status, type, said));
    const err = await fail(ask(engine(r.fetchImpl)));
    expect(err).toMatchObject({ kind: 'unavailable', status, fatal: false });
  });

  it('maps other client errors (413, 422, 409) to bad_response', async () => {
    for (const status of [413, 422, 409]) {
      const r = recorder(() => apiError(status, 'invalid_request_error', 'something is off'));
      const err = await fail(ask(engine(r.fetchImpl)));
      expect(err.kind).toBe('bad_response');
    }
  });

  it('retries a 500 and succeeds on the second try', async () => {
    const r = recorder((_c, n) => (n === 1 ? apiError(500, 'api_error', 'Internal server error') : json(ANSWER)));
    const answer = await ask(engine(r.fetchImpl, { retries: 2 }));
    expect(answer.citations).toHaveLength(2);
    expect(r.calls).toHaveLength(2);
  });

  it('retries a 429 and succeeds on the second try', async () => {
    const r = recorder((_c, n) => (n === 1 ? apiError(429, 'rate_limit_error', 'slow down') : json(ANSWER)));
    await ask(engine(r.fetchImpl, { retries: 1 }));
    expect(r.calls).toHaveLength(2);
  });

  it('does not retry what is not transient', async () => {
    const r = recorder(() => apiError(400, 'invalid_request_error', 'nope'));
    await fail(ask(engine(r.fetchImpl, { retries: 3 })));
    expect(r.calls).toHaveLength(1);
  });

  it('maps a network error to unavailable', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.1:443') });
    });
    const err = await fail(ask(engine(down)));
    expect(err).toMatchObject({ kind: 'unavailable', fatal: false });
    expect(down).toHaveBeenCalledTimes(1);
  });

  it('maps a timeout to unavailable', async () => {
    const hang = (_url: string, init: RequestInit = {}) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))));
    const err = await fail(ask(engine(hang, { timeoutMs: 30 })));
    expect(err).toMatchObject({ kind: 'unavailable', fatal: false });
    expect(err.message).toContain('отговорът се забави');
  });

  it('maps an invalid JSON body to bad_response', async () => {
    const r = recorder(() => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await fail(ask(engine(r.fetchImpl)))).toMatchObject({ kind: 'bad_response' });
  });

  it('maps an aborted signal to aborted (fatal): before the call and during it', async () => {
    const before = new AbortController();
    before.abort();
    const r = recorder(() => json(ANSWER));
    expect(await fail(engine(r.fetchImpl).ask(QUESTION, { location: LOCATION, signal: before.signal }))).toMatchObject({ kind: 'aborted', fatal: true });
    expect(r.calls).toHaveLength(0);

    const during = new AbortController();
    const hang = (_url: string, init: RequestInit = {}) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))));
    const pending = fail(engine(hang).ask(QUESTION, { location: LOCATION, signal: during.signal }));
    setTimeout(() => during.abort(), 10);
    expect(await pending).toMatchObject({ kind: 'aborted', fatal: true });
  });

  it('stops retrying when the caller aborts while the SDK waits to retry', async () => {
    const controller = new AbortController();
    const r = recorder(() => apiError(503, 'api_error', 'busy', { 'retry-after': '5', 'retry-after-ms': '' }));
    const pending = fail(engine(r.fetchImpl, { retries: 2 }).ask(QUESTION, { location: LOCATION, signal: controller.signal }));
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    expect(await pending).toMatchObject({ kind: 'aborted' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('never lets the key into an error, even when the API echoes it', async () => {
    const cases: Array<[number, string]> = [
      [400, 'invalid_request_error'],
      [401, 'authentication_error'],
      [403, 'permission_error'],
      [404, 'not_found_error'],
      [429, 'rate_limit_error'],
      [500, 'api_error'],
      [413, 'request_too_large'],
    ];
    for (const [status, type] of cases) {
      const r = recorder(() => apiError(status, type, `bad x-api-key ${KEY} in request`));
      const err = await fail(ask(engine(r.fetchImpl)));
      expect(err).toBeInstanceOf(Error);
      expect(everything(err)).not.toContain(KEY);
    }
    const down = async () => {
      throw new TypeError(`request to https://api.anthropic.com failed for key ${KEY}`, { cause: new Error(`inner ${KEY}`) });
    };
    expect(everything(await fail(ask(engine(down))))).not.toContain(KEY);
    const odd = recorder(() => new Response(`{"oops": ${KEY}`, { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(everything(await fail(ask(engine(odd.fetchImpl))))).not.toContain(KEY);
  });

  it('quotes the API\'s message after blanking the key, so a 400 that echoes it still says what was wrong', async () => {
    const r = recorder(() => apiError(400, 'invalid_request_error', `header x-api-key=${KEY} is malformed`));
    const err = await fail(ask(engine(r.fetchImpl)));
    expect(err.message).toContain('is malformed');
    expect(err.message).toContain('***');
  });

  it('writes its messages in Bulgarian', async () => {
    const r = recorder(() => apiError(401, 'authentication_error', 'invalid x-api-key'));
    expect((await fail(ask(engine(r.fetchImpl)))).message).toMatch(/Claude.*отхвърли API ключа/);
  });
});

describe('AnthropicEngine.generate', () => {
  const reply = message([thinking, text('Готово.')], { usage: usage(30, 9) });

  it('sends a plain request for a current model: no tools, effort medium, 4000 tokens of room for thinking', async () => {
    const r = recorder(() => json(reply));
    const result = await engine(r.fetchImpl).generate({ system: 'Be brief.', prompt: 'Write a title.', maxTokens: 1200 });
    expect(r.calls[0]!.url).toBe(URL_);
    expect(r.calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(r.calls[0]!.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 5200,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Write a title.' }],
      output_config: { effort: 'medium' },
    });
    expect(result).toEqual({ text: 'Готово.', usage: { inputTokens: 30, outputTokens: 9 } });
  });

  it('defaults to 2000 tokens (plus the room for thinking) and leaves out `system` without a system prompt', async () => {
    const r = recorder(() => json(reply));
    await engine(r.fetchImpl).generate({ prompt: 'p' });
    expect(r.calls[0]!.body).toEqual({ model: 'claude-opus-5-5', max_tokens: 6000, messages: [{ role: 'user', content: 'p' }], output_config: { effort: 'medium' } });
  });

  it('sends neither effort nor extra room to a model that does not think by default', async () => {
    const r = recorder(() => json(reply));
    await engine(r.fetchImpl, { model: 'claude-haiku-4-5' }).generate({ prompt: 'p', maxTokens: 700 });
    expect(r.calls[0]!.body).toEqual({ model: 'claude-haiku-4-5', max_tokens: 700, messages: [{ role: 'user', content: 'p' }] });
  });

  it('has no JSON mode: `json` changes nothing in the request, the prompt has to ask for it', async () => {
    const plain = recorder(() => json(reply));
    const wantJson = recorder(() => json(reply));
    await engine(plain.fetchImpl).generate({ prompt: 'p' });
    await engine(wantJson.fetchImpl).generate({ prompt: 'p', json: true });
    expect(wantJson.calls[0]!.body).toEqual(plain.calls[0]!.body);
  });

  it('never sends the forbidden fields', async () => {
    const r = recorder(() => json(reply));
    await engine(r.fetchImpl).generate({ system: 's', prompt: 'p', json: true });
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools']) expect(key in r.calls[0]!.body).toBe(false);
  });

  it('does not cap a long text at the answer limit', async () => {
    const r = recorder(() => json(message([text('y'.repeat(15_000))])));
    expect((await engine(r.fetchImpl).generate({ prompt: 'p' })).text).toHaveLength(15_000);
  });

  it('reports a refusal, an empty reply and max_tokens without text; passes the signal; maps errors', async () => {
    const refused = recorder(() => json(message([], { stop_reason: 'refusal' })));
    expect(await fail(engine(refused.fetchImpl).generate({ prompt: 'p' }))).toMatchObject({ kind: 'refused' });
    const empty = recorder(() => json(message([thinking], { stop_reason: 'max_tokens' })));
    expect(await fail(engine(empty.fetchImpl).generate({ prompt: 'p' }))).toMatchObject({ kind: 'bad_response' });
    const controller = new AbortController();
    controller.abort();
    const ok = recorder(() => json(reply));
    expect(await fail(engine(ok.fetchImpl).generate({ prompt: 'p', signal: controller.signal }))).toMatchObject({ kind: 'aborted' });
    const denied = recorder(() => apiError(401, 'authentication_error', 'invalid x-api-key'));
    expect(await fail(engine(denied.fetchImpl).generate({ prompt: 'p' }))).toMatchObject({ kind: 'auth' });
  });
});

describe('AnthropicEngine identity', () => {
  it('is Claude, with the configured model', () => {
    expect(new AnthropicEngine({ apiKey: KEY, model: 'claude-sonnet-5' })).toMatchObject({ id: 'anthropic', label: 'Claude', model: 'claude-sonnet-5' });
  });

  it('keeps the key out of anything that prints or serialises the engine (the SDK client holds it, so the client is private too)', () => {
    const e = new AnthropicEngine({ apiKey: KEY, model: 'claude-opus-5-5' }, { fetchImpl: async () => json({}) });
    expect(inspect(e, { depth: 8, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(e)).not.toContain(KEY);
  });
});
