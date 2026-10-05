import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { OPPORTUNITY_LABEL_TEXT, type OpportunityLabel } from '../../shared/domain';
import type { Opportunity } from '../../shared/schemas';
import { pct } from '../lib/format';

// Opportunity map: how weak is the competition (x) against how valuable is the searcher (y).
// The top-right corner is where a small site wins. One hue on an ordinal ramp encodes the category, with the
// category also written in the legend and the tooltip. Every point has a hit area of ~28px and keyboard focus;
// the table next to it is the full-detail twin of this chart. The drawing is sized to its container (1 unit =
// 1 CSS pixel), so text stays readable on a phone instead of being scaled down with the picture.

const MIN_W = 300;
const MAX_W = 960;
const HIT_RADIUS = 28;

const COLORS: Record<OpportunityLabel, string> = {
  quick_win: 'var(--ord-quick)',
  good: 'var(--ord-good)',
  hard: 'var(--ord-hard)',
  skip: 'var(--ord-skip)',
};
const ORDER: OpportunityLabel[] = ['quick_win', 'good', 'hard', 'skip'];

interface Pt {
  o: Opportunity;
  x: number;
  y: number;
  r: number;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(680);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (): void => setWidth(Math.max(MIN_W, Math.min(MAX_W, Math.round(el.clientWidth))));
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function Scatter({ items, selected, onSelect }: { items: readonly Opportunity[]; selected: string | null; onSelect: (keyword: string) => void }): JSX.Element {
  const [active, setActive] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const W = useWidth(box);
  const narrow = W < 520;
  const H = Math.max(300, Math.min(460, Math.round(W * 0.52)));
  const M = narrow ? { top: 14, right: 14, bottom: 44, left: 56 } : { top: 16, right: 20, bottom: 48, left: 52 };
  const PW = W - M.left - M.right;
  const PH = H - M.top - M.bottom;
  const sx = (v: number): number => M.left + v * PW;
  const sy = (v: number): number => M.top + (1 - v) * PH;

  const points: Pt[] = useMemo(
    () =>
      items
        .filter((o) => o.assessment)
        .map((o) => ({ o, x: M.left + o.assessment!.weakness * PW, y: M.top + (1 - o.commercial) * PH, r: o.label === 'quick_win' ? 7 : 5.5 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, W, H],
  );

  // Label only the few best points, and only where a label does not run into another label or the edge.
  const labels = useMemo(() => {
    const placed: Box[] = [];
    const out: Array<{ key: string; x: number; y: number; anchor: 'start' | 'end'; text: string }> = [];
    const hits = (b: Box): boolean => placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
    const limit = narrow ? 3 : 5;
    for (const p of [...points].sort((a, b) => b.o.score - a.o.score).slice(0, limit)) {
      const text = shorten(p.o.keyword, narrow ? 22 : 34);
      const width = text.length * 6.2;
      for (const side of ['start', 'end'] as const) {
        const x = side === 'start' ? p.x + p.r + 6 : p.x - p.r - 6;
        const b: Box = { x0: side === 'start' ? x : x - width, x1: side === 'start' ? x + width : x, y0: p.y - 8, y1: p.y + 8 };
        if (b.x0 < M.left || b.x1 > W - 4 || hits(b)) continue;
        placed.push(b);
        out.push({ key: p.o.keyword, x, y: p.y + 4, anchor: side, text });
        break;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, narrow, W]);

  const activePoint = points.find((p) => p.o.keyword === active) ?? null;

  const nearest = (clientX: number, clientY: number): Pt | null => {
    const svg = box.current?.querySelector('svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const px = (clientX - rect.left) * scale;
    const py = (clientY - rect.top) * scale;
    let best: Pt | null = null;
    let bestD = HIT_RADIUS;
    for (const p of points) {
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };

  const onMove = (e: PointerEvent): void => {
    const hit = nearest(e.clientX, e.clientY);
    setActive(hit ? hit.o.keyword : null);
    const rect = box.current?.getBoundingClientRect();
    if (hit && rect) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    else setTip(null);
  };

  const ticks = narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const clientW = box.current?.clientWidth ?? W;
  const tooltipAt = activePoint ? { x: (activePoint.x / W) * clientW, y: (activePoint.y / W) * clientW } : tip;

  return (
    <div class="chart" ref={box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label="Карта на възможностите: хоризонтално е слабостта на конкуренцията, вертикално е търговската стойност на фразата"
        onPointerMove={onMove}
        onPointerLeave={() => {
          setActive(null);
          setTip(null);
        }}
        onClick={(e) => {
          const hit = nearest(e.clientX, e.clientY);
          if (hit) onSelect(hit.o.keyword);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line class="gridline" x1={M.left} x2={W - M.right} y1={sy(t)} y2={sy(t)} />
            <line class="gridline" x1={sx(t)} x2={sx(t)} y1={M.top} y2={H - M.bottom} />
            <text class="tick" x={M.left - 8} y={sy(t) + 4} text-anchor="end">{Math.round(t * 100)}%</text>
            <text class="tick" x={sx(t)} y={H - M.bottom + 18} text-anchor="middle">{Math.round(t * 100)}%</text>
          </g>
        ))}
        <line class="axis" x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} />
        <line class="axis" x1={M.left} x2={M.left} y1={M.top} y2={H - M.bottom} />
        <text class="axis-title" x={M.left + PW / 2} y={H - 8} text-anchor="middle">{narrow ? 'Слабост на конкуренцията →' : 'Слабост на конкуренцията в Google →'}</text>
        <text class="axis-title" transform={`translate(${narrow ? 9 : 12} ${M.top + PH / 2}) rotate(-90)`} text-anchor="middle">{narrow ? 'Търговска стойност →' : 'Търговска стойност на фразата →'}</text>
        <text class="quadrant" x={W - M.right - 6} y={M.top + 14} text-anchor="end">лесно и ценно</text>
        <text class="quadrant" x={M.left + 6} y={H - M.bottom - 8}>трудно и ниска стойност</text>

        {points.map((p) => (
          <circle
            key={p.o.keyword}
            class={`pt${active === p.o.keyword || selected === p.o.keyword ? ' is-active' : ''}`}
            cx={p.x}
            cy={p.y}
            r={p.r}
            fill={COLORS[p.o.label]}
            tabIndex={0}
            role="img"
            aria-label={`${p.o.keyword}: ${OPPORTUNITY_LABEL_TEXT[p.o.label]}, слабост ${pct(p.o.assessment?.weakness)}, търговска стойност ${pct(p.o.commercial)}, оценка ${p.o.score}`}
            onFocus={() => setActive(p.o.keyword)}
            onBlur={() => setActive(null)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(p.o.keyword))}
          />
        ))}
        {labels.map((l) => (
          <text key={l.key} class="pt-label" x={l.x} y={l.y} text-anchor={l.anchor}>{l.text}</text>
        ))}
      </svg>

      {activePoint && tooltipAt ? (
        <div class="tooltip" role="tooltip" style={{ left: `${Math.max(0, Math.min(tooltipAt.x + 14, clientW - 250))}px`, top: `${Math.max(0, tooltipAt.y - 10)}px` }}>
          <strong>{activePoint.o.keyword}</strong>
          <div class="t-row"><span>Категория</span><span>{OPPORTUNITY_LABEL_TEXT[activePoint.o.label]}</span></div>
          <div class="t-row"><span>Оценка</span><span>{activePoint.o.score}</span></div>
          <div class="t-row"><span>Слабост на SERP</span><span>{pct(activePoint.o.assessment?.weakness)}</span></div>
          <div class="t-row"><span>Търговска стойност</span><span>{pct(activePoint.o.commercial)}</span></div>
          {activePoint.o.volume !== null ? <div class="t-row"><span>Търсения/мес</span><span>{activePoint.o.volume}</span></div> : null}
        </div>
      ) : null}

      <div class="legend" style={{ marginTop: '10px' }}>
        {ORDER.map((l) => (
          <span key={l}>
            <i class="swatch" style={{ background: COLORS[l], borderRadius: '50%' }} />
            {OPPORTUNITY_LABEL_TEXT[l]}
          </span>
        ))}
      </div>
    </div>
  );
}
