import type { AnalyzeRequest, JobState, PipelineStep, ProgressEvent } from '../shared/schemas';
import { PipelineError, runAnalysis } from './pipeline/analyze';
import type { Runtime } from './runtime';
import { newId, type Store } from './store';

// Analyses take tens of seconds, so they run as background jobs: the browser starts one, then follows its
// progress over Server-Sent Events. Jobs live in memory (a restart drops running ones — their reports are only
// written on completion); finished reports live in the Store.

export type JobMessage = { type: 'progress'; payload: ProgressEvent } | { type: 'state'; payload: JobState };

interface Job {
  state: JobState;
  request: AnalyzeRequest;
  reportId: string;
  events: ProgressEvent[];
  listeners: Set<(m: JobMessage) => void>;
  controller: AbortController;
}

export interface JobLogger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

const MAX_BUFFERED_EVENTS = 300;
const KEEP_FINISHED_MS = 60 * 60 * 1000;
const MAX_QUEUED = 20;
const MAX_FINISHED_KEPT = 100;

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly active = new Set<Promise<void>>();

  constructor(
    private readonly deps: { store: Store; runtime: Runtime; maxConcurrent: number; logger: JobLogger },
  ) {}

  start(request: AnalyzeRequest): JobState {
    if (this.queue.length >= MAX_QUEUED) throw new PipelineError('Има твърде много чакащи анализи. Опитай след малко.', 'input');
    const id = newId('j');
    const job: Job = {
      state: { id, status: 'queued', keyword: request.keyword, createdAt: new Date().toISOString(), last: null, reportId: null, error: null },
      request,
      reportId: newId('r'),
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.emit(job, 'queued', 0, this.running >= this.deps.maxConcurrent ? 'Чака ред за изпълнение…' : 'Стартирам…');
    queueMicrotask(() => this.pump());
    return job.state;
  }

  /** Resolves once nothing is running or queued (used by tests and for a tidy shutdown). */
  async idle(): Promise<void> {
    while (this.active.size > 0 || this.queue.length > 0) {
      await Promise.allSettled([...this.active]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  get(id: string): JobState | null {
    return this.jobs.get(id)?.state ?? null;
  }

  list(): JobState[] {
    return [...this.jobs.values()].map((j) => j.state).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Replays buffered events, then the current state, then streams live messages. Returns an unsubscribe function. */
  subscribe(id: string, listener: (m: JobMessage) => void): (() => void) | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    for (const event of job.events) listener({ type: 'progress', payload: event });
    listener({ type: 'state', payload: job.state });
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state.status === 'done' || job.state.status === 'error') return false;
    job.controller.abort(new PipelineError('Анализът е прекратен.', 'aborted'));
    const queuedAt = this.queue.indexOf(id);
    if (queuedAt !== -1) {
      this.queue.splice(queuedAt, 1);
      this.finish(job, 'error', 'Анализът е прекратен.');
    }
    return true;
  }

  private pump(): void {
    while (this.running < this.deps.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const job = this.jobs.get(id);
      if (!job) continue;
      this.running++;
      const run: Promise<void> = this.execute(job).finally(() => {
        this.active.delete(run);
        this.running--;
        this.pump();
      });
      this.active.add(run);
    }
  }

  private emit(job: Job, step: PipelineStep, pct: number, message: string): void {
    const event: ProgressEvent = { jobId: job.state.id, step, pct: Math.max(0, Math.min(100, pct)), message, at: new Date().toISOString() };
    job.state = { ...job.state, last: event };
    job.events.push(event);
    if (job.events.length > MAX_BUFFERED_EVENTS) job.events.splice(0, job.events.length - MAX_BUFFERED_EVENTS);
    for (const l of job.listeners) l({ type: 'progress', payload: event });
  }

  private finish(job: Job, status: 'done' | 'error', error: string | null): void {
    job.state = { ...job.state, status, error, reportId: status === 'done' ? job.reportId : null };
    for (const l of job.listeners) l({ type: 'state', payload: job.state });
    setTimeout(() => this.jobs.delete(job.state.id), KEEP_FINISHED_MS).unref();
    this.forgetOldFinished();
  }

  /** The registry must not grow with the number of analyses ever started: only the latest finished ones are kept. */
  private forgetOldFinished(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state.status === 'done' || j.state.status === 'error');
    if (finished.length <= MAX_FINISHED_KEPT) return;
    finished.sort((a, b) => a.state.createdAt.localeCompare(b.state.createdAt));
    for (const job of finished.slice(0, finished.length - MAX_FINISHED_KEPT)) this.jobs.delete(job.state.id);
  }

  private async execute(job: Job): Promise<void> {
    if (job.controller.signal.aborted) return;
    job.state = { ...job.state, status: 'running' };
    for (const l of job.listeners) l({ type: 'state', payload: job.state });
    const { store, runtime, logger } = this.deps;
    let handle: ReturnType<Runtime['createRun']> | null = null;
    const started = Date.now();
    try {
      handle = runtime.createRun();
      const settings = await store.getSettings();
      const report = await runAnalysis(
        { id: job.reportId, request: job.request, tracked: settings.competitors.map((c) => c.domain) },
        handle.deps,
        (step, pct, message) => this.emit(job, step, pct, message),
        job.controller.signal,
      );
      await store.saveReport(report);
      this.emit(job, 'done', 100, 'Готово');
      this.finish(job, 'done', null);
      // One line of counts plus the report's own notes: enough to see from the server log whether a run went well.
      const u = report.usage;
      logger.info(
        `анализ ${job.reportId} „${report.seed.keyword}“ — ${Math.round((Date.now() - started) / 1000)} с, ${report.status === 'partial' ? 'непълен' : 'пълен'}; ` +
          `Jev: ${u.jevRequests} заявки (${u.jevFailures} неуспешни); SERP: ${u.serpCalls} (${u.serpCacheHits} от кеша); ` +
          `страници: ${u.pagesFetched} изтеглени, ${u.pagesBlocked} блокирани, ${u.pagesFailed} неуспешни`,
      );
      for (const note of report.warnings) logger.info(`  бележка: ${note}`);
    } catch (err) {
      const known = err instanceof PipelineError;
      if (!known) logger.error(`анализ ${job.reportId} се провали`, err);
      this.finish(job, 'error', known ? err.message : 'Неочаквана грешка при анализа. Подробности има в логовете на сървъра.');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
