import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ExtractedPage } from '../jev/questions';
import { ExtractError, extractPage, type ExtractContext } from './extract';

// A competitor's page is untrusted markup and extracting facts from it is CPU-bound. extract.ts keeps a time budget of
// its own, but that is only checked between steps, so one slow step would still hold the thread that serves the web UI
// and every other analysis. In production the work therefore runs in a worker thread that is stopped when it passes a
// hard deadline (or its memory limit); the main thread only waits for a message and stays responsive whatever the page
// contains. Where the worker script has not been built (tests, `npm run dev`) the same code runs in-process.

export interface PageExtractor {
  readonly mode: 'worker' | 'in-process';
  extract(html: string, ctx: ExtractContext): Promise<ExtractedPage>;
  /** Stops the worker thread, if any. Jobs still waiting are rejected. */
  close(): Promise<void>;
}

/** Messages between the pool and extract-worker.ts. Everything in them is plain data, copied by structured clone. */
export interface WorkerRequest {
  id: number;
  html: string;
  ctx: ExtractContext;
}
export type WorkerReply = { id: number; ok: true; page: ExtractedPage } | { id: number; ok: false; name: string; message: string };

export class InProcessExtractor implements PageExtractor {
  readonly mode = 'in-process';

  async extract(html: string, ctx: ExtractContext): Promise<ExtractedPage> {
    return extractPage(html, ctx);
  }

  async close(): Promise<void> {}
}

export interface WorkerExtractorOptions {
  /** The bundled worker script (dist/extract-worker.mjs). */
  file: URL | string;
  /** Hard deadline for one page, in milliseconds. Longer than extract.ts's own budget, which reports precisely where it gave up. */
  timeoutMs?: number;
  /** V8 old-generation limit of the worker, in MB. Past it the thread is stopped and the page is reported instead of the server running out of memory. */
  maxMemoryMb?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_MEMORY_MB = 192;

interface Job {
  id: number;
  html: string;
  ctx: ExtractContext;
  resolve: (page: ExtractedPage) => void;
  reject: (error: Error) => void;
}

/**
 * One worker thread, one page at a time (extraction is CPU-bound, so more threads would only compete for the same
 * cores); the rest wait in line. A worker that times out, crashes or runs out of memory is replaced by a fresh one for
 * the next page, and only the page that caused it is lost.
 */
export class WorkerExtractor implements PageExtractor {
  readonly mode = 'worker';
  private worker: Worker | null = null;
  private active: (Job & { timer: NodeJS.Timeout }) | null = null;
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;
  private readonly file: URL | string;
  private readonly timeoutMs: number;
  private readonly maxMemoryMb: number;

  constructor(options: WorkerExtractorOptions) {
    this.file = options.file;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxMemoryMb = options.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB;
  }

  extract(html: string, ctx: ExtractContext): Promise<ExtractedPage> {
    if (this.closed) return Promise.reject(new ExtractError('Разборът на страниците е спрян.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, html, ctx, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const stopped = new ExtractError('Разборът на страниците е спрян.');
    for (const job of this.queue.splice(0)) job.reject(stopped);
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(stopped);
      this.active = null;
    }
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }

  private pump(): void {
    while (!this.active && !this.closed) {
      const job = this.queue.shift();
      if (!job) return;
      this.active = { ...job, timer: setTimeout(() => this.onTimeout(job.id), this.timeoutMs) };
      try {
        this.worker ??= this.spawn();
        this.worker.postMessage({ id: job.id, html: job.html, ctx: job.ctx } satisfies WorkerRequest);
      } catch (err) {
        // The worker could not start (or the message could not be sent): this page fails, the next one gets a fresh attempt.
        this.discardWorker();
        this.finish(job.id)?.reject(failure(err));
      }
    }
  }

  private spawn(): Worker {
    const worker = new Worker(this.file, {
      // Nothing a page could do inside the worker needs the server's secrets, so it gets none.
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: this.maxMemoryMb },
    });
    worker.unref(); // an idle worker must never keep the process alive
    worker.on('message', (reply: WorkerReply) => this.onReply(worker, reply));
    // Without an 'error' listener a crash inside the worker would be rethrown here and take the whole server down.
    worker.on('error', (err) => this.onGone(worker, err));
    worker.on('messageerror', (err) => this.onGone(worker, err));
    worker.on('exit', (code) => this.onGone(worker, new Error(`the worker exited with code ${code}`)));
    return worker;
  }

  /** Takes the active job if it is `id`, stopping its clock. */
  private finish(id: number): Job | null {
    const job = this.active;
    if (!job || job.id !== id) return null;
    clearTimeout(job.timer);
    this.active = null;
    return job;
  }

  private discardWorker(): void {
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate().catch(() => undefined);
  }

  private onReply(worker: Worker, reply: WorkerReply): void {
    if (worker !== this.worker) return; // a worker that was already replaced
    const job = this.finish(reply.id);
    if (!job) return;
    if (reply.ok) job.resolve(reply.page);
    else job.reject(reply.name === 'ExtractError' ? new ExtractError(reply.message) : new Error(reply.message));
    this.pump();
  }

  private onGone(worker: Worker, err: unknown): void {
    if (worker !== this.worker) return; // stopped on purpose, or already replaced
    this.discardWorker();
    const job = this.active ? this.finish(this.active.id) : null;
    job?.reject(failure(err));
    this.pump();
  }

  private onTimeout(id: number): void {
    const job = this.finish(id);
    if (!job) return;
    this.discardWorker(); // stops whatever the page made the thread do, however tight the loop
    job.reject(new ExtractError(`Разборът на страницата не приключи за ${Math.round(this.timeoutMs / 1000)} с и беше прекратен`));
    this.pump();
  }
}

function failure(err: unknown): ExtractError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ERR_WORKER_OUT_OF_MEMORY') return new ExtractError('Страницата е твърде тежка за разбор (не стигна паметта)');
  const detail = typeof code === 'string' ? code : err instanceof Error ? err.message.slice(0, 80) : 'неизвестна причина';
  return new ExtractError(`Разборът на страницата спря неочаквано (${detail})`);
}

/** Where the bundled worker sits: next to the server bundle (dist/server.mjs → dist/extract-worker.mjs). */
export const WORKER_FILE = new URL('./extract-worker.mjs', import.meta.url);

/** The worker if it has been built, otherwise the in-process extractor. */
export function createExtractor(file: URL | string = WORKER_FILE): PageExtractor {
  try {
    if (existsSync(typeof file === 'string' ? file : fileURLToPath(file))) return new WorkerExtractor({ file });
  } catch {
    // an unusable path is the same as no worker
  }
  return new InProcessExtractor();
}
