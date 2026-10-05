import { Fragment, type JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { CompetitorProfile, Report } from '../../shared/schemas';
import { SignalList } from '../components/details';
import { Callout, Icon, MiniBar, RoleBadge } from '../components/ui';
import { api } from '../lib/api';
import { pct } from '../lib/format';
import { DIMENSIONS } from '../lib/report';

const place = (n: number | null): string => (n === null ? '—' : String(Math.round(n * 10) / 10));

/** The single most notable strength and weakness on one line: the reader can scan 15 competitors without opening any. */
function Headline({ c }: { c: CompetitorProfile }): JSX.Element {
  const s = c.strengths[0];
  const w = c.weaknesses[0];
  if (!s && !w) {
    const text = c.seedPage ? 'Без ясно изразени силни и слаби страни.' : c.role === 'own' ? 'Твоя страница не е анализирана — задай адрес при нов анализ.' : 'Страницата за основната фраза не е анализирана.';
    return <div class="cell-sub">{text}</div>;
  }
  return (
    <div class="cell-sub headline">
      {s ? <span class="hl hl-strength"><Icon name="plus" size={13} />{s.label}</span> : null}
      {w ? <span class="hl hl-weakness"><Icon name="minus" size={13} />{w.label}</span> : null}
    </div>
  );
}

function Detail({ c }: { c: CompetitorProfile }): JSX.Element {
  const v = c.visibility;
  return (
    <div class="grid grid-3">
      <div>
        <div class="section-title">Силни страни</div>
        <SignalList signals={c.strengths} kind="strength" empty="Няма ясно изразени." />
      </div>
      <div>
        <div class="section-title">Слабости</div>
        <SignalList signals={c.weaknesses} kind="weakness" empty="Няма ясно изразени." />
      </div>
      <div class="stack">
        <div>
          <div class="section-title">Оценка на страницата за основната фраза</div>
          {c.scorecard ? (
            <div class="stack" style={{ gap: '6px' }}>
              {DIMENSIONS.map((d) => (
                <div key={d.key} class="spread" style={{ fontWeight: d.key === 'overall' ? 650 : 400 }}>
                  <span>{d.label}</span>
                  <MiniBar value={c.scorecard![d.key]} />
                </div>
              ))}
            </div>
          ) : (
            <p class="small muted">
              {c.role === 'own' ? 'Не е анализирана твоя страница за тази фраза — задай адрес при нов анализ и ще я сравним с водещите.' : 'Страницата не е изтеглена, затова няма оценка на съдържанието.'}
            </p>
          )}
        </div>
        <dl class="kv">
          <dt>Фрази в топ 10 / топ 3</dt><dd>{v.top10} / {v.top3} <span class="muted">(от {v.keywordsSeen} показали го)</span></dd>
          <dt>Най-добра / средна позиция</dt><dd>{place(v.bestPosition)} / {place(v.avgPosition)}</dd>
        </dl>
        {c.vulnerableKeywords.length > 0 ? (
          <div>
            <div class="section-title">Фрази, при които е уязвим</div>
            <ul class="stack" style={{ margin: 0, paddingLeft: '18px' }}>
              {c.vulnerableKeywords.map((k) => (
                <li key={k.keyword}><span class="cell-main">{k.keyword}</span> <span class="muted">— позиция {k.position}: {k.reason}</span></li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function CompetitorsTab({ report }: { report: Report }): JSX.Element {
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Start with the strongest analysed competitor open, so the page shows a real profile instead of a closed list.
  const first = report.competitors.find((c) => c.role !== 'own' && c.strengths.length + c.weaknesses.length > 0)?.domain;
  const [open, setOpen] = useState<Set<string>>(new Set(first ? [first] : []));
  const maxShare = useMemo(() => Math.max(0.0001, ...report.competitors.map((c) => c.visibility.shareOfVoice)), [report.competitors]);

  const track = async (domain: string): Promise<void> => {
    try {
      await api.addCompetitor(domain);
      setAdded((s) => new Set([...s, domain]));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Неуспешно добавяне.');
    }
  };
  const toggle = (domain: string): void =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(domain)) next.add(domain);
      return next;
    });
  const allOpen = open.size === report.competitors.length;

  return (
    <div class="stack-lg">
      <p class="muted" style={{ maxWidth: '75ch' }}>
        Това са домейните, които реално се появяват в Google за проверените фрази — не само тези, които познаваш. Следените конкуренти се показват винаги, дори да не са в топ 10. Отвори ред за пълния профил.
      </p>
      {error ? <Callout kind="error">{error}</Callout> : null}
      {added.size > 0 ? <Callout>Добавени към следените: {[...added].join(', ')}. Ще се отчитат във всеки следващ анализ.</Callout> : null}

      <section>
        <div class="toolbar">
          <button type="button" class="btn btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(report.competitors.map((c) => c.domain)))}>
            {allOpen ? 'Свий всички' : 'Разгъни всички'}
          </button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <caption>
              „Видимост“ е делът от общата видимост в проверените резултати (по-високата позиция тежи повече). „Оценка“ е композитната оценка на страницата за основната фраза.
            </caption>
            <thead>
              <tr>
                <th aria-label="Детайли" />
                <th>Конкурент</th>
                <th>Видимост</th>
                <th class="num hide-sm">Топ 3 / топ 10</th>
                <th class="num hide-sm">Най-добра поз.</th>
                <th class="hide-sm">Оценка</th>
              </tr>
            </thead>
            <tbody>
              {report.competitors.map((c) => {
                const isOpen = open.has(c.domain);
                const tracked = added.has(c.domain);
                return (
                  <Fragment key={c.domain}>
                    <tr class={isOpen ? 'is-open' : ''}>
                      <td>
                        <button type="button" class="row-toggle" aria-expanded={isOpen} aria-label={`Профил на ${c.domain}`} onClick={() => toggle(c.domain)}>
                          <Icon name="chevron" size={14} />
                        </button>
                      </td>
                      <td class="col-wide">
                        <div class="row" style={{ gap: '8px' }}>
                          <span class="cell-main">{c.domain}</span>
                          <RoleBadge role={c.role === 'discovered' && tracked ? 'tracked' : c.role} />
                          {c.role === 'discovered' && !tracked ? (
                            <button type="button" class="btn btn-sm" onClick={() => track(c.domain)} title="Добави в списъка със следени конкуренти"><Icon name="plus" size={14} />Следи</button>
                          ) : null}
                        </div>
                        <Headline c={c} />
                      </td>
                      <td><MiniBar value={c.visibility.shareOfVoice / maxShare} text={pct(c.visibility.shareOfVoice)} /></td>
                      <td class="num hide-sm">{c.visibility.top3} / {c.visibility.top10}</td>
                      <td class="num hide-sm">{c.visibility.bestPosition === null ? '—' : `#${c.visibility.bestPosition}`}</td>
                      <td class="hide-sm">{c.scorecard ? <MiniBar value={c.scorecard.overall} /> : <span class="muted">—</span>}</td>
                    </tr>
                    {isOpen ? (
                      <tr class="detail">
                        <td colSpan={6}><Detail c={c} /></td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
