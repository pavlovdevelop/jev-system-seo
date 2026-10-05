import { Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { PAGE_TYPE_LABELS, type PageType } from '../../shared/domain';
import type { Report } from '../../shared/schemas';
import { PageDetail } from '../components/details';
import { Confidence, Difficulty, HBar, Icon, MiniBar, RoleBadge } from '../components/ui';
import { int, pct } from '../lib/format';

export function SerpTab({ report }: { report: Report }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const { seed } = report;
  const a = seed.assessment;

  return (
    <div class="stack-lg">
      {a ? (
        <section class="card">
          <div class="card-head">
            <h2>Колко е силна конкуренцията</h2>
            <span class="row"><Difficulty value={a.difficulty} /><span class="muted small">слабост {pct(a.weakness)}</span></span>
          </div>
          <div class="grid grid-2">
            <div class="hbars">
              <HBar label="Тип страница, който не пасва на търсенето" value={a.components.pageTypeMismatch} />
              <HBar label="Резултати, непосветени на самата фраза" value={a.components.notDedicated} />
              <HBar label="Заглавия без цялата фраза" value={a.components.titleGap} />
            </div>
            <div class="hbars">
              <HBar label="Доминация на силни домейни (затруднява)" value={a.components.topicalDominance} tone="other" />
              {a.components.thinContent !== null ? <HBar label="Плитко съдържание на водещите" value={a.components.thinContent} /> : null}
            </div>
          </div>
          <p class="small muted" style={{ marginTop: '12px' }}>
            Първите три стойности помагат на новодошъл: колкото са по-високи, толкова по-лесно се конкурира. Тук няма данни за обратни връзки — домейн с много външни връзки може да е труден въпреки слабо съдържание.
          </p>
        </section>
      ) : null}

      <div class="table-wrap">
        <table class="table">
          <caption>Водещи резултати за „{seed.keyword}“ — оценени от Jev и измерени от самата страница. Отвори ред за детайли.</caption>
          <thead>
            <tr>
              <th aria-label="Детайли" />
              <th class="num">#</th>
              <th>Страница</th>
              <th>Тип (Jev)</th>
              <th>Съдържание</th>
              <th>Оптимизация</th>
              <th>Доверие</th>
              <th>Конверсия</th>
              <th class="num">Думи</th>
            </tr>
          </thead>
          <tbody>
            {seed.pages.map((p) => {
              const isOpen = open === p.url;
              const blocked = p.fetch.status !== 'ok';
              return (
                <Fragment key={p.url}>
                  <tr class={isOpen ? 'is-open' : ''}>
                    <td>
                      <button type="button" class="row-toggle" aria-expanded={isOpen} aria-label={`Детайли за ${p.domain}`} onClick={() => setOpen(isOpen ? null : p.url)}>
                        <Icon name="chevron" size={14} />
                      </button>
                    </td>
                    <td class="num">{p.position ?? '—'}</td>
                    <td>
                      <div class="row" style={{ gap: '6px' }}>
                        <span class="cell-main">{p.domain}</span>
                        <RoleBadge role={p.role} />
                        {blocked ? <span class="badge" title={p.fetch.error ?? ''}><Icon name="alert" size={12} />не е изтеглена</span> : null}
                      </div>
                      <div class="cell-sub trunc">{p.title}</div>
                    </td>
                    <td>
                      {p.judgments.pageType ? (
                        <div class="row" style={{ gap: '8px' }}>
                          <span>{PAGE_TYPE_LABELS[p.judgments.pageType.value as PageType]}</span>
                          <Confidence value={p.judgments.pageType.confidence} />
                        </div>
                      ) : <span class="muted">—</span>}
                    </td>
                    <td><MiniBar value={p.composite.content} text={p.composite.content === null ? '—' : String(Math.round(p.composite.content * 100))} /></td>
                    <td><MiniBar value={p.composite.optimization} /></td>
                    <td><MiniBar value={p.composite.trust} /></td>
                    <td><MiniBar value={p.composite.conversion} /></td>
                    <td class="num">{p.metrics ? int(p.metrics.wordCount) : '—'}</td>
                  </tr>
                  {isOpen ? (
                    <tr class="detail">
                      <td colSpan={9}><PageDetail page={p} /></td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p class="small muted">
        Оценките 0–100 са композитни: за съдържанието се комбинират дълбочина, отговор на нуждата и конкретика (Jev) с дължината (измерена); „Оптимизация“ е изцяло измерена; „Доверие“ и „Конверсия“ комбинират преценките на Jev с измерени контакти и форми. Теглата са в кода и са описани в „Данни и методика“.
      </p>
    </div>
  );
}
