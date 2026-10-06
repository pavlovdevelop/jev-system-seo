import { Fragment, type JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { PAGE_TYPE_LABELS } from '../../shared/domain';
import type { CompetitorPage, SiteAuditReport } from '../../shared/audit';
import { Breakable, Headline, Pips, Verdict } from '../components/Pips';
import { PageLink } from '../components/details';
import { Empty, Icon, MiniBar } from '../components/ui';
import { COMPETITOR_SCORES, competitorCounts, filterCompetitors, pathOf, sortCompetitors, type CompetitorFilter } from '../lib/audit';
import { pct } from '../lib/format';

// Panel 02: the competitors' pages that were read in depth, scored on five things, with a verdict: steal the technique or skip.

const FILTERS: ReadonlyArray<{ id: CompetitorFilter; label: string }> = [
  { id: 'all', label: 'Всички' },
  { id: 'steal', label: 'Копирай' },
  { id: 'skip', label: 'Пропусни' },
];

const googleRank = (c: CompetitorPage): string => (c.googleRank === null ? '—' : `#${c.googleRank}`);

/** The "opens in a new tab" mark that stays with the last piece of a link. */
const Ext = (): JSX.Element => (
  <span class="au-ext">
    <Icon name="external" size={12} />
  </span>
);

function Detail({ c }: { c: CompetitorPage }): JSX.Element {
  return (
    <div class="grid grid-2">
      <div class="stack">
        <div>
          <div class="section-title">Защо</div>
          <p>{c.why}</p>
        </div>
        <div>
          <div class="section-title">Какво прави тя, което ние не правим</div>
          {c.techniques.length === 0 ? (
            <p class="small muted">Няма конкретна техника за копиране.</p>
          ) : (
            <ul class="stack" style={{ margin: 0, paddingLeft: '18px' }}>
              {c.techniques.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </div>
        <p class="small">
          <span class="muted">Срещу нашата страница: </span>
          {c.ourUrl ? <PageLink url={c.ourUrl}><Breakable text={pathOf(c.ourUrl)} after={<Ext />} /></PageLink> : <span class="muted">нямаме страница за тази фраза</span>}
        </p>
      </div>
      <dl class="kv">
        {COMPETITOR_SCORES.map((s) => (
          <Fragment key={s.key}>
            <dt>{s.label}</dt>
            <dd class="row" style={{ gap: '10px' }}>
              <Pips value={c.scores[s.key]} label={s.label} />
              <span class="muted">{pct(c.scores[s.key])}</span>
            </dd>
          </Fragment>
        ))}
        <dt>Обща оценка</dt>
        <dd>{pct(c.overall)}</dd>
        <dt>Фраза</dt>
        <dd>{c.phrase}</dd>
        <dt>Тип страница</dt>
        <dd>{c.type ? PAGE_TYPE_LABELS[c.type] : '—'}</dd>
        <dt>Заглавие</dt>
        <dd>{c.title}</dd>
        <dt>Google</dt>
        <dd>{googleRank(c)}</dd>
        <dt>Цитира го ИИ</dt>
        <dd>{c.aiShare === null ? 'не е проверявано' : `${pct(c.aiShare)} от отговорите`}</dd>
      </dl>
    </div>
  );
}

export function CompetitorsTab({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const [filter, setFilter] = useState<CompetitorFilter>('all');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const all = audit.competitorPages;
  const counts = useMemo(() => competitorCounts(all), [all]);
  const rows = useMemo(() => sortCompetitors(filterCompetitors(all, filter)), [all, filter]);
  const keyOf = (c: CompetitorPage): string => `${c.domain}|${c.url}`;
  const toggle = (key: string): void =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  if (all.length === 0) {
    return <Empty title="Няма прочетени конкурентни страници">Нужен е SERP доставчик, за да намерим страниците, които водят в Google — добави ключ в „Настройки“.</Empty>;
  }
  const allOpen = rows.length > 0 && rows.every((c) => open.has(keyOf(c)));

  return (
    <div class="stack-lg">
      <Headline value={counts.steal} unit="страници за копиране">
        от {counts.all} прочетени конкурентни страници — оценени по отговор, дълбочина, доказателства, schema и свежест.
      </Headline>

      <section>
        <div class="toolbar" role="group" aria-label="Филтър по решение">
          <div class="chips">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" class="chip chip-btn" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} <b>{counts[f.id]}</b>
              </button>
            ))}
          </div>
          <button type="button" class="btn btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map(keyOf)))}>
            {allOpen ? 'Свий всички' : 'Разгъни всички'}
          </button>
        </div>

        <div class="table-wrap">
          <table class="table au-table mid">
            <caption class="sr-only">Конкурентни страници с оценка по пет показателя и решение</caption>
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">Подробности</span></th>
                <th scope="col">Конкурент · страница</th>
                {COMPETITOR_SCORES.map((s) => (
                  <th key={s.key} scope="col" class="hide-sm">{s.label}</th>
                ))}
                <th scope="col" class="num hide-sm">Google</th>
                <th scope="col" class="num hide-sm" title="Дял от отговорите на ИИ, които цитират този сайт">ИИ цитира</th>
                <th scope="col" class="hide-sm">Решение</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10}><Empty title="Няма страници по този филтър" /></td>
                </tr>
              ) : null}
              {rows.map((c) => {
                const key = keyOf(c);
                const isOpen = open.has(key);
                return (
                  <Fragment key={key}>
                    <tr class={`${isOpen ? 'is-open ' : ''}${c.verdict === 'steal' ? 'is-steal' : ''}`}>
                      <td>
                        <button type="button" class="row-toggle" aria-expanded={isOpen} aria-label={`Подробности за ${c.domain}${pathOf(c.url)}`} onClick={() => toggle(key)}>
                          <Icon name="chevron" size={14} />
                        </button>
                      </td>
                      <td class="au-page">
                        <div class="cell-main"><Breakable text={c.domain} /></div>
                        <div class="cell-sub">
                          <PageLink url={c.url}>
                            <Breakable text={pathOf(c.url)} after={<Ext />} />
                          </PageLink>
                        </div>
                        <div class="show-sm" style={{ marginTop: '6px' }}>
                          <div class="row" style={{ gap: '10px' }}>
                            <Verdict kind={c.verdict} />
                            <span class="xs muted">оценка</span>
                            <MiniBar value={c.overall} />
                          </div>
                        </div>
                      </td>
                      {COMPETITOR_SCORES.map((s) => (
                        <td key={s.key} class="hide-sm"><Pips value={c.scores[s.key]} label={s.label} /></td>
                      ))}
                      <td class="num hide-sm">{googleRank(c)}</td>
                      <td class="num hide-sm">{c.aiShare === null ? '—' : pct(c.aiShare)}</td>
                      <td class="hide-sm"><Verdict kind={c.verdict} /></td>
                    </tr>
                    {isOpen ? (
                      <tr class="detail">
                        <td colSpan={10}><Detail c={c} /></td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p class="small muted" style={{ marginTop: '10px' }}>
          Подредбата е по обща оценка на страницата. „Копирай“ означава, че страницата прави нещо, което струва да вземем; „Пропусни“ — че няма какво да научим от нея.
        </p>
      </section>
    </div>
  );
}
