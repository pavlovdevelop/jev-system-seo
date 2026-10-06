import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { BuyerQuestion, SiteAuditReport } from '../../shared/audit';
import { ENGINE_LABELS } from '../../shared/domain';
import { Breakable, Headline, Verdict } from '../components/Pips';
import { PageLink } from '../components/details';
import { Empty, Icon, MiniBar } from '../components/ui';
import { askedQuestionCount, filterQuestions, NEXT_STEP_LABELS, noPageShare, pathOf, QUESTION_STAGES, QUESTION_VERDICT_TEXT, questionCounts, sortQuestions, STAGE_LABELS, type QuestionFilter } from '../lib/audit';
import { bgCount } from '../../shared/plural';
import { int, pct } from '../lib/format';

// Panel 03: does the site have a page for what buyers ask an AI? Who the AI cites instead, and what to do about it.

const VERDICTS = ['all', 'no_page', 'weak', 'answered'] as const;

/** Domains the engines cite for the question, and a badge when an engine cites or names us too. */
function Cites({ q, checked }: { q: BuyerQuestion; checked: boolean }): JSX.Element {
  const us = q.citedBy.map((e) => ENGINE_LABELS[e]).join(', ');
  if (q.aiCites.length === 0 && q.citedBy.length === 0) {
    return <span class="muted" title={checked ? 'ИИ двигателите не са питани за този въпрос' : 'Няма проверка в ИИ двигателите'}>—<span class="sr-only"> не е питан</span></span>;
  }
  return (
    <div class="au-cites">
      {q.aiCites.map((d) => (
        <span key={d} class="chip au-chip" title={d}>{d}</span>
      ))}
      {q.citedBy.length > 0 ? (
        <span class="badge badge-own" title={`Цитират или назовават и нас: ${us}`}>
          <Icon name="check" size={12} />
          + ние<span class="au-badge-by">{us}</span>
        </span>
      ) : null}
    </div>
  );
}

function Row({ q, checked }: { q: BuyerQuestion; checked: boolean }): JSX.Element {
  const step = NEXT_STEP_LABELS[q.nextStep];
  return (
    <tr class={q.verdict === 'no_page' ? 'is-gap' : ''}>
      <td class="au-question">
        <div class="cell-main">{q.text}</div>
        <div class="cell-sub">{STAGE_LABELS[q.stage]}</div>
        <div class="show-sm au-meta">
          <Verdict kind={q.verdict} />
          <div class="small">{q.nextStep === 'none' ? null : <><span class="muted">Следваща стъпка: </span>{step}</>}</div>
          <div class="small muted">
            {q.volume === null ? 'питан: неизвестно' : `питан ${int(q.volume)} пъти/мес.`}
            {q.bestPage ? <> · {pathOf(q.bestPage)} · {pct(q.match)}</> : ' · няма наша страница'}
          </div>
          {q.aiCites.length + q.citedBy.length > 0 ? <Cites q={q} checked={checked} /> : null}
        </div>
      </td>
      <td class="num hide-sm">{int(q.volume)}</td>
      <td class="hide-sm">
        {q.bestPage ? <PageLink url={q.bestPage}><Breakable text={pathOf(q.bestPage)} /></PageLink> : <span class="muted">—</span>}
      </td>
      <td class="hide-sm"><MiniBar value={q.match} /></td>
      <td class="hide-sm"><Cites q={q} checked={checked} /></td>
      <td class="hide-sm"><Verdict kind={q.verdict} /></td>
      <td class="hide-sm">{q.nextStep === 'none' ? <span class="muted">—</span> : step}</td>
    </tr>
  );
}

export function QuestionsTab({ audit }: { audit: SiteAuditReport }): JSX.Element {
  const all = audit.questions;
  const [filter, setFilter] = useState<QuestionFilter>({ stage: 'all', verdict: 'all' });
  const counts = useMemo(() => questionCounts(all, filter), [all, filter]);
  const rows = useMemo(() => sortQuestions(filterQuestions(all, filter)), [all, filter]);
  const asked = audit.geo ? askedQuestionCount(audit.geo.answers) : 0;
  const share = noPageShare(audit.figures);

  if (all.length === 0) {
    return <Empty title="Няма проверени въпроси">Този одит е пуснат без въпроси на купувачите (0 в опциите) — пусни нов с поне един.</Empty>;
  }

  return (
    <div class="stack-lg">
      <Headline value={pct(share)} unit="от въпросите нямат страница">
        Без страница на сайта: {audit.figures.questionsNoPage} от {bgCount(audit.figures.questionsTotal, 'въпрос', 'въпроса')}, които купувачите задават на ИИ.
      </Headline>

      <section>
        <div class="toolbar" role="group" aria-label="Филтри за въпросите">
          <div class="chips">
            {VERDICTS.map((v) => (
              <button key={v} type="button" class="chip chip-btn" aria-pressed={filter.verdict === v} onClick={() => setFilter((f) => ({ ...f, verdict: v }))}>
                {v === 'all' ? 'Всички' : QUESTION_VERDICT_TEXT[v]} <b>{counts.verdict[v]}</b>
              </button>
            ))}
          </div>
          <select class="select" aria-label="Етап на купувача" value={filter.stage} onChange={(e) => setFilter((f) => ({ ...f, stage: e.currentTarget.value as QuestionFilter['stage'] }))}>
            <option value="all">Всички етапи ({counts.stage.all})</option>
            {QUESTION_STAGES.map((s) => (
              <option key={s} value={s}>{STAGE_LABELS[s]} ({counts.stage[s]})</option>
            ))}
          </select>
        </div>

        <div class="table-wrap">
          <table class="table au-table au-fixed">
            <caption class="sr-only">Въпроси на купувачите, дали сайтът има страница с отговор и какво е следващата стъпка</caption>
            <thead>
              <tr>
                <th scope="col" style={{ width: '24%' }}>Въпрос</th>
                <th scope="col" class="num hide-sm" style={{ width: '7%' }} title="Колко пъти месечно се търси">Питани/<wbr />мес.</th>
                <th scope="col" class="hide-sm" style={{ width: '13%' }}>Най-добра наша страница</th>
                <th scope="col" class="hide-sm" style={{ width: '10%' }}>Съвпадение</th>
                <th scope="col" class="hide-sm" style={{ width: '17%' }}>ИИ цитира</th>
                <th scope="col" class="hide-sm" style={{ width: '15%' }}>Решение</th>
                <th scope="col" class="hide-sm" style={{ width: '14%' }}>Следваща стъпка</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}><Empty title="Няма въпроси по тези филтри" /></td>
                </tr>
              ) : null}
              {rows.map((q) => (
                <Row key={q.id} q={q} checked={asked > 0} />
              ))}
            </tbody>
          </table>
        </div>
        <p class="small muted" style={{ marginTop: '10px' }}>
          Подредбата е: първо въпросите без страница, после със слаб отговор, после отговорените — в рамките на групата първо най-търсените.
          {audit.geo ? ` ИИ двигателите са питани за ${asked} от ${bgCount(all.length, 'въпрос', 'въпроса')}.` : ' ИИ двигателите не са питани, затова няма данни кого цитират.'}
        </p>
      </section>
    </div>
  );
}
