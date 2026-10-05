import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JobState, PipelineStep, ProgressEvent } from '../../shared/schemas';
import { Callout, Icon, Loading } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/hooks';

const STEPS: Array<{ id: PipelineStep; label: string; detail: string }> = [
  { id: 'serp', label: 'Търся в Google', detail: 'водещи резултати, свързани търсения, въпроси' },
  { id: 'crawl', label: 'Тегля страниците на конкурентите', detail: 'само публични страници, спазвам robots.txt' },
  { id: 'judge', label: 'Jev оценява страниците', detail: 'тип, намерение, дълбочина, доверие, конверсия' },
  { id: 'expand', label: 'Намирам свързани фрази', detail: 'Jev проверява кои са релевантни за бизнеса ти' },
  { id: 'candidates', label: 'Проверявам конкуренцията по фрази', detail: 'SERP и бърза оценка на всеки резултат' },
  { id: 'volumes', label: 'Месечни търсения', detail: 'ако е настроен източник' },
  { id: 'score', label: 'Изчислявам възможностите', detail: 'оценки, конкуренти, план за съдържание' },
  { id: 'save', label: 'Подготвям отчета', detail: '' },
];

export function RunPage({ jobId }: { jobId: string }): JSX.Element {
  const [job, setJob] = useState<JobState | null>(null);
  const [last, setLast] = useState<ProgressEvent | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const apply = (state: JobState): void => {
      setJob(state);
      if (state.last) setLast(state.last);
      if ((state.status === 'done' || state.status === 'error') && !finished.current) {
        finished.current = true;
        source?.close();
        if (poll) clearInterval(poll);
        if (state.status === 'done' && state.reportId) setTimeout(() => !closed && navigate(`/report/${state.reportId}`), 700);
      }
    };

    const startPolling = (): void => {
      if (poll || finished.current) return;
      poll = setInterval(() => {
        api.job(jobId).then(({ job: j }) => apply(j), (e: unknown) => {
          if (e instanceof ApiError && e.status === 404) {
            setProblem('Задачата не е намерена — сървърът може да е бил рестартиран. Пусни анализа отново.');
            if (poll) clearInterval(poll);
          }
        });
      }, 3000);
    };

    // The first read tells us immediately whether the job exists at all.
    api.job(jobId).then(({ job: j }) => {
      apply(j);
      if (finished.current || closed) return;
      source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
      source.addEventListener('progress', (e) => setLast(JSON.parse((e as MessageEvent<string>).data) as ProgressEvent));
      source.addEventListener('state', (e) => apply(JSON.parse((e as MessageEvent<string>).data) as JobState));
      // EventSource retries silently after a network error and never gives up, so a stream that a proxy keeps
      // cutting would freeze the page. A slow poll next to it costs one tiny request every few seconds and always converges.
      source.onerror = () => startPolling();
      startPolling();
    }, (e: unknown) => {
      setProblem(e instanceof ApiError && e.status === 404 ? 'Задачата не е намерена — сървърът може да е бил рестартиран. Пусни анализа отново.' : e instanceof Error ? e.message : 'Грешка при връзката.');
    });

    return () => {
      closed = true;
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [jobId]);

  const cancel = async (): Promise<void> => {
    try {
      await api.cancelJob(jobId);
    } catch {
      // already finished: the stream will tell us
    }
  };

  if (problem) {
    return (
      <div class="stack">
        <Callout kind="error">{problem}</Callout>
        <div><a class="btn btn-primary" href="#/">Нов анализ</a></div>
      </div>
    );
  }
  if (!job) return <Loading text="Свързвам се със задачата…" />;

  const failed = job.status === 'error';
  const done = job.status === 'done';
  const pct = done ? 100 : (last?.pct ?? 0);
  const activeIndex = done ? STEPS.length : Math.max(0, STEPS.findIndex((s) => s.id === last?.step));

  return (
    <div class="stack-lg" style={{ maxWidth: '760px' }}>
      <div class="page-head">
        <p class="small muted"><a href="#/">← Всички анализи</a></p>
        <h1 style={{ marginTop: '4px' }}>Анализирам „{job.keyword}“</h1>
        <p class="page-sub">Обикновено отнема от половин до две минути. Можеш да оставиш страницата отворена — отчетът ще се покаже сам.</p>
      </div>

      {failed ? (
        <Callout kind="error">
          <strong>Анализът не успя.</strong>
          <p style={{ marginTop: '4px' }}>{job.error}</p>
          <p class="small muted" style={{ marginTop: '6px' }}>Провери ключовете в <a href="#/settings">Настройки</a> или пусни <code>npm run doctor</code> на сървъра.</p>
        </Callout>
      ) : null}

      <section class="card">
        <div class="spread" style={{ marginBottom: '10px' }}>
          <strong aria-live="polite">{failed ? 'Прекратено' : done ? 'Готово — отварям отчета…' : (last?.message ?? 'Стартирам…')}</strong>
          <span class="muted num">{Math.round(pct)}%</span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Напредък на анализа"><span style={{ width: `${pct}%` }} /></div>

        <ol class="steps" style={{ marginTop: '18px' }}>
          {STEPS.map((s, i) => {
            const state = failed && i === activeIndex ? 'failed' : i < activeIndex ? 'done' : i === activeIndex && !failed ? 'active' : 'pending';
            return (
              <li key={s.id} class={`step ${state === 'failed' ? '' : state}`}>
                <span class="step-icon" aria-hidden="true">{state === 'done' ? <Icon name="check" size={13} /> : state === 'failed' ? <Icon name="x" size={13} /> : null}</span>
                <span>
                  {s.label}
                  {s.detail ? <span class="muted small"> — {s.detail}</span> : null}
                  {state === 'done' ? <span class="sr-only"> (готово)</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <div class="row">
        {!done && !failed ? <button type="button" class="btn" onClick={cancel}>Прекрати</button> : null}
        {failed ? <a class="btn btn-primary" href="#/">Опитай отново</a> : null}
      </div>
    </div>
  );
}
