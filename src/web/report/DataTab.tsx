import type { JSX } from 'preact';
import type { Report } from '../../shared/schemas';
import { COMPOSITE_WEIGHTS, EASY_AT, LABEL_THRESHOLDS, MEDIUM_AT, OPPORTUNITY_WEIGHTS, STRENGTH_WEIGHTS } from '../../shared/weights';
import { Callout, Icon } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, int, seconds, usd } from '../lib/format';

const w = (n: number): string => n.toFixed(2).replace('.', ',');

export function DataTab({ report }: { report: Report }): JSX.Element {
  const u = report.usage;
  const s = STRENGTH_WEIGHTS;
  const o = OPPORTUNITY_WEIGHTS;
  const c = COMPOSITE_WEIGHTS;
  return (
    <div class="stack-lg">
      {report.warnings.length > 0 ? (
        <Callout kind="warn">
          <strong>Бележки към този анализ</strong>
          <ul>{report.warnings.map((x) => <li key={x}>{x}</li>)}</ul>
        </Callout>
      ) : null}

      <div class="grid grid-2">
        <section class="card">
          <div class="card-head"><h2>Какво струва и колко отне</h2></div>
          <dl class="kv">
            <dt>Дата</dt><dd>{dateTime(report.createdAt)}</dd>
            <dt>Продължителност</dt><dd>{seconds(u.durationMs)}</dd>
            <dt>Заявки към Jev</dt><dd>{int(u.jevRequests)} {u.jevFailures > 0 ? <span class="muted">({u.jevFailures} неуспешни)</span> : null}</dd>
            <dt>Токени към Jev</dt><dd>{int(u.jevInputTokens)} вход · {int(u.jevOutputTokens)} изход</dd>
            <dt>Цена на Jev (прибл.)</dt><dd>{usd(u.estimatedJevCostUsd)}</dd>
            <dt>SERP заявки</dt><dd>{u.serpCalls} платени · {u.serpCacheHits} от кеша</dd>
            <dt>Заявки за обем</dt><dd>{u.volumeCalls}</dd>
            <dt>Страници</dt><dd>{u.pagesFetched} изтеглени · {u.pagesBlocked} блокирани от robots.txt · {u.pagesFailed} неуспешни</dd>
          </dl>
        </section>
        <section class="card">
          <div class="card-head"><h2>Източници</h2></div>
          <dl class="kv">
            <dt>Режим</dt><dd>{report.mode === 'demo' ? 'ДЕМО (примерни данни)' : 'реален'}</dd>
            <dt>SERP</dt><dd>{report.providers.serp === 'manual' ? 'ръчно въведени адреси' : report.providers.serp}</dd>
            <dt>Търсения/мес</dt><dd>{report.providers.volume ?? 'не е настроен'}</dd>
            <dt>Jev</dt><dd>{report.providers.jev.model} · {report.providers.jev.endpoint}</dd>
            <dt>Пазар</dt><dd>{report.request.market}</dd>
          </dl>
          <div class="row" style={{ marginTop: '16px' }}>
            <a class="btn btn-sm" href={api.exportUrl(report.id, 'csv')} download><Icon name="download" size={14} />Фрази (CSV)</a>
            <a class="btn btn-sm" href={api.exportUrl(report.id, 'md')} download><Icon name="download" size={14} />Отчет (Markdown)</a>
            <a class="btn btn-sm" href={api.exportUrl(report.id, 'json')} download><Icon name="download" size={14} />Всички данни (JSON)</a>
          </div>
        </section>
      </div>

      <section class="card">
        <div class="card-head"><h2>Как работи анализът</h2><p>Какво мери кодът и какво решава Jev</p></div>
        <ol class="steps-how">
          <li><div><strong>Резултатите в Google.</strong> Вземаме водещите страници за фразата от SERP доставчика. Jev не знае кой е на първа позиция — това е жива информация и идва от доставчика.</div></li>
          <li><div><strong>Страниците.</strong> Теглим конкурентните страници (спазваме robots.txt, без заобикаляне на защити) и <em>измерваме в код</em>: заглавие, H1–H3, думи, schema.org, цени, призиви за действие, контакти, изображения. Скрит текст, скриптове и банери за бисквитки се изрязват, преди нещо да стигне до Jev.</div></li>
          <li><div><strong>Jev решава.</strong> За всяка страница задаваме три фокусирани групи въпроси: какво е и какво намерение обслужва; колко дълбоко и конкретно е съдържанието; какво доверие и конверсия показва. Всеки отговор е <em>вероятност</em> със „сигурност“. Въпросите са на английски (там Jev е най-точен), а съдържанието е на български. Типът страница и намерението се питат с обърнат ред на опциите и се усредняват — Jev има лек наклон към първата опция.</div></li>
          <li><div><strong>Кодът смята.</strong> Всичко числово е в код, не в Jev (той не е калкулатор). Композитните оценки на страница комбинират: съдържание = {w(c.content.depth)}·дълбочина + {w(c.content.need)}·отговор на нуждата + {w(c.content.specific)}·конкретика + {w(c.content.length)}·дължина; общо = {w(c.overall.content)}·съдържание + {w(c.overall.optimization)}·оптимизация + {w(c.overall.trust)}·доверие + {w(c.overall.conversion)}·конверсия.</div></li>
          <li><div><strong>Слабост на SERP.</strong> Сила на резултат = {w(s.typeFit)}·пасване на типа страница + {w(s.dedicated)}·посветеност на фразата + {w(s.titleMatch)}·заглавие + {w(s.depth)}·дълбочина (ако е изтеглена) + {w(s.dominance)}·доминация на домейна. Слабостта е средното на (1 − сила) с тегла по позиция (първите места тежат повече). Лесно: ≥ {Math.round(EASY_AT * 100)}%, средно: ≥ {Math.round(MEDIUM_AT * 100)}%, иначе трудно.</div></li>
          <li><div><strong>Възможност.</strong> Оценка = 100 × релевантност × ({w(o.weakness)}·слабост + {w(o.commercial)}·търговска стойност + {w(o.specificity)}·специфичност + {w(o.demand)}·обем). „Бърза победа“ изисква лесен SERP и оценка ≥ {LABEL_THRESHOLDS.quickWin}; без проверен SERP оценката е ограничена до {LABEL_THRESHOLDS.unverifiedCap}.</div></li>
        </ol>
        <div style={{ marginTop: '16px' }}>
          <Callout kind="warn">
            <strong>Ограничения, които трябва да знаеш.</strong>
            <ul>
              <li>Няма данни за обратни връзки и авторитет на домейна. Страница със слабо съдържание на много силен домейн може да е трудна за изпреварване.</li>
              <li>Jev е обучен основно на английски; при български текст сигурността му е по-ниска — гледай индикаторите за сигурност и не вземай решения само по един отговор.</li>
              <li>Оценките на Jev са вероятности, не факти. Калибрирани са за групи от прогнози, не гарантират верен отговор за всяка отделна страница.</li>
              <li>Месечните търсения идват от Google Ads данни (DataForSEO) и може да липсват за редки фрази.</li>
            </ul>
          </Callout>
        </div>
      </section>
    </div>
  );
}
