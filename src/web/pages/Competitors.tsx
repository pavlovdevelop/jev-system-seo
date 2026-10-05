import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { CompetitorOverviewRow, Settings } from '../../shared/schemas';
import { Callout, Empty, Icon, Loading, RoleBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, int, pct } from '../lib/format';
import { parseDomains } from '../lib/form';
import { useAsync } from '../lib/hooks';

const SHARE_HINT = 'Колко от общата видимост в проверените резултати държи сайтът (по-високата позиция тежи повече). Средно за анализите, в които се е появявал.';

function Stats({ row }: { row: CompetitorOverviewRow | undefined }): JSX.Element {
  if (!row || row.reports === 0) {
    return <td colSpan={4} class="muted small">още не се е появявал в анализ</td>;
  }
  return (
    <>
      <td class="num">{int(row.reports)}</td>
      <td class="num" title={SHARE_HINT}>{pct(row.avgShareOfVoice)}</td>
      <td class="num">{row.bestPosition !== null ? `#${row.bestPosition}` : '—'}</td>
      <td class="nowrap small muted">{row.lastSeen ? dateTime(row.lastSeen) : '—'}</td>
    </>
  );
}

export function CompetitorsPage(): JSX.Element {
  const settings = useAsync(() => api.settings(), []);
  const overview = useAsync(() => api.competitorOverview(), []);
  const [domain, setDomain] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const rows = useMemo(() => new Map((overview.data?.competitors ?? []).map((r) => [r.domain, r])), [overview.data]);
  const tracked = settings.data?.settings.competitors ?? [];
  const suggestions = useMemo(
    () =>
      (overview.data?.competitors ?? [])
        .filter((r) => !r.tracked && !r.own && r.reports > 0)
        .sort((a, b) => b.reports - a.reports || b.avgShareOfVoice - a.avgShareOfVoice || a.domain.localeCompare(b.domain))
        .slice(0, 25),
    [overview.data],
  );

  const apply = (next: Settings): void => {
    settings.setData((s) => (s ? { ...s, settings: next } : s));
    overview.reload();
  };

  const add = async (raw: string, withNote = ''): Promise<void> => {
    setProblem(null);
    const parsed = parseDomains(raw);
    if (parsed.bad.length > 0 || parsed.ok.length === 0) return setProblem(`Не разпознавам „${raw.trim() || '…'}“ като домейн. Напиши го като competitor.bg.`);
    setBusy(parsed.ok.join(','));
    try {
      let next: Settings | null = null;
      for (const d of parsed.ok) {
        if (tracked.some((t) => t.domain === d)) continue;
        next = (await api.addCompetitor(d, withNote)).settings;
      }
      if (next) apply(next);
      setDomain('');
      setNote('');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Неуспешно добавяне.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (d: string): Promise<void> => {
    setProblem(null);
    setBusy(d);
    try {
      apply((await api.removeCompetitor(d)).settings);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Неуспешно премахване.');
    } finally {
      setBusy(null);
    }
  };

  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error && !settings.data) return <Callout kind="error">{settings.error.message}</Callout>;

  return (
    <div class="stack-lg">
      <div class="page-head" style={{ marginBottom: 0 }}>
        <h1>Конкуренти</h1>
        <p class="page-sub">Следените конкуренти влизат във всеки анализ — дори когато не са в първите резултати — и получават собствен профил със силни и слаби страни. Отдолу виждаш кои още сайтове се появяват най-често.</p>
      </div>

      {problem ? <Callout kind="error">{problem}</Callout> : null}

      <section class="card">
        <div class="card-head">
          <h2>Следени конкуренти</h2>
          <p>{tracked.length} от 100</p>
        </div>

        <form
          class="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void add(domain, note);
          }}
        >
          <label class="sr-only" for="c-domain">Домейн на конкурент</label>
          <input id="c-domain" class="input" style={{ maxWidth: '280px' }} type="text" inputMode="url" autoComplete="off" spellcheck={false} placeholder="competitor.bg" value={domain} onInput={(e) => setDomain(e.currentTarget.value)} />
          <label class="sr-only" for="c-note">Бележка</label>
          <input id="c-note" class="input" style={{ maxWidth: '320px' }} type="text" maxLength={200} autoComplete="off" placeholder="бележка (по желание)" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
          <button type="submit" class="btn btn-primary" disabled={busy !== null || domain.trim() === ''}>
            <Icon name="plus" />Добави
          </button>
        </form>

        {tracked.length === 0 ? (
          <Empty title="Още не следиш конкуренти">Добави домейните, които познаваш — или избери от предложенията по-долу, след като направиш първия анализ.</Empty>
        ) : (
          <div class="table-wrap">
            <table class="table mid">
              <caption class="sr-only">Следени конкуренти</caption>
              <thead>
                <tr>
                  <th scope="col">Домейн</th>
                  <th scope="col" class="num">Анализи</th>
                  <th scope="col" class="num" title={SHARE_HINT}>Дял от видимостта</th>
                  <th scope="col" class="num">Най-добра позиция</th>
                  <th scope="col">Последно видян</th>
                  <th scope="col"><span class="sr-only">Действия</span></th>
                </tr>
              </thead>
              <tbody>
                {tracked.map((c) => (
                  <tr key={c.domain}>
                    <td>
                      <div class="cell-main">{c.domain} <RoleBadge role="tracked" /></div>
                      {c.note ? <div class="cell-sub">{c.note}</div> : null}
                    </td>
                    <Stats row={rows.get(c.domain)} />
                    <td class="num">
                      <button type="button" class="icon-btn" aria-label={`Спри да следиш ${c.domain}`} title="Спри да следиш" disabled={busy === c.domain} onClick={() => void remove(c.domain)}>
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

      <section class="card">
        <div class="card-head">
          <h2>Често срещани в резултатите</h2>
          <p>сайтове от твоите анализи, които още не следиш</p>
        </div>
        {overview.loading && !overview.data ? (
          <Loading text="Зареждам…" />
        ) : suggestions.length === 0 ? (
          <Empty title="Още няма предложения">След първия анализ тук ще се появят сайтовете, които се срещат най-често в резултатите.</Empty>
        ) : (
          <div class="table-wrap">
            <table class="table mid">
              <caption class="sr-only">Открити конкуренти</caption>
              <thead>
                <tr>
                  <th scope="col">Домейн</th>
                  <th scope="col" class="num">Анализи</th>
                  <th scope="col" class="num" title={SHARE_HINT}>Дял от видимостта</th>
                  <th scope="col" class="num">Най-добра позиция</th>
                  <th scope="col">Последно видян</th>
                  <th scope="col"><span class="sr-only">Действия</span></th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((r) => (
                  <tr key={r.domain}>
                    <td class="cell-main">{r.domain}</td>
                    <Stats row={r} />
                    <td class="num">
                      <button type="button" class="btn btn-sm" disabled={busy !== null} onClick={() => void add(r.domain)}>
                        <Icon name="plus" size={14} />Следи
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
