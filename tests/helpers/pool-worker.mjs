// A stand-in for extract-worker.mjs that misbehaves on demand, so the pool's handling of a hung, crashing, memory-hungry
// or confused worker can be tested without needing a page that makes the real extractor do those things.
import { parentPort } from 'node:worker_threads';

let inFlight = 0;

parentPort.on('message', ({ id, html }) => {
  inFlight++;
  const reply = (body) => {
    inFlight--;
    parentPort.postMessage({ id, ...body });
  };
  switch (html) {
    case 'HANG':
      for (;;); // a loop no cooperative time budget would ever interrupt
    case 'THROW':
      throw new Error('boom');
    case 'EXIT':
      process.exit(3);
      break;
    case 'OOM': {
      const hoard = [];
      for (;;) hoard.push(new Array(100_000).fill(Math.random()));
    }
    case 'OOM-CODE': {
      // what Node reports when a worker passes resourceLimits.maxOldGenerationSizeMb
      const error = new Error('Worker terminated due to reaching memory limit');
      error.code = 'ERR_WORKER_OUT_OF_MEMORY';
      throw error;
    }
    case 'FAIL-EXTRACT':
      return reply({ ok: false, name: 'ExtractError', message: 'Страницата е твърде сложна' });
    case 'FAIL-OTHER':
      return reply({ ok: false, name: 'TypeError', message: 'нещо друго' });
    case 'WRONG-ID':
      parentPort.postMessage({ id: id + 1000, ok: true, page: { echo: 'stale' } });
      return reply({ ok: true, page: { echo: 'right' } });
    case 'ENV':
      return reply({ ok: true, page: { echo: Object.keys(process.env).join(',') } });
    default:
      if (html.startsWith('SLOW:')) {
        const [, ms, label] = html.split(':');
        const seen = inFlight;
        return void setTimeout(() => reply({ ok: true, page: { echo: label, inFlight: seen } }), Number(ms));
      }
      return reply({ ok: true, page: { echo: html } });
  }
});
