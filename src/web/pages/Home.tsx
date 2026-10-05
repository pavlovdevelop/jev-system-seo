import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MARKET_IDS, MARKETS, type MarketId } from '../../shared/markets';
import type { AnalyzeRequestInput, ReportSummary, StatusResponse } from '../../shared/schemas';
import { Callout, Difficulty, Empty, Icon, Loading } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, int } from '../lib/format';
import { estimateRun, parseDomains, parseUrls } from '../lib/form';
import { navigate, useAsync } from '../lib/hooks';

interface FormState {
  keyword: string;
  market: MarketId;
  ownDomain: string;
  ownUrl: string;
  businessDescription: string;
  competitors: string;
  manualUrls: string;
  remember: boolean;
  expandKeywords: boolean;
  maxCandidates: number;
  deepPages: number;
  serpDepth: 10 | 20;
}

const INITIAL: FormState = {
  keyword: '',
  market: 'bg',
  ownDomain: '',
  ownUrl: '',
  businessDescription: '',
  competitors: '',
  manualUrls: '',
  remember: true,
  expandKeywords: true,
  maxCandidates: 20,
  deepPages: 10,
  serpDepth: 10,
};

const MAX_DESCRIPTION = 600;
const stepsUpTo = (max: number, steps: readonly number[]): number[] => [...new Set(steps.filter((s) => s <= max).concat(max))].sort((a, b) => a - b);

function Setup({ status }: { status: StatusResponse }): JSX.Element | null {
  if (status.demo) return null;
  const jevMissing = !status.jev.configured;
  const serpMissing = !status.serp.configured;
  if (!jevMissing && !serpMissing) return null;
  return (
    <div class="stack">
      {jevMissing ? (
        <Callout kind="error">
          <strong>Jev не е свързан.</strong> Без него платформата не може да оценява страниците. Добави <code>JEV_API_KEY</code> във файла <code>.env</code> на сървъра и го рестартирай — стъпките са в <a href="#/settings">Настройки</a>.
        </Callout>
      ) : null}
      {serpMissing ? (
        <Callout kind="warn">
          <strong>Няма източник за резултатите от Google.</strong> Jev не знае какво е на първа страница днес — това идва от SERP доставчик (<code>SERPER_API_KEY</code> или DataForSEO). Дотогава можеш да въведеш адреси на конкурентите ръчно в „Разширени настройки“ — тогава няма да има автоматично търсене на свързани фрази.
        </Callout>
      ) : null}
    </div>
  );
}

function HowItWorks(): JSX.Element {
  return (
    <section class="card">
      <div class="card-head">
        <h2>Как работи</h2>
      </div>
      <ol class="steps-how">
        <li>
          <div>
            <strong>Google.</strong> Взимам водещите резултати за фразата през SERP доставчик и намирам свързани фрази и въпроси.
          </div>
        </li>
        <li>
          <div>
            <strong>Страниците.</strong> Тегля публичните страници на конкурентите (спазвам <code>robots.txt</code>) и измервам заглавия, дължина, FAQ, цени, контакти.
          </div>
        </li>
        <li>
          <div>
            <strong>Jev.</strong> Решава това, което не се брои: какъв тип страница е, на каква нужда отговаря, колко е конкретна, вдъхва ли доверие. Оценките и подредбата ги смята кодът — всяка е проследима.
          </div>
        </li>
        <li>
          <div>
            <strong>Възможности.</strong> За всяка свързана фраза проверявам колко слаба е конкуренцията и показвам къде по-малък сайт може да спечели.
          </div>
        </li>
      </ol>
      <p class="small muted" style={{ marginTop: '14px' }}>
        Jev не пише текст и не гледа Google на живо — отговаря с вероятности и сигурност. Оценките са ориентир за приоритет, не гаранция за позиция.
      </p>
    </section>
  );
}

function History({ rows, onDelete }: { rows: ReportSummary[]; onDelete: (r: ReportSummary) => void }): JSX.Element {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.keyword.toLowerCase().includes(q) || (r.topDomain ?? '').includes(q)) : rows;
  return (
    <section class="card" aria-labelledby="history-title">
      <div class="card-head">
        <h2 id="history-title">Предишни анализи</h2>
        <p>{rows.length} {rows.length === 1 ? 'отчет' : 'отчета'}, запазени на сървъра</p>
      </div>
      {rows.length > 6 ? (
        <div class="toolbar">
          <input class="input" type="search" placeholder="Търси по фраза или домейн" aria-label="Търси в предишните анализи" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Empty title="Още няма анализи">Първият отчет ще се появи тук и ще остане запазен, за да сравняваш във времето.</Empty>
      ) : shown.length === 0 ? (
        <Empty title="Няма съвпадения" />
      ) : (
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Предишни анализи</caption>
            <thead>
              <tr>
                <th scope="col">Фраза</th>
                <th scope="col">Дата</th>
                <th scope="col" class="num">Бързи победи</th>
                <th scope="col" class="num">Фрази</th>
                <th scope="col">Конкуренция</th>
                <th scope="col">Водещ сайт</th>
                <th scope="col"><span class="sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td class="col-wide">
                    <a href={`#/report/${encodeURIComponent(r.id)}`} class="cell-main">{r.keyword}</a>
                    <div class="cell-sub">
                      {MARKETS[r.market]?.label ?? r.market}
                      {r.mode === 'demo' ? ' · демо' : ''}
                      {r.status === 'partial' ? ' · непълен' : ''}
                    </div>
                  </td>
                  <td class="nowrap">{dateTime(r.createdAt)}</td>
                  <td class="num">{int(r.quickWins)}</td>
                  <td class="num">{int(r.opportunities)}</td>
                  <td><Difficulty value={r.difficulty} /></td>
                  <td class="trunc">{r.topDomain ?? '—'}</td>
                  <td class="num nowrap">
                    <a class="btn btn-sm" href={`#/report/${encodeURIComponent(r.id)}`}>Отвори</a>
                    <button type="button" class="icon-btn" aria-label={`Изтрий отчета за ${r.keyword}`} onClick={() => onDelete(r)}>
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

export function HomePage({ status }: { status: StatusResponse }): JSX.Element {
  const settings = useAsync(() => api.settings(), []);
  const reports = useAsync(() => api.reports(), []);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const prefilled = useRef(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => setForm((f) => ({ ...f, [key]: value }));

  // The saved profile (and, in demo mode, the sample data) fills only what the user has not typed yet.
  useEffect(() => {
    if (prefilled.current || !settings.data) return;
    prefilled.current = true;
    const { settings: s, demoDefaults: d } = settings.data;
    setForm((f) => ({
      ...f,
      market: s.market,
      keyword: f.keyword || d?.keyword || '',
      ownDomain: f.ownDomain || s.ownDomain || d?.ownDomain || '',
      businessDescription: f.businessDescription || s.businessDescription || d?.businessDescription || '',
      competitors: f.competitors || (d && s.competitors.length === 0 ? d.competitors.join('\n') : ''),
    }));
  }, [settings.data]);

  const trackedCount = settings.data?.settings.competitors.length ?? 0;
  const manualMode = !status.serp.configured;
  const maxDeep = Math.max(1, status.limits.maxDeepPages);
  const maxCandidates = Math.max(0, status.limits.maxCandidates);
  const startable = status.demo || (status.jev.configured && (status.serp.configured || parseUrls(form.manualUrls).ok.length > 0));

  const parsedCompetitors = useMemo(() => parseDomains(form.competitors), [form.competitors]);
  const parsedManual = useMemo(() => parseUrls(form.manualUrls), [form.manualUrls]);
  const estimate = useMemo(
    () =>
      estimateRun({
        deepPages: Math.min(form.deepPages, maxDeep),
        expandKeywords: form.expandKeywords && !manualMode,
        maxCandidates: Math.min(form.maxCandidates, maxCandidates),
        serpDepth: form.serpDepth,
        hasOwnUrl: form.ownUrl.trim() !== '',
        manualMode,
        extraCompetitors: parsedCompetitors.ok.length + trackedCount,
        pageCap: maxDeep,
      }),
    [form, manualMode, maxDeep, maxCandidates, parsedCompetitors.ok.length, trackedCount],
  );

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setProblem(null);
    const keyword = form.keyword.trim().replace(/\s+/g, ' ');
    if (keyword.length < 2) return setProblem('Въведи ключова дума.');

    const own = form.ownDomain.trim() ? parseDomains(form.ownDomain) : { ok: [], bad: [] };
    if (own.bad.length > 0 || own.ok.length > 1) return setProblem('Домейнът ти трябва да е един, напр. mysite.bg.');
    if (parsedCompetitors.bad.length > 0) return setProblem(`Не разпознавам като домейн: ${parsedCompetitors.bad.join(', ')}. Напиши ги като competitor.bg, по един на ред.`);
    if (parsedManual.bad.length > 0) return setProblem(`Не разпознавам като адрес: ${parsedManual.bad.join(', ')}. Адресите са от вида https://site.bg/страница.`);
    const ownUrl = form.ownUrl.trim() ? parseUrls(form.ownUrl) : { ok: [], bad: [] };
    if (ownUrl.bad.length > 0 || ownUrl.ok.length > 1) return setProblem('Страницата ти трябва да е един адрес, напр. https://mysite.bg/uslugi/uebsait.');
    if (manualMode && !status.demo && parsedManual.ok.length === 0) return setProblem('Няма SERP доставчик — въведи поне един адрес на конкурентна страница в „Разширени настройки“.');

    const body: AnalyzeRequestInput = {
      keyword,
      market: form.market,
      ownDomain: own.ok[0] ?? null,
      ownUrl: ownUrl.ok[0] ?? null,
      competitors: parsedCompetitors.ok,
      manualUrls: parsedManual.ok,
      businessDescription: form.businessDescription.trim(),
      options: { deepPages: Math.min(form.deepPages, maxDeep), expandKeywords: form.expandKeywords && !manualMode, maxCandidates: Math.min(form.maxCandidates, maxCandidates), serpDepth: form.serpDepth },
    };

    setBusy(true);
    try {
      if (form.remember) {
        // Remembering is a convenience: a failure here must never block the analysis itself.
        await api.saveSettings({ businessDescription: body.businessDescription ?? '', ownDomain: own.ok[0] ?? null, market: form.market }).catch(() => undefined);
      }
      const { job } = await api.startAnalysis(body);
      navigate(`/run/${job.id}`);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Неуспешно стартиране на анализа.');
      setBusy(false);
    }
  };

  const remove = async (r: ReportSummary): Promise<void> => {
    if (!confirm(`Да изтрия ли отчета за „${r.keyword}“?`)) return;
    try {
      await api.deleteReport(r.id);
      reports.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Неуспешно изтриване.');
    }
  };

  const deepOptions = stepsUpTo(maxDeep, [3, 5, 8, 10, 12, 15]);
  const candidateOptions = stepsUpTo(Math.max(maxCandidates, 1), [10, 20, 30, 40]);
  const remaining = MAX_DESCRIPTION - form.businessDescription.length;

  return (
    <div class="stack-lg">
      <div class="page-head" style={{ marginBottom: 0 }}>
        <h1>Кой е пред теб в Google и къде можеш да го изпревариш</h1>
        <p class="page-sub">
          Въведи ключова дума. Платформата намира водещите сайтове, чете страниците им и с помощта на Jev показва силните и слабите им страни и свързаните фрази, по които можеш да се класираш бързо.
        </p>
      </div>

      <Setup status={status} />

      <div class="grid grid-main" style={{ alignItems: 'start' }}>
        <form class="card stack-lg" onSubmit={submit} noValidate aria-describedby={problem ? 'form-problem' : undefined}>
          <div class="field">
            <label class="label" for="f-keyword">Ключова дума</label>
            <input id="f-keyword" class="input input-xl" type="text" required minLength={2} maxLength={120} autoFocus autoComplete="off" placeholder="напр. изработка на уеб сайт" value={form.keyword} onInput={(e) => set('keyword', e.currentTarget.value)} />
            <span class="hint">Фразата, по която искаш да се класираш. Анализът е за една фраза наведнъж.</span>
          </div>

          <div class="grid grid-2">
            <div class="field">
              <label class="label" for="f-market">Пазар</label>
              <select id="f-market" class="select" value={form.market} onChange={(e) => set('market', e.currentTarget.value as MarketId)}>
                {MARKET_IDS.map((id) => (
                  <option key={id} value={id}>{MARKETS[id].label}</option>
                ))}
              </select>
              <span class="hint">От кой Google гледаме резултатите.</span>
            </div>
            <div class="field">
              <label class="label" for="f-own">Твоят домейн <span class="muted">(по желание)</span></label>
              <input id="f-own" class="input" type="text" inputMode="url" autoComplete="off" spellcheck={false} placeholder="mysite.bg" value={form.ownDomain} onInput={(e) => set('ownDomain', e.currentTarget.value)} />
              <span class="hint">За да видим къде си ти и какво ти липсва.</span>
            </div>
          </div>

          <div class="field">
            <label class="label" for="f-ownurl">Твоята страница за тази фраза <span class="muted">(по желание)</span></label>
            <input id="f-ownurl" class="input" type="text" inputMode="url" autoComplete="off" spellcheck={false} placeholder="https://mysite.bg/uslugi/izrabotka-na-sait" value={form.ownUrl} onInput={(e) => set('ownUrl', e.currentTarget.value)} />
            <span class="hint">Ако вече имаш страница, ще я сравним с водещите и ще получиш конкретен списък с липси.</span>
          </div>

          <div class="field">
            <label class="label" for="f-desc">Какво предлага бизнесът ти <span class="muted">(по желание)</span></label>
            <textarea id="f-desc" class="textarea" maxLength={MAX_DESCRIPTION} rows={3} placeholder="напр. Агенция в София, правим уебсайтове и онлайн магазини за малки и средни фирми." value={form.businessDescription} onInput={(e) => set('businessDescription', e.currentTarget.value)} />
            <span class="hint">Jev го ползва, за да отсее свързаните фрази, които наистина са за теб. Остават {remaining} знака.</span>
          </div>

          <div class="field">
            <label class="label" for="f-comp">Допълнителни конкуренти за този анализ <span class="muted">(по желание)</span></label>
            <textarea id="f-comp" class="textarea" rows={3} spellcheck={false} placeholder={'competitor-one.bg\ncompetitor-two.com'} value={form.competitors} onInput={(e) => set('competitors', e.currentTarget.value)} />
            <span class="hint">
              По един домейн на ред. Ще бъдат описани, дори да не са в първите резултати.
              {trackedCount > 0 ? <> Винаги се включват и <strong>{trackedCount}</strong> следени конкуренти — <a href="#/competitors">управлявай ги</a>.</> : <> Постоянен списък можеш да водиш в <a href="#/competitors">Конкуренти</a>.</>}
            </span>
          </div>

          <details class="adv" open={manualMode && !status.demo}>
            <summary>Разширени настройки</summary>
            <div class="stack-lg">
              <div class="field">
                <label class="label" for="f-urls">Страници на конкуренти за директен анализ</label>
                <textarea id="f-urls" class="textarea" rows={3} spellcheck={false} placeholder={'https://competitor.bg/uslugi/sait\nhttps://other.com/web-design'} value={form.manualUrls} onInput={(e) => set('manualUrls', e.currentTarget.value)} />
                <span class="hint">
                  {manualMode && !status.demo ? 'Без SERP доставчик това е единственият вход: анализирам точно тези страници.' : 'По един адрес на ред. Анализират се наред с водещите резултати.'}
                </span>
              </div>

              <div class="grid grid-2">
                <div class="field">
                  <label class="label" for="f-deep">Страници за подробен анализ</label>
                  <select id="f-deep" class="select" value={String(form.deepPages)} onChange={(e) => set('deepPages', Number(e.currentTarget.value))}>
                    {deepOptions.map((n) => (
                      <option key={n} value={n}>{n} първи резултата</option>
                    ))}
                  </select>
                  <span class="hint">Тегля и оценявам с Jev само тези страници.</span>
                </div>
                <div class="field">
                  <label class="label" for="f-depth">Резултати от Google</label>
                  <select id="f-depth" class="select" value={String(form.serpDepth)} onChange={(e) => set('serpDepth', e.currentTarget.value === '20' ? 20 : 10)} disabled={manualMode}>
                    <option value="10">първите 10</option>
                    <option value="20">първите 20</option>
                  </select>
                  <span class="hint">Повече резултати = по-широка картина и по-висока цена на SERP заявката.</span>
                </div>
              </div>

              <div class="stack">
                <label class="check">
                  <input type="checkbox" checked={form.expandKeywords && !manualMode} disabled={manualMode} onChange={(e) => set('expandKeywords', e.currentTarget.checked)} />
                  <span>
                    <strong>Търси свързани фрази, по които можеш да се класираш бързо</strong>
                    <span class="hint" style={{ display: 'block' }}>Генерира кандидати от резултатите и въпросите на Google, Jev отсява релевантните, а за най-добрите проверявам конкуренцията.</span>
                  </span>
                </label>
                <div class="field" style={{ maxWidth: '320px' }}>
                  <label class="label" for="f-cand">Колко свързани фрази да проверя</label>
                  <select id="f-cand" class="select" value={String(Math.min(form.maxCandidates, Math.max(maxCandidates, 1)))} onChange={(e) => set('maxCandidates', Number(e.currentTarget.value))} disabled={!form.expandKeywords || manualMode || maxCandidates === 0}>
                    {candidateOptions.map((n) => (
                      <option key={n} value={n}>{n} фрази</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </details>

          <label class="check">
            <input type="checkbox" checked={form.remember} onChange={(e) => set('remember', e.currentTarget.checked)} />
            <span>Запомни пазара, домейна и описанието за следващите анализи</span>
          </label>

          {problem ? <div id="form-problem"><Callout kind="error">{problem}</Callout></div> : null}

          <div class="stack">
            <div class="row">
              <button type="submit" class="btn btn-primary" disabled={busy || !startable || form.keyword.trim().length < 2}>
                <Icon name="search" />
                {busy ? 'Стартирам…' : 'Анализирай'}
              </button>
              {!startable ? <span class="small muted">{status.jev.configured ? 'Въведи адреси на конкуренти, за да стартираш без SERP доставчик.' : 'Първо свържи Jev (виж Настройки).'}</span> : null}
            </div>
            <p class="small muted">
              Най-много ≈{int(estimate.serpCalls)} заявки към Google, ≈{int(estimate.jevRequests)} кратки заявки към Jev и {int(estimate.pages)} изтеглени страници. Повтарящите се отговори се взимат от кеша и не се плащат; реалната цена се вижда в отчета.
            </p>
          </div>
        </form>

        <aside class="stack">
          <HowItWorks />
        </aside>
      </div>

      {reports.loading && !reports.data ? <Loading text="Зареждам предишните анализи…" /> : null}
      {reports.error && !reports.data ? <Callout kind="error">{reports.error.message}</Callout> : null}
      {reports.data ? <History rows={reports.data.reports} onDelete={remove} /> : null}
    </div>
  );
}
