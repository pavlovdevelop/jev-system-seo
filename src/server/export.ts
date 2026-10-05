import { INTENT_LABELS, OPPORTUNITY_LABEL_TEXT, PAGE_TYPE_LABELS, type Intent, type PageType } from '../shared/domain';
import type { Report } from '../shared/schemas';
import { stripInvisible } from '../shared/text';

// Plain-text exports of a report. CSV is meant for spreadsheets, Markdown for pasting into a doc or a ticket.

/** Content-Disposition for a download. File names are ASCII-only (see `fileSlug`): non-ASCII names are not honoured everywhere. */
export function attachment(name: string): string {
  return `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
}

/** Spreadsheet apps execute cells that start with = + - @ as formulas; competitor-controlled text must not. */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value === 'string') s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? '' : String(Math.round(x * 100)));
/**
 * Text that came from a competitor's page (titles, headings, schema types, provider messages) must stay text when the
 * Markdown is pasted into a document or a ticket: no links, no images, no raw HTML, no table breaks, no hidden characters.
 * Without an escaped "[" there is no link or image, so parentheses and "!" are left alone and ordinary sentences stay readable.
 */
export function mdText(value: string | number | null | undefined): string {
  return stripInvisible(String(value ?? ''))
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[\\`*_\[\]<>#|]/g, '\\$&')
    .replace(/^([-+]|\d+[.)])/, '\\$1')
    .trim();
}

/** A URL as inert text: inside a code span nothing is a link, and a backtick cannot end the span. */
export function mdUrl(url: string): string {
  return `\`${stripInvisible(url).replace(/[`\s]/g, '')}\``;
}

const mdCell = mdText;

export function opportunitiesCsv(report: Report): string {
  const header = ['Фраза', 'Оценка', 'Категория', 'Релевантност %', 'Търговска стойност %', 'Слабост на SERP %', 'Трудност', 'Търсения/мес', 'CPC', 'Намерение', 'Препоръчан формат', 'Моя позиция', 'Източници', 'Защо'];
  const rows = report.opportunities.map((o) => [
    o.keyword,
    o.score,
    OPPORTUNITY_LABEL_TEXT[o.label],
    pct(o.relevance),
    pct(o.commercial),
    pct(o.assessment?.weakness),
    o.assessment ? { easy: 'лесно', medium: 'средно', hard: 'трудно' }[o.assessment.difficulty] : '',
    o.volume,
    o.cpc,
    o.intent ? INTENT_LABELS[o.intent.value as Intent] : '',
    o.recommendedFormat ? PAGE_TYPE_LABELS[o.recommendedFormat as PageType] : '',
    o.ownPosition,
    o.sources.join('+'),
    o.reasons.join('; '),
  ]);
  // BOM so that Excel opens the UTF-8 (Cyrillic) file correctly
  return `${String.fromCharCode(0xfeff)}${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function reportMarkdown(report: Report): string {
  const { seed, brief } = report;
  const lines: string[] = [];
  const date = new Date(report.createdAt).toLocaleString('bg-BG', { dateStyle: 'long', timeStyle: 'short' });
  lines.push(`# SEO анализ: „${mdText(seed.keyword)}“`, '', `Дата: ${date} · Пазар: ${mdText(report.request.market)} · Режим: ${report.mode === 'demo' ? 'ДЕМО (примерни данни)' : 'реален'}`, '');
  if (report.mode === 'demo') lines.push('> Данните са примерни и фиктивни.', '');

  lines.push('## Какво показва Google', '', mdText(brief.summary) || '—', '');
  if (seed.assessment) lines.push(`Слабост на резултатите: **${pct(seed.assessment.weakness)}%** (${{ easy: 'лесно', medium: 'средно', hard: 'трудно' }[seed.assessment.difficulty]}).`, '');
  if (seed.ownRank) lines.push(`Твоята позиция: **${seed.ownRank.position}** (${mdUrl(seed.ownRank.url)})`, '');

  lines.push('## Топ резултати', '', '| # | Домейн | Тип (Jev) | Сигурност | Думи | Общ резултат % |', '| - | - | - | - | - | - |');
  for (const p of seed.pages) {
    lines.push(`| ${p.position ?? '—'} | ${mdCell(p.domain)} | ${p.judgments.pageType ? PAGE_TYPE_LABELS[p.judgments.pageType.value as PageType] : '—'} | ${pct(p.judgments.pageType?.confidence)} | ${p.metrics?.wordCount ?? '—'} | ${pct(p.composite.overall)} |`);
  }
  lines.push('');

  lines.push('## Възможности (фрази)', '', '| Фраза | Оценка | Категория | Търсения/мес | Защо |', '| - | - | - | - | - |');
  for (const o of report.opportunities.filter((x) => !x.deep).slice(0, 30)) {
    lines.push(`| ${mdCell(o.keyword)} | ${o.score} | ${OPPORTUNITY_LABEL_TEXT[o.label]} | ${o.volume ?? '—'} | ${mdCell(o.reasons.slice(0, 2).join('; '))} |`);
  }
  lines.push('');

  lines.push('## Конкуренти', '');
  for (const c of report.competitors.slice(0, 12)) {
    lines.push(`### ${mdText(c.domain)}${c.role === 'own' ? ' (ти)' : c.role === 'tracked' ? ' (следен)' : ''}`, '', `Видимост: ${pct(c.visibility.shareOfVoice)}% · фрази: ${c.visibility.keywordsSeen} · топ 3: ${c.visibility.top3}`);
    if (c.strengths.length) lines.push('', '**Силни страни:** ' + c.strengths.map((s) => mdText(s.label)).join('; '));
    if (c.weaknesses.length) lines.push('', '**Слаби страни:** ' + c.weaknesses.map((s) => mdText(s.label)).join('; '));
    lines.push('');
  }

  lines.push('## План за съдържание', '', ...brief.checklist.map((c) => `- ${mdText(c)}`), '');
  if (brief.ownGaps?.length) lines.push('### Какво липсва на твоята страница', '', ...brief.ownGaps.map((g) => `- **${mdText(g.label)}** — ${mdText(g.detail)}`), '');

  if (report.warnings.length) lines.push('## Бележки', '', ...report.warnings.map((w) => `- ${mdText(w)}`), '');
  lines.push('---', `Изготвено с Jev SEO Radar. Оценките на Jev са вероятности, не факти; вижте сигурността до всяка преценка.`);
  return lines.join('\n');
}
