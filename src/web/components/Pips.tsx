import { Fragment, type ComponentChildren, type JSX } from 'preact';
import { COMPETITOR_VERDICT_TEXT, ELEMENT_VERDICT_TEXT, PLAN_KIND_TEXT, pipsFilled, QUESTION_VERDICT_TEXT } from '../lib/audit';
import { pct } from '../lib/format';
import { Icon, type IconName } from './ui';

// Small parts shared by the panels of the site audit: pip bars, verdict chips, the big headline number and a
// text that may break at slashes and dashes.

/**
 * Five small segments. Solid means filled and outlined means empty, so the number of filled segments is the value and
 * colour only reinforces it (the hue steps along the one blue ramp). A value that could not be judged is a muted dash.
 * Screen readers get "Отговор: 3 от 5"; the tooltip has the percent.
 */
export function Pips({ value, n = 5, label }: { value: number | null | undefined; n?: number; label: string }): JSX.Element {
  const filled = pipsFilled(value, n);
  if (filled === null) {
    return (
      <span class="pips-none" title={`${label}: не е оценено`}>
        <span aria-hidden="true">—</span>
        <span class="sr-only">{label}: не е оценено</span>
      </span>
    );
  }
  const level = filled >= Math.ceil(n * 0.8) ? 'hi' : filled >= Math.ceil(n * 0.5) ? 'mid' : 'lo';
  return (
    <span class={`pips lv-${level}`} title={`${label}: ${pct(value)}`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} class={i < filled ? 'on' : ''} aria-hidden="true" />
      ))}
      <span class="sr-only">{label}: {filled} от {n}</span>
    </span>
  );
}

// ───────────── verdict chips: an icon and a word on a tint, never colour alone ─────────────

export type VerdictKind = 'keep' | 'change' | 'steal' | 'skip' | 'no_page' | 'weak' | 'answered' | 'create' | 'rewrite';
type Tone = 'ok' | 'act' | 'warn' | 'bad' | 'muted';

const VERDICTS: Record<VerdictKind, { tone: Tone; icon: IconName; text: string }> = {
  keep: { tone: 'ok', icon: 'check', text: ELEMENT_VERDICT_TEXT.keep },
  change: { tone: 'warn', icon: 'refresh', text: ELEMENT_VERDICT_TEXT.change },
  steal: { tone: 'act', icon: 'copy', text: COMPETITOR_VERDICT_TEXT.steal },
  skip: { tone: 'muted', icon: 'minus', text: COMPETITOR_VERDICT_TEXT.skip },
  no_page: { tone: 'bad', icon: 'x', text: QUESTION_VERDICT_TEXT.no_page },
  weak: { tone: 'warn', icon: 'alert', text: QUESTION_VERDICT_TEXT.weak },
  answered: { tone: 'ok', icon: 'check', text: QUESTION_VERDICT_TEXT.answered },
  create: { tone: 'act', icon: 'plus', text: PLAN_KIND_TEXT.create },
  rewrite: { tone: 'warn', icon: 'refresh', text: PLAN_KIND_TEXT.rewrite },
};

export function Verdict({ kind }: { kind: VerdictKind }): JSX.Element {
  const v = VERDICTS[kind];
  return (
    <span class={`verdict verdict-${v.tone}`}>
      <Icon name={v.icon} size={14} />
      {v.text}
    </span>
  );
}

// ───────────── headline of a panel ─────────────

/** The big number of a panel with what it counts ("33%" — "от въпросите нямат страница") and one line of detail under it. */
export function Headline({ value, unit, children }: { value: ComponentChildren; unit: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="au-headline">
      <span class="au-headline-num">{value}</span>
      <span class="au-headline-text">
        <strong>{unit}</strong>
        {children ? <span class="muted small">{children}</span> : null}
      </span>
    </div>
  );
}

// ───────────── text that can break ─────────────

/**
 * Paths and domains have no spaces: this lets them break after a slash, dash or dot instead of widening a column.
 * `after` (an icon, a tag) stays glued to the last piece, so it never ends up alone on a line.
 */
export function Breakable({ text, after }: { text: string; after?: ComponentChildren }): JSX.Element {
  const parts = text.split(/(?<=[/\-._?&=])/);
  const last = parts.length - 1;
  return (
    <>
      {parts.map((part, i) =>
        i === last && after ? (
          <span key={i} class="nowrap">
            {part}
            {after}
          </span>
        ) : (
          <Fragment key={i}>
            {part}
            {i < last ? <wbr /> : null}
          </Fragment>
        ),
      )}
    </>
  );
}
