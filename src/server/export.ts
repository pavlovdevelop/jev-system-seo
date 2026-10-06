import { CRITERION_LABELS, ELEMENT_LABELS, ENGINE_LABELS, NEXT_STEP_LABELS, SKIP_REASON_LABELS, STAGE_LABELS, type SiteAuditReport } from '../shared/audit';
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

// ───────────── whole-site audit ─────────────

/** The SEO elements as a spreadsheet: one row per page element, the ones to change first. */
export function auditElementsCsv(audit: SiteAuditReport): string {
  const header = ['Страница', 'Елемент', 'Сега', 'Решение', 'Сигурност %', 'Защо', 'Предложение', 'Предложението е от', 'Приоритет %', 'Позиция в Google'];
  const rank = new Map(audit.pages.map((p) => [p.url, p.rank]));
  const rows = audit.elements.map((e) => [
    e.url,
    ELEMENT_LABELS[e.element],
    e.now,
    e.verdict === 'change' ? 'Промени' : 'Запази',
    pct(e.confidence),
    e.reason,
    e.proposal ?? '',
    e.proposalBy === 'llm' ? 'езиков модел' : e.proposalBy === 'rule' ? 'правило' : '',
    pct(e.impact),
    rank.get(e.url) ?? '',
  ]);
  return `${String.fromCharCode(0xfeff)}${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** The audit as a document: the headline figures, what the AI assistants say, and the plan page by page. */
export function auditMarkdown(audit: SiteAuditReport): string {
  const f = audit.figures;
  const lines: string[] = [];
  const date = new Date(audit.createdAt).toLocaleString('bg-BG', { dateStyle: 'long', timeStyle: 'short' });
  lines.push(`# Одит на сайта ${mdText(audit.site.domain)}`, '', `Дата: ${date} · Страници: ${audit.site.pagesAudited} · Режим: ${audit.mode === 'demo' ? 'ДЕМО (примерни данни)' : 'реален'}`, '');
  if (audit.mode === 'demo') lines.push('> Данните са примерни и фиктивни.', '');

  lines.push('## Накратко', '');
  lines.push(`- SEO елементи за промяна: **${f.elementsToChange}** от ${f.elementsTotal}`);
  lines.push(`- Конкурентни страници, които си струва да се копират: **${f.pagesToSteal}** от ${f.competitorPagesTotal}`);
  lines.push(`- Въпроси на купувачите без страница: **${f.questionsNoPage}** от ${f.questionsTotal}`);
  if (f.citabilityNow !== null) lines.push(`- Шанс страниците да бъдат цитирани от ИИ: **${pct(f.citabilityNow)}%** (след поправките: ${pct(f.citabilityAfter)}%) — оценка, не измерване`);
  if (f.citationRate !== null) lines.push(`- Реално цитиране или споменаване в отговорите на ИИ: **${pct(f.citationRate)}%** — на проба от ${f.questionsTotal} въпроса`);
  lines.push('');

  if (audit.geo) {
    lines.push('## Какво казва ИИ', '', '| Двигател | Модел | Цитират ни | Не ни цитират | Дял | Цитиран вместо нас |', '| - | - | - | - | - | - |');
    for (const e of audit.geo.engines) {
      lines.push(`| ${ENGINE_LABELS[e.engine]} | ${mdCell(e.model)} | ${e.citingUs} | ${e.skippingUs} | ${pct(e.rate)}% (${pct(e.rateLow)}–${pct(e.rateHigh)}%) | ${e.citedInstead ? mdCell(e.citedInstead.domain) : '—'} |`);
    }
    lines.push('');
  }

  lines.push('## План: страници за създаване или пренаписване', '');
  if (audit.plan.length === 0) lines.push('Няма страници, които ИИ да пропуска — или проверката с ИИ не е пускана.', '');
  for (const plan of audit.plan) {
    lines.push(`### ${plan.kind === 'create' ? 'Нова страница' : 'Пренапиши'}: ${mdText(plan.title)}`, '');
    lines.push(plan.url ? `Адрес: ${mdUrl(plan.url)}` : `Предложен адрес: ${mdUrl(plan.suggestedPath ?? '')}`, '');
    if (plan.engines.length > 0) lines.push(`Важно за: ${plan.engines.map((e) => ENGINE_LABELS[e]).join(', ')}`, '');
    lines.push('Въпроси, на които да отговаря:', ...plan.questions.map((q) => `- ${mdText(q)}`), '', 'Стъпки по ред:');
    plan.checklist.forEach((c, i) => lines.push(`${i + 1}. ${mdText(c.text)} — _${mdText(c.why)}_`));
    lines.push('');
  }

  lines.push('## Въпроси без отговор на сайта', '', '| Въпрос | Етап | Най-добра страница | Съвпадение | Вердикт | Следваща стъпка |', '| - | - | - | - | - | - |');
  for (const q of audit.questions.filter((x) => x.verdict !== 'answered').slice(0, 40)) {
    lines.push(`| ${mdCell(q.text)} | ${STAGE_LABELS[q.stage]} | ${q.bestPage ? mdUrl(q.bestPage) : '—'} | ${q.match === null ? '—' : `${pct(q.match)}%`} | ${q.verdict === 'no_page' ? 'Няма страница' : 'Слаб отговор'} | ${NEXT_STEP_LABELS[q.nextStep]} |`);
  }
  lines.push('');

  if (audit.geo && audit.geo.skips.length > 0) {
    lines.push('## Защо ИИ ни пропуска', '');
    const seen = new Set<string>();
    for (const s of audit.geo.skips) {
      if (seen.has(s.questionId)) continue;
      seen.add(s.questionId);
      lines.push(`- ${mdText(s.question)} — ${s.reasons.map((r) => SKIP_REASON_LABELS[r]).join(', ')}${s.winner ? ` (цитиран: ${mdText(s.winner.domain)})` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Най-важните SEO промени', '', '| Страница | Елемент | Сега | Предложение |', '| - | - | - | - |');
  for (const e of audit.elements.filter((x) => x.verdict === 'change').slice(0, 30)) {
    lines.push(`| ${mdUrl(e.url)} | ${ELEMENT_LABELS[e.element]} | ${mdCell(e.now)} | ${mdCell(e.proposal ?? e.reason)} |`);
  }
  lines.push('');

  if (audit.warnings.length > 0) lines.push('## Бележки', '', ...audit.warnings.map((w) => `- ${mdText(w)}`), '');
  lines.push('---', `Изготвено с Jev SEO Radar. Критериите за цитируемост (${Object.values(CRITERION_LABELS).join(', ')}) са преценка на Jev и измерени признаци; теглата им са ориентир, не гаранция за цитиране.`);
  return lines.join('\n');
}
