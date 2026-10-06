import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { MARKETS, type MarketId } from '../../shared/markets';
import type { SiteAuditReport } from '../../shared/audit';
import { CitabilityTab } from '../audit/Citability';
import { CompetitorsTab } from '../audit/Competitors';
import { ElementsTab } from '../audit/Elements';
import { GeoTab } from '../audit/Geo';
import { Overview } from '../audit/Overview';
import { PlanTab } from '../audit/Plan';
import { QuestionsTab } from '../audit/Questions';
import { Callout, Icon, Loading, Menu } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { navigate, useAsync, type AuditTab } from '../lib/hooks';

const TABS: ReadonlyArray<{ id: AuditTab; label: string }> = [
  { id: 'overview', label: 'Преглед' },
  { id: 'elements', label: 'SEO елементи' },
  { id: 'competitors', label: 'Конкурентни страници' },
  { id: 'questions', label: 'Въпроси' },
  { id: 'citability', label: 'Цитиране' },
  { id: 'geo', label: 'ИИ видимост' },
  { id: 'plan', label: 'План' },
];

/** How many rows a tab holds, shown beside its name (the overview and the AI tab have no single count). */
function countOf(tab: AuditTab, a: SiteAuditReport): number | null {
  switch (tab) {
    case 'elements':
      return a.elements.length;
    case 'competitors':
      return a.competitorPages.length;
    case 'questions':
      return a.questions.length;
    case 'citability':
      return a.pages.length;
    case 'plan':
      return a.plan.length;
    default:
      return null;
  }
}

function TabContent({ tab, audit }: { tab: AuditTab; audit: SiteAuditReport }): JSX.Element {
  switch (tab) {
    case 'elements':
      return <ElementsTab audit={audit} />;
    case 'competitors':
      return <CompetitorsTab audit={audit} />;
    case 'questions':
      return <QuestionsTab audit={audit} />;
    case 'citability':
      return <CitabilityTab audit={audit} />;
    case 'geo':
      return <GeoTab audit={audit} />;
    case 'plan':
      return <PlanTab audit={audit} />;
    default:
      return <Overview audit={audit} />;
  }
}

export function AuditPage({ id, tab }: { id: string; tab: AuditTab }): JSX.Element {
  const { data, error, loading } = useAsync(() => api.audit(id), [id]);
  const [problem, setProblem] = useState<string | null>(null);

  if (loading && !data) return <Loading text="Зареждам одита…" />;
  if (error || !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div class="stack">
        <Callout kind="error">{notFound ? 'Този одит не е намерен — може да е изтрит.' : (error?.message ?? 'Неуспешно зареждане.')}</Callout>
        <div><a class="btn" href="#/site">Към „Мой сайт“</a></div>
      </div>
    );
  }
  const audit = data.audit;
  const goTab = (t: AuditTab): void => navigate(`/audit/${id}/${t}`);
  // Tabs follow the WAI-ARIA pattern: only the active tab is in the Tab order; arrows, Home and End move between tabs.
  const onTabKey = (e: KeyboardEvent): void => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const target = TABS[next];
    if (!target) return;
    goTab(target.id);
    requestAnimationFrame(() => document.getElementById(`tab-${target.id}`)?.focus());
  };

  const remove = async (): Promise<void> => {
    if (!confirm(`Да изтрия ли одита на „${audit.site.domain}“?`)) return;
    try {
      await api.deleteAudit(id);
      navigate('/site');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Неуспешно изтриване.');
    }
  };

  const market = MARKETS[audit.request.market as MarketId];
  return (
    <div>
      <div class="page-head spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <p class="small muted"><a href="#/site">← Всички одити</a></p>
          <h1 style={{ marginTop: '4px', overflowWrap: 'anywhere' }}>{audit.site.domain}</h1>
          <div class="row" style={{ marginTop: '8px' }}>
            <span class="muted small">{dateTime(audit.createdAt)}</span>
            <span class="badge">{market?.label ?? audit.request.market}</span>
            {audit.mode === 'demo' ? (
              <span class="badge badge-demo"><Icon name="flask" size={13} />демо данни</span>
            ) : (
              <span class="badge"><Icon name="check" size={13} />реални данни</span>
            )}
            {audit.status === 'partial' ? <span class="badge" title="Част от стъпките не завършиха — виж бележките в Прегледа"><Icon name="alert" size={13} />непълен</span> : null}
          </div>
        </div>
        <div class="row">
          <Menu label="Експорт" icon="download">
            <a href={api.auditExportUrl(id, 'md')} download><Icon name="doc" size={16} />Резюме и план (Markdown)</a>
            <a href={api.auditExportUrl(id, 'csv')} download><Icon name="doc" size={16} />SEO елементите (CSV за Excel)</a>
            <a href={api.auditExportUrl(id, 'json')} download><Icon name="doc" size={16} />Всички данни (JSON)</a>
            <button type="button" onClick={() => print()}><Icon name="doc" size={16} />Печат / PDF (този раздел)</button>
          </Menu>
          <button type="button" class="btn btn-danger" onClick={remove} aria-label="Изтрий одита"><Icon name="trash" /></button>
        </div>
      </div>

      {problem ? <div style={{ marginBottom: '14px' }}><Callout kind="error">{problem}</Callout></div> : null}
      {audit.status === 'partial' ? (
        <div style={{ marginBottom: '14px' }}>
          <Callout kind="warn">
            <strong>Одитът е непълен.</strong> Част от стъпките не завършиха или бяха прекратени, затова числата са по-ниска оценка, а някои раздели може да са празни.
            {audit.warnings.length > 0 ? <> Виж <a href={`#/audit/${encodeURIComponent(id)}/overview`}>бележките в Прегледа</a>.</> : null}
          </Callout>
        </div>
      ) : null}

      <div class="tabs" role="tablist" aria-label="Раздели на одита">
        {TABS.map((t) => {
          const count = countOf(t.id, audit);
          return (
            <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} class="tab" aria-selected={tab === t.id} aria-controls="tabpanel" tabIndex={tab === t.id ? 0 : -1} onClick={() => goTab(t.id)} onKeyDown={onTabKey}>
              {t.label}
              {count !== null ? <span class="count">{count}</span> : null}
            </button>
          );
        })}
      </div>

      <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        <TabContent tab={tab} audit={audit} />
      </div>
    </div>
  );
}
