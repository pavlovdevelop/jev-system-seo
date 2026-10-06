import type { JSX } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { ENGINE_LABELS, type FixPlan, type SiteAuditReport } from '../../shared/audit';
import { bgCount } from '../../shared/plural';
import { PageLink } from '../components/details';
import { Empty, Icon, Meter } from '../components/ui';
import { pct } from '../lib/format';
import { copyText, countPlans, parseDone, planMarkdown, planStorageKey, PLAN_KIND_LABELS, plansMarkdown, progressText, sortEngineIds, sortPlans, WRITTEN_BY_LABELS } from '../lib/geo';
import { usePersistentState } from '../lib/hooks';
import './geo.css';

// "План": the pages to write or rewrite so that AI assistants cite the site, the most valuable first, each with an ordered
// checklist. Ticks are kept in this browser, per audit and per plan; a plan can be copied as Markdown into a ticket.

// ───────────────────────── copying ─────────────────────────

type CopyState = 'idle' | 'ok' | 'failed';

/** A button that copies Markdown and says so politely (a live region); when the browser refuses, the text is offered to select by hand. */
function CopyMarkdown({ label, build, primary }: { label: string; build: () => string; primary?: boolean }): JSX.Element {
  const [state, setState] = useState<CopyState>('idle');
  const [text, setText] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const areaId = useId();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    const markdown = build();
    const ok = await copyText(markdown);
    window.clearTimeout(timer.current);
    setText(markdown);
    setState(ok ? 'ok' : 'failed');
    if (ok) timer.current = window.setTimeout(() => setState('idle'), 4000);
  };

  return (
    <div class="plan-copy">
      <div class="plan-copy-row">
        <button type="button" class={`btn btn-sm${primary ? ' btn-primary' : ''}`} onClick={() => void copy()}>
          <Icon name="copy" size={14} />
          {label}
        </button>
        <span class="plan-copy-status small" role="status">
          {state === 'ok' ? (
            <>
              <Icon name="check" size={14} />
              Копирано в клипборда
            </>
          ) : state === 'failed' ? (
            'Браузърът не позволи копиране. Маркирай текста по-долу и го копирай ръчно.'
          ) : null}
        </span>
      </div>
      {state === 'failed' ? (
        <textarea
          id={areaId}
          class="textarea plan-copy-text"
          readOnly
          rows={10}
          value={text}
          aria-label="Markdown за ръчно копиране"
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : null}
    </div>
  );
}

// ───────────────────────── one plan ─────────────────────────

/** Where the page lives: the address to rewrite, or the one to create. */
function Where({ plan }: { plan: FixPlan }): JSX.Element | null {
  if (plan.url) {
    return (
      <p class="plan-url">
        <PageLink url={plan.url}>{plan.url}</PageLink>
      </p>
    );
  }
  return plan.suggestedPath ? (
    <p class="plan-url">
      предложен адрес <code>{plan.suggestedPath}</code>
    </p>
  ) : null;
}

/** "28% → 61%" with one bar: the dark part is today, the light part what the plan could add (a projection). */
function Gain({ now, after }: { now: number; after: number }): JSX.Element {
  const w = (v: number): string => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
  return (
    <div class="plan-gain">
      <div class="plan-gain-text">
        <span class="sr-only">от </span>
        <span class="plan-gain-fig">{pct(now)}</span>
        <span class="plan-gain-arrow" aria-hidden="true">
          →
        </span>
        <span class="sr-only"> до </span>
        <span class="plan-gain-fig">{pct(after)}</span>
        <span class="muted xs">прогноза</span>
      </div>
      <div class="plan-gain-track" aria-hidden="true">
        <span class="plan-gain-after" style={{ width: w(after) }} />
        <span class="plan-gain-now" style={{ width: w(now) }} />
      </div>
    </div>
  );
}

function PlanCard({ plan, auditId }: { plan: FixPlan; auditId: string }): JSX.Element {
  const head = useId();
  const ids = useMemo(() => plan.checklist.map((s) => s.id), [plan.checklist]);
  const [stored, setStored] = usePersistentState<unknown>(planStorageKey(auditId, plan.id), []);
  const done = useMemo(() => parseDone(stored, ids), [stored, ids]);
  const total = plan.checklist.length;
  const toggle = (id: string): void => setStored(done.includes(id) ? done.filter((x) => x !== id) : [...done, id]);
  const finished = total > 0 && done.length === total;

  return (
    <article class="card plan-card" aria-labelledby={head}>
      <header class="plan-head">
        <div class="plan-head-main">
          <span class={`badge plan-kind plan-kind-${plan.kind}`}>
            <Icon name={plan.kind === 'create' ? 'plus' : 'refresh'} size={13} />
            {PLAN_KIND_LABELS[plan.kind]}
          </span>
          <h3 id={head}>{plan.title}</h3>
          <Where plan={plan} />
        </div>
        <CopyMarkdown label="Копирай като Markdown" build={() => planMarkdown(plan, { level: 1 })} />
      </header>

      <div class="plan-body">
        <div class="plan-meta">
          {plan.engines.length > 0 ? (
            <div>
              <h4 class="section-title">Важи за</h4>
              <div class="chips">
                {sortEngineIds(plan.engines).map((e) => (
                  <span key={e} class="badge">
                    {ENGINE_LABELS[e]}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {plan.citability ? (
            <div>
              <h4 class="section-title">Цитируемост на страницата</h4>
              <Gain now={plan.citability.now} after={plan.citability.after} />
            </div>
          ) : null}

          {plan.questions.length > 0 ? (
            <div>
              <h4 class="section-title">Въпроси, на които да отговаря</h4>
              <ul class="plan-questions">
                {plan.questions.map((q, i) => (
                  <li key={`${i}-${q}`}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div class="plan-steps">
          <div class="plan-progress">
            <h4 class="section-title">Стъпки по ред</h4>
            <div class="plan-progress-row">
              {finished ? (
                <span class="status status-easy">
                  <Icon name="check" size={16} />
                  Всичко е готово
                </span>
              ) : (
                <span class="plan-count">{progressText(done.length, total)}</span>
              )}
              <Meter value={total === 0 ? 0 : done.length / total} label={`Готови стъпки: ${progressText(done.length, total)}`} />
            </div>
          </div>
          <ol class="plan-list" role="list">
            {plan.checklist.map((step, i) => {
              const checked = done.includes(step.id);
              return (
                <li key={step.id}>
                  <label class={`plan-step${checked ? ' is-done' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(step.id)} />
                    <span class="plan-step-num" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span class="plan-step-body">
                      <span class="plan-step-text">{step.text}</span>
                      {step.why.trim() ? <span class="plan-step-why">защо: {step.why}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <p class="plan-by" title={plan.writtenBy === 'llm' ? 'Текстът на стъпките е написан от езиков модел по резултатите от одита. Прочети го критично: моделът може да греши.' : 'Стъпките идват от фиксирани правила, не от езиков модел.'}>
        <Icon name={plan.writtenBy === 'llm' ? 'bolt' : 'doc'} size={14} />
        {WRITTEN_BY_LABELS[plan.writtenBy]}
      </p>
    </article>
  );
}

// ───────────────────────── the tab ─────────────────────────

function NothingToDo({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const asked = audit.geo !== null && audit.geo.engines.length > 0;
  if (!asked) {
    return (
      <Empty title="Планът се строи от отговорите на ИИ двигателите">
        Страниците за писане и пренаписване се извеждат от това къде ChatGPT, Claude и Gemini ни пропускат. Тази проверка не е пускана — тя иска поне един от ключовете <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code> или <code>GEMINI_API_KEY</code>. Добави го в <a href="#/settings">Настройки</a> и пусни одита отново.
      </Empty>
    );
  }
  if (audit.geo?.engines.every((e) => e.answered === 0)) {
    return <Empty title="Няма отговори, от които да се изведе план">Двигателите не върнаха нито един отговор. Виж раздела „ИИ видимост“ за причините и пусни одита отново.</Empty>;
  }
  return <Empty title="Няма какво да се поправя">Не открихме въпроси, по които двигателите да ни пропускат, нито страници, които да се пренапишат или да се създадат.</Empty>;
}

export function PlanTab({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const plans = useMemo(() => sortPlans(audit.plan), [audit.plan]);
  const heading = useId();
  if (plans.length === 0) return <NothingToDo audit={audit} />;
  const { total, create, rewrite } = countPlans(plans);

  return (
    <div class="stack-lg plan">
      <section class="card plan-summary" aria-labelledby={heading}>
        <div class="plan-summary-main">
          <h2 id={heading}>{bgCount(total, 'страница за работа', 'страници за работа')}</h2>
          <div class="chips">
            <span class="badge plan-kind plan-kind-create">
              <Icon name="plus" size={13} />
              {bgCount(create, 'нова страница', 'нови страници')}
            </span>
            <span class="badge plan-kind plan-kind-rewrite">
              <Icon name="refresh" size={13} />
              {bgCount(rewrite, 'пренаписване', 'пренаписвания')}
            </span>
          </div>
          <p class="small muted">Подредени по приоритет — започни от първата. Отметките се пазят в този браузър.</p>
        </div>
        <CopyMarkdown primary label="Копирай целия план" build={() => plansMarkdown(plans, { domain: audit.request.domain })} />
      </section>

      <ol class="plan-cards" role="list">
        {plans.map((plan) => (
          <li key={`${audit.id}:${plan.id}`}>
            <PlanCard plan={plan} auditId={audit.id} />
          </li>
        ))}
      </ol>
    </div>
  );
}
