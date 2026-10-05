import type { JSX } from 'preact';
import { INTENT_LABELS, PAGE_TYPE_LABELS, type Intent, type PageType } from '../../shared/domain';
import { MARKETS, type MarketId } from '../../shared/markets';
import type { Report } from '../../shared/schemas';
import { Callout, Difficulty, Icon, Loading, Menu, Meter, Tile } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, int, pct } from '../lib/format';
import { navigate, useAsync } from '../lib/hooks';
import { candidatesOf } from '../lib/report';
import { BriefTab } from '../report/BriefTab';
import { CompetitorsTab } from '../report/CompetitorsTab';
import { DataTab } from '../report/DataTab';
import { OpportunitiesTab } from '../report/OpportunitiesTab';
import { Overview } from '../report/Overview';
import { SerpTab } from '../report/SerpTab';
import { useState } from 'preact/hooks';

const TABS = [
  { id: 'overview', label: 'Преглед' },
  { id: 'serp', label: 'Топ резултати' },
  { id: 'opportunities', label: 'Възможности' },
  { id: 'competitors', label: 'Конкуренти' },
  { id: 'brief', label: 'План за съдържание' },
  { id: 'data', label: 'Данни и методика' },
] as const;

function Tiles({ report }: { report: Report }): JSX.Element {
  const { seed } = report;
  const candidates = candidatesOf(report);
  const verified = candidates.filter((o) => o.assessment).length;
  const quick = candidates.filter((o) => o.label === 'quick_win').length;
  const good = candidates.filter((o) => o.label === 'good').length;
  const a = seed.assessment;
  const type = seed.intent.dominantPageType;
  const intent = seed.intent.dominantIntent;
  const hasOwn = report.request.ownDomain !== null;

  return (
    <div class="tiles">
      <Tile hero label="Бързи победи" value={verified > 0 ? quick : '—'} sub={verified > 0 ? `фрази с лесна конкуренция, които си струва да таргетираш — от ${verified} проверени${good > 0 ? `, още ${good} добри` : ''}` : 'Няма проверени фрази: нужен е SERP доставчик и включено търсене на свързани фрази.'} />
      <Tile label="Лекота на класиране" value={a ? pct(a.weakness) : '—'} sub={`за самата фраза „${seed.keyword}“`}>
        {a ? <><Meter value={a.weakness} label="Слабост на конкуренцията" /><Difficulty value={a.difficulty} /></> : null}
      </Tile>
      <Tile text label="Какво показва Google" value={type ? PAGE_TYPE_LABELS[type as PageType] : '—'} sub={type ? `${pct(seed.intent.pageTypeShare[type] ?? 0)} от водещите${intent ? ` · ${INTENT_LABELS[intent as Intent].toLowerCase()}` : ''}` : undefined} />
      <Tile label="Твоята позиция" value={seed.ownRank ? `#${seed.ownRank.position}` : '—'} sub={seed.ownRank ? 'в Google за основната фраза' : hasOwn ? `извън първите ${report.request.options.serpDepth} резултата` : 'няма зададен домейн'} />
      <Tile label="Типична дължина" value={seed.stats.medianWordCount !== null ? `~${int(seed.stats.medianWordCount)}` : '—'} sub={`думи при ${seed.stats.pagesFetched} изтеглени страници`} />
    </div>
  );
}

export function ReportPage({ id, tab }: { id: string; tab: string }): JSX.Element {
  const { data, error, loading } = useAsync(() => api.report(id), [id]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (loading && !data) return <Loading text="Зареждам отчета…" />;
  if (error || !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div class="stack">
        <Callout kind="error">{notFound ? 'Този отчет не е намерен — може да е изтрит.' : (error?.message ?? 'Неуспешно зареждане.')}</Callout>
        <div><a class="btn" href="#/">Към началото</a></div>
      </div>
    );
  }
  const report = data.report;
  const active = TABS.some((t) => t.id === tab) ? tab : 'overview';
  const goTab = (t: string): void => navigate(`/report/${id}/${t}`);
  // Tabs follow the WAI-ARIA pattern: only the active tab is in the Tab order; arrows, Home and End move between tabs.
  const onTabKey = (e: KeyboardEvent): void => {
    const i = TABS.findIndex((t) => t.id === active);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const target = TABS[next] as (typeof TABS)[number];
    goTab(target.id);
    requestAnimationFrame(() => document.getElementById(`tab-${target.id}`)?.focus());
  };

  const rerun = async (keyword: string, ownUrl: string | null): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const r = report.request;
      const { job } = await api.startAnalysis({ keyword, market: r.market, ownDomain: r.ownDomain, ownUrl, competitors: r.competitors, manualUrls: keyword === r.keyword ? r.manualUrls : [], businessDescription: r.businessDescription, options: r.options });
      navigate(`/run/${job.id}`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Неуспешно стартиране.');
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!confirm(`Да изтрия ли отчета за „${report.seed.keyword}“?`)) return;
    try {
      await api.deleteReport(id);
      navigate('/');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Неуспешно изтриване.');
    }
  };

  const opportunityCount = report.opportunities.filter((o) => !o.deep).length;
  const market = MARKETS[report.request.market as MarketId];

  return (
    <div>
      <div class="page-head spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <p class="small muted"><a href="#/">← Всички анализи</a></p>
          <h1 style={{ marginTop: '4px' }}>„{report.seed.keyword}“</h1>
          <div class="row" style={{ marginTop: '8px' }}>
            <span class="muted small">{dateTime(report.createdAt)}</span>
            <span class="badge">{market?.label ?? report.request.market}</span>
            {report.mode === 'demo' ? <span class="badge badge-demo"><Icon name="flask" size={13} />демо данни</span> : null}
            {report.status === 'partial' ? <span class="badge" title="Част от оценките липсват — виж „Данни и методика“"><Icon name="alert" size={13} />непълен</span> : null}
          </div>
        </div>
        <div class="row">
          <Menu label="Експорт" icon="download">
            <a href={api.exportUrl(id, 'csv')} download><Icon name="doc" size={16} />Фрази (CSV за Excel)</a>
            <a href={api.exportUrl(id, 'md')} download><Icon name="doc" size={16} />Отчет (Markdown)</a>
            <a href={api.exportUrl(id, 'json')} download><Icon name="doc" size={16} />Всички данни (JSON)</a>
            <button type="button" onClick={() => print()}><Icon name="doc" size={16} />Печат / PDF</button>
          </Menu>
          <button type="button" class="btn" disabled={busy} onClick={() => rerun(report.seed.keyword, report.request.ownUrl)} title="Пусни същия анализ отново с актуални данни">
            <Icon name="refresh" />Обнови
          </button>
          <button type="button" class="btn btn-danger" onClick={remove} aria-label="Изтрий отчета"><Icon name="trash" /></button>
        </div>
      </div>

      {problem ? <div style={{ marginBottom: '14px' }}><Callout kind="error">{problem}</Callout></div> : null}
      <Tiles report={report} />
      {report.warnings.length > 0 ? (
        <div style={{ marginTop: '14px' }}>
          <Callout kind="warn">
            {report.warnings[0]}
            {report.warnings.length > 1 ? <> <a href={`#/report/${id}/data`}>и още {report.warnings.length - 1}…</a></> : null}
          </Callout>
        </div>
      ) : null}

      <div class="tabs" role="tablist" aria-label="Раздели на отчета">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} class="tab" aria-selected={active === t.id} aria-controls="tabpanel" tabIndex={active === t.id ? 0 : -1} onClick={() => goTab(t.id)} onKeyDown={onTabKey}>
            {t.label}
            {t.id === 'opportunities' ? <span class="count">{opportunityCount}</span> : null}
            {t.id === 'competitors' ? <span class="count">{report.competitors.length}</span> : null}
          </button>
        ))}
      </div>

      <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${active}`}>
        {active === 'overview' ? <Overview report={report} goTab={goTab} /> : null}
        {active === 'serp' ? <SerpTab report={report} /> : null}
        {active === 'opportunities' ? <OpportunitiesTab report={report} onDeep={(kw) => rerun(kw, null)} /> : null}
        {active === 'competitors' ? <CompetitorsTab report={report} /> : null}
        {active === 'brief' ? <BriefTab report={report} /> : null}
        {active === 'data' ? <DataTab report={report} /> : null}
      </div>
    </div>
  );
}
