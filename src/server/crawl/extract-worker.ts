import { parentPort } from 'node:worker_threads';
import { extractPage } from './extract';
import type { WorkerReply, WorkerRequest } from './extract-pool';

// The thread that WorkerExtractor (extract-pool.ts) starts: one message in, one reply out. Bundled to dist/extract-worker.mjs.

const port = parentPort;
if (port) {
  port.on('message', (request: WorkerRequest) => {
    let reply: WorkerReply;
    try {
      reply = { id: request.id, ok: true, page: extractPage(request.html, request.ctx) };
    } catch (err) {
      reply = { id: request.id, ok: false, name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : 'неизвестна грешка' };
    }
    port.postMessage(reply);
  });
}
