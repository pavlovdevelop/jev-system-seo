import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// ───────────── async data ─────────────
export interface Async<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
  setData: (v: T | null | ((prev: T | null) => T | null)) => void;
}

/** Runs `fn` on mount and whenever `deps` change. A newer call supersedes an older one that is still in flight. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[] = []): Async<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const mine = ++seq.current;
    // keep the previous data on screen while reloading: no layout jump
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => seq.current === mine && setState({ data, error: null, loading: false }),
      (error: unknown) => seq.current === mine && setState((s) => ({ data: s.data, error: error instanceof Error ? error : new Error(String(error)), loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((v: T | null | ((prev: T | null) => T | null)) => {
    setState((s) => ({ ...s, data: typeof v === 'function' ? (v as (p: T | null) => T | null)(s.data) : v }));
  }, []);
  return { ...state, reload, setData };
}

// ───────────── hash router ─────────────
export type Route =
  | { name: 'home' }
  | { name: 'run'; jobId: string }
  | { name: 'report'; id: string; tab: string }
  | { name: 'competitors' }
  | { name: 'settings' }
  | { name: 'notfound' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  if (!a) return { name: 'home' };
  if (a === 'run' && b) return { name: 'run', jobId: b };
  if (a === 'report' && b) return { name: 'report', id: b, tab: c ?? 'overview' };
  if (a === 'competitors') return { name: 'competitors' };
  if (a === 'settings') return { name: 'settings' };
  return { name: 'notfound' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const navigate = (path: string): void => {
  location.hash = path.startsWith('#') ? path : `#${path}`;
};

// ───────────── persistence (always optional: storage can be blocked or empty) ─────────────
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private window, blocked site data): the UI simply does not remember
  }
}

export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readStorage(key);
    if (raw === null) return initial;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      writeStorage(key, JSON.stringify(v));
    },
    [key],
  );
  return [value, set];
}

// ───────────── theme ─────────────
export type ThemePref = 'system' | 'light' | 'dark';

export function applyTheme(pref: ThemePref): void {
  if (pref === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', pref);
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => {
    const raw = readStorage('radar.theme');
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  });
  useEffect(() => applyTheme(pref), [pref]);
  const set = useCallback((p: ThemePref) => {
    setPref(p);
    writeStorage('radar.theme', p === 'system' ? null : p);
  }, []);
  return [pref, set];
}

/** Closes something (a menu) on outside click or Escape. */
export function useDismiss(open: boolean, onClose: () => void, ref: { current: HTMLElement | null }): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, ref]);
}
