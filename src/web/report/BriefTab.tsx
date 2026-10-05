import type { JSX } from 'preact';
import { INTENT_LABELS, PAGE_TYPE_LABELS, type Intent, type PageType } from '../../shared/domain';
import type { Report } from '../../shared/schemas';
import { Empty, HBar, Tile } from '../components/ui';
import { int, pct } from '../lib/format';
import { usePersistentState } from '../lib/hooks';

function Range({ min, target, max, own }: { min: number; target: number; max: number; own?: number | null }): JSX.Element {
  const scale = Math.max(max * 1.25, own ?? 0, 1);
  const at = (v: number): string => `${(v / scale) * 100}%`;
  return (
    <div>
      <div class="range" role="img" aria-label={`Препоръчан обем: от ${min} до ${max} думи, цел ${target}${own ? `, твоята страница има ${own}` : ''}`}>
        <div class="range-bar" style={{ left: at(min), width: `${((max - min) / scale) * 100}%` }} />
        <div class="range-pin" style={{ left: at(target) }} title={`цел: ${target}`} />
        {own ? <div class="range-pin own" style={{ left: at(own) }} title={`твоята страница: ${own}`} /> : null}
      </div>
      <div class="range-ticks"><span>0</span><span>{int(Math.round(scale))} думи</span></div>
    </div>
  );
}

export function BriefTab({ report }: { report: Report }): JSX.Element {
  const b = report.brief;
  const [done, setDone] = usePersistentState<string[]>(`radar.brief.${report.id}`, []);
  const toggle = (item: string): void => setDone(done.includes(item) ? done.filter((x) => x !== item) : [...done, item]);
  const ownWords = report.seed.ownPage?.metrics?.wordCount ?? null;
  const nPages = Math.max(1, report.seed.pages.filter((p) => p.metrics && p.role !== 'own').length);

  return (
    <div class="stack-lg">
      <section class="card">
        <div class="card-head"><h2>Какво да напишеш</h2><p>План, изведен от данните — не е генериран текст</p></div>
        <p>{b.summary}</p>
        <div class="tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', marginTop: '16px' }}>
          <Tile text label="Тип страница" value={b.pageType ? PAGE_TYPE_LABELS[b.pageType as PageType] : '—'} sub={b.intent ? `за търсещи: ${INTENT_LABELS[b.intent as Intent].toLowerCase()}` : undefined} />
          <Tile label="Препоръчан обем" value={b.length ? `~${int(b.length.target)}` : '—'} sub={b.length ? `думи (между ${int(b.length.min)} и ${int(b.length.max)})` : 'недостатъчно данни'} />
          <Tile label="Дължина на заглавието" value={b.titlePatterns ? `~${b.titlePatterns.avgLength}` : '—'} sub={b.titlePatterns ? `знака; ${pct(b.titlePatterns.startsWithKeywordShare)} започват с фразата` : undefined} />
        </div>
        {b.length ? (
          <div style={{ marginTop: '16px' }}>
            <div class="section-title">Обем спрямо водещите страници</div>
            <Range min={b.length.min} target={b.length.target} max={b.length.max} own={ownWords} />
            <div class="legend" style={{ marginTop: '8px' }}>
              <span><i class="swatch" style={{ background: 'var(--track)' }} />препоръчан диапазон</span>
              <span><i class="swatch" style={{ background: 'var(--accent)' }} />цел</span>
              {ownWords ? <span><i class="swatch" style={{ background: 'var(--accent-2)' }} />твоята страница ({int(ownWords)})</span> : null}
            </div>
          </div>
        ) : null}
      </section>

      <div class="grid grid-main">
        <section class="card">
          <div class="card-head"><h2>Списък със задачи</h2><p>Отметките се пазят в този браузър</p></div>
          <ul class="checklist">
            {b.checklist.map((item) => (
              <li key={item}>
                <label>
                  <input type="checkbox" checked={done.includes(item)} onChange={() => toggle(item)} />
                  <span>{item}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section class="card">
          <div class="card-head"><h2>Какво имат водещите</h2><p>дял от конкурентните страници</p></div>
          {b.trustElements.length === 0 ? <p class="muted">Няма данни.</p> : (
            <div class="hbars">
              {b.trustElements.map((t) => <HBar key={t.id} label={t.label} value={t.share} text={`${t.pages}/${nPages}`} />)}
            </div>
          )}
          {b.schemaTypes.length > 0 ? (
            <div style={{ marginTop: '16px' }}>
              <div class="section-title">Структурирани данни</div>
              <div class="chips">{b.schemaTypes.map((s) => <span class="chip" key={s.type}>{s.type} <b>{s.pages}</b></span>)}</div>
            </div>
          ) : null}
        </section>
      </div>

      <div class="grid grid-2">
        <section class="card">
          <div class="card-head"><h2>Подтеми</h2><p>заглавия, споделени от поне ¼ от страниците</p></div>
          {b.subtopics.length === 0 ? <Empty title="Няма общи подтеми">Нужни са поне 3 изтеглени страници.</Empty> : (
            <ul class="stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {b.subtopics.map((s) => (
                <li key={s.topic}>
                  <HBar stacked label={s.topic} value={s.pages / nPages} text={`${s.pages}/${nPages}`} sub={s.examples.length > 1 ? `напр. ${s.examples.slice(1, 3).join(' · ')}` : undefined} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="card">
          <div class="card-head"><h2>Термини и въпроси</h2></div>
          <div class="section-title">Термини, които повечето страници използват</div>
          {b.mustCover.length === 0 ? <p class="muted small">Няма достатъчно данни.</p> : (
            <div class="chips">{b.mustCover.map((m) => <span class="chip" key={m.term}>{m.term} <b>{m.pages}/{nPages}</b></span>)}</div>
          )}
          <div class="section-title" style={{ marginTop: '18px' }}>Въпроси, на които да отговориш</div>
          {b.questions.length === 0 ? <p class="muted small">Няма открити въпроси.</p> : (
            <ul class="stack" style={{ margin: 0, paddingLeft: '18px' }}>
              {b.questions.map((q) => <li key={q.question}>{q.question} <span class="muted xs">{q.source === 'paa' ? '(„Хората питат“)' : '(от заглавия)'}</span></li>)}
            </ul>
          )}
        </section>
      </div>

      {b.ownGaps ? (
        <section class="card">
          <div class="card-head"><h2>Какво липсва на твоята страница</h2><p>{report.seed.ownPage?.url}</p></div>
          {b.ownGaps.length === 0 ? <p>Не открихме очевидни пропуски спрямо водещите страници. Добра работа.</p> : (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Вид</th><th>Какво</th><th>Детайл</th></tr></thead>
                <tbody>
                  {b.ownGaps.map((g, i) => (
                    <tr key={`${g.kind}-${g.label}-${i}`}>
                      <td class="nowrap">{{ term: 'Термин', subtopic: 'Подтема', element: 'Елемент', length: 'Обем' }[g.kind]}</td>
                      <td class="cell-main">{g.label}</td>
                      <td class="muted">{g.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
