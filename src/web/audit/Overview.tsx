import type { JSX } from 'preact';
import type { EngineRun, SiteAuditReport } from '../../shared/audit';
import { ENGINE_LABELS } from '../../shared/domain';
import { Breakable, Verdict } from '../components/Pips';
import { Callout, Icon, Meter } from '../components/ui';
import { duration, intervalText, noPageShare, pathOf, SITE_SOURCE_TEXT, topPlan } from '../lib/audit';
import { clamp01, int, pct, usd } from '../lib/format';

// The first screen of an audit: four headline numbers (one for each panel), what the AI engines really say about the
// site, what to do first, and what the audit cost.

function Panel({ href, no, title, value, unit, sub, bar, go }: { href: string; no: string; title: string; value: string; unit: string; sub: string; bar: JSX.Element | null; go: string }): JSX.Element {
  return (
    <a class="au-panel" href={href}>
      <span class="au-panel-head">
        <span class="au-panel-no" aria-hidden="true">{no}</span>
        <span class="au-panel-title">{title}</span>
      </span>
      <span class="au-panel-num">{value}</span>
      <span class="au-panel-unit">{unit}</span>
      {bar}
      <span class="au-panel-sub">{sub}</span>
      <span class="au-panel-go">
        {go}
        <Icon name="chevron" size={14} />
      </span>
    </a>
  );
}

const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

function Panels({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const f = audit.figures;
  const base = `#/audit/${encodeURIComponent(audit.id)}`;
  const bar = (value: number | null, label: string): JSX.Element | null => (value === null ? null : <Meter value={value} label={label} />);
  const now = f.citabilityNow;
  const after = f.citabilityAfter;
  return (
    <div class="au-panels">
      <Panel
        href={`${base}/elements`}
        no="01"
        title="Всеки SEO елемент, оценен поотделно"
        value={int(f.elementsToChange)}
        unit="елемента за промяна"
        bar={bar(share(f.elementsToChange, f.elementsTotal), 'Дял на елементите за промяна')}
        sub={`от ${int(f.elementsTotal)} оценени на ${int(audit.site.pagesAudited)} страници`}
        go="Към елементите"
      />
      <Panel
        href={`${base}/competitors`}
        no="02"
        title="Страници и техники за копиране от конкурентите"
        value={int(f.pagesToSteal)}
        unit="страници за копиране"
        bar={bar(share(f.pagesToSteal, f.competitorPagesTotal), 'Дял на страниците за копиране')}
        sub={f.competitorPagesTotal > 0 ? `от ${int(f.competitorPagesTotal)} прочетени конкурентни страници` : 'няма прочетени конкурентни страници'}
        go="Към конкурентите"
      />
      <Panel
        href={`${base}/questions`}
        no="03"
        title="Отговарят ли страниците ни на въпросите, които хората задават на ИИ?"
        value={pct(noPageShare(f))}
        unit="от въпросите нямат страница"
        bar={bar(noPageShare(f), 'Дял на въпросите без страница')}
        sub={f.questionsTotal > 0 ? `${int(f.questionsNoPage)} от ${int(f.questionsTotal)} въпроса` : 'няма проверени въпроси'}
        go="Към въпросите"
      />
      <Panel
        href={`${base}/citability`}
        no="04"
        title="Колко вероятно е всяка страница да бъде цитирана?"
        value={pct(now)}
        unit="шанс за цитиране"
        bar={
          now === null ? null : (
            <span class="au-ba" role="img" aria-label={`Шанс за цитиране: сега ${pct(now)}${after !== null ? `, след поправките ${pct(after)}` : ''}`}>
              <span class="au-ba-now" style={{ width: `${clamp01(now) * 100}%` }} />
              {after !== null ? <span class="au-ba-gain" style={{ left: `${clamp01(now) * 100}%`, width: `${Math.max(0, clamp01(after) - clamp01(now)) * 100}%` }} /> : null}
            </span>
          )
        }
        sub={after !== null ? `след поправките: ${pct(after)}` : 'няма оценени страници'}
        go="Към цитирането"
      />
    </div>
  );
}

function EngineRow({ e }: { e: EngineRun }): JSX.Element {
  const none = e.answered === 0;
  return (
    <li class="au-engine">
      <div class="au-engine-name">
        <strong>{e.label}</strong>
        <span class="xs muted">{e.model}{e.search ? '' : ' · без търсене'}</span>
      </div>
      {none ? (
        <span class="muted small au-range-none">няма отговори</span>
      ) : (
        <span class="au-range" role="img" aria-label={`${e.label}: ${pct(e.rate)} от отговорите цитират или назовават сайта; 95% интервал от ${pct(e.rateLow)} до ${pct(e.rateHigh)}`}>
          <span class="au-range-band" style={{ left: `${clamp01(e.rateLow) * 100}%`, width: `${Math.max(0, clamp01(e.rateHigh) - clamp01(e.rateLow)) * 100}%` }} />
          <span class="au-range-mark" style={{ left: `${clamp01(e.rate) * 100}%` }} />
        </span>
      )}
      <div class="au-engine-rate">
        <strong>{none ? '—' : pct(e.rate)}</strong>
        {none ? null : <span class="xs muted">интервал {intervalText(e.rateLow, e.rateHigh)}</span>}
      </div>
      <div class="au-engine-n small muted">
        {e.citingUs} от {e.answered} отговора{e.failed > 0 ? ` · ${e.failed} без отговор` : ''}
      </div>
    </li>
  );
}

function Engines({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const engines = audit.geo?.engines ?? [];
  return (
    <section class="card" aria-labelledby="au-geo-title">
      <div class="card-head">
        <h2 id="au-geo-title">Реално цитиране от ИИ</h2>
        <p>дял от отговорите, в които асистентът цитира или назовава сайта · 95% интервал</p>
      </div>
      {engines.length === 0 ? (
        <p class="muted row" style={{ flexWrap: 'nowrap' }}>
          <Icon name="info" size={16} />
          <span>ИИ двигателите не са питани — добави ключове в <a href="#/settings">Настройки</a>.</span>
        </p>
      ) : (
        <>
          <ul class="au-engines">
            {engines.map((e) => (
              <EngineRow key={e.engine} e={e} />
            ))}
          </ul>
          <a class="btn btn-sm" href={`#/audit/${encodeURIComponent(audit.id)}/geo`}>Подробно: ИИ видимост</a>
        </>
      )}
    </section>
  );
}

function FirstSteps({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const top = topPlan(audit.plan, 5);
  return (
    <section class="card" aria-labelledby="au-first-title">
      <div class="card-head">
        <h2 id="au-first-title">Какво да направиш първо</h2>
        <a class="btn btn-sm" href={`#/audit/${encodeURIComponent(audit.id)}/plan`}>Целия план</a>
      </div>
      {top.length === 0 ? (
        <p class="muted">Още няма предложени страници — планът се изготвя от въпросите без страница и от отговорите на ИИ двигателите.</p>
      ) : (
        <ol class="au-todo">
          {top.map((p, i) => {
            const first = p.checklist[0];
            const where = p.kind === 'create' ? p.suggestedPath : p.url ? pathOf(p.url) : null;
            return (
              <li key={p.id}>
                <span class="au-todo-no" aria-hidden="true">{i + 1}</span>
                <div>
                  <div class="row" style={{ gap: '10px' }}>
                    <span class="cell-main">{p.title}</span>
                    <Verdict kind={p.kind} />
                  </div>
                  {where ? <div class="cell-sub"><Breakable text={where} /></div> : null}
                  {first ? <div class="small" style={{ marginTop: '4px' }}><span class="muted">Първа стъпка: </span>{first.text}</div> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Cost({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const u = audit.usage;
  const engines = audit.geo?.engines ?? [];
  return (
    <section class="card" aria-labelledby="au-cost-title">
      <div class="card-head">
        <h2 id="au-cost-title">Разход</h2>
        <p>какво струва и колко отне този одит</p>
      </div>
      <dl class="kv">
        <dt>Продължителност</dt>
        <dd>{duration(u.durationMs)}</dd>
        <dt>Заявки към Jev</dt>
        <dd>{int(u.jevRequests)} {u.jevFailures > 0 ? <span class="muted">({u.jevFailures} неуспешни)</span> : null}</dd>
        <dt>Токени към Jev</dt>
        <dd>{int(u.jevInputTokens)} вход · {int(u.jevOutputTokens)} изход</dd>
        <dt>Цена на Jev (прибл.)</dt>
        <dd>{usd(u.estimatedJevCostUsd)}</dd>
        <dt>SERP заявки</dt>
        <dd>{int(u.serpCalls)}</dd>
        <dt>Страници</dt>
        <dd>{int(u.pagesFetched)} прочетени · {int(u.pagesFailed)} неуспешни</dd>
        <dt>ИИ двигатели</dt>
        <dd>
          {u.engineCalls === 0 ? (
            'не са питани'
          ) : (
            <>
              {int(u.engineCalls)} заявки
              {u.estimatedEngineCostUsd !== null ? ` · ${usd(u.estimatedEngineCostUsd)} (прибл.)` : <span class="muted"> · цената зависи от модела</span>}
            </>
          )}
        </dd>
        {engines.length > 1 && u.estimatedEngineCostUsd === null
          ? engines.map((e) => (
              <div key={e.engine} class="au-kv-sub">
                <dt>{ENGINE_LABELS[e.engine]}</dt>
                <dd>{int(e.usage.calls)} заявки · {e.usage.estimatedCostUsd === null ? 'цената не е известна' : `${usd(e.usage.estimatedCostUsd)} (прибл.)`}</dd>
              </div>
            ))
          : null}
        <dt>Писане на предложения</dt>
        <dd>{audit.providers.writer ? `${int(u.writerCalls)} заявки · ${audit.providers.writer}` : 'фиксирани правила (без ИИ)'}</dd>
      </dl>
    </section>
  );
}

function SiteFacts({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const s = audit.site;
  const p = audit.providers;
  return (
    <section class="card" aria-labelledby="au-site-title">
      <div class="card-head">
        <h2 id="au-site-title">Сайтът</h2>
        <p>откъде е взет списъкът със страници</p>
      </div>
      <dl class="kv">
        <dt>Домейн</dt>
        <dd>{s.domain}</dd>
        <dt>Страници</dt>
        <dd>{int(s.pagesAudited)} одитирани от {int(s.pagesFound)} открити</dd>
        <dt>Откъде са</dt>
        <dd>{SITE_SOURCE_TEXT[s.source]}</dd>
        <dt>Режим</dt>
        <dd>{audit.mode === 'demo' ? 'ДЕМО (примерни данни)' : 'реален'}</dd>
        <dt>Jev</dt>
        <dd>{p.jev.model}</dd>
        <dt>Google данни</dt>
        <dd>{p.serp ?? 'не е настроен'}</dd>
        <dt>ИИ двигатели</dt>
        <dd>{p.engines.length === 0 ? 'няма' : p.engines.map((e) => `${ENGINE_LABELS[e.engine]} (${e.model})`).join(', ')}</dd>
      </dl>
      {s.truncated ? (
        <div style={{ marginTop: '14px' }}>
          <Callout kind="info">
            Сайтът има повече страници, отколкото е зададеният лимит: одитирани са {int(s.pagesAudited)} от {int(s.pagesFound)}. Увеличи „Страници от сайта“ при нов одит, за да ги обхванеш всички.
          </Callout>
        </div>
      ) : null}
    </section>
  );
}

export function Overview({ audit }: { audit: SiteAuditReport }): JSX.Element {
  return (
    <div class="stack-lg">
      <Panels audit={audit} />
      <Engines audit={audit} />
      <FirstSteps audit={audit} />
      {audit.warnings.length > 0 ? (
        <Callout kind="warn">
          <strong>Бележки към този одит</strong>
          <ul>
            {audit.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <div class="grid grid-2">
        <Cost audit={audit} />
        <SiteFacts audit={audit} />
      </div>
    </div>
  );
}
