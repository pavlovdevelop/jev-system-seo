import type { JSX } from 'preact';
import { arcDash } from '../lib/geo';
import { clamp01, pct } from '../lib/format';

// A ring gauge for one share (0..1): the filled arc is the value, the thin outer arc is the interval it could lie in.
// One hue and a lighter step of it for the track; the figure sits in the middle, in ink — never in the mark's colour.
// Drawn with presentation styles that read the app's CSS variables, so light, dark and print follow the theme with no
// stylesheet of its own. The text alternative says everything the picture shows.

export type DonutTone = 'accent' | 'own' | 'muted';

const TONES: Record<DonutTone, { arc: string; track: string }> = {
  accent: { arc: 'var(--accent)', track: 'var(--track)' },
  own: { arc: 'var(--accent-2)', track: 'color-mix(in srgb, var(--accent-2) 22%, var(--surface))' },
  muted: { arc: 'var(--deemph)', track: 'var(--surface-3)' },
};

const CENTER = 50;
const RING_R = 35;
const RING_W = 12;
const INTERVAL_R = 46;
const INTERVAL_W = 4;

export interface DonutProps {
  /** The share, 0..1; null draws an empty ring and an em dash. */
  value: number | null;
  /** The ends of the interval the share could lie in, 0..1 (95% Wilson interval, for example). */
  low?: number | null;
  high?: number | null;
  /** What the ring measures; it is the start of the text alternative. */
  label: string;
  /** Width and height in px; the drawing shrinks to a narrower container. */
  size?: number;
  tone?: DonutTone;
}

export function Donut({ value, low = null, high = null, label, size = 112, tone = 'accent' }: DonutProps): JSX.Element {
  const known = value !== null && Number.isFinite(value);
  const v = known ? clamp01(value) : 0;
  const hasInterval = known && low !== null && high !== null && Number.isFinite(low) && Number.isFinite(high);
  const colors = TONES[tone];
  const ring = arcDash(0, v, RING_R);
  const band = hasInterval ? arcDash(low as number, high as number, INTERVAL_R) : null;
  const text = known ? pct(v) : '—';
  const alt = known ? `${label}: ${pct(v)}${hasInterval ? `, 95% интервал от ${pct(low)} до ${pct(high)}` : ''}` : `${label}: няма данни`;
  // four characters ("100%") need a smaller figure to stay inside the ring
  const fontSize = text.length >= 4 ? 19 : 23;

  return (
    <svg class="geo-donut" viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={alt} style={{ maxWidth: '100%', height: 'auto', flex: 'none' }}>
      <circle cx={CENTER} cy={CENTER} r={RING_R} fill="none" stroke-width={RING_W} style={{ stroke: colors.track }} />
      {band && band.dash > 0 ? (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={INTERVAL_R}
          fill="none"
          stroke-width={INTERVAL_W}
          stroke-dasharray={`${band.dash} ${band.gap}`}
          stroke-dashoffset={band.offset}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
          style={{ stroke: colors.arc, opacity: 0.55 }}
        />
      ) : null}
      {known && ring.dash > 0 ? (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RING_R}
          fill="none"
          stroke-width={RING_W}
          stroke-dasharray={`${ring.dash} ${ring.gap}`}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
          style={{ stroke: colors.arc }}
        />
      ) : null}
      <text x={CENTER} y={CENTER} dy="0.35em" text-anchor="middle" font-size={fontSize} font-weight="650" style={{ fill: 'var(--ink)' }}>
        {text}
      </text>
    </svg>
  );
}
