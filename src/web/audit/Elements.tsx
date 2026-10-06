import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { ElementVerdict, SiteAuditReport, SitePage } from '../../shared/audit';
import { Breakable, Headline, Verdict } from '../components/Pips';
import { Confidence, Empty } from '../components/ui';
import { bgCount } from '../../shared/plural';
import { bgNoun, ELEMENT_LABELS, elementCounts, filterElements, pathOf, SEO_ELEMENTS, sortElements, type ElementFilter, type ElementSort } from '../lib/audit';
import { int } from '../lib/format';

// Panel 01: every SEO element of every page, judged one by one — what it says now, what to change it to and who wrote that.

const PAGE_SIZE = 50;

/** The sure-ness of a verdict: a rule is always 100%, a judgement carries Jev's own confidence. */
function Sureness({ e }: { e: ElementVerdict }): JSX.Element {
  return (
    <div class="stack" style={{ gap: '2px' }}>
      {e.source === 'rule' ? (
        <span class="dots" title="Обективно правило — сигурност 100%">
          <i class="on" />
          <i class="on" />
          <i class="on" />
          <span class="sr-only">сигурност висока</span>
        </span>
      ) : (
        <Confidence value={e.confidence} />
      )}
      <span class="xs muted">{e.source === 'rule' ? 'правило' : 'Jev'}</span>
    </div>
  );
}

/** Who wrote a proposal. The tag stays with the last word, so it never sits alone on a line. */
function By({ by }: { by: 'rule' | 'llm' }): JSX.Element {
  return (
    <span class="au-by" title={by === 'llm' ? 'Предложението е написано от езиков модел' : 'Предложението е по фиксирано правило'} aria-hidden="true">
      {by === 'llm' ? 'ИИ' : 'правило'}
    </span>
  );
}

/** The proposal with its tag; a very long last word (an address) is left to wrap on its own. */
function Proposal({ text, by }: { text: string; by: 'rule' | 'llm' | null }): JSX.Element {
  if (!by) return <>{text}</>;
  const m = /^([\s\S]*\s)?(\S+)$/.exec(text);
  const head = m?.[1] ?? '';
  const last = m?.[2] ?? text;
  return last.length > 24 ? (
    <>
      {text}
      <By by={by} />
    </>
  ) : (
    <>
      {head}
      <span class="nowrap">
        {last}
        <By by={by} />
      </span>
    </>
  );
}

function Diff({ e }: { e: ElementVerdict }): JSX.Element {
  return (
    <div class="au-diff">
      {e.verdict === 'change' ? (
        <>
          <div class="au-old">
            <span class="sr-only">Сега: </span>
            <s>{e.now}</s>
          </div>
          <div class="au-new">
            <span class="au-arrow" aria-hidden="true">→</span>
            <span>
              <span class="sr-only">Предложение{e.proposalBy ? ` (${e.proposalBy === 'llm' ? 'от ИИ' : 'по правило'})` : ''}: </span>
              <Proposal text={e.proposal ?? 'виж причината'} by={e.proposalBy} />
            </span>
          </div>
        </>
      ) : (
        <div>
          <span class="sr-only">Сега: </span>
          {e.now}
        </div>
      )}
      <div class="cell-sub">{e.reason}</div>
    </div>
  );
}

function Row({ e, page }: { e: ElementVerdict; page: SitePage | undefined }): JSX.Element {
  const path = page?.path ?? pathOf(e.url);
  const rank = page?.rank ?? null;
  return (
    <tr class={e.verdict === 'change' ? 'is-change' : ''}>
      <td class="au-page">
        <div class="cell-main" title={e.url}><Breakable text={path} /></div>
        <div class="show-sm xs muted">{ELEMENT_LABELS[e.element]}</div>
        <div class="show-sm" style={{ marginTop: '6px' }}><Verdict kind={e.verdict} /></div>
      </td>
      <td class="hide-sm">{ELEMENT_LABELS[e.element]}</td>
      <td><Diff e={e} /></td>
      <td class="num hide-sm" title={rank !== null && page?.phrase ? `Позиция в Google за „${page.phrase}“` : 'Позицията не е проверена или страницата е извън резултатите'}>{rank !== null ? `#${rank}` : '—'}</td>
      <td class="hide-sm"><Sureness e={e} /></td>
      <td class="hide-sm"><Verdict kind={e.verdict} /></td>
    </tr>
  );
}

export function ElementsTab({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const all = audit.elements;
  const [filter, setFilter] = useState<ElementFilter>({ verdict: 'all', element: 'all', query: '' });
  const [sort, setSort] = useState<ElementSort>('impact');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const pages = useMemo(() => new Map(audit.pages.map((p) => [p.url, p])), [audit.pages]);
  const change = (patch: Partial<ElementFilter>): void => {
    setFilter((f) => ({ ...f, ...patch }));
    setLimit(PAGE_SIZE);
  };

  const rows = useMemo(() => sortElements(filterElements(all, filter), sort), [all, filter, sort]);
  const counts = useMemo(() => elementCounts(all, filter), [all, filter]);
  const kinds = SEO_ELEMENTS.filter((k) => all.some((e) => e.element === k));
  const shown = rows.slice(0, limit);

  if (all.length === 0) {
    return <Empty title="Няма оценени SEO елементи">Страниците не бяха прочетени или оценката им не завърши — виж бележките в „Преглед“.</Empty>;
  }

  return (
    <div class="stack-lg">
      <Headline value={int(audit.figures.elementsToChange)} unit={`${bgNoun(audit.figures.elementsToChange, 'елемент', 'елемента')} за промяна`}>
        от {bgCount(audit.figures.elementsTotal, 'оценен елемент', 'оценени елемента')} на {bgCount(audit.site.pagesAudited, 'страница', 'страници')} — всеки е оценен поотделно, с предложение и кой го е написал.
      </Headline>

      <section>
        <div class="toolbar" role="group" aria-label="Филтри за елементите">
          <div class="chips">
            {(['all', 'change', 'keep'] as const).map((v) => (
              <button key={v} type="button" class="chip chip-btn" aria-pressed={filter.verdict === v} onClick={() => change({ verdict: v })}>
                {v === 'all' ? 'Всички' : v === 'change' ? 'За промяна' : 'За запазване'} <b>{counts.verdict[v]}</b>
              </button>
            ))}
          </div>
          <input class="input" type="search" placeholder="Търси по адрес…" aria-label="Търсене по адрес на страницата" value={filter.query} onInput={(e) => change({ query: e.currentTarget.value })} />
          <select class="select" aria-label="Подредба" value={sort} onChange={(e) => setSort(e.currentTarget.value === 'page' ? 'page' : 'impact')}>
            <option value="impact">Подреди по: влияние</option>
            <option value="page">Подреди по: страница</option>
          </select>
        </div>
        <div class="chips" role="group" aria-label="Вид елемент" style={{ marginBottom: '14px' }}>
          <button type="button" class="chip chip-btn" aria-pressed={filter.element === 'all'} onClick={() => change({ element: 'all' })}>
            Всички елементи <b>{counts.all}</b>
          </button>
          {kinds.map((k) => (
            <button key={k} type="button" class="chip chip-btn" aria-pressed={filter.element === k} onClick={() => change({ element: filter.element === k ? 'all' : k })}>
              {ELEMENT_LABELS[k]} <b>{counts.element[k] ?? 0}</b>
            </button>
          ))}
        </div>

        <p class="au-count" role="status">
          <strong>{counts.verdict.change}</strong> от {counts.verdict.all} {counts.verdict.all === 1 ? 'елемент е' : 'елемента са'} за промяна
          {rows.length !== counts.verdict.all ? <span class="muted"> · показани: {rows.length}</span> : null}
        </p>

        <div class="table-wrap">
          <table class="table au-table">
            <caption class="sr-only">SEO елементи, оценени поотделно: сега и предложение</caption>
            <thead>
              <tr>
                <th scope="col">Страница</th>
                <th scope="col" class="hide-sm">Елемент</th>
                <th scope="col">Сега → Предложение</th>
                <th scope="col" class="num hide-sm" title="Позиция на страницата в Google за основната ѝ фраза">Позиция</th>
                <th scope="col" class="hide-sm">Сигурност</th>
                <th scope="col" class="hide-sm">Решение</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6}><Empty title="Няма елементи по тези филтри">Опитай с друг вид елемент или изчисти търсенето.</Empty></td>
                </tr>
              ) : null}
              {shown.map((e) => (
                <Row key={`${e.url}|${e.element}`} e={e} page={pages.get(e.url)} />
              ))}
            </tbody>
          </table>
        </div>

        {rows.length > shown.length ? (
          <div class="row" style={{ marginTop: '14px' }}>
            <button type="button" class="btn" onClick={() => setLimit(limit + PAGE_SIZE)}>
              Покажи още {Math.min(PAGE_SIZE, rows.length - shown.length)}
            </button>
            <span class="small muted">показани {shown.length} от {rows.length}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
