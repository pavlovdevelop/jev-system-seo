import { Fragment, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { KEYWORD_SOURCE_LABELS, OPPORTUNITY_LABEL_TEXT, OPPORTUNITY_LABELS, PAGE_TYPE_LABELS, type KeywordSource, type OpportunityLabel, type PageType } from '../../shared/domain';
import type { Opportunity, Report } from '../../shared/schemas';
import { Scatter } from '../components/Scatter';
import { Confidence, Difficulty, Empty, HBar, Icon, LabelBadge, MiniBar } from '../components/ui';
import { int, pct } from '../lib/format';

type Sort = 'score' | 'volume' | 'weakness' | 'commercial';
const SORTS: Array<[Sort, string]> = [['score', 'Оценка'], ['weakness', 'Слабост на SERP'], ['commercial', 'Търговска стойност'], ['volume', 'Търсения/мес']];

function Detail({ o, onDeep }: { o: Opportunity; onDeep: (keyword: string) => void }): JSX.Element {
  const a = o.assessment;
  return (
    <div class="grid grid-2">
      <div class="stack">
        <div>
          <div class="section-title">Защо</div>
          <ul class="stack" style={{ margin: 0, paddingLeft: '18px' }}>
            {o.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
        <dl class="kv">
          <dt>Източници</dt><dd>{o.sources.map((s) => KEYWORD_SOURCE_LABELS[s as KeywordSource]).join(', ')}</dd>
          <dt>Конкуренция в Google</dt><dd>{a ? <Difficulty value={a.difficulty} /> : 'SERP не е проверен'}</dd>
          <dt>Релевантност (Jev)</dt><dd>{pct(o.relevance)}</dd>
          <dt>Търговска стойност (Jev)</dt><dd>{pct(o.commercial)}</dd>
          <dt>Специфичност</dt><dd>{pct(o.specificity)}</dd>
          <dt>Търсения на месец</dt><dd>{o.volume !== null ? int(o.volume) : 'няма данни'}</dd>
          <dt>Моя позиция</dt><dd>{o.ownPosition ?? 'извън проверените резултати'}</dd>
          {o.cpc !== null ? <><dt>CPC (Google Ads)</dt><dd>{o.cpc.toFixed(2)}</dd></> : null}
          {o.competitionIndex !== null ? <><dt>Конкуренция в рекламите</dt><dd>{o.competitionIndex}/100</dd></> : null}
          {o.recommendedFormat ? <><dt>Препоръчан формат</dt><dd>{PAGE_TYPE_LABELS[o.recommendedFormat as PageType]}</dd></> : null}
        </dl>
        {o.deep ? null : (
          <div>
            <button type="button" class="btn btn-sm" onClick={() => onDeep(o.keyword)} title="Пусни пълен анализ с изтегляне на страниците за тази фраза">
              <Icon name="target" size={14} />Дълбок анализ на тази фраза
            </button>
          </div>
        )}
      </div>
      <div>
        <div class="section-title">Топ резултати в Google за тази фраза</div>
        {a ? (
          <div class="table-wrap" style={{ border: 0 }}>
            <table class="table" style={{ fontSize: '13px' }}>
              <thead><tr><th class="num">#</th><th>Домейн</th><th>Тип</th><th>Заглавие</th><th>Сила</th></tr></thead>
              <tbody>
                {a.results.map((r) => (
                  <tr key={`${r.position}-${r.domain}`}>
                    <td class="num">{r.position}</td>
                    <td>{r.domain}</td>
                    <td>{r.pageType ? <span class="row" style={{ gap: '6px' }}>{PAGE_TYPE_LABELS[r.pageType.value as PageType]}<Confidence value={r.pageType.confidence} /></span> : '—'}</td>
                    <td>{pct(r.titleMatch)} от фразата</td>
                    <td><MiniBar value={r.strength} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p class="small muted">SERP не е извлечен за тази фраза.</p>}
        {a ? (
          <div class="hbars" style={{ marginTop: '12px' }}>
            <HBar label="Тип, който не пасва" value={a.components.pageTypeMismatch} />
            <HBar label="Непосветени резултати" value={a.components.notDedicated} />
            <HBar label="Заглавия без фразата" value={a.components.titleGap} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function OpportunitiesTab({ report, onDeep }: { report: Report; onDeep: (keyword: string) => void }): JSX.Element {
  const all = report.opportunities;
  const [label, setLabel] = useState<'all' | OpportunityLabel>('all');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | KeywordSource>('all');
  const [sort, setSort] = useState<Sort>('score');
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const o of all) c[o.label] = (c[o.label] ?? 0) + 1;
    return c;
  }, [all]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = all.filter((o) => (label === 'all' || o.label === label) && (source === 'all' || o.sources.includes(source)) && (!q || o.keyword.toLowerCase().includes(q)));
    const key = (o: Opportunity): number => (sort === 'volume' ? (o.volume ?? -1) : sort === 'weakness' ? (o.assessment?.weakness ?? -1) : sort === 'commercial' ? o.commercial : o.score);
    return [...filtered].sort((a, b) => key(b) - key(a) || a.keyword.localeCompare(b.keyword));
  }, [all, label, query, source, sort]);

  useEffect(() => {
    if (!selected) return;
    setOpen(selected);
    document.getElementById(`opp-${selected}`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [selected]);

  if (all.length <= 1 && all.every((o) => o.deep)) {
    return (
      <Empty title="Няма проверени фрази">
        Този анализ е пуснат без търсене на свързани фрази. Пусни нов анализ с включена опция „Търси свързани фрази“.
      </Empty>
    );
  }

  const verified = all.filter((o) => o.assessment);
  return (
    <div class="stack-lg">
      <section class="card">
        <div class="card-head">
          <h2>Карта на възможностите</h2>
          <button type="button" class="btn btn-sm" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{asTable ? 'Покажи графика' : 'Покажи като таблица'}</button>
        </div>
        {verified.length === 0 ? (
          <p class="muted">Няма проверени SERP-ове, затова картата не може да се построи (нужен е SERP доставчик).</p>
        ) : asTable ? (
          <div class="table-wrap">
            <table class="table">
              <caption>Данните на графиката</caption>
              <thead><tr><th>Фраза</th><th>Категория</th><th class="num">Слабост %</th><th class="num">Търг. стойност %</th><th class="num">Оценка</th></tr></thead>
              <tbody>
                {verified.map((o) => (
                  <tr key={o.keyword}><td>{o.keyword}</td><td>{OPPORTUNITY_LABEL_TEXT[o.label]}</td><td class="num">{Math.round((o.assessment?.weakness ?? 0) * 100)}</td><td class="num">{Math.round(o.commercial * 100)}</td><td class="num">{o.score}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Scatter items={rows.filter((o) => o.assessment)} selected={selected} onSelect={setSelected} />
        )}
      </section>

      <section>
        <div class="toolbar" role="group" aria-label="Филтри за фразите">
          <div class="chips">
            {(['all', ...OPPORTUNITY_LABELS] as const).map((l) => (
              <button key={l} type="button" class="chip chip-btn" aria-pressed={label === l} onClick={() => setLabel(l)}>
                {l === 'all' ? 'Всички' : OPPORTUNITY_LABEL_TEXT[l]} <b>{counts[l] ?? 0}</b>
              </button>
            ))}
          </div>
          <input class="input" type="search" placeholder="Търси във фразите…" aria-label="Търсене във фразите" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          <select class="select" aria-label="Източник на фразата" value={source} onChange={(e) => setSource((e.target as HTMLSelectElement).value as 'all' | KeywordSource)}>
            <option value="all">Всички източници</option>
            {(Object.keys(KEYWORD_SOURCE_LABELS) as KeywordSource[]).filter((s) => s !== 'seed').map((s) => <option key={s} value={s}>{KEYWORD_SOURCE_LABELS[s]}</option>)}
          </select>
          <select class="select" aria-label="Подредба" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
            {SORTS.map(([v, t]) => <option key={v} value={v}>Подреди по: {t}</option>)}
          </select>
        </div>

        <div class="table-wrap">
          <table class="table">
            <caption>{rows.length} от {all.length} фрази. „Оценка“ комбинира слабостта на конкуренцията, търговската стойност, специфичността и (ако има) обема.</caption>
            <thead>
              <tr>
                <th aria-label="Детайли" />
                <th>Фраза</th>
                <th class="hide-sm">Категория</th>
                <th>Оценка</th>
                <th class="hide-sm">Конкуренция</th>
                <th class="hide-sm">Търг. стойност</th>
                <th class="num hide-sm">Търсения/мес</th>
                <th class="hide-sm">Формат</th>
                <th class="num hide-sm">Моя поз.</th>
                <th class="hide-sm" aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={10}><Empty title="Няма фрази по тези филтри" /></td></tr> : null}
              {rows.map((o) => {
                const isOpen = open === o.keyword;
                return (
                  <Fragment key={o.keyword}>
                    <tr id={`opp-${o.keyword}`} class={`${isOpen ? 'is-open' : ''}${selected === o.keyword ? ' is-selected' : ''}`}>
                      <td>
                        <button type="button" class="row-toggle" aria-expanded={isOpen} aria-label={`Детайли за „${o.keyword}“`} onClick={() => setOpen(isOpen ? null : o.keyword)}>
                          <Icon name="chevron" size={14} />
                        </button>
                      </td>
                      <td class="col-wide">
                        <div class="cell-main">{o.keyword}</div>
                        <div class="cell-sub hide-sm">{o.deep ? 'основна фраза (дълбок анализ)' : o.reasons[0] ?? ''}</div>
                        <div class="show-sm" style={{ marginTop: '6px' }}><LabelBadge label={o.label} /></div>
                      </td>
                      <td class="hide-sm"><LabelBadge label={o.label} /></td>
                      <td><MiniBar value={o.score / 100} text={String(Math.round(o.score))} /></td>
                      <td class="hide-sm">{o.assessment ? <Difficulty value={o.assessment.difficulty} /> : <span class="muted" title="SERP не е проверен">непроверена</span>}</td>
                      <td class="hide-sm"><MiniBar value={o.commercial} /></td>
                      <td class="num hide-sm">{int(o.volume)}</td>
                      <td class="hide-sm">{o.recommendedFormat ? PAGE_TYPE_LABELS[o.recommendedFormat as PageType] : '—'}</td>
                      <td class="num hide-sm">{o.ownPosition ?? '—'}</td>
                      <td class="hide-sm">
                        {o.deep ? null : (
                          <button type="button" class="btn btn-sm" onClick={() => onDeep(o.keyword)} title="Пусни пълен анализ с изтегляне на страниците за тази фраза">
                            <Icon name="target" size={14} />Дълбок анализ
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen ? <tr class="detail"><td colSpan={10}><Detail o={o} onDeep={onDeep} /></td></tr> : null}
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
