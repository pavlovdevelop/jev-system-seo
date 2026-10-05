import type { JSX } from 'preact';
import { PAGE_TYPE_LABELS, type PageType } from '../../shared/domain';
import type { Report } from '../../shared/schemas';
import { Callout, HBar, LabelBadge, MiniBar } from '../components/ui';
import { pct } from '../lib/format';
import { candidatesOf, DIMENSIONS, peerMedians } from '../lib/report';

export function Overview({ report, goTab }: { report: Report; goTab: (tab: string) => void }): JSX.Element {
  const { seed, brief } = report;
  const top = candidatesOf(report).filter((o) => o.label === 'quick_win' || o.label === 'good').slice(0, 5);
  const typeRows = Object.entries(seed.intent.pageTypeShare).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const competitors = report.competitors.slice(0, 6);
  const maxShare = Math.max(0.0001, ...competitors.map((c) => c.visibility.shareOfVoice));
  const medians = peerMedians(seed.pages);
  const own = seed.ownPage;

  return (
    <div class="grid grid-main">
      <div class="stack-lg">
        <section class="card">
          <div class="card-head"><h2>Какво показва Google</h2></div>
          <p>{brief.summary}</p>
          {seed.intent.agreement === false ? (
            <div style={{ marginTop: '12px' }}>
              <Callout kind="info">
                Jev чете самата фраза като „{seed.intent.keywordIntent?.value}“, но реалните резултати са друг тип. При разминаване вярвай на резултатите — те показват какво Google смята, че търсещите искат.
              </Callout>
            </div>
          ) : null}
          {typeRows.length > 0 ? (
            <div style={{ marginTop: '18px' }}>
              <div class="section-title">Тип на водещите страници (по оценка на Jev)</div>
              <div class="hbars">
                {typeRows.map(([type, share]) => (
                  <HBar key={type} label={PAGE_TYPE_LABELS[type as PageType]} value={share} />
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Най-добри възможности</h2>
            <button type="button" class="btn btn-sm" onClick={() => goTab('opportunities')}>Всички фрази</button>
          </div>
          {top.length === 0 ? (
            <p class="muted">Няма достатъчно ясни възможности. Виж всички фрази или пусни анализ с по-широк избор на кандидати.</p>
          ) : (
            <ol class="opp-list">
              {top.map((o) => (
                <li key={o.keyword}>
                  <div>
                    <div class="cell-main">{o.keyword}</div>
                    <div class="cell-sub">{o.reasons.slice(0, 2).join(' · ')}</div>
                  </div>
                  <div class="row" style={{ flex: 'none' }}>
                    <LabelBadge label={o.label} />
                    <span class="num" style={{ minWidth: '34px', fontWeight: 650 }}>{o.score}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Първи стъпки</h2>
            <button type="button" class="btn btn-sm" onClick={() => goTab('brief')}>Целия план</button>
          </div>
          <ul class="stack" style={{ margin: 0, paddingLeft: '18px' }}>
            {brief.checklist.slice(0, 5).map((c) => <li key={c}>{c}</li>)}
          </ul>
        </section>
      </div>

      <div class="stack-lg">
        <section class="card">
          <div class="card-head"><h2>Кой доминира</h2><p>видимост по всички проверени фрази</p></div>
          {competitors.length === 0 ? (
            <p class="muted">Няма данни за видимост.</p>
          ) : (
            <>
              <div class="hbars">
                {competitors.map((c) => (
                  <HBar
                    key={c.domain}
                    label={c.domain}
                    sub={`${c.visibility.keywordsSeen} фрази · топ 3: ${c.visibility.top3}`}
                    value={c.visibility.shareOfVoice / maxShare}
                    text={pct(c.visibility.shareOfVoice)}
                    {...(c.role === 'own' ? { tone: 'own' as const } : c.role === 'discovered' ? { tone: 'other' as const } : {})}
                  />
                ))}
              </div>
              <div class="legend" style={{ marginTop: '12px' }}>
                <span><i class="swatch" style={{ background: 'var(--accent-2)' }} />ти</span>
                <span><i class="swatch" style={{ background: 'var(--accent)' }} />следени</span>
                <span><i class="swatch" style={{ background: 'var(--deemph)' }} />открити</span>
              </div>
            </>
          )}
          <button type="button" class="btn btn-sm" style={{ marginTop: '14px' }} onClick={() => goTab('competitors')}>Профили на конкурентите</button>
        </section>

        <section class="card">
          <div class="card-head"><h2>Твоята страница</h2><p>спрямо медианата на конкурентите</p></div>
          {own && own.metrics ? (
            <div class="stack">
              {DIMENSIONS.filter((d) => d.key !== 'overall').map((d) => (
                <div key={d.key} class="spread">
                  <span>{d.label}</span>
                  <span class="row" style={{ gap: '14px' }}>
                    <span class="row" style={{ gap: '6px' }} title="твоята страница"><i class="swatch" style={{ background: 'var(--accent-2)' }} /><MiniBar value={own.composite[d.key]} /></span>
                    <span class="row" style={{ gap: '6px' }} title="медиана на конкурентите"><i class="swatch" style={{ background: 'var(--accent)' }} /><MiniBar value={medians[d.key]} /></span>
                  </span>
                </div>
              ))}
              <div class="legend">
                <span><i class="swatch" style={{ background: 'var(--accent-2)' }} />ти</span>
                <span><i class="swatch" style={{ background: 'var(--accent)' }} />медиана на конкурентите</span>
              </div>
              {brief.ownGaps && brief.ownGaps.length > 0 ? (
                <p class="small muted">Намерени пропуски: {brief.ownGaps.length}. Виж „План за съдържание“.</p>
              ) : null}
            </div>
          ) : (
            <p class="muted small">
              Задай домейн в настройките или адрес на твоята страница при нов анализ — ще я сравним с конкурентите и ще покажем какво ѝ липсва.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
