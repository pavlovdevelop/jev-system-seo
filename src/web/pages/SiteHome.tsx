import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SiteAuditListItem } from '../../shared/audit';
import type { EngineId } from '../../shared/domain';
import { MARKET_IDS, MARKETS, type MarketId } from '../../shared/markets';
import { bgCount } from '../../shared/plural';
import type { StatusResponse } from '../../shared/schemas';
import { Callout, Empty, Icon, Loading } from '../components/ui';
import { api } from '../lib/api';
import {
  AUDIT_DEFAULTS,
  AUDIT_DESCRIPTION_MAX,
  auditBounds,
  BRAND_NAME_MAX,
  BRAND_NAME_MIN,
  BRAND_NAMES_MAX,
  buildAuditRequest,
  clampInt,
  estimateAudit,
  noPageShare,
  parseBrandNames,
  type AuditBounds,
} from '../lib/audit';
import { dateTime, int, pct, usd } from '../lib/format';
import { parseDomains } from '../lib/form';
import { navigate, useAsync } from '../lib/hooks';

interface FormState {
  domain: string;
  market: MarketId;
  description: string;
  brands: string;
  competitors: string;
  engines: Partial<Record<EngineId, boolean>>;
  maxPages: string;
  questions: string;
  competitorPages: string;
  rankChecks: string;
  remember: boolean;
}

const initialForm = (status: StatusResponse): FormState => ({
  domain: '',
  market: 'bg',
  description: '',
  brands: '',
  competitors: '',
  engines: Object.fromEntries(status.engines.map((e) => [e.id, e.configured])),
  maxPages: String(Math.min(AUDIT_DEFAULTS.maxPages, Math.max(1, status.audit.maxPages))),
  questions: String(Math.min(AUDIT_DEFAULTS.questions, Math.max(0, status.audit.maxQuestions))),
  competitorPages: String(AUDIT_DEFAULTS.competitorPages),
  rankChecks: String(AUDIT_DEFAULTS.rankChecks),
  remember: true,
});

const ENV_NAME: Record<EngineId, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

function Setup({ status }: { status: StatusResponse }): JSX.Element | null {
  if (status.demo) return null;
  const jevMissing = !status.jev.configured;
  const serpMissing = !status.serp.configured;
  const noEngine = !status.engines.some((e) => e.configured);
  if (!jevMissing && !serpMissing && !noEngine) return null;
  return (
    <div class="stack">
      {jevMissing ? (
        <Callout kind="error">
          <strong>Jev не е свързан.</strong> Без него платформата не може да оценява страниците. Добави <code>JEV_API_KEY</code> във файла <code>.env</code> на сървъра и го рестартирай — стъпките са в <a href="#/settings">Настройки</a>.
        </Callout>
      ) : null}
      {serpMissing ? (
        <Callout kind="warn">
          <strong>Няма източник за резултатите от Google.</strong> Позициите в Google и страниците на конкурентите идват от SERP доставчик (<code>SERPER_API_KEY</code> или DataForSEO). Без него тези части няма да ги има в одита.
        </Callout>
      ) : null}
      {noEngine ? (
        <Callout kind="info">
          <strong>Няма настроен ИИ асистент.</strong> Частта „ИИ видимост“ — какво казват ChatGPT, Claude и Gemini за сайта ти — ще бъде пропусната. Добави поне един ключ (<code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code> или <code>GEMINI_API_KEY</code>) — виж <a href="#/settings">Настройки</a>.
        </Callout>
      ) : null}
    </div>
  );
}

/** What the audit will do and what it will roughly cost, as upper bounds: cached answers are free. */
function Estimate({ status, numbers, engines }: { status: StatusResponse; numbers: { pages: number; questions: number; competitorPages: number; rankChecks: number }; engines: number }): JSX.Element {
  const e = estimateAudit({ ...numbers, engines, caps: status.audit, serp: status.demo || status.serp.configured });
  const configured = status.engines.filter((x) => x.configured).length;
  const asksAi = engines > 0 && e.engineCalls > 0;
  return (
    <div class="au-estimate" role="group" aria-labelledby="est-title">
      <h2 id="est-title">Какво ще направи одитът <span class="muted">— най-много</span></h2>
      <dl class="au-est-grid">
        <div>
          <dt>страници за четене</dt>
          <dd>≈{int(e.pagesToRead)}</dd>
          <dd class="au-est-sub">{int(e.pages)} твои + {int(e.competitorPages)} на конкуренти</dd>
        </div>
        <div>
          <dt>заявки към Jev</dt>
          <dd>≈{int(e.jevRequests)}</dd>
          <dd class="au-est-sub">≈{int(e.jevInputTokens)} токена · {usd(e.jevCostUsd)}</dd>
        </div>
        <div>
          <dt>заявки към Google</dt>
          <dd>≈{int(e.serpCalls)}</dd>
          <dd class="au-est-sub">{numbers.rankChecks} позиции + основни</dd>
        </div>
        <div>
          <dt>заявки към ИИ</dt>
          <dd>{asksAi ? `≈${int(e.engineCalls)}` : '—'}</dd>
          <dd class="au-est-sub">{asksAi ? `${bgCount(engines, 'двигател', 'двигателя')} × ${bgCount(e.questions, 'въпрос', 'въпроса')}` : 'няма'}</dd>
        </div>
      </dl>
      {configured === 0 && !status.demo ? (
        <p class="small">Няма настроен ИИ двигател, затова частта „ИИ видимост“ се пропуска.</p>
      ) : asksAi ? (
        <p class="small muted">Цената на ИИ двигателите зависи от модела — виж таблото на доставчика.</p>
      ) : null}
      <p class="small muted">Повтарящите се отговори се взимат от кеша и не се плащат; реалната цена се вижда в отчета.</p>
    </div>
  );
}

function WhatYouGet(): JSX.Element {
  return (
    <section class="card">
      <div class="card-head">
        <h2>Какво получаваш</h2>
      </div>
      <ol class="steps-how">
        <li><div><strong>SEO елементите.</strong> Заглавие, описание, H1, FAQ, schema и още — всеки оценен поотделно, с предложение какво да стане.</div></li>
        <li><div><strong>Конкурентите.</strong> Кои техники на водещите страници си струва да вземеш и кои да пропуснеш.</div></li>
        <li><div><strong>Въпросите.</strong> На кои въпроси на купувачите нямаш страница с отговор.</div></li>
        <li><div><strong>Цитирането.</strong> Колко вероятно е ИИ да цитира всяка от страниците ти и какво да поправиш първо.</div></li>
        <li><div><strong>ИИ видимостта.</strong> Какво наистина казват ChatGPT, Claude и Gemini за сайта ти.</div></li>
        <li><div><strong>Плана.</strong> Страници за писане или пренаписване — с подредени чеклисти.</div></li>
      </ol>
      <p class="small muted" style={{ marginTop: '14px' }}>Оценките са ориентир за приоритет, не гаранция, че ИИ ще те цитира.</p>
    </section>
  );
}

function Hint({ bounds, children }: { bounds: { min: number; max: number }; children: string }): JSX.Element {
  return <span class="hint">{children} От {bounds.min} до {bounds.max}.</span>;
}

function History({ rows, onDelete }: { rows: SiteAuditListItem[]; onDelete: (a: SiteAuditListItem) => void }): JSX.Element {
  return (
    <section class="card" aria-labelledby="audits-title">
      <div class="card-head">
        <h2 id="audits-title">Предишни одити</h2>
        <p>{bgCount(rows.length, 'одит', 'одита')}, запазени на сървъра</p>
      </div>
      {rows.length === 0 ? (
        <Empty title="Още няма одити">Първият одит ще се появи тук и ще остане запазен, за да сравняваш във времето.</Empty>
      ) : (
        <div class="table-wrap">
          <table class="table mid">
            <caption class="sr-only">Предишни одити на сайтове</caption>
            <thead>
              <tr>
                <th scope="col">Сайт</th>
                <th scope="col">Дата</th>
                <th scope="col" class="num hide-sm" title="Елементи за промяна от всички оценени">За промяна</th>
                <th scope="col" class="num hide-sm" title="Конкурентни страници за копиране">За копиране</th>
                <th scope="col" class="num hide-sm" title="Дял на въпросите без страница">Без страница</th>
                <th scope="col" class="num hide-sm" title="Среден шанс за цитиране от ИИ, сега">Цитиране</th>
                <th scope="col"><span class="sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td class="col-wide">
                    <a href={`#/audit/${encodeURIComponent(a.id)}`} class="cell-main">{a.domain}</a>
                    <div class="cell-sub">
                      {MARKETS[a.market]?.label ?? a.market} · {bgCount(a.pagesAudited, 'страница', 'страници')}
                      {a.mode === 'demo' ? ' · демо' : ''}
                      {a.status === 'partial' ? ' · непълен' : ''}
                    </div>
                    <div class="show-sm cell-sub">
                      {int(a.figures.elementsToChange)} елемента за промяна · цитиране {pct(a.figures.citabilityNow)}
                    </div>
                  </td>
                  <td class="nowrap">{dateTime(a.createdAt)}</td>
                  <td class="num hide-sm">{int(a.figures.elementsToChange)} <span class="muted">/ {int(a.figures.elementsTotal)}</span></td>
                  <td class="num hide-sm">{int(a.figures.pagesToSteal)}</td>
                  <td class="num hide-sm">{pct(noPageShare(a.figures))}</td>
                  <td class="num hide-sm">{pct(a.figures.citabilityNow)}</td>
                  <td class="num nowrap">
                    <a class="btn btn-sm" href={`#/audit/${encodeURIComponent(a.id)}`}>Отвори</a>
                    <button type="button" class="icon-btn" aria-label={`Изтрий одита на ${a.domain}`} onClick={() => onDelete(a)}>
                      <Icon name="trash" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function SiteHomePage({ status }: { status: StatusResponse }): JSX.Element {
  const settings = useAsync(() => api.settings(), []);
  const audits = useAsync(() => api.audits(), []);
  const jobs = useAsync(() => api.jobs(), []);
  const [form, setForm] = useState<FormState>(() => initialForm(status));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const prefilled = useRef(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => setForm((f) => ({ ...f, [key]: value }));
  const bounds: AuditBounds = useMemo(() => auditBounds(status.audit), [status.audit]);

  // The saved profile (and, in demo mode, the sample data) fills only what the user has not typed yet.
  useEffect(() => {
    if (prefilled.current || !settings.data) return;
    prefilled.current = true;
    const { settings: s, demoDefaults: d } = settings.data;
    const tracked = s.competitors.map((c) => c.domain);
    setForm((f) => ({
      ...f,
      market: s.market,
      domain: f.domain || s.ownDomain || d?.ownDomain || '',
      description: f.description || s.businessDescription || d?.businessDescription || '',
      brands: f.brands || (s.brandNames.length > 0 ? s.brandNames : (d?.brandNames ?? [])).join('\n'),
      competitors: f.competitors || (tracked.length > 0 ? tracked : (d?.competitors ?? [])).join('\n'),
    }));
  }, [settings.data]);

  // An audit keeps running when the user leaves its page: show it here, and refresh the list when it ends.
  const running = (jobs.data?.jobs ?? []).filter((j) => j.kind === 'site' && (j.status === 'queued' || j.status === 'running'));
  const runningCount = running.length;
  const wasRunning = useRef(0);
  useEffect(() => {
    if (runningCount === 0) return;
    const timer = setInterval(jobs.reload, 3000);
    return () => clearInterval(timer);
  }, [runningCount, jobs.reload]);
  useEffect(() => {
    if (wasRunning.current > runningCount) audits.reload();
    wasRunning.current = runningCount;
  }, [runningCount, audits.reload]);

  const chosen = status.engines.filter((e) => e.configured && form.engines[e.id] !== false).map((e) => e.id);
  const numbers = {
    pages: clampInt(form.maxPages, bounds.maxPages.min, bounds.maxPages.max, Math.min(AUDIT_DEFAULTS.maxPages, bounds.maxPages.max)),
    questions: clampInt(form.questions, bounds.questions.min, bounds.questions.max, Math.min(AUDIT_DEFAULTS.questions, bounds.questions.max)),
    competitorPages: clampInt(form.competitorPages, bounds.competitorPages.min, bounds.competitorPages.max, AUDIT_DEFAULTS.competitorPages),
    rankChecks: clampInt(form.rankChecks, bounds.rankChecks.min, bounds.rankChecks.max, AUDIT_DEFAULTS.rankChecks),
  };
  const startable = status.demo || status.jev.configured;
  const brandCount = useMemo(() => parseBrandNames(form.brands).names.length, [form.brands]);
  const competitorCount = useMemo(() => parseDomains(form.competitors).ok.length, [form.competitors]);
  const configuredEngines = status.engines.filter((e) => e.configured).length;

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setProblem(null);
    const built = buildAuditRequest(
      { domain: form.domain, market: form.market, description: form.description, brands: form.brands, competitors: form.competitors, engines: chosen, configuredEngines, maxPages: form.maxPages, questions: form.questions, competitorPages: form.competitorPages, rankChecks: form.rankChecks },
      bounds,
    );
    if (!built.ok) return setProblem(built.problem);
    setBusy(true);
    try {
      if (form.remember) {
        // Remembering is a convenience: a failure here must never block the audit itself.
        await api.saveSettings({ ownDomain: built.body.domain, businessDescription: built.body.businessDescription ?? '', brandNames: built.body.brandNames ?? [], market: form.market }).catch(() => undefined);
      }
      const { job } = await api.startAudit(built.body);
      navigate(`/run/${job.id}`);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Неуспешно стартиране на одита.');
      setBusy(false);
    }
  };

  const remove = async (a: SiteAuditListItem): Promise<void> => {
    if (!confirm(`Да изтрия ли одита на „${a.domain}“ от ${dateTime(a.createdAt)}?`)) return;
    try {
      await api.deleteAudit(a.id);
      audits.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Неуспешно изтриване.');
    }
  };

  const remaining = AUDIT_DESCRIPTION_MAX - form.description.length;
  // Fields are held to their range when the user leaves them, so what they see is what the audit will use.
  const settle = (key: 'maxPages' | 'questions' | 'competitorPages' | 'rankChecks', fallback: number): void => {
    const b = bounds[key];
    set(key, String(clampInt(form[key], b.min, b.max, Math.min(fallback, b.max))));
  };

  return (
    <div class="stack-lg">
      <div class="page-head" style={{ marginBottom: 0 }}>
        <h1>Одит на целия сайт</h1>
        <p class="page-sub">
          Проверяваме всички страници на сайта ти: всеки SEO елемент поотделно, какво правят конкурентите, на кои въпроси на купувачите нямаш страница и какво казват ChatGPT, Claude и Gemini за теб. Накрая получаваш подреден план.
        </p>
      </div>

      <Setup status={status} />

      {running.length > 0 ? (
        <Callout>
          <strong>В момента тече одит:</strong>{' '}
          {running.map((j, i) => (
            <span key={j.id}>
              {i > 0 ? ', ' : ''}
              <a href={`#/run/${encodeURIComponent(j.id)}`}>„{j.keyword}“ ({Math.round(j.last?.pct ?? 0)}%)</a>
            </span>
          ))}
        </Callout>
      ) : null}

      <div class="grid grid-main" style={{ alignItems: 'start' }}>
        <form class="card stack-lg" onSubmit={submit} noValidate aria-describedby={problem ? 'form-problem' : undefined}>
          <div class="grid grid-2">
            <div class="field">
              <label class="label" for="a-domain">Домейн на сайта</label>
              <input id="a-domain" class="input input-xl" type="text" inputMode="url" required autoFocus autoComplete="off" spellcheck={false} placeholder="mysite.bg" value={form.domain} onInput={(e) => set('domain', e.currentTarget.value)} />
              <span class="hint">Сайтът, който одитираме. Може и с https://.</span>
            </div>
            <div class="field">
              <label class="label" for="a-market">Пазар</label>
              <select id="a-market" class="select" style={{ minHeight: '50px' }} value={form.market} onChange={(e) => set('market', e.currentTarget.value as MarketId)}>
                {MARKET_IDS.map((id) => (
                  <option key={id} value={id}>{MARKETS[id].label}</option>
                ))}
              </select>
              <span class="hint">От кой Google гледаме резултатите.</span>
            </div>
          </div>

          <div class="field">
            <label class="label" for="a-desc">Какво предлага бизнесът ти</label>
            <textarea id="a-desc" class="textarea" required maxLength={AUDIT_DESCRIPTION_MAX} rows={3} placeholder="напр. Агенция в София, правим уебсайтове и онлайн магазини за малки и средни фирми." value={form.description} onInput={(e) => set('description', e.currentTarget.value)} />
            <span class="hint">По него измисляме въпросите, които купувачите ти задават на ИИ. Остават {remaining} знака.</span>
          </div>

          <div class="grid grid-2">
            <div class="field">
              <label class="label" for="a-brands">Имена на марката <span class="muted">(по желание)</span></label>
              <textarea id="a-brands" class="textarea" rows={3} spellcheck={false} placeholder={'Моето студио\nMy Studio'} value={form.brands} onInput={(e) => set('brands', e.currentTarget.value)} />
              <span class="hint">
                Как ИИ може да нарича бизнеса ти — така разпознаваме споменаване. По едно име на ред ({BRAND_NAME_MIN}–{BRAND_NAME_MAX} знака, най-много {BRAND_NAMES_MAX}){brandCount > 0 ? ` — въведени: ${brandCount}` : ''}.
              </span>
            </div>
            <div class="field">
              <label class="label" for="a-comp">Конкуренти <span class="muted">(по желание)</span></label>
              <textarea id="a-comp" class="textarea" rows={3} spellcheck={false} placeholder={'competitor-one.bg\ncompetitor-two.com'} value={form.competitors} onInput={(e) => set('competitors', e.currentTarget.value)} />
              <span class="hint">
                По един домейн на ред: ще ги разпознаваме в отговорите на ИИ и ще четем страници от тях{competitorCount > 0 ? ` (въведени: ${competitorCount})` : ''}. Постоянен списък водиш в <a href="#/competitors">Конкуренти</a>.
              </span>
            </div>
          </div>

          <fieldset class="au-fieldset">
            <legend class="label">Кого да питаме</legend>
            {status.engines.length === 0 ? (
              <p class="small muted">Сървърът не съобщи кои ИИ асистенти са налични.</p>
            ) : (
              <div class="au-engine-pick">
                {status.engines.map((e) => (
                  <label key={e.id} class={`check${e.configured ? '' : ' is-off'}`}>
                    <input type="checkbox" checked={e.configured && form.engines[e.id] !== false} disabled={!e.configured} onChange={(ev) => set('engines', { ...form.engines, [e.id]: ev.currentTarget.checked })} />
                    <span>
                      <strong>{e.label}</strong>
                      <span class="hint" style={{ display: 'block' }}>{e.configured ? (e.model ?? 'свързан') : <>не е настроен — <code>{ENV_NAME[e.id]}</code></>}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div class="au-num-grid">
            <div class="field">
              <label class="label" for="a-pages">Страници от сайта</label>
              <input id="a-pages" class="input" type="number" inputMode="numeric" min={bounds.maxPages.min} max={bounds.maxPages.max} step={1} value={form.maxPages} onInput={(e) => set('maxPages', e.currentTarget.value)} onBlur={() => settle('maxPages', AUDIT_DEFAULTS.maxPages)} />
              <Hint bounds={bounds.maxPages}>Колко страници да одитираме.</Hint>
            </div>
            <div class="field">
              <label class="label" for="a-questions">Въпроси на купувачите</label>
              <input id="a-questions" class="input" type="number" inputMode="numeric" min={bounds.questions.min} max={bounds.questions.max} step={1} value={form.questions} onInput={(e) => set('questions', e.currentTarget.value)} onBlur={() => settle('questions', AUDIT_DEFAULTS.questions)} />
              <Hint bounds={bounds.questions}>0 — без въпроси и без ИИ.</Hint>
            </div>
            <div class="field">
              <label class="label" for="a-cpages">Страници на конкуренти</label>
              <input id="a-cpages" class="input" type="number" inputMode="numeric" min={bounds.competitorPages.min} max={bounds.competitorPages.max} step={1} value={form.competitorPages} onInput={(e) => set('competitorPages', e.currentTarget.value)} onBlur={() => settle('competitorPages', AUDIT_DEFAULTS.competitorPages)} />
              <Hint bounds={bounds.competitorPages}>Четем в дълбочина.</Hint>
            </div>
            <div class="field">
              <label class="label" for="a-rank">Проверки за позиция</label>
              <input id="a-rank" class="input" type="number" inputMode="numeric" min={bounds.rankChecks.min} max={bounds.rankChecks.max} step={1} value={form.rankChecks} onInput={(e) => set('rankChecks', e.currentTarget.value)} onBlur={() => settle('rankChecks', AUDIT_DEFAULTS.rankChecks)} />
              <Hint bounds={bounds.rankChecks}>Страници, чиято позиция в Google търсим.</Hint>
            </div>
          </div>

          <label class="check">
            <input type="checkbox" checked={form.remember} onChange={(e) => set('remember', e.currentTarget.checked)} />
            <span>Запомни домейна, пазара, описанието и имената на марката за следващите одити</span>
          </label>

          <Estimate status={status} numbers={numbers} engines={chosen.length} />

          {problem ? <div id="form-problem"><Callout kind="error">{problem}</Callout></div> : null}

          <div class="row">
            <button type="submit" class="btn btn-primary" disabled={busy || !startable}>
              <Icon name="search" />
              {busy ? 'Стартирам…' : 'Стартирай одита'}
            </button>
            {!startable ? <span class="small muted">Първо свържи Jev (виж Настройки).</span> : null}
          </div>
        </form>

        <aside class="stack">
          <WhatYouGet />
        </aside>
      </div>

      {audits.loading && !audits.data ? <Loading text="Зареждам предишните одити…" /> : null}
      {audits.error && !audits.data ? <Callout kind="error">{audits.error.message}</Callout> : null}
      {audits.data ? <History rows={audits.data.audits} onDelete={remove} /> : null}
    </div>
  );
}
