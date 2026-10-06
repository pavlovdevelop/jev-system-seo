import type { JSX } from 'preact';
import { CRITERIA, CRITERION_LABELS, type Criterion } from '../../shared/audit';
import {
  ANSWER_MATCH,
  CITABILITY_FIX_TARGET,
  CITABILITY_WEIGHTS,
  COMPETITOR_PAGE_WEIGHTS,
  FRESH_FLOOR,
  FRESH_MONTHS,
  META_LENGTH,
  PAGE_IMPORTANCE,
  STALE_MONTHS,
  STEAL_AT,
  STEAL_MIN_RELEVANCE,
  TITLE_LENGTH,
} from '../../shared/weights';
import { Callout } from '../components/ui';

// "How it is computed": every number of the audit that comes from a formula, with the weights the server really uses
// (they are imported from the same file), and what is measured by code, judged by Jev, or only a heuristic.

const pc = (n: number): string => `${Math.round(n * 100)}%`;

/** How each of the eight criteria is obtained; the weights beside it are the real ones. */
const HOW: Record<Criterion, { who: string; how: string }> = {
  answer: { who: 'Jev', how: 'Отговаря ли началото на страницата директно на въпроса, който тя обслужва.' },
  facts: { who: 'Jev', how: 'Има ли конкретни факти: цени, срокове, числа, спецификации — а не общи фрази.' },
  sources: { who: 'код + Jev', how: 'На половина измерено (колко различни външни сайта са цитирани; четири са пълен резултат), на половина — преценка на Jev.' },
  author: { who: 'код + Jev', how: 'На половина измерено (автор, ЕИК, адрес, страница „За нас“), на половина — показва ли страницата кой стои зад нея.' },
  faq: { who: 'код', how: 'FAQPage schema е най-силният знак; следват секция с въпроси и заглавия във вид на въпроси.' },
  fresh: { who: 'код', how: `Дата на промяна или публикуване (иначе най-новата година в текста). До ${FRESH_MONTHS} месеца е ${pc(1)}, после пада до ${pc(FRESH_FLOOR)} при ${STALE_MONTHS} месеца.` },
  compare: { who: 'код', how: 'Таблица е най-добре; следват няколко списъка, после един списък.' },
  links: { who: 'код', how: 'Вътрешни връзки спрямо дължината на страницата.' },
};

export function Method(): JSX.Element {
  const importance = Object.entries(PAGE_IMPORTANCE) as Array<[keyof typeof PAGE_IMPORTANCE, number]>;
  const c = COMPETITOR_PAGE_WEIGHTS;
  const ordered = [...CRITERIA].sort((a, b) => CITABILITY_WEIGHTS[b] - CITABILITY_WEIGHTS[a]);
  return (
    <section class="card" aria-labelledby="au-method-title">
      <div class="card-head">
        <h2 id="au-method-title">Как се смята</h2>
        <p>Какво мери кодът, какво решава Jev и кое е само ориентир</p>
      </div>

      <ol class="steps-how">
        <li>
          <div>
            <strong>SEO елементите.</strong> Кодът проверява дължините: заглавие {TITLE_LENGTH.min}–{TITLE_LENGTH.max} знака, мета описание {META_LENGTH.min}–{META_LENGTH.max} знака, дубликати между страниците, липсващи елементи. Всичко, което иска разбиране — ясно ли е заглавието, съвпада ли H1 със страницата, отговаря ли въведението веднага — решава Jev, един въпрос за един елемент. Предложенията за нов текст идват от езиков модел, ако има такъв, иначе от фиксирани правила; те са чернова, не готов текст.
          </div>
        </li>
        <li>
          <div>
            <strong>Индекс на цитиране.</strong> Среднопретеглена стойност на осем критерия (таблицата по-долу). Критерий, който не може да се прецени (например страница без дата), не участва, а теглата на останалите се преизчисляват. Ако Jev не е могъл да прочете нито началото, нито фактите на страницата, индекс не се дава. „След първата поправка“ е <em>проекция</em>: най-тежкият по пропуснати точки критерий се вдига до поне {pc(CITABILITY_FIX_TARGET)} и индексът се смята наново.
          </div>
        </li>
        <li>
          <div>
            <strong>Конкурентни страници.</strong> Пет оценки: отговор {pc(c.answer)}, дълбочина {pc(c.depth)}, доказателства {pc(c.proof)}, schema.org {pc(c.schema)}, актуалност {pc(c.fresh)}. Страница е „за копиране“ от общ резултат {pc(STEAL_AT)} нагоре и поне {pc(STEAL_MIN_RELEVANCE)} релевантност към твоята фраза; иначе е „пропусни“. Копира се структурата и пълнотата — не текстът.
          </div>
        </li>
        <li>
          <div>
            <strong>Липсващи страници.</strong> Кодът намира най-близките страници на сайта до всеки въпрос на купувач, а Jev преценява отговаря ли страницата на въпроса и в правилния ли ъгъл е. Под {pc(ANSWER_MATCH.weakBelow)} съвпадение няма страница за въпроса, под {pc(ANSWER_MATCH.answeredAt)} има слаба, иначе въпросът е покрит.
          </div>
        </li>
        <li>
          <div>
            <strong>ИИ видимост.</strong> Всеки въпрос се задава така, както би го написал човек, на всеки двигател с включено търсене в мрежата. Отчита се дали сайтът ти е <em>цитиран</em> (домейнът е сред източниците) или <em>назован</em> (марката е в текста). Дялът е „колко от получените отговори те включват“, а до него стои 95% интервал на Уилсън: при 24 въпроса интервалът е широк, а два отделни одита могат да се различават само от шум. Кой е цитиран вместо теб се брои по отговорите, в които те няма.
          </div>
        </li>
        <li>
          <div>
            <strong>Защо губят страниците.</strong> За всеки въпрос, на който двигателите цитират други, се гледа най-близката ти страница: твърде кратка ли е (под 350 думи или много по-къса от цитираната — измерено), грешен ли е ъгълът, без конкретни данни ли е, отговаря ли в началото (преценки на Jev), слабо ли е доверието, остаряла ли е. Ако страница няма, това е причината. Не се правят нови заявки към Jev: причините са аритметика върху вече направените преценки. Редът в плана е по брой изгубени отговори; чеклистът е на езиков модел, ако е свързан, иначе от фиксирани правила.
          </div>
        </li>
      </ol>

      <div class="table-wrap" style={{ marginTop: '16px' }}>
        <table class="table">
          <caption>Осемте критерия на индекса на цитиране и теглата им</caption>
          <thead>
            <tr>
              <th scope="col">Критерий</th>
              <th scope="col" class="num">Тегло</th>
              <th scope="col">Кой го определя</th>
              <th scope="col" class="col-wide">Как</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((k) => (
              <tr key={k}>
                <th scope="row">{CRITERION_LABELS[k]}</th>
                <td class="num">{pc(CITABILITY_WEIGHTS[k])}</td>
                <td>{HOW[k].who}</td>
                <td class="col-wide">{HOW[k].how}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p class="muted" style={{ marginTop: '12px' }}>
        Важност на страницата при подреждането на елементите за промяна: {importance.map(([type, w]) => `${type.replace(/_/g, ' ')} ${pc(w)}`).join(' · ')}; началната страница винаги е 100%.
      </p>

      <div style={{ marginTop: '16px' }}>
        <Callout kind="warn">
          <strong>Какво не е това</strong>
          <ul>
            <li>Теглата са преценка, а не коефициенти, пресметнати от данни: никой не публикува как ИИ асистентите избират източници. Затова индексът е ориентир за приоритет, не вероятност.</li>
            <li>ИИ видимостта е извадка. Един и същ въпрос получава различен отговор при всяко питане, а резултатът зависи от държавата, езика и версията на модела.</li>
            <li>Въпросите на купувачите са генерирани и пресяти, не са реалните въпроси към ChatGPT — те не се публикуват от никого.</li>
          </ul>
        </Callout>
      </div>
    </section>
  );
}
