import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { StatusResponse } from '../shared/schemas';
import { Callout, Empty, Icon, Loading, type IconName } from './components/ui';
import { api } from './lib/api';
import { useAsync, useRoute, useTheme, type Route, type ThemePref } from './lib/hooks';
import { CompetitorsPage } from './pages/Competitors';
import { HomePage } from './pages/Home';
import { ReportPage } from './pages/Report';
import { RunPage } from './pages/Run';
import { SettingsPage } from './pages/Settings';

const THEME_NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_TEXT: Record<ThemePref, string> = { system: 'като системата', light: 'светла', dark: 'тъмна' };
const THEME_ICON: Record<ThemePref, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };

const TITLES: Record<Route['name'], string> = {
  home: 'Анализи',
  run: 'Анализът тече',
  report: 'Отчет',
  competitors: 'Конкуренти',
  settings: 'Настройки',
  notfound: 'Страницата липсва',
};

/** Which top-level nav item a route belongs to (a report or a running job is part of "Анализи"). */
const section = (r: Route): 'home' | 'competitors' | 'settings' | null => (r.name === 'competitors' ? 'competitors' : r.name === 'settings' ? 'settings' : r.name === 'notfound' ? null : 'home');

function ProviderPill({ ok, name, detail }: { ok: boolean; name: string; detail: string }): JSX.Element {
  return (
    <a class="badge" href="#/settings" title={`${name}: ${detail}`}>
      <Icon name={ok ? 'check' : 'alert'} size={13} />
      {name}
      <span class="sr-only">{ok ? ' — свързан' : ' — не е свързан'}</span>
    </a>
  );
}

function Header({ status, route }: { status: StatusResponse | null; route: Route }): JSX.Element {
  const [theme, setTheme] = useTheme();
  const active = section(route);
  const current = (name: 'home' | 'competitors' | 'settings'): 'page' | undefined => (active === name ? 'page' : undefined);
  return (
    <header class="app-header">
      <div class="app-header-inner">
        <a class="brand" href="#/" aria-label="Jev SEO Radar — начало">
          <span class="brand-mark" aria-hidden="true"><Icon name="radar" size={18} /></span>
          Jev SEO Radar
        </a>
        <nav class="nav" aria-label="Основна навигация">
          <a href="#/" aria-current={current('home')}>Анализи</a>
          <a href="#/competitors" aria-current={current('competitors')}>Конкуренти</a>
          <a href="#/settings" aria-current={current('settings')}>Настройки</a>
        </nav>
        <div class="header-actions">
          {status ? (
            <>
              <ProviderPill ok={status.jev.configured} name="Jev" detail={status.jev.configured ? (status.jev.model ?? 'свързан') : 'не е свързан'} />
              <ProviderPill ok={status.serp.configured} name="Google данни" detail={status.serp.configured ? status.serp.provider : 'не е настроен SERP доставчик'} />
            </>
          ) : null}
          <button type="button" class="icon-btn" onClick={() => setTheme(THEME_NEXT[theme])} aria-label={`Тема: ${THEME_TEXT[theme]}. Натисни, за да смениш.`} title={`Тема: ${THEME_TEXT[theme]}`}>
            <Icon name={THEME_ICON[theme]} />
          </button>
        </div>
      </div>
    </header>
  );
}

function Page({ route, status }: { route: Route; status: StatusResponse }): JSX.Element {
  switch (route.name) {
    case 'home':
      return <HomePage status={status} />;
    case 'run':
      return <RunPage key={route.jobId} jobId={route.jobId} />;
    case 'report':
      return <ReportPage key={route.id} id={route.id} tab={route.tab} />;
    case 'competitors':
      return <CompetitorsPage />;
    case 'settings':
      return <SettingsPage status={status} />;
    default:
      return (
        <Empty title="Тази страница не съществува">
          <a href="#/">Към началото</a>
        </Empty>
      );
  }
}

export function App(): JSX.Element {
  const route = useRoute();
  const status = useAsync(() => api.status(), []);
  const main = useRef<HTMLElement | null>(null);
  const first = useRef(true);

  useEffect(() => {
    document.title = `${TITLES[route.name]} · Jev SEO Radar`;
  }, [route.name]);

  // Moving between pages (not between tabs of one report) starts at the top and hands focus to the content.
  const navKey = route.name === 'report' ? `report:${route.id}` : route.name === 'run' ? `run:${route.jobId}` : route.name;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    main.current?.focus({ preventScroll: true });
  }, [navKey]);

  const s = status.data;
  return (
    <>
      <a
        class="skip-link"
        href="#/"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Към съдържанието
      </a>
      <Header status={s} route={route} />
      {s?.demo ? (
        <div class="demo-banner" role="note">
          <div>
            <Icon name="flask" size={16} />
            <span>
              <strong>Демо режим.</strong> Данните са измислени, а Jev е имитация — подходящо е да разгледаш как изглежда отчетът. За истински анализ добави ключове (виж <a href="#/settings">Настройки</a>) и стартирай без <code>--demo</code>.
            </span>
          </div>
        </div>
      ) : null}
      <main id="main" class="container" ref={main} tabIndex={-1}>
        {status.loading && !s ? <Loading text="Свързвам се със сървъра…" /> : null}
        {status.error && !s ? (
          <div class="stack">
            <Callout kind="error">
              <strong>Няма връзка със сървъра.</strong> {status.error.message} Провери дали е стартиран (<code>npm start</code>) и опитай пак.
            </Callout>
            <div><button type="button" class="btn" onClick={status.reload}><Icon name="refresh" />Опитай отново</button></div>
          </div>
        ) : null}
        {s ? <Page route={route} status={s} /> : null}
      </main>
      <footer class="app-footer">
        Jev SEO Radar{s ? ` · версия ${s.version}` : ''} · ключовете и отчетите остават на твоя сървър · оценките са ориентир, не гаранция за позиция
      </footer>
    </>
  );
}
