import type { ComponentChildren, JSX } from 'preact';
import { INTENT_LABELS, PAGE_TYPE_LABELS, type Intent, type PageType } from '../../shared/domain';
import type { FetchInfo, PageAnalysis, PageJudgments, PageMetrics, Signal } from '../../shared/schemas';
import { safeHref } from '../../shared/urls';
import { int, pct, SOURCE_TEXT } from '../lib/format';
import { Confidence, Icon, MiniBar } from './ui';

/** Strengths and weaknesses of a competitor — categories, not a verdict: strength = plus (blue), weakness = minus (orange). */
export function SignalList({ signals, kind, empty }: { signals: readonly Signal[]; kind: 'strength' | 'weakness'; empty?: string }): JSX.Element {
  const rows = signals.filter((s) => s.kind === kind);
  if (rows.length === 0) return <p class="small muted">{empty ?? 'Няма отчетени.'}</p>;
  return (
    <ul class="signals">
      {rows.map((s) => (
        <li key={s.id} class={`signal ${kind}`}>
          <Icon name={kind === 'strength' ? 'plus' : 'minus'} size={16} />
          <div>
            <div>{s.label}</div>
            <div class="why">
              {s.evidence} · {SOURCE_TEXT[s.source]}
              {s.confidence === 'low' ? ' · ниска сигурност' : ''}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

type NoulKey = 'targetsQuery' | 'localToMarket' | 'genericContent' | 'statesPrices' | 'showsPortfolio' | 'showsReviews' | 'clearCta' | 'showsIdentity';
const NOUL_ROWS: Array<[NoulKey, string]> = [
  ['targetsQuery', 'Посветена на търсената фраза'],
  ['localToMarket', 'Насочена към този пазар'],
  ['genericContent', 'Общи фрази без конкретика'],
  ['statesPrices', 'Показва цени'],
  ['showsPortfolio', 'Показва портфолио или примери'],
  ['showsReviews', 'Показва отзиви'],
  ['clearCta', 'Има ясен призив за действие'],
  ['showsIdentity', 'Показва кой стои зад сайта'],
];

const verdict = (p: number): string => (p >= 0.7 ? 'да' : p <= 0.3 ? 'не' : 'несигурно');

/** Everything Jev decided about one page, with its probabilities — so every conclusion can be audited. */
export function JudgmentsTable({ judgments }: { judgments: PageJudgments }): JSX.Element {
  const j = judgments;
  if (Object.keys(j).length === 0) return <p class="small muted">Jev не върна оценки за тази страница.</p>;
  return (
    <table class="table" style={{ fontSize: '13px' }}>
      <thead>
        <tr><th>Въпрос към Jev</th><th>Отговор</th><th>Вероятност</th><th>Сигурност</th></tr>
      </thead>
      <tbody>
        {j.pageType ? (
          <tr>
            <td>Тип страница</td>
            <td>{PAGE_TYPE_LABELS[j.pageType.value as PageType]}{j.pageType.runnerUp ? <span class="muted"> (иначе: {PAGE_TYPE_LABELS[j.pageType.runnerUp.value as PageType].toLowerCase()} {pct(j.pageType.runnerUp.p)})</span> : null}</td>
            <td class="num">{pct(j.pageType.p)}</td>
            <td><Confidence value={j.pageType.confidence} /></td>
          </tr>
        ) : null}
        {j.intentServed ? (
          <tr>
            <td>Намерение, което обслужва</td>
            <td>{INTENT_LABELS[j.intentServed.value as Intent]}</td>
            <td class="num">{pct(j.intentServed.p)}</td>
            <td><Confidence value={j.intentServed.confidence} /></td>
          </tr>
        ) : null}
        {j.topicDepth ? (
          <tr>
            <td>Дълбочина на темата</td>
            <td>{j.topicDepth.raw.toFixed(1)} от {j.topicDepth.levels - 1}</td>
            <td><MiniBar value={j.topicDepth.value} /></td>
            <td><Confidence value={j.topicDepth.confidence} /></td>
          </tr>
        ) : null}
        {j.needSatisfied ? (
          <tr>
            <td>Отговаря на нуждата на търсещия</td>
            <td>{j.needSatisfied.raw.toFixed(1)} от {j.needSatisfied.levels - 1}</td>
            <td><MiniBar value={j.needSatisfied.value} /></td>
            <td><Confidence value={j.needSatisfied.confidence} /></td>
          </tr>
        ) : null}
        {NOUL_ROWS.map(([key, label]) => {
          const a = j[key];
          return a ? (
            <tr key={key}>
              <td>{label}</td>
              <td>{verdict(a.p)}</td>
              <td><MiniBar value={a.p} text={pct(a.p)} /></td>
              <td><Confidence value={Math.abs(2 * a.p - 1)} /></td>
            </tr>
          ) : null;
        })}
      </tbody>
    </table>
  );
}

const yesNo = (v: boolean): string => (v ? 'да' : 'не');

/** Facts measured in code from the page itself (no AI involved). */
export function MetricsList({ metrics, fetch }: { metrics: PageMetrics | null; fetch: FetchInfo }): JSX.Element {
  const f = fetch;
  const access = (
    <>
      <dt>Достъп</dt>
      <dd>
        {f.status === 'ok' ? `изтеглена${f.fromCache ? ' (от кеша)' : ''}${f.ttfbMs !== null ? ` · ${f.ttfbMs} ms` : ''}${f.bytes ? ` · ${(f.bytes / 1024).toFixed(0)} KB` : ''}` : (f.error ?? f.status)}
      </dd>
    </>
  );
  if (!metrics) {
    return <dl class="kv">{access}<dt>Забележка</dt><dd>Оценена само по заглавие и описание в резултатите.</dd></dl>;
  }
  const m = metrics;
  return (
    <dl class="kv">
      {access}
      <dt>Заглавие</dt><dd>{m.title ?? '—'} <span class="muted">({m.titleLength} знака)</span></dd>
      <dt>Мета описание</dt><dd>{m.metaDescription ? `${m.metaDescriptionLength} знака` : 'липсва'}</dd>
      <dt>H1</dt><dd>{m.h1.length === 0 ? 'липсва' : m.h1.join(' · ')}</dd>
      <dt>H2 / H3</dt><dd>{m.h2Count} / {m.h3Count}</dd>
      <dt>Думи в съдържанието</dt><dd>{int(m.wordCount)}</dd>
      <dt>Фраза в заглавие / H1 / URL</dt><dd>{yesNo(m.keyword.inTitle)} / {yesNo(m.keyword.inH1)} / {yesNo(m.keyword.inUrl)}</dd>
      <dt>Структурирани данни</dt><dd>{m.schemaTypes.length ? m.schemaTypes.join(', ') : 'няма'}</dd>
      <dt>FAQ</dt><dd>{m.hasFaqSchema ? 'със schema' : m.hasFaqSection ? 'секция без schema' : 'няма'}</dd>
      <dt>Изображения със alt</dt><dd>{m.images.withAlt} от {m.images.total}</dd>
      <dt>Връзки (вътр. / външни)</dt><dd>{m.links.internal} / {m.links.external}</dd>
      <dt>Контакти</dt><dd>тел. {m.phones} · имейл {m.emails} · форма {yesNo(m.hasContactForm)}</dd>
      {m.ctaTexts.length ? (<><dt>Призиви за действие</dt><dd>{m.ctaTexts.slice(0, 4).join(' · ')}</dd></>) : null}
      {m.priceMentions.length ? (<><dt>Цени (откъс)</dt><dd>{m.priceMentions[0]}</dd></>) : null}
      <dt>Техническо</dt>
      <dd>{m.https ? 'HTTPS' : 'без HTTPS'} · {m.hasViewport ? 'мобилен viewport' : 'без viewport'} · {m.lang ?? 'без lang'}{m.noindex ? ' · noindex' : ''}</dd>
    </dl>
  );
}

export function PageLink({ url, children }: { url: string; children: ComponentChildren }): JSX.Element {
  const href = safeHref(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

export function PageDetail({ page }: { page: PageAnalysis }): JSX.Element {
  return (
    <div class="grid grid-3">
      <div>
        <div class="section-title">Силни страни</div>
        <SignalList signals={page.signals} kind="strength" />
        <div class="section-title" style={{ marginTop: '16px' }}>Слабости</div>
        <SignalList signals={page.signals} kind="weakness" />
      </div>
      <div>
        <div class="section-title">Как реши Jev</div>
        <JudgmentsTable judgments={page.judgments} />
      </div>
      <div>
        <div class="section-title">Измерено от страницата</div>
        <MetricsList metrics={page.metrics} fetch={page.fetch} />
        <p class="small" style={{ marginTop: '10px' }}>
          <PageLink url={page.url}>Отвори страницата <Icon name="external" size={13} /></PageLink>
        </p>
      </div>
    </div>
  );
}
