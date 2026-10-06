import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import { PAGE_TYPE_LABELS } from '../../shared/domain';
import type { SiteAuditReport, SitePage } from '../../shared/audit';
import { Breakable, Headline, Pips } from '../components/Pips';
import { Empty } from '../components/ui';
import { CITABILITY_PIPS, citabilityRows, CRITERION_LABELS, pointsGain, signed, whyNotJudged } from '../lib/audit';
import { pct } from '../lib/format';

// Panel 04: how likely an AI assistant is to cite each page, what holds it back and what to fix first.

/** The chance now as a bar; the stripes show how much of the gap the first fix would close. */
function Chance({ now, after }: { now: number; after: number }): JSX.Element {
  return (
    <span class="au-chance" title={`Сега ${pct(now)}, след първата поправка ${pct(after)}`}>
      <span class="au-chance-track" aria-hidden="true">
        <span class="au-chance-now" style={{ width: `${now * 100}%` }} />
        <span class="au-chance-gain" style={{ left: `${now * 100}%`, width: `${Math.max(0, after - now) * 100}%` }} />
      </span>
      <span class="mini-val">{pct(now)}</span>
    </span>
  );
}

function FixFirst({ page }: { page: SitePage }): JSX.Element {
  const fix = page.citability?.fixFirst;
  if (!fix) return <span class="muted">—</span>;
  return (
    <div>
      <div class="au-fix-kind">{CRITERION_LABELS[fix.criterion]}</div>
      <div>{fix.action}</div>
    </div>
  );
}

function Row({ page }: { page: SitePage }): JSX.Element {
  const c = page.citability;
  return (
    <tr>
      <td class="au-page">
        <div class="cell-main" title={page.url}><Breakable text={page.path} /></div>
        <div class="cell-sub">{page.type ? PAGE_TYPE_LABELS[page.type] : 'тип: не е определен'}</div>
        {c?.fixFirst ? (
          <div class="show-sm small" style={{ marginTop: '6px' }}>
            <span class="muted">Поправи първо: </span>{c.fixFirst.action}
          </div>
        ) : null}
      </td>
      <td>
        {c ? (
          <Chance now={c.now} after={c.after} />
        ) : (
          <div>
            <span class="muted">не е оценена</span>
            <div class="cell-sub">{whyNotJudged(page)}</div>
          </div>
        )}
      </td>
      {CITABILITY_PIPS.map((k) => (
        <td key={k.key} class="hide-sm"><Pips value={page.criteria[k.key]} label={CRITERION_LABELS[k.key]} /></td>
      ))}
      <td class="hide-sm"><FixFirst page={page} /></td>
      <td class="num">
        {c ? (
          <>
            <span class="cell-main">{pct(c.after)}</span>
            <div class="xs au-gain" title="Промяна в процентни пунктове">{signed(pointsGain(c.now, c.after))}</div>
          </>
        ) : (
          <span class="muted">—</span>
        )}
      </td>
    </tr>
  );
}

export function CitabilityTab({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const rows = useMemo(() => citabilityRows(audit.pages), [audit.pages]);
  const judged = rows.filter((p) => p.citability !== null).length;
  const { citabilityNow: now, citabilityAfter: after } = audit.figures;

  if (rows.length === 0) {
    return <Empty title="Няма одитирани страници">Сайтът не върна страници, които да оценим.</Empty>;
  }

  return (
    <div class="stack-lg">
      <Headline
        value={
          <>
            {pct(now)}
            {after !== null ? <span class="au-headline-after"> → {pct(after)}</span> : null}
          </>
        }
        unit="среден шанс да бъде цитирана страница"
      >
        {after !== null ? 'сега → след първата поправка на всяка страница. ' : ''}
        Оценени страници: {judged} от {rows.length}{judged < rows.length ? ' — останалите не можаха да се оценят' : ''}.
      </Headline>

      <div class="table-wrap">
        <table class="table au-table">
          <caption class="sr-only">Шанс за цитиране на всяка страница, оценка по пет критерия и какво да се поправи първо — най-слабите са най-горе</caption>
          <thead>
            <tr>
              <th scope="col">Страница</th>
              <th scope="col">Шанс</th>
              {CITABILITY_PIPS.map((k) => (
                <th key={k.key} scope="col" class="hide-sm" title={CRITERION_LABELS[k.key]}>{k.label}</th>
              ))}
              <th scope="col" class="hide-sm">Поправи първо</th>
              <th scope="col" class="num" title="Шанс след първата поправка">След</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Row key={p.url} page={p} />
            ))}
          </tbody>
        </table>
      </div>
      <p class="small muted">
        Шансът е тегловна комбинация от осем критерия (отговор в началото, FAQ, автор, актуалност, източници, факти, сравнение, вътрешни връзки); тук са показани петте най-важни. „След“ е прогноза, не измерване. Подредбата е от най-слабата страница към най-силната; страниците без оценка са най-долу.
      </p>
    </div>
  );
}
