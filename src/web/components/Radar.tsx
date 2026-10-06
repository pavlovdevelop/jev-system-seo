import type { JSX } from 'preact';
import { clamp01, pct } from '../lib/format';
import { radarAngle, radarPoint, radarRuns } from '../lib/geo';

// A radar chart of one thing measured on six (or more) axes, each 0..1. One series, so one hue: a 2px outline, a wash
// of the same hue inside it and a marker with a surface ring on every value. An axis without a value (null) is a gap in
// the outline with a hollow marker and "н/д" on its label — never a silent zero. The values are written next to the axes,
// so the picture can be read without hovering; the text alternative and a visually hidden table say the same for
// screen readers. Colors are the app's CSS variables, so light, dark and print follow the theme.

export interface RadarAxis {
  /** The full name of the axis (text alternative and table). */
  label: string;
  /** A shorter name for the chart itself; defaults to `label`. */
  short?: string;
  value: number | null;
}

export interface RadarProps {
  axes: readonly RadarAxis[];
  /** The width of the drawing in px; it shrinks to a narrower container, never grows past it. */
  size?: number;
  /** What the chart shows ("Профил на страницата example.com"): the start of the text alternative. */
  title: string;
}

const RINGS = [0.25, 0.5, 0.75, 1] as const;
const LABEL_SIZE = 11;
const LINE = 13;

const valueText = (v: number | null): string => (v === null ? 'н/д' : pct(v));

export function Radar({ axes, size = 260, title }: RadarProps): JSX.Element {
  const n = axes.length;
  const alt = `${title}: ${axes.map((a) => `${a.label} — ${a.value === null ? 'не може да се прецени' : pct(a.value)}`).join('; ')}`;
  const table = (
    <div class="sr-only">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Показател</th>
            <th scope="col">Стойност</th>
          </tr>
        </thead>
        <tbody>
          {axes.map((a) => (
            <tr key={a.label}>
              <th scope="row">{a.label}</th>
              <td>{a.value === null ? 'не може да се прецени' : pct(a.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // fewer than three axes is not a polygon: say it in words instead of drawing a line
  if (n < 3) {
    return (
      <div style={{ position: 'relative' }}>
        <p class="small muted">{alt}</p>
        {table}
      </div>
    );
  }

  const W = size;
  const R = Math.round(size * 0.235);
  const H = Math.round(R * 2 + 2 * (LINE * 2 + 16));
  const cx = W / 2;
  const cy = H / 2;
  const values = axes.map((a) => (a.value === null ? null : clamp01(a.value)));
  const at = (i: number, v: number) => radarPoint(i, n, R * v, cx, cy);
  const path = (indices: readonly number[]): string => indices.map((i) => at(i, values[i] ?? 0)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const runs = radarRuns(values);

  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: `${W}px` }}>
      <svg class="geo-radar" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={alt} style={{ display: 'block', height: 'auto', overflow: 'visible' }}>
        {RINGS.map((ring) => (
          <polygon key={ring} class="geo-radar-ring" points={axes.map((_, i) => at(i, ring)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} fill="none" stroke-width="1" style={{ stroke: ring === 1 ? 'var(--axis)' : 'var(--grid)' }} />
        ))}
        {axes.map((a, i) => {
          const end = at(i, 1);
          return <line key={a.label} class="geo-radar-spoke" x1={cx} y1={cy} x2={end.x} y2={end.y} stroke-width="1" style={{ stroke: 'var(--grid)' }} />;
        })}

        {runs.map((run) =>
          run.closed ? (
            <polygon key="all" class="geo-radar-area" points={path(run.indices)} stroke-width="2" stroke-linejoin="round" style={{ fill: 'var(--accent)', fillOpacity: 0.14, stroke: 'var(--accent)' }} />
          ) : (
            <g key={run.indices.join('-')}>
              {run.indices.length > 1 ? <polygon class="geo-radar-area" points={`${cx},${cy} ${path(run.indices)}`} stroke="none" style={{ fill: 'var(--accent)', fillOpacity: 0.14 }} /> : null}
              {run.indices.length > 1 ? <polyline class="geo-radar-area" points={path(run.indices)} fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" style={{ stroke: 'var(--accent)' }} /> : null}
            </g>
          ),
        )}

        {axes.map((a, i) => {
          const v = values[i] ?? null;
          if (v === null) {
            const rim = at(i, 1);
            return (
              <circle key={a.label} class="geo-radar-gap" cx={rim.x} cy={rim.y} r="4" stroke-width="1.5" style={{ fill: 'var(--surface)', stroke: 'var(--ink-3)' }}>
                <title>{`${a.label}: не може да се прецени`}</title>
              </circle>
            );
          }
          const p = at(i, v);
          return (
            <circle key={a.label} class="geo-radar-dot" cx={p.x} cy={p.y} r="4" stroke-width="2" style={{ fill: 'var(--accent)', stroke: 'var(--surface)' }}>
              <title>{`${a.label}: ${pct(v)}`}</title>
            </circle>
          );
        })}

        {axes.map((a, i) => {
          const theta = radarAngle(i, n);
          const dx = Math.cos(theta);
          const dy = Math.sin(theta); // y grows downwards: -1 is twelve o'clock
          const out = radarPoint(i, n, R + 12, cx, cy);
          const anchor = dx > 0.3 ? 'start' : dx < -0.3 ? 'end' : 'middle';
          // the two lines (name, value) sit above the label point at the top, below it at the bottom, centred beside it
          const y1 = dy < -0.75 ? out.y - LINE : dy > 0.75 ? out.y + 10 : out.y - 3;
          return (
            <text key={a.label} x={out.x} text-anchor={anchor} font-size={LABEL_SIZE}>
              <tspan x={out.x} y={y1} style={{ fill: 'var(--ink-2)' }}>
                {a.short ?? a.label}
              </tspan>
              <tspan x={out.x} dy={LINE} font-weight="650" style={{ fill: a.value === null ? 'var(--ink-2)' : 'var(--ink)' }}>
                {valueText(a.value)}
              </tspan>
            </text>
          );
        })}
      </svg>
      {table}
    </div>
  );
}
