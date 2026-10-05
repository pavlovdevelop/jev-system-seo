import type { Question, Questions } from '@typesafe-ai/sdk';
import { Jev, type SystemOneTransport } from '../../src/server/jev/client';

export type Script = Record<string, unknown>;
type Req = Parameters<SystemOneTransport['systemOne']>[0];

/** A scripted wire answer for each question id; unscripted questions get a neutral answer. The reversed twin mirrors its original. */
export function scriptedJev(script: Script, opts: { failWhen?: (req: Req) => Error | null } = {}) {
  const requests: Req[] = [];
  const transport: SystemOneTransport = {
    async systemOne(req) {
      requests.push(req);
      const err = opts.failWhen?.(req);
      if (err) throw err;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(req.questions as Questions)) {
        const base = id.replace(/__rev$/, '');
        answers[id] = script[base] ?? neutral(q);
      }
      return { model: 'jev-test', answers, usage: { input_tokens: 100, output_tokens: 10 } };
    },
  };
  const jev = new Jev({ transport, model: 'jev-test', logger: { warn: () => {}, debug: () => {} }, cacheSize: 0 });
  return { jev, requests };
}

function neutral(q: Question): unknown {
  if (q.type === 'noul') return { type: 'noul', noul: 0.5 };
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    return { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])) };
  }
  const n = q.criteria.length;
  return { type: 'score', score: (n - 1) / 2, probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), 1 / n])) };
}

export const noulAnswer = (p: number) => ({ type: 'noul', noul: p });
export const choiceAnswer = (choice: string, others: Record<string, number> = {}, confidence?: number) => ({
  type: 'choice',
  choice,
  probabilities: { [choice]: 0.8, ...others },
  ...(confidence !== undefined ? { confidence } : {}),
});
export const scoreAnswer = (score: number, levels: number, confidence?: number) => {
  const probs = Array.from({ length: levels }, (_, i) => Math.max(0, 1 - Math.abs(i - score)));
  const sum = probs.reduce((a, b) => a + b, 0) || 1;
  return {
    type: 'score',
    score,
    probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p / sum])),
    ...(confidence !== undefined ? { confidence } : {}),
  };
};
