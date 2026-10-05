import type { ComponentChildren, JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { OPPORTUNITY_LABEL_TEXT, type OpportunityLabel } from '../../shared/domain';
import { clamp01, confidenceLevel, DIFFICULTY_TEXT, pct } from '../lib/format';
import { useDismiss } from '../lib/hooks';

// ───────────── icons (24×24, stroked, inherit currentColor) ─────────────
const ICONS = {
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12 19 5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 3 20h18L12 4z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6L5 19a1 1 0 0 0 .9 1.5h12.2A1 1 0 0 0 19 19l-5-10V3"/>',
  bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5a3.5 3.5 0 0 1 0 6.5"/><path d="M18 14.5c1.8.8 3 2.4 3 5.5"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      aria-label={title}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

// ───────────── labels, badges ─────────────
const LABEL_COLOR: Record<OpportunityLabel, string> = {
  quick_win: 'var(--ord-quick)',
  good: 'var(--ord-good)',
  hard: 'var(--ord-hard)',
  skip: 'var(--ord-skip)',
};

/** Opportunity category: a one-hue ordinal dot plus the label itself — never color alone. */
export function LabelBadge({ label }: { label: OpportunityLabel }): JSX.Element {
  return (
    <span class="badge">
      <span class="dot" style={{ background: LABEL_COLOR[label] }} />
      {OPPORTUNITY_LABEL_TEXT[label]}
    </span>
  );
}

export function RoleBadge({ role }: { role: 'own' | 'tracked' | 'discovered' | 'serp' | 'manual' }): JSX.Element | null {
  if (role === 'own') return <span class="badge badge-own"><span class="dot" style={{ background: 'var(--accent-2)' }} />ти</span>;
  if (role === 'tracked') return <span class="badge badge-tracked"><span class="dot" style={{ background: 'var(--accent)' }} />следен</span>;
  if (role === 'manual') return <span class="badge">въведен ръчно</span>;
  return null;
}

/** Difficulty is a state, so it uses the status colors — always with an icon and a word. */
export function Difficulty({ value }: { value: 'easy' | 'medium' | 'hard' | null }): JSX.Element {
  if (!value) return <span class="muted">—</span>;
  const icon: IconName = value === 'easy' ? 'check' : value === 'medium' ? 'info' : 'alert';
  return (
    <span class={`status status-${value}`}>
      <Icon name={icon} size={16} />
      {DIFFICULTY_TEXT[value]}
    </span>
  );
}

/** Jev's confidence as three dots plus words for screen readers (docs.typesafe.ai/confidence). */
export function Confidence({ value }: { value: number | null | undefined }): JSX.Element {
  if (value === null || value === undefined) return <span class="muted">—</span>;
  const { dots, text } = confidenceLevel(value);
  return (
    <span class="dots" title={`Сигурност на Jev: ${text} (${pct(value)})`}>
      {[1, 2, 3].map((i) => (
        <i key={i} class={i <= dots ? 'on' : ''} />
      ))}
      <span class="sr-only">сигурност {text}</span>
    </span>
  );
}

// ───────────── bars, meters, tiles ─────────────
/** Value 0..1 as a thin bar with the number beside it. One hue; identity is never encoded here. */
export function MiniBar({ value, text }: { value: number | null | undefined; text?: string }): JSX.Element {
  if (value === null || value === undefined) return <span class="muted">—</span>;
  return (
    <span class="mini">
      <span class="mini-track" aria-hidden="true">
        <span class="mini-fill" style={{ width: `${clamp01(value) * 100}%`, display: 'block' }} />
      </span>
      <span class="mini-val">{text ?? Math.round(value * 100)}</span>
    </span>
  );
}

export function HBar({ label, value, text, tone, sub, stacked }: { label: ComponentChildren; value: number; text?: string; tone?: 'own' | 'other'; sub?: ComponentChildren; stacked?: boolean }): JSX.Element {
  return (
    <div class={`hbar${stacked || sub ? ' stacked' : ''}`}>
      <div class="hbar-label">
        <div>{label}</div>
        {sub ? <div class="xs muted">{sub}</div> : null}
      </div>
      <div class="hbar-track" aria-hidden="true">
        <div class={`hbar-fill${tone ? ` ${tone}` : ''}`} style={{ width: `${clamp01(value) * 100}%` }} />
      </div>
      <div class="hbar-value">{text ?? pct(value)}</div>
    </div>
  );
}

export function Meter({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div class="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamp01(value) * 100)} aria-label={label}>
      <span style={{ width: `${clamp01(value) * 100}%` }} />
    </div>
  );
}

export function Tile(props: { label: string; value: ComponentChildren; sub?: ComponentChildren; hero?: boolean; text?: boolean; children?: ComponentChildren }): JSX.Element {
  return (
    <div class={`tile${props.hero ? ' tile-hero' : ''}`}>
      <div class="tile-label">{props.label}</div>
      <div class={`tile-value${props.text ? ' text' : ''}`}>{props.value}</div>
      {props.children}
      {props.sub ? <div class="tile-sub">{props.sub}</div> : null}
    </div>
  );
}

// ───────────── feedback ─────────────
export function Callout({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error'; children: ComponentChildren }): JSX.Element {
  return (
    <div class={`callout ${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <Icon name={kind === 'info' ? 'info' : 'alert'} />
      <div class="grow">{children}</div>
    </div>
  );
}

export function Loading({ text = 'Зареждане…' }: { text?: string }): JSX.Element {
  return (
    <div class="loading" role="status">
      <span class="spinner" aria-hidden="true" /> {text}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="empty">
      <h3>{title}</h3>
      {children ? <p class="small" style={{ marginTop: '6px' }}>{children}</p> : null}
    </div>
  );
}

// ───────────── menu (exports) ─────────────
export function Menu({ label, icon, children }: { label: string; icon?: IconName; children: ComponentChildren }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(open, () => setOpen(false), ref);
  return (
    <div class="menu" ref={ref}>
      <button type="button" class="btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon ? <Icon name={icon} /> : null}
        {label}
      </button>
      {open ? (
        <div class="menu-list" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
