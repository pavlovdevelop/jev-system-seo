import { APIError, choice, noul, score } from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import { Jev, JevError, choiceConfidence, createSdkTransport, scoreConfidence, toJevError, type SystemOneTransport } from '../../src/server/jev/client';
import type { JevConfig } from '../../src/server/config';

type Req = Parameters<SystemOneTransport['systemOne']>[0];

function fakeTransport(handler: (req: Req) => Record<string, unknown> | Error, usage = { input_tokens: 100, output_tokens: 10 }) {
  const requests: Req[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const transport: SystemOneTransport = {
    async systemOne(req) {
      requests.push(req);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const out = handler(req);
      if (out instanceof Error) throw out;
      return { model: 'jev-test', answers: out, usage };
    },
  };
  return { transport, requests, maxInFlight: () => maxInFlight };
}

const quiet = { warn: () => {}, debug: () => {} };
const jevWith = (transport: SystemOneTransport, extra: Partial<ConstructorParameters<typeof Jev>[0]> = {}) =>
  new Jev({ transport, model: 'jev-test', logger: quiet, ...extra });

describe('answer parsing', () => {
  it('parses and clamps noul answers', async () => {
    const { transport } = fakeTransport(() => ({ a: { type: 'noul', noul: 0.8 }, b: { type: 'noul', noul: 1.0000001 } }));
    const answers = await jevWith(transport).ask('x', { a: noul('A?'), b: noul('B?') });
    expect(answers.a.p).toBe(0.8);
    expect(answers.b.p).toBe(1);
  });

  it('parses choice answers, normalises probabilities and derives the runner-up', async () => {
    const { transport } = fakeTransport(() => ({
      t: { type: 'choice', choice: 'billing', probabilities: { billing: 0.6, technical: 0.3, sales: 0.3 }, confidence: 0.4 },
    }));
    const { t } = await jevWith(transport).ask('x', { t: choice('Team?', { billing: 'b', technical: 't', sales: 's' }) });
    expect(t.value).toBe('billing');
    expect(Object.values(t.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(t.p).toBeCloseTo(0.5, 10);
    expect(t.confidence).toBe(0.4);
    expect(t.runnerUp?.value).toBe('technical');
  });

  it('computes confidence itself when the server omits it', async () => {
    const { transport } = fakeTransport(() => ({ t: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 } } }));
    const { t } = await jevWith(transport).ask('x', { t: choice('?', { a: null, b: null }) });
    expect(t.confidence).toBeCloseTo(choiceConfidence([0.8, 0.2]), 10);
  });

  it('recovers the choice from probabilities when the label is unknown', async () => {
    const { transport } = fakeTransport(() => ({ t: { type: 'choice', choice: 'nonsense', probabilities: { a: 0.1, b: 0.9 } } }));
    const { t } = await jevWith(transport).ask('x', { t: choice('?', { a: null, b: null }) });
    expect(t.value).toBe('b');
  });

  it('parses score answers whether probabilities come as a map or as an array', async () => {
    const q = { s: score('How much?', ['none', 'some', 'lots']) };
    const asMap = fakeTransport(() => ({ s: { type: 'score', score: 1.5, legend: {}, probabilities: { '0': 0, '1': 0.5, '2': 0.5 }, confidence: 0.25 } }));
    const asArray = fakeTransport(() => ({ s: { score: 1.5, probabilities: [0, 0.5, 0.5], confidence: 0.25 } }));
    const a = (await jevWith(asMap.transport).ask('x', q)).s;
    const b = (await jevWith(asArray.transport).ask('x', q)).s;
    for (const s of [a, b]) {
      expect(s.raw).toBe(1.5);
      expect(s.value).toBeCloseTo(0.75, 10);
      expect(s.levels).toBe(3);
      expect(s.probabilities).toEqual([0, 0.5, 0.5]);
    }
  });

  it('rejects malformed answers as bad_response', async () => {
    const { transport } = fakeTransport(() => ({ a: { type: 'noul' } }));
    await expect(jevWith(transport).ask('x', { a: noul('A?') })).rejects.toMatchObject({ kind: 'bad_response' });
    const none = fakeTransport(() => ({}));
    await expect(jevWith(none.transport).ask('x', { a: noul('A?') })).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('confidence formulas (docs.typesafe.ai/confidence)', () => {
  it('matches the documented worked examples', () => {
    expect(choiceConfidence([0.6, 0.3, 0.1])).toBeCloseTo(0.4, 10);
    expect(choiceConfidence([0.6, 0.2, 0.2])).toBeCloseTo(0.4, 10);
    expect(scoreConfidence([0, 0.5, 0.5])).toBeCloseTo(0.25, 10);
    expect(scoreConfidence([0.5, 0, 0.5])).toBeCloseTo(0, 10);
    expect(scoreConfidence([0, 0.57, 0.43])).toBeCloseTo(0.355, 2);
  });
});

describe('debiasing choice order', () => {
  const q = { page_type: choice('Type?', { first: 'f', second: 's', third: 't' }) };

  it('adds a reversed twin question in the same request and averages both distributions', async () => {
    const { transport, requests } = fakeTransport((req) => {
      const forward = Object.keys((req.questions.page_type as { criteria: object }).criteria);
      expect(forward).toEqual(['first', 'second', 'third']);
      return {
        page_type: { type: 'choice', choice: 'first', probabilities: { first: 0.7, second: 0.2, third: 0.1 } },
        page_type__rev: { type: 'choice', choice: 'third', probabilities: { first: 0.1, second: 0.2, third: 0.7 } },
      };
    });
    const { page_type } = await jevWith(transport).ask('state', q, { debias: ['page_type'] });
    expect(requests).toHaveLength(1);
    expect(Object.keys((requests[0]!.questions.page_type__rev as { criteria: object }).criteria)).toEqual(['third', 'second', 'first']);
    expect(page_type.probabilities.first).toBeCloseTo(0.4, 10);
    expect(page_type.probabilities.third).toBeCloseTo(0.4, 10);
    expect(page_type.probabilities.second).toBeCloseTo(0.2, 10);
    // disagreement between the two orderings lowers confidence
    expect(page_type.confidence).toBeLessThan(0.5);
  });

  it('shuffles options deterministically per state', async () => {
    const orders: string[][] = [];
    const { transport } = fakeTransport((req) => {
      orders.push(Object.keys((req.questions.page_type as { criteria: object }).criteria));
      return { page_type: { type: 'choice', choice: 'first', probabilities: { first: 1, second: 0, third: 0 } } };
    });
    const jev1 = jevWith(transport, { cacheSize: 0 });
    await jev1.ask('same state', q, { shuffleChoices: true });
    await jev1.ask('same state', q, { shuffleChoices: true });
    expect(orders[0]).toEqual(orders[1]);
    expect([...orders[0]!].sort()).toEqual(['first', 'second', 'third']);
  });

  it('rejects ids that collide with the reserved twin suffix', async () => {
    const { transport } = fakeTransport(() => ({}));
    await expect(jevWith(transport).ask('x', { bad__rev: noul('?') })).rejects.toThrow(/must not end with/);
  });
});

describe('caching, stats and concurrency', () => {
  it('serves identical requests from cache and tracks token usage and cost', async () => {
    const { transport, requests } = fakeTransport(() => ({ a: { type: 'noul', noul: 0.5 } }), { input_tokens: 1_000_000, output_tokens: 5 });
    const jev = jevWith(transport, { pricePerMTok: 0.042 });
    await jev.ask('same', { a: noul('A?') });
    await jev.ask('same', { a: noul('A?') });
    await jev.ask('different', { a: noul('A?') });
    expect(requests).toHaveLength(2);
    const s = jev.stats();
    expect(s.requests).toBe(2);
    expect(s.cacheHits).toBe(1);
    expect(s.inputTokens).toBe(2_000_000);
    expect(s.estimatedCostUsd).toBeCloseTo(0.084, 6);
  });

  it('never exceeds the configured concurrency', async () => {
    const f = fakeTransport(() => ({ a: { type: 'noul', noul: 0.5 } }));
    const jev = jevWith(f.transport, { maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 9 }, (_, i) => jev.ask(`state ${i}`, { a: noul('A?') })));
    expect(f.maxInFlight()).toBe(2);
  });
});

describe('error handling', () => {
  const sdkError = (status: number, body: unknown = { message: 'x' }) => APIError.fromResponse(status, body, new Headers());

  it('maps SDK errors to JevError kinds', () => {
    expect(toJevError(sdkError(401)).kind).toBe('auth');
    expect(toJevError(sdkError(403)).kind).toBe('auth');
    expect(toJevError(sdkError(422, { message: 'questions.a.type: invalid' })).kind).toBe('invalid_request');
    expect(toJevError(sdkError(429)).kind).toBe('rate_limit');
    expect(toJevError(sdkError(529)).kind).toBe('unavailable');
    expect(toJevError(new Error('boom')).kind).toBe('unavailable');
  });

  it('tryAsk degrades to null on transient errors but rethrows fatal ones', async () => {
    const transient = fakeTransport(() => sdkError(529));
    const j1 = jevWith(transient.transport);
    expect(await j1.tryAsk('x', { a: noul('A?') })).toBeNull();
    expect(j1.stats().failures).toBe(1);

    const fatal = fakeTransport(() => sdkError(401));
    const j2 = jevWith(fatal.transport);
    await expect(j2.tryAsk('x', { a: noul('A?') })).rejects.toBeInstanceOf(JevError);
    await expect(j2.tryAsk('x', { a: noul('A?') })).rejects.toMatchObject({ kind: 'auth', fatal: true });
  });
});

describe('official SDK wire format', () => {
  const base: JevConfig = { apiKey: 'test-key', baseURL: 'https://api.typesafe.ai', model: 'jev-latest', flavor: 'typesafe', pricePerMTok: 0.042 };

  it('posts to {baseURL}/v1/systemone with a Bearer key and the documented body, and parses the documented response', async () => {
    const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            is_urgent: { type: 'noul', noul: 0.95 },
            dept: { type: 'choice', choice: 'billing', probabilities: { billing: 0.88, technical: 0.12 }, confidence: 0.76 },
            mood: { type: 'score', score: 1.05, legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' }, probabilities: { '0': 0, '1': 0.95, '2': 0.05 }, confidence: 0.92 },
          },
          usage: { input_tokens: 296, output_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const jev = new Jev({ transport: createSdkTransport(base, fakeFetch), model: base.model, logger: quiet });
    const a = await jev.ask('Help! My payouts have been failing for 3 days.', {
      is_urgent: noul('Does this convey urgency?'),
      dept: choice('Which team?', { billing: 'Payments', technical: 'Bugs' }),
      mood: score('How frustrated?', ['Calm', 'Frustrated', 'Very angry']),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    const h = Object.fromEntries(Object.entries(seen[0]!.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h.authorization).toBe('Bearer test-key');
    expect(seen[0]!.body.model).toBe('jev-latest');
    expect(seen[0]!.body.state).toBe('Help! My payouts have been failing for 3 days.');
    expect(seen[0]!.body.questions.dept).toEqual({ type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Bugs' } });
    expect(seen[0]!.body.questions.mood.criteria).toEqual(['Calm', 'Frustrated', 'Very angry']);
    expect(a.is_urgent.p).toBe(0.95);
    expect(a.dept.value).toBe('billing');
    expect(a.mood.raw).toBeCloseTo(1.05, 10);
    expect(a.mood.value).toBeCloseTo(0.525, 10);
    expect(jev.stats().inputTokens).toBe(296);
  });

  it('routes through the Vercel AI Gateway base URL when configured', async () => {
    let url = '';
    const fakeFetch = async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers: { a: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const cfg: JevConfig = { ...base, baseURL: 'https://ai-gateway.vercel.sh/typesafe', model: 'typesafe-ai/jev', flavor: 'vercel' };
    await new Jev({ transport: createSdkTransport(cfg, fakeFetch), model: cfg.model, logger: quiet }).ask('x', { a: noul('A?') });
    expect(url).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  });

  it('surfaces a 401 from the wire as a fatal auth error without retrying', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      return new Response(JSON.stringify({ message: 'Missing or invalid API key' }), { status: 401, headers: { 'content-type': 'application/json' } });
    };
    const jev = new Jev({ transport: createSdkTransport(base, fakeFetch), model: base.model, logger: quiet });
    await expect(jev.ask('x', { a: noul('A?') })).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(calls).toBe(1);
  });

  it('retries 529 overloads with backoff and then succeeds', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      if (calls < 3) return new Response('{"message":"overloaded"}', { status: 529, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
      return new Response(JSON.stringify({ model: 'm', answers: { a: { type: 'noul', noul: 0.3 } }, usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const jev = new Jev({ transport: createSdkTransport(base, fakeFetch), model: base.model, logger: quiet });
    expect((await jev.ask('x', { a: noul('A?') })).a.p).toBe(0.3);
    expect(calls).toBe(3);
  });
});
