import type { JSX } from 'preact';
import { useId, useMemo, useState } from 'preact/hooks';
import { ENGINE_LABELS, SKIP_REASON_LABELS, SOURCE_KIND_LABELS, type AnswerRecord, type EngineId, type EngineRun, type Geo, type SiteAuditReport, type SiteAuditRequest, type SkipAnalysis, type WinnerPage } from '../../shared/audit';
import { bgCount } from '../../shared/plural';
import { safeHref } from '../../shared/urls';
import { PageLink } from '../components/details';
import { Donut } from '../components/Donut';
import { Radar } from '../components/Radar';
import { Callout, Empty, HBar, Icon, RoleBadge, type IconName } from '../components/ui';
import { int, pct } from '../lib/format';
import {
  ageText,
  ANSWER_FILTERS,
  ANSWER_STATUS_LABELS,
  answersOf,
  countByFilter,
  criteriaRows,
  displayPath,
  domainRole,
  filterAnswers,
  formatLatency,
  groupSkips,
  intervalParts,
  isOwnDomain,
  NO_QUESTION_TEXT,
  questionIndex,
  sampleRange,
  sampleText,
  score10Text,
  SKIP_ACTION_LABELS,
  sortEngines,
  sortWinners,
  usageParts,
  winnerAxes,
  wordsText,
  type AnswerFilter,
  type AnswerStatus,
  type SkipGroup,
} from '../lib/geo';
import './geo.css';

// "ИИ видимост": what ChatGPT, Claude and Gemini actually say about the business. One column per engine (how often we are
// cited or named, who is cited instead, the latest answers), then why the engines skip us question by question and the
// pages they cite instead. Everything that came from an engine or from the web is rendered as text, never as markup.

const FEED_FIRST = 8;
const FEED_STEP = 8;
const CARDS_FIRST = 6;
const CARDS_STEP = 6;
const DOMAINS_FIRST = 5;

// ───────────────────────── small parts ─────────────────────────

const STATUS_ICON: Record<AnswerStatus, IconName> = { cited: 'check', named: 'info', missing: 'x', failed: 'alert' };

/** A state is an icon, a word and a tint — never the tint alone. */
function StatusChip({ status }: { status: AnswerStatus }): JSX.Element {
  return (
    <span class={`badge geo-st geo-st-${status}`}>
      <Icon name={STATUS_ICON[status]} size={13} />
      {ANSWER_STATUS_LABELS[status]}
    </span>
  );
}

function EngineBadge({ engine, skipped }: { engine: EngineId; skipped?: boolean }): JSX.Element {
  return (
    <span class="badge geo-engine-badge">
      {skipped ? <Icon name="x" size={12} /> : null}
      {ENGINE_LABELS[engine]}
    </span>
  );
}

/** A source an engine named: the domain as a link to the page, our own marked with the word "ти" as well as a border. */
function SourceChip({ citation, own }: { citation: AnswerRecord['citations'][number]; own: boolean }): JSX.Element {
  return (
    <span class={`chip geo-src${own ? ' is-own' : ''}`} title={citation.title || citation.url}>
      <PageLink url={citation.url}>{citation.domain || displayPath(citation.url)}</PageLink>
      {own ? <span class="geo-own-tag">ти</span> : null}
    </span>
  );
}

/** A domain with a break point after each dot, so a long one wraps between its parts instead of in the middle of a word. */
function Dom({ value }: { value: string }): JSX.Element {
  const parts = value.split('.');
  return (
    <>
      {parts.map((part, i) => (
        <span key={`${i}-${part}`}>
          {part}
          {i < parts.length - 1 ? (
            <>
              .<wbr />
            </>
          ) : null}
        </span>
      ))}
    </>
  );
}

/** "Покажи още 8 (остават 16)" while there is more, "Покажи по-малко" once everything is out. */
function ShowMore({ total, shown, first, step, onChange, what }: { total: number; shown: number; first: number; step: number; onChange: (n: number) => void; what: string }): JSX.Element | null {
  if (total <= first) return null;
  const left = total - shown;
  return left > 0 ? (
    <button type="button" class="btn btn-sm geo-more" onClick={() => onChange(Math.min(total, shown + step))}>
      Покажи още {Math.min(step, left)}
      {left > step ? <span class="muted"> (остават {left})</span> : null}
      <span class="sr-only"> {what}</span>
    </button>
  ) : (
    <button type="button" class="btn btn-sm geo-more" onClick={() => onChange(first)}>
      Покажи по-малко<span class="sr-only"> {what}</span>
    </button>
  );
}

// ───────────────────────── one engine ─────────────────────────

function AnswerCard({ answer, question, request }: { answer: AnswerRecord; question: string; request: SiteAuditRequest }): JSX.Element {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const failed = answer.status === 'failed';
  const shownSources = answer.citations.slice(0, 3);
  const moreSources = answer.citations.length - shownSources.length;
  const hasDetail = answer.excerpt.trim() !== '' || answer.citations.length > 0 || (failed && !!answer.error);

  return (
    <li class={`geo-answer is-${answer.status}`}>
      <div class="geo-answer-top">
        <StatusChip status={answer.status} />
        <span class="geo-latency" title="Време за отговор на двигателя">
          {formatLatency(answer.latencyMs)}
        </span>
      </div>
      <p class="geo-q">{question}</p>

      {failed ? (
        <p class="geo-error small">{answer.error ? `Грешка: ${answer.error}` : 'Двигателят не върна отговор.'}</p>
      ) : (
        <dl class="geo-metrics">
          <div>
            <dt>Позиция</dt>
            <dd>{answer.position !== null ? `#${answer.position}` : '—'}</dd>
          </div>
          <div>
            <dt>Дял</dt>
            <dd>{pct(answer.share)}</dd>
          </div>
          <div>
            <dt title="Колко топло говори отговорът за нас, когато ни назовава">Тон</dt>
            <dd>{answer.sentiment !== null ? pct(answer.sentiment) : '—'}</dd>
          </div>
        </dl>
      )}

      {shownSources.length > 0 ? (
        <div class="geo-line">
          <span class="geo-lbl">Източници</span>
          <span class="geo-chips">
            {shownSources.map((c, i) => (
              <SourceChip key={`${c.url}-${i}`} citation={c} own={isOwnDomain(c.domain, request)} />
            ))}
            {moreSources > 0 ? <span class="chip geo-more-chip">+{moreSources}</span> : null}
          </span>
        </div>
      ) : null}
      {answer.brands.length > 0 ? (
        <div class="geo-line">
          <span class="geo-lbl">Назовани конкуренти</span>
          <span class="geo-brands">{answer.brands.join(', ')}</span>
        </div>
      ) : null}

      {hasDetail ? (
        <>
          <button type="button" class="geo-exp" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
            <Icon name="chevron" size={14} />
            {failed ? 'Подробности' : 'Откъс от отговора'}
          </button>
          <div id={panel} class="geo-exp-body" hidden={!open}>
            {answer.excerpt.trim() ? <p class="geo-excerpt">{answer.excerpt}</p> : null}
            {answer.citations.length > 0 ? (
              <ul class="geo-sources">
                {answer.citations.map((c, i) => (
                  <li key={`${c.url}-${i}`}>
                    <PageLink url={c.url}>{c.title || c.domain || c.url}</PageLink>
                    <span class="muted xs"> · {c.domain}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {failed && answer.error ? <p class="small muted">{answer.error}</p> : null}
          </div>
        </>
      ) : null}
    </li>
  );
}

function Feed({ name, answers, texts, request }: { name: string; answers: AnswerRecord[]; texts: ReadonlyMap<string, string>; request: SiteAuditRequest }): JSX.Element {
  const head = useId();
  const [filter, setFilter] = useState<AnswerFilter>('all');
  const [shown, setShown] = useState(FEED_FIRST);
  const counts = useMemo(() => countByFilter(answers), [answers]);
  const rows = useMemo(() => filterAnswers(answers, filter), [answers, filter]);
  const visible = rows.slice(0, shown);

  return (
    <div class="geo-sec geo-feed" role="group" aria-labelledby={head}>
      <h4 class="section-title" id={head}>
        Последни отговори
      </h4>
      <div class="chips" role="group" aria-label={`Филтър на отговорите на ${name}`}>
        {ANSWER_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            class="chip chip-btn"
            aria-pressed={filter === f.id}
            onClick={() => {
              setFilter(f.id);
              setShown(FEED_FIRST);
            }}
          >
            {f.label} <b>{counts[f.id]}</b>
          </button>
        ))}
      </div>
      <p class="sr-only" role="status">
        Показани {visible.length} от {bgCount(rows.length, 'отговор', 'отговора')}
      </p>
      {rows.length === 0 ? (
        <p class="small muted geo-none">{answers.length === 0 ? 'Няма записани отговори на този двигател.' : 'Няма отговори по този филтър.'}</p>
      ) : (
        <ol class="geo-answers" role="list">
          {visible.map((a) => (
            <AnswerCard key={`${a.engine}:${a.questionId}`} answer={a} question={texts.get(a.questionId) ?? NO_QUESTION_TEXT} request={request} />
          ))}
        </ol>
      )}
      <ShowMore total={rows.length} shown={shown} first={FEED_FIRST} step={FEED_STEP} onChange={setShown} what={`отговори на ${name}`} />
    </div>
  );
}

function TopCited({ run, request }: { run: EngineRun; request: SiteAuditRequest }): JSX.Element {
  const head = useId();
  const [shown, setShown] = useState(DOMAINS_FIRST);
  const rows = run.topCited.map((c) => ({ ...c, role: domainRole(c.domain, request) }));
  // our own domain is always shown, wherever it ranks
  const visible = rows.filter((r, i) => i < shown || r.role === 'own');
  const kinds = new Set(visible.map((r) => r.role));

  return (
    <div class="geo-sec geo-cited" role="group" aria-labelledby={head}>
      <h4 class="section-title" id={head}>
        Най-цитирани домейни
      </h4>
      {rows.length === 0 ? (
        <p class="small muted">{run.search ? 'В отговорите няма посочени източници.' : 'Без търсене в мрежата двигателят не посочва източници, затова се отчита само дали ни назовава.'}</p>
      ) : (
        <>
          <div class="hbars">
            {visible.map((r) => (
              <HBar
                key={r.domain}
                stacked
                label={
                  <span class="geo-dom-row">
                    <span class="geo-dom">
                      <Dom value={r.domain} />
                    </span>
                    {r.role === 'own' ? <RoleBadge role="own" /> : r.role === 'competitor' ? <span class="badge badge-tracked">конкурент</span> : null}
                  </span>
                }
                sub={bgCount(r.answers, 'отговор', 'отговора')}
                value={r.share}
                text={pct(r.share)}
                {...(r.role === 'own' ? { tone: 'own' as const } : r.role === 'other' ? { tone: 'other' as const } : {})}
              />
            ))}
          </div>
          {kinds.size > 1 ? (
            <div class="legend geo-legend">
              {kinds.has('own') ? (
                <span>
                  <i class="swatch" style={{ background: 'var(--accent-2)' }} />
                  ти
                </span>
              ) : null}
              {kinds.has('competitor') ? (
                <span>
                  <i class="swatch" style={{ background: 'var(--accent)' }} />
                  конкурент от списъка
                </span>
              ) : null}
              {kinds.has('other') ? (
                <span>
                  <i class="swatch" style={{ background: 'var(--deemph)' }} />
                  други
                </span>
              ) : null}
            </div>
          ) : null}
          <ShowMore total={rows.length} shown={shown} first={DOMAINS_FIRST} step={DOMAINS_FIRST} onChange={setShown} what="домейни" />
        </>
      )}
    </div>
  );
}

function EngineCard({ run, answers, texts, request }: { run: EngineRun; answers: AnswerRecord[]; texts: ReadonlyMap<string, string>; request: SiteAuditRequest }): JSX.Element {
  const head = useId();
  const name = run.label || ENGINE_LABELS[run.engine];
  const none = run.answered === 0;
  const { citedInstead } = run;
  const interval = intervalParts(run.rate, run.rateLow, run.rateHigh);

  // Six direct children, always: in a wide layout the columns line their rows up (a subgrid), so none may come and go.
  return (
    <article class="card geo-engine" aria-labelledby={head}>
      <header class="geo-engine-head">
        <div class="geo-engine-name">
          <h3 id={head}>{name}</h3>
          <span class="geo-model">{run.model}</span>
        </div>
        <span class="badge" title={run.search ? 'Двигателят е ползвал търсене в мрежата, затова отговорите му имат източници.' : 'Без търсене в мрежата двигателят отговаря само от наученото и не посочва източници.'}>
          <Icon name={run.search ? 'search' : 'doc'} size={13} />
          {run.search ? 'с търсене в мрежата' : 'само знания на модела'}
        </span>
      </header>

      <div class="geo-hero">
        <Donut value={none ? null : run.rate} low={none ? null : run.rateLow} high={none ? null : run.rateHigh} label={`${name}: дял на отговорите, в които сме цитирани или назовани`} />
        <div class="geo-hero-text">
          {none ? (
            <p class="geo-hero-lead">Няма отговори{run.failed > 0 ? `: ${bgCount(run.failed, 'заявка е неуспешна', 'заявки са неуспешни')}` : ''}</p>
          ) : (
            <>
              <p class="geo-hero-lead">
                Цитирани или назовани сме в <b>{run.citingUs}</b> от <b>{run.answered}</b> {run.answered === 1 ? 'отговор' : 'отговора'}
              </p>
              <p class="geo-hero-interval">
                <i class="geo-arc-key" aria-hidden="true" />
                <span class="nowrap">{interval.value}</span> <span class="nowrap">{interval.note}</span>
              </p>
            </>
          )}
        </div>
      </div>

      <dl class="geo-stats">
        <div class="geo-stat">
          <dt>{run.citingUs === 1 ? 'отговор с нас' : 'отговора с нас'}</dt>
          <dd>{int(run.citingUs)}</dd>
        </div>
        <div class="geo-stat">
          <dt>{run.skippingUs === 1 ? 'отговор без нас' : 'отговора без нас'}</dt>
          <dd>{int(run.skippingUs)}</dd>
        </div>
        <div class="geo-stat">
          <dt>{run.failed === 1 ? 'неуспешен' : 'неуспешни'}</dt>
          <dd>{int(run.failed)}</dd>
        </div>
        <div class="geo-stat">
          <dt>Цитиран вместо нас</dt>
          <dd class="geo-stat-text">
            {citedInstead ? (
              <>
                <span class="geo-dom">
                    <Dom value={citedInstead.domain} />
                  </span>
                <span class="geo-stat-note">{bgCount(citedInstead.answers, 'отговор', 'отговора')}</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>

      <p class="geo-usage" title={`Токени: ${int(run.usage.inputTokens)} вход, ${int(run.usage.outputTokens)} изход`}>
        {usageParts(run.usage).map((part, i) => (
          <span key={part}>
            {i > 0 ? ' · ' : ''}
            <span class="nowrap">{part}</span>
          </span>
        ))}
      </p>

      <TopCited run={run} request={request} />
      <Feed name={name} answers={answers} texts={texts} request={request} />
    </article>
  );
}

// ───────────────────────── why the engines skip us ─────────────────────────

function Criteria({ rows }: { rows: ReturnType<typeof criteriaRows> }): JSX.Element {
  return (
    <ul class="geo-crit" role="list">
      {rows.map((r) => (
        <li key={r.key} class="hbar geo-crit-row">
          <span class="hbar-label">{r.label}</span>
          {r.value === null ? (
            <>
              <span class="hbar-track geo-crit-gap" aria-hidden="true" />
              <span class="hbar-value muted" title="Не може да се прецени">
                н/д<span class="sr-only"> (не може да се прецени)</span>
              </span>
            </>
          ) : (
            <>
              <span class="hbar-track" aria-hidden="true">
                <span class="hbar-fill" style={{ width: `${Math.round(r.value * 100)}%`, display: 'block' }} />
              </span>
              <span class="hbar-value">{pct(r.value)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function ActionChip({ action }: { action: SkipAnalysis['action'] }): JSX.Element {
  return (
    <span class={`badge geo-action geo-action-${action}`}>
      <Icon name={action === 'create' ? 'plus' : 'refresh'} size={13} />
      {SKIP_ACTION_LABELS[action]}
    </span>
  );
}

function SkipCard({ group }: { group: SkipGroup }): JSX.Element {
  const { page } = group;
  const detail = page.detail;
  const words = wordsText(page.words);

  return (
    <article class="card geo-skip">
      <header class="geo-skip-head">
        <h3 class="geo-skip-q">{group.question || NO_QUESTION_TEXT}</h3>
        <span class="geo-actions">
          {group.actions.map((a) => (
            <ActionChip key={a} action={a} />
          ))}
        </span>
      </header>

      <div class="geo-line">
        <span class="geo-lbl">Не ни цитират</span>
        <span class="geo-chips">
          {group.engines.map((e) => (
            <EngineBadge key={e} engine={e} skipped />
          ))}
        </span>
      </div>

      <div class="geo-skip-body">
        <section class="geo-skip-col">
          <h4 class="section-title">Цитира се вместо нас</h4>
          <ul class="geo-instead" role="list">
            {group.items.map((item) => (
              <li key={item.engine}>
                <EngineBadge engine={item.engine} />
                {item.winner ? (
                  <span class="geo-instead-what">
                    <span class="geo-dom">{item.winner.url ? <PageLink url={item.winner.url}><Dom value={item.winner.domain} /></PageLink> : <Dom value={item.winner.domain} />}</span>
                    <span class="muted xs">{SOURCE_KIND_LABELS[item.winner.kind]}</span>
                  </span>
                ) : (
                  <span class="muted small">без посочен източник</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section class="geo-skip-col">
          <h4 class="section-title">Нашата страница</h4>
          {page.exists ? (
            <>
              <p class="geo-page">
                {page.url ? (
                  <PageLink url={page.url}>
                    <span class="geo-dom" title={page.url}>
                      {displayPath(page.url) === '/' ? 'началната страница' : displayPath(page.url)}
                    </span>
                  </PageLink>
                ) : (
                  <span class="muted">адресът не е известен</span>
                )}
              </p>
              <p class="small muted">{[words, ageText(page.ageMonths)].filter(Boolean).join(' · ')}</p>
            </>
          ) : (
            <p class="geo-nopage">
              <Icon name="alert" size={15} />
              няма страница по този въпрос
            </p>
          )}
          {detail ? (
            <div class="geo-citability">
              <Score value={detail.score10} label="Цитируемост на нашата страница" />
              <Criteria rows={criteriaRows(detail.criteria)} />
            </div>
          ) : null}
        </section>
      </div>

      {group.reasons.length > 0 ? (
        <div class="geo-line geo-reasons">
          <span class="geo-lbl">Причини</span>
          <span class="geo-chips">
            {group.reasons.map((r) => (
              <span key={r} class="chip">
                {SKIP_REASON_LABELS[r]}
              </span>
            ))}
          </span>
        </div>
      ) : null}
    </article>
  );
}

/** Why there is nothing to list: no engine answered, we are in every answer, or the audit has no such analysis. */
function nothingSaid(geo: Geo, what: 'skips' | 'winners'): string {
  const answered = geo.engines.reduce((sum, e) => sum + e.answered, 0);
  const lost = geo.answers.filter((a) => a.status === 'missing').length;
  if (answered === 0) return 'Двигателите не върнаха нито един отговор, затова няма какво да се анализира.';
  if (lost === 0) return what === 'skips' ? 'Няма въпроси, по които двигателите да ни пропускат — във всеки отговор сме цитирани или назовани.' : 'Няма страници, които да ни изпреварват: нямаше отговор, в който двигател да ни пропуска.';
  return what === 'skips' ? 'Този одит няма анализ на пропуснатите въпроси.' : 'Няма прочетени страници на победителите: двигателите не са посочили източници (без търсене в мрежата няма цитати) или страниците не са могли да се прочетат.';
}

function SkipSection({ groups, geo }: { groups: SkipGroup[]; geo: Geo }): JSX.Element {
  const head = useId();
  const [shown, setShown] = useState(CARDS_FIRST);

  return (
    <section id={SKIPS_ID} class="geo-anchor" aria-labelledby={head}>
      <div class="card-head">
        <h2 id={head}>Защо двигателите ни пропускат</h2>
        <p>по въпрос: първо тези, по които ни пропускат най-много двигатели</p>
      </div>
      {groups.length === 0 ? (
        <Callout>{nothingSaid(geo, 'skips')}</Callout>
      ) : (
        <>
          <div class="geo-skips">
            {groups.slice(0, shown).map((g) => (
              <SkipCard key={g.questionId} group={g} />
            ))}
          </div>
          <div class="geo-more-row">
            <ShowMore total={groups.length} shown={shown} first={CARDS_FIRST} step={CARDS_STEP} onChange={setShown} what="въпроси" />
          </div>
        </>
      )}
    </section>
  );
}

// ───────────────────────── pages the engines cite ─────────────────────────

function Score({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div class="geo-score" role="img" aria-label={`${label}: ${score10Text(value)} от 10`}>
      <span class="geo-score-num">{score10Text(value)}</span>
      <span class="geo-score-of">/10</span>
      <span class="geo-score-cap">цитируемост</span>
    </div>
  );
}

function WinnerCard({ page }: { page: WinnerPage }): JSX.Element {
  const words = wordsText(page.words);
  return (
    <article class="card geo-win">
      <header class="geo-win-head">
        <h3 class="geo-win-domain">
          <PageLink url={page.url}>
            <span class="geo-dom">
              <Dom value={page.domain} />
            </span>
            {safeHref(page.url) ? (
              <>
                {' '}
                <Icon name="external" size={13} />
              </>
            ) : null}
          </PageLink>
        </h3>
        <span class="badge">{SOURCE_KIND_LABELS[page.kind]}</span>
      </header>
      {page.title ? (
        <p class="geo-win-title" title={page.title}>
          {page.title}
        </p>
      ) : null}
      <p class="geo-win-meta">
        <EngineBadge engine={page.engine} />
        <span>цитирана в {bgCount(page.citedIn, 'отговор', 'отговора')}</span>
        {words ? <span>{words}</span> : null}
      </p>

      <div class="geo-win-body">
        <div class="geo-radar-box">
          <Radar axes={winnerAxes(page.radar)} title={`Профил на страницата на ${page.domain}`} />
        </div>
        <div class="geo-win-side">
          <Score value={page.score10} label="Оценка на страницата" />
          {page.whyCited.length > 0 ? (
            <div>
              <h4 class="section-title">Защо я цитират</h4>
              <ul class="geo-why">
                {page.whyCited.map((w, i) => (
                  <li key={`${i}-${w}`}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function WinnerSection({ winners, geo }: { winners: WinnerPage[]; geo: Geo }): JSX.Element {
  const head = useId();
  const [shown, setShown] = useState(CARDS_FIRST);

  return (
    <section id={WINNERS_ID} class="geo-anchor" aria-labelledby={head}>
      <div class="card-head">
        <h2 id={head}>Страници, които двигателите цитират</h2>
        <p>прочетени, за да се види какво ги прави цитируеми</p>
      </div>
      {winners.length === 0 ? (
        <Callout>{nothingSaid(geo, 'winners')}</Callout>
      ) : (
        <>
          <div class="geo-wins">
            {winners.slice(0, shown).map((w) => (
              <WinnerCard key={`${w.engine}:${w.url}`} page={w} />
            ))}
          </div>
          <div class="geo-more-row">
            <ShowMore total={winners.length} shown={shown} first={CARDS_FIRST} step={CARDS_STEP} onChange={setShown} what="страници" />
          </div>
        </>
      )}
    </section>
  );
}

// ───────────────────────── the tab ─────────────────────────

function NotAsked(): JSX.Element {
  return (
    <Empty title="ИИ двигателите не са питани">
      Тази част от одита задава въпросите на купувачите ти на ChatGPT, Claude и Gemini и проверява дали те цитират сайта. Тя заработва, когато на сървъра има поне един от ключовете <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code> или{' '}
      <code>GEMINI_API_KEY</code>. Останалата част от одита е пълна и без тях. Виж <a href="#/settings">Настройки</a>.
    </Empty>
  );
}

const SKIPS_ID = 'geo-skips';
const WINNERS_ID = 'geo-winners';

/** The hash belongs to the router, so a jump inside the page is a scroll, not a link to "#something". */
function jumpTo(id: string): void {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

function GeoReport({ audit, geo }: { audit: SiteAuditReport; geo: Geo }): JSX.Element {
  const engines = sortEngines(geo.engines);
  const texts = useMemo(() => questionIndex(audit.questions, geo.skips), [audit.questions, geo.skips]);
  const groups = useMemo(() => groupSkips(geo.skips, texts), [geo.skips, texts]);
  const winners = useMemo(() => sortWinners(geo.winners), [geo.winners]);
  const heading = useId();
  const sample = sampleText(sampleRange(engines, audit.questions.length));

  return (
    <div class="stack-lg geo">
      <p class="muted geo-intro">
        Задавахме въпросите на купувачите на всеки двигател и проверихме дали сме цитирани или назовани, и кой е цитиран вместо нас. Резултатът е проба от {sample}, не пълна картина — отговорите на ИИ се менят.
      </p>

      {groups.length + winners.length > 0 ? (
        <div class="geo-jump">
          <span class="geo-lbl">Към раздел</span>
          {groups.length > 0 ? (
            <button type="button" class="chip chip-btn" onClick={() => jumpTo(SKIPS_ID)}>
              Защо ни пропускат <b>{groups.length}</b>
            </button>
          ) : null}
          {winners.length > 0 ? (
            <button type="button" class="chip chip-btn" onClick={() => jumpTo(WINNERS_ID)}>
              Страници, които цитират <b>{winners.length}</b>
            </button>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby={heading}>
        <div class="card-head">
          <h2 id={heading}>Какво казват двигателите</h2>
          <p>цитиран — сайтът ни е сред източниците; назован — марката ни е в текста, без връзка</p>
        </div>
        <div class={`geo-engines geo-engines-${engines.length}`}>
          {engines.map((run) => (
            <EngineCard key={run.engine} run={run} answers={answersOf(geo.answers, run.engine)} texts={texts} request={audit.request} />
          ))}
        </div>
      </section>

      <SkipSection groups={groups} geo={geo} />
      <WinnerSection winners={winners} geo={geo} />
    </div>
  );
}

export function GeoTab({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const { geo } = audit;
  return geo && geo.engines.length > 0 ? <GeoReport audit={audit} geo={geo} /> : <NotAsked />;
}
