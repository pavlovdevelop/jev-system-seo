const NBSP_RE = /\p{Zs}/gu;

export const pct = (x: number | null | undefined): string => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
export const int = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toLocaleString('bg-BG').replace(NBSP_RE, ' '));

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('bg-BG', { dateStyle: 'medium', timeStyle: 'short' });
}

export function usd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return 'под 1 цент';
  return `$${n.toFixed(2)}`;
}

export function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} с`;
}

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

export function confidenceLevel(c: number): { dots: 1 | 2 | 3; text: string } {
  return c >= 0.6 ? { dots: 3, text: 'висока' } : c >= 0.3 ? { dots: 2, text: 'средна' } : { dots: 1, text: 'ниска' };
}

export const DIFFICULTY_TEXT = { easy: 'лесно', medium: 'средно', hard: 'трудно' } as const;
export const ROLE_TEXT = { own: 'ти', tracked: 'следен', discovered: 'открит' } as const;
export const SOURCE_TEXT = { measured: 'измерено', jev: 'Jev' } as const;
