import type { PageType } from '../../src/shared/domain';
import {
  CRITERIA,
  ENGINE_LABELS,
  type AnswerRecord,
  type BuyerQuestion,
  type CompetitorPage,
  type CriteriaScores,
  type Criterion,
  type ElementVerdict,
  type EngineId,
  type EngineRun,
  type FixPlan,
  type NextStep,
  type QuestionSource,
  type QuestionStage,
  type SeoElement,
  type SiteAuditListItem,
  type SiteAuditReport,
  type SitePage,
  type SkipAnalysis,
  type SkipReason,
  type SourceKind,
  type WinnerPage,
} from '../../src/shared/audit';
import type { PageMetrics } from '../../src/shared/schemas';
import { ANSWER_MATCH, CITABILITY_FIX_TARGET, CITABILITY_WEIGHTS, COMPETITOR_PAGE_WEIGHTS } from '../../src/shared/weights';

// A realistic, deterministic site audit for the fictional Bulgarian web studio "Моето студио" (my-studio.example).
// The raw rows below are hand-written; everything derived from them (citability, figures, engine rates and Wilson
// bounds, who is cited for a question, skip analyses…) is computed, so the report is internally consistent.
// Nothing is random: a tiny seeded generator fills in latencies, tokens and which sources an answer cites.

const N = null;
const DOMAIN = 'my-studio.example';
const ORIGIN = `https://${DOMAIN}`;
const BRAND = 'Моето студио';
export const SAMPLE_AUDIT_ID = 'a_demo5kq2m7x9';
const CREATED = '2026-10-05T09:12:03.000Z';
const DURATION_MS = 214_800;
const ENGINES: readonly EngineId[] = ['openai', 'anthropic', 'gemini'];
const MODELS: Record<EngineId, string> = { openai: 'gpt-5.2', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-3-pro' };
const ENGINE_COST: Record<EngineId, number | null> = { openai: 0.27, anthropic: 0.36, gemini: N }; // Gemini's price is unknown
const STAGES: readonly QuestionStage[] = ['discover', 'compare', 'price', 'trust', 'howto', 'local'];

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`site-audit-sample: missing ${what}`);
  return v;
};

/** mulberry32: the same sequence on every call and every machine. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% Wilson score interval for k successes out of n. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [r3(Math.max(0, centre - margin)), r3(Math.min(1, centre + margin))];
}

// ───────────────────────── other people's sites (cited by the AI, read as competitors) ─────────────────────────

const SITES: Record<string, { brand: string; path: string; title: string; kind: SourceKind }> = {
  'pixel-studio.example': { brand: 'Пиксел Студио', path: '/uslugi/izrabotka-na-uebsait/', title: 'Изработка на уебсайт — цени, срокове и процес', kind: 'brand' },
  'webmasters-bg.example': { brand: 'Уебмастърс', path: '/izrabotka-na-sait', title: 'Изработка на сайт от Уебмастърс — пакети и цени', kind: 'brand' },
  'seo-pro.example': { brand: 'СЕО Про', path: '/izrabotka-i-seo/', title: 'Уебсайт и SEO в един пакет — СЕО Про', kind: 'brand' },
  'magazin-expert.example': { brand: 'Магазин Експерт', path: '/izrabotka-na-onlain-magazin', title: 'Онлайн магазин по поръчка — платформи, цени, интеграции', kind: 'brand' },
  'firmi-bg.example': { brand: 'Фирми.бг', path: '/kategoria/izrabotka-na-saitove', title: 'Фирми за изработка на сайтове — каталог', kind: 'other' },
  'digital-blog.example': { brand: 'Дигитален блог', path: '/blog/kak-da-izberem-firma-za-sait', title: 'Как да изберем фирма за сайт: ръководство и контролен списък', kind: 'guide' },
  'forum-programisti.example': { brand: 'Форум Програмисти', path: '/t/kolko-struva-sait-12345', title: 'Колко струва сайт? — тема във форума', kind: 'community' },
  'top-agencii.example': { brand: 'Топ агенции', path: '/klasaciya/top-10-firmi-za-saitove', title: 'Топ 10 фирми за изработка на сайт в България', kind: 'compare' },
  'biznes-gov.example': { brand: 'Бизнес портал', path: '/rakovodstvo/onlain-prisastvie', title: 'Онлайн присъствие за малкия бизнес — ръководство', kind: 'authority' },
  'dnevnik-biznes.example': { brand: 'Дневник Бизнес', path: '/news/uebsait-za-malkiya-biznes', title: 'Защо малките фирми губят клиенти без добър сайт', kind: 'media' },
  'sait-ot-nulata.example': { brand: 'Сайт от нулата', path: '/', title: 'Сайт от нулата — изработка на сайтове', kind: 'brand' },
  'fabrika-za-saitove.example': { brand: 'Фабрика за сайтове', path: '/izrabotka-na-saitove.html', title: 'Изработка на сайтове — Фабрика за сайтове', kind: 'brand' },
};
const site = (domain: string) => must(SITES[domain], `site ${domain}`);
/** The sources an engine tends to cite, by what the buyer is trying to do (most likely first). */
const STAGE_SOURCES: Record<QuestionStage, readonly string[]> = {
  discover: ['pixel-studio.example', 'top-agencii.example', 'firmi-bg.example', 'webmasters-bg.example'],
  compare: ['digital-blog.example', 'forum-programisti.example', 'top-agencii.example', 'pixel-studio.example'],
  price: ['pixel-studio.example', 'digital-blog.example', 'webmasters-bg.example', 'forum-programisti.example'],
  trust: ['firmi-bg.example', 'forum-programisti.example', 'pixel-studio.example', 'dnevnik-biznes.example'],
  howto: ['digital-blog.example', 'biznes-gov.example', 'seo-pro.example', 'pixel-studio.example'],
  local: ['firmi-bg.example', 'webmasters-bg.example', 'magazin-expert.example', 'top-agencii.example'],
};

// ───────────────────────── SEO elements (panel 01) ─────────────────────────
// path, element, current value (null = the page's title), confidence (1 = an objective rule), reason, proposal (null = keep), who wrote the proposal.

type ElementRow = readonly [path: string, element: SeoElement, now: string | null, confidence: number, reason: string, proposal: string | null, by: 'rule' | 'llm' | null];
const ELEMENT_ROWS: readonly ElementRow[] = [
  ['/', 'title', N, 0.93, 'Заглавието е само името на марката — не казва какво предлагате', 'Изработка на уебсайтове и онлайн магазини | Моето студио', 'llm'],
  ['/', 'meta', 'липсва', 1, 'Няма мета описание — Google го съставя от случаен текст', 'Опиши услугата, града и първата стъпка в 140–160 знака', 'rule'],
  ['/', 'h1', 'Добре дошли в Моето студио', 0.9, 'H1 не съдържа фразата, по която искате да ви намират', 'Уебсайтове и онлайн магазини за малък и среден бизнес', 'llm'],
  ['/', 'intro', 'Ние сме екип от креативни професионалисти, които…', 0.82, 'Въведението е общо — не казва какво правите и за колко', 'Правим уебсайтове и онлайн магазини за малък бизнес — от 990 лв., готови за 3–4 седмици.', 'llm'],
  ['/', 'schema', 'няма', 1, 'Няма Organization — ИИ не може да ви разпознае като фирма', 'Добави JSON-LD Organization с име, лого, адрес и телефон', 'rule'],
  ['/', 'canonical', `${ORIGIN}/`, 1, 'Сочи към самата страница', N, N],
  ['/', 'links', '12 вътрешни връзки', 1, 'Достатъчно връзки към услугите и блога', N, N],
  ['/', 'url', '/', 1, 'Началната страница не се променя', N, N],
  ['/', 'images', '9 от 9 със alt', 1, 'Всички картинки имат алтернативен текст', N, N],
  ['/uslugi/izrabotka-na-sait', 'title', N, 0.88, 'Започва с фразата и е в рамките на 60 знака', N, N],
  ['/uslugi/izrabotka-na-sait', 'h1', 'Изработка на уебсайт', 0.9, 'Съвпада със заглавието и търсената фраза', N, N],
  ['/uslugi/izrabotka-na-sait', 'url', '/uslugi/izrabotka-na-sait', 1, 'Кратък адрес с фразата', N, N],
  ['/uslugi/izrabotka-na-sait', 'meta', 'Професионална изработка на уебсайтове. Свържете се с нас!', 0.86, 'Описанието е общо — без цена и без причина да се кликне', 'Уебсайт от 990 лв. за 3–4 седмици: дизайн, мобилна версия и SEO основа. Вижте цените и примери.', 'llm'],
  ['/uslugi/izrabotka-na-sait', 'h2', 'Нашите услуги · Защо ние · Процес', 0.78, 'Подзаглавията са общи, а не въпроси, които купувачът задава', 'Колко струва уебсайт? · Колко време отнема? · Какво получавате?', 'llm'],
  ['/uslugi/izrabotka-na-sait', 'intro', 'Всеки бизнес има нужда от онлайн присъствие…', 0.84, 'Откриването е клише и забавя отговора', 'Изработваме уебсайт за малък бизнес от 990 лв. и 3–4 седмици. Цената включва дизайн, мобилна версия и базова SEO оптимизация.', 'llm'],
  ['/uslugi/izrabotka-na-sait', 'faq', 'няма', 1, 'Няма секция с въпроси — ИИ често цитира готови въпроси и отговори', 'Добави 6 въпроса (цена, срок, поддръжка, собственост) със FAQPage schema', 'rule'],
  ['/uslugi/onlain-magazin', 'title', N, 0.85, 'Съдържа фразата и е с подходяща дължина', N, N],
  ['/uslugi/onlain-magazin', 'meta', 'липсва', 1, 'Няма мета описание', 'Онлайн магазин по поръчка от 2 400 лв.: кошница, плащане, доставка и обучение. Готов за 5–6 седмици.', 'llm'],
  ['/uslugi/onlain-magazin', 'intro', 'Използваме най-новите технологии като…', 0.8, 'Въведението изброява технологии, а не какво печели клиентът', 'Онлайн магазин с кошница, плащане и доставка — от 2 400 лв., готов за 5–6 седмици.', 'llm'],
  ['/uslugi/onlain-magazin', 'images', '2 от 14 със alt', 1, 'На 12 картинки липсва алтернативен текст', 'Добави описателен alt на 12-те картинки', 'rule'],
  ['/uslugi/onlain-magazin', 'links', '9 вътрешни връзки', 1, 'Връзки към ценоразписа и портфолиото', N, N],
  ['/uslugi/seo-optimizaciya', 'title', N, 0.8, 'Съдържа фразата и описва за кого е', N, N],
  ['/uslugi/seo-optimizaciya', 'h1', 'SEO оптимизация за малък бизнес', 0.85, 'H1 казва какво е и за кого', N, N],
  ['/uslugi/seo-optimizaciya', 'url', '/uslugi/seo-optimizaciya', 1, 'Кратък адрес с фразата', N, N],
  ['/uslugi/seo-optimizaciya', 'meta', 'SEO оптимизация. Повече клиенти от Google.', 0.82, 'Кратко и общо — няма цена, нито какво включва', 'SEO за малък бизнес от 290 лв./месец: технически одит, текстове и отчет. Безплатна първа консултация.', 'llm'],
  ['/uslugi/seo-optimizaciya', 'schema', 'Organization', 1, 'Липсва Service с цена „от“', 'Добави Service с цена „от“ и срок', 'rule'],
  ['/tsenoraz', 'title', 'Ценоразпис | Моето студио', 0.9, 'Заглавието не съдържа „цена“ и „уебсайт“', 'Цена на уебсайт и онлайн магазин — ценоразпис 2026 | Моето студио', 'llm'],
  ['/tsenoraz', 'meta', 'Вижте нашия ценоразпис.', 0.9, 'Три думи — без нито една цена', 'Цени: уебсайт от 990 лв., онлайн магазин от 2 400 лв., SEO от 290 лв./месец. Какво включва всеки пакет.', 'llm'],
  ['/tsenoraz', 'h1', 'Колко струва? Ценоразпис 2026', 0.84, 'Отговаря на въпроса, който купувачът задава', N, N],
  ['/tsenoraz', 'url', '/tsenoraz', 1, 'Кратък адрес', N, N],
  ['/tsenoraz', 'schema', 'няма', 1, 'Цените не са описани като Offer', 'Добави Offer за всеки пакет с цена и валута', 'rule'],
  ['/tsenoraz', 'canonical', `${ORIGIN}/tsenoraz?utm_source=mail`, 1, 'Canonical сочи към адрес с параметър', `Задай canonical ${ORIGIN}/tsenoraz`, 'rule'],
  ['/za-nas', 'title', N, 0.7, 'Ясно и кратко', N, N],
  ['/za-nas', 'meta', 'липсва', 1, 'Няма мета описание', 'Екипът зад Моето студио: опит, клиенти и начин на работа — запознайте се с нас', 'rule'],
  ['/za-nas', 'h1', 'За нас', 0.8, 'H1 е две думи и не казва кои сте', 'Екипът зад Моето студио: опит, клиенти и подход', 'llm'],
  ['/za-nas', 'intro', 'Моето студио е основано през 2014 г.', 0.78, 'Липсват числа — колко проекта, колко души', 'Моето студио е екип от 6 души в София. От 2014 г. сме изработили над 120 сайта за малък и среден бизнес.', 'llm'],
  ['/za-nas', 'schema', 'няма', 1, 'Няма Organization и Person за основателите', 'Добави Organization и Person с имена и роли', 'rule'],
  ['/za-nas', 'images', '6 от 6 със alt', 1, 'Всички снимки имат алтернативен текст', N, N],
  ['/blog/kolko-struva-sait', 'title', N, 0.9, 'Съдържа годината и обещава пълен отговор', N, N],
  ['/blog/kolko-struva-sait', 'meta', 'Уебсайт от 990 до 6 000 лв. — виж какво определя цената и как да не платиш повече.', 0.85, 'Отговаря на въпроса и съдържа числа', N, N],
  ['/blog/kolko-struva-sait', 'h1', 'Колко струва уебсайт през 2026', 0.9, 'Точно фразата, която хората търсят', N, N],
  ['/blog/kolko-struva-sait', 'faq', '4 въпроса, без schema', 1, 'Въпросите не са маркирани с FAQPage', 'Добави FAQPage schema към 4-те въпроса', 'rule'],
  ['/blog/kolko-struva-sait', 'links', '9 вътрешни връзки', 1, 'Добре свързана със страниците за услуги', N, N],
  ['/blog/kak-da-izberem-firma-za-sait', 'title', N, 0.74, 'Заглавието е в 1 л. мн.ч., а търсещите пишат „как да избера“', 'Как да изберете фирма за изработка на уебсайт: 7 въпроса преди да подпишете', 'llm'],
  ['/blog/kak-da-izberem-firma-za-sait', 'meta', 'липсва', 1, 'Няма мета описание', 'Седем въпроса към всяка агенция преди договор: цена, срок, собственост на сайта и поддръжка.', 'llm'],
  ['/blog/kak-da-izberem-firma-za-sait', 'intro', 'Преди да подпишете договор, задайте седем въпроса…', 0.8, 'Започва направо с отговор', N, N],
  ['/blog/kak-da-izberem-firma-za-sait', 'schema', 'Article без автор', 1, 'Няма автор и дата на публикуване', 'Добави author и datePublished в Article', 'rule'],
  ['/blog/kak-da-izberem-firma-za-sait', 'images', '5 от 5 със alt', 1, 'Всички картинки имат алтернативен текст', N, N],
  ['/blog/seo-za-malkiya-biznes', 'title', N, 0.8, 'Съдържа фразата в началото', N, N],
  ['/blog/seo-za-malkiya-biznes', 'intro', 'В днешно време SEO е важно за всеки бизнес…', 0.83, 'Откриването е клише и забавя отговора', 'Започни с 3 стъпки: местни фрази, бърз сайт и отделна страница за всяка услуга.', 'llm'],
  ['/blog/seo-za-malkiya-biznes', 'links', '2 вътрешни връзки', 1, 'Малко връзки към страниците за услуги', 'Свържи със /uslugi/seo-optimizaciya и /tsenoraz', 'rule'],
  ['/chesti-vaprosi', 'title', N, 0.85, 'Описва съдържанието ясно', N, N],
  ['/chesti-vaprosi', 'faq', '14 въпроса със FAQPage', 1, 'Въпросите са маркирани правилно', N, N],
  ['/chesti-vaprosi', 'canonical', `${ORIGIN}/chesti-vaprosi`, 1, 'Сочи към самата страница', N, N],
  ['/chesti-vaprosi', 'meta', 'липсва', 1, 'Няма мета описание', 'Отговори на 14 въпроса за цена, срок, собственост и поддръжка на сайта', 'rule'],
  ['/portfolio', 'title', 'Портфолио', 1, 'Заглавието е твърде кратко (9 знака)', 'Портфолио: уебсайтове и онлайн магазини, изработени от Моето студио', 'rule'],
  ['/portfolio', 'images', '0 от 18 със alt', 1, 'На 18 картинки липсва алтернативен текст', 'Добави alt на 18-те картинки: клиент и вид проект', 'rule'],
  ['/portfolio', 'canonical', `${ORIGIN}/portfolio`, 1, 'Сочи към самата страница', N, N],
  ['/kontakti', 'title', 'Контакти', 1, 'Заглавието е една дума (8 знака)', 'Контакти — Моето студио, София: адрес, телефон, имейл', 'rule'],
  ['/kontakti', 'schema', 'няма', 1, 'Няма LocalBusiness с адрес и работно време', 'Добави LocalBusiness с адрес, телефон и работно време', 'rule'],
  ['/kontakti', 'meta', 'Свържете се с нас: ул. „Примерна“ 12, София, тел. 02 000 0000', 0.9, 'Съдържа адрес и телефон', N, N],
  ['/blog/wordpress-ili-sait-po-poruchka', 'title', N, 0.8, 'Без годината и без за кого е', 'WordPress или сайт по поръчка: какво е по-добре за малка фирма (2026)', 'llm'],
  ['/blog/wordpress-ili-sait-po-poruchka', 'h1', 'WordPress или сайт по поръчка?', 0.85, 'Въпросът е формулиран както го търсят', N, N],
  ['/blog/wordpress-ili-sait-po-poruchka', 'intro', 'Въпросът е често срещан и много хора се колебаят…', 0.85, 'Няма отговор в началото', 'Накратко: WordPress е по-евтин и бърз за старт, а сайтът по поръчка — по-добър при специфични нужди и растеж.', 'llm'],
  ['/blog/wordpress-ili-sait-po-poruchka', 'schema', 'Article без дата на промяна', 1, 'Статията е на 38 месеца и няма dateModified', 'Добави dateModified и обнови цените и данните', 'rule'],
  ['/blog/wordpress-ili-sait-po-poruchka', 'links', '1 вътрешна връзка', 1, 'Не води към услугата', 'Свържи със /uslugi/izrabotka-na-sait и /tsenoraz', 'rule'],
];
const elementNow = (path: string, element: SeoElement): string | null => ELEMENT_ROWS.find((r) => r[0] === path && r[1] === element)?.[2] ?? N;

function buildElements(pageOrder: readonly string[]): ElementVerdict[] {
  const rnd = seeded(23);
  const weight: Record<SeoElement, number> = { title: 1, meta: 0.9, h1: 0.9, h2: 0.7, intro: 0.75, faq: 0.8, schema: 0.75, canonical: 0.5, links: 0.5, images: 0.45, url: 0.6 };
  return ELEMENT_ROWS.map(([path, element, now, confidence, reason, proposal, by]) => {
    const rank = pageOrder.indexOf(path);
    const change = proposal !== N;
    const impact = change ? weight[element] * (1 - rank * 0.05) * (0.7 + 0.3 * rnd()) : 0.02 + 0.08 * rnd();
    return { url: ORIGIN + path, element, now: now ?? must(PAGE_ROWS.find((p) => p[0] === path), `page ${path}`)[1], verdict: change ? 'change' : 'keep', confidence, reason, proposal, source: confidence === 1 ? 'rule' : 'jev', proposalBy: change ? by : N, impact: r2(impact) };
  });
}

// ───────────────────────── pages and their citability (panel 04) ─────────────────────────
// path, title, type, phrase, Google rank, months since the last change, words, the eight criteria in CRITERIA order (null = not judged).

type Eight = readonly [number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null];
type PageRow = readonly [path: string, title: string, type: PageType | null, phrase: string | null, rank: number | null, age: number, words: number, scores: Eight | null];
const PAGE_ROWS: readonly PageRow[] = [
  ['/', 'Моето студио', 'company_homepage', 'изработка на уебсайт', 14, 2, 640, [0.45, 0.15, 0.3, 0.8, 0.2, 0.5, N, 0.7]],
  ['/uslugi/izrabotka-na-sait', 'Изработка на уебсайт | Моето студио', 'service_page', 'изработка на уебсайт', 9, 5, 980, [0.55, 0.6, 0.4, 0.7, 0.15, 0.6, 0.3, 0.65]],
  ['/uslugi/onlain-magazin', 'Онлайн магазин по поръчка — Моето студио', 'service_page', 'онлайн магазин по поръчка', 22, 8, 870, [0.55, 0.35, 0.35, 0.6, 0.2, 0.25, 0.2, 0.5]],
  ['/uslugi/seo-optimizaciya', 'SEO оптимизация за малък бизнес', 'service_page', 'seo оптимизация', N, 14, 760, [0.55, 0, 0.4, 0.5, 0.4, 0.5, 0.3, 0.55]],
  ['/tsenoraz', 'Ценоразпис | Моето студио', 'service_page', 'цена на уебсайт', 31, 3, 520, [0.75, 0.2, 0.25, 0.85, 0.1, 0.75, 0.55, 0.35]],
  ['/za-nas', 'За нас — Моето студио', 'company_homepage', 'моето студио', 3, 26, 410, [0.5, 0.05, 0, 0.2, 0.25, 0.45, N, 0.4]],
  ['/blog/kolko-struva-sait', 'Колко струва уебсайт през 2026: пълно ръководство', 'blog_article', 'колко струва уебсайт', 18, 11, 1850, [0.7, 0.55, 0.55, 0.45, 0.2, 0.8, 0.65, 0.75]],
  ['/blog/kak-da-izberem-firma-za-sait', 'Как да изберем фирма за сайт: 7 въпроса', 'blog_article', 'как да избера фирма за уебсайт', 27, 18, 1420, [0.8, 0.4, 0.5, 0.5, 0.6, 0.7, 0.1, 0.7]],
  ['/blog/seo-za-malkiya-biznes', 'SEO за малкия бизнес: с какво да започнеш', 'blog_article', 'seo за малък бизнес', 41, 9, 1230, [0.75, 0.5, 0.6, 0.5, 0.6, 0.65, 0.5, 0.1]],
  ['/chesti-vaprosi', 'Често задавани въпроси за изработка на сайт', 'other', 'въпроси за изработка на сайт', N, 4, 1100, [0.85, 0.95, 0.35, 0.75, 0.4, 0.5, N, 0.55]],
  ['/portfolio', 'Портфолио', N, N, N, 7, 380, N], // Jev did not answer: no criteria, no citability
  ['/kontakti', 'Контакти', 'other', N, N, 20, 140, [0.7, N, 0.25, 0.3, N, 0.1, N, 0.3]],
  ['/blog/wordpress-ili-sait-po-poruchka', 'WordPress или сайт по поръчка?', 'blog_article', 'wordpress или сайт по поръчка', N, 38, 900, [0.5, 0.2, 0.3, 0.05, 0.25, 0.45, 0.4, 0.35]],
];
const BROKEN_PATH = '/stari-ceni'; // a 404 that is still in the sitemap
const PAGE_ORDER = [...PAGE_ROWS.map((r) => r[0]), BROKEN_PATH];

const WEIGHTS: Record<Criterion, number> = CITABILITY_WEIGHTS;
const FIX_ACTIONS: Record<Criterion, string> = {
  answer: 'Отговори на въпроса в първите 40 думи',
  faq: 'Добави 5–6 въпроса и отговора със schema',
  author: 'Покажи автор, роля и опит на екипа',
  fresh: 'Обнови данните и добави дата на промяна',
  sources: 'Цитирай 3 източника с връзки',
  facts: 'Добави конкретни цени, срокове и числа',
  compare: 'Добави таблица за сравнение',
  links: 'Свържи с 3 свързани страници на сайта',
};
// a few pages get a more specific first fix than the generic one for the criterion
const FIX_OVERRIDES: Record<string, Partial<Record<Criterion, string>>> = {
  '/kontakti': { facts: 'Добави адрес, телефон и работно време' },
  '/za-nas': { author: 'Покажи екипа с имена, роли и опит' },
  '/tsenoraz': { sources: 'Посочи откъде са цените и кога са обновени' },
  '/blog/seo-za-malkiya-biznes': { links: 'Свържи със страниците за услуги и цени' },
};
const criteriaOf = (s: Eight | null): CriteriaScores => ({ answer: s?.[0] ?? N, faq: s?.[1] ?? N, author: s?.[2] ?? N, fresh: s?.[3] ?? N, sources: s?.[4] ?? N, facts: s?.[5] ?? N, compare: s?.[6] ?? N, links: s?.[7] ?? N });

/** Weighted mean of the criteria that could be judged; `after` assumes the criterion with the biggest weighted gap is lifted to the fix target. */
function citabilityOf(path: string, c: CriteriaScores): SitePage['citability'] {
  const judged = CRITERIA.filter((k) => c[k] !== N);
  if (judged.length === 0) return N;
  const total = judged.reduce((s, k) => s + WEIGHTS[k], 0);
  const now = judged.reduce((s, k) => s + WEIGHTS[k] * (c[k] ?? 0), 0) / total;
  const gaps = judged.map((k) => ({ k, gap: (WEIGHTS[k] * (1 - (c[k] ?? 0))) / total }));
  const worst = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
  const lift = (WEIGHTS[worst.k] * Math.max(0, CITABILITY_FIX_TARGET - (c[worst.k] ?? 0))) / total;
  return { now: r2(now), after: r2(Math.min(1, now + lift)), fixFirst: { criterion: worst.k, action: FIX_OVERRIDES[path]?.[worst.k] ?? FIX_ACTIONS[worst.k] } };
}

function metricsOf(path: string, title: string, words: number): PageMetrics {
  const meta = elementNow(path, 'meta');
  const hasMeta = meta !== N && meta !== 'липсва';
  return {
    title, titleLength: title.length, metaDescription: hasMeta ? meta : N, metaDescriptionLength: hasMeta ? meta.length : 0,
    h1: [elementNow(path, 'h1') ?? title], headings: [], h2Count: 4, h3Count: 6, wordCount: words, lang: 'bg', canonical: `${ORIGIN}${path}`, canonicalIsSelf: true, noindex: false,
    hasViewport: true, https: true, schemaTypes: elementNow(path, 'schema')?.startsWith('Organization') ? ['Organization'] : [], hasFaqSchema: path === '/chesti-vaprosi', hasFaqSection: path.includes('vaprosi'),
    images: { total: 9, withAlt: 5 }, links: { internal: 8, external: 2 }, hasContactForm: path === '/kontakti', phones: 1, emails: 1, ctaTexts: ['Свържете се с нас'], priceMentions: [], socialProof: [],
    navLabels: ['Услуги', 'Цени', 'Блог', 'Контакти'], latestYear: 2026, modifiedAt: N, publishedAt: N, tables: 0, lists: 3, externalDomains: 1, hasAuthor: false, faqQuestions: 0,
    keyword: { inTitle: true, inH1: false, inUrl: false, inMeta: false, titleCoverage: 0.8, bodyCoverage: 0.7, startsTitleWithKeyword: false },
  };
}

function buildPages(elements: readonly ElementVerdict[]): SitePage[] {
  const rnd = seeded(11);
  const toChange = (url: string): number => elements.filter((e) => e.url === url && e.verdict === 'change').length;
  const pages = PAGE_ROWS.map(([path, title, type, phrase, rank, age, words, scores]): SitePage => {
    const criteria = criteriaOf(scores);
    const judged = CRITERIA.filter((k) => criteria[k] !== N).length;
    return {
      url: ORIGIN + path, path,
      fetch: { status: 'ok', httpStatus: 200, error: N, finalUrl: ORIGIN + path, ttfbMs: Math.round(90 + rnd() * 320), bytes: Math.round(38_000 + rnd() * 170_000), fromCache: false },
      metrics: metricsOf(path, title, words), type, phrase, rank, ageMonths: age, words, criteria, citability: citabilityOf(path, criteria),
      elementsToChange: toChange(ORIGIN + path), judgmentStatus: judged === 0 ? 'none' : judged >= 7 ? 'complete' : 'partial',
    };
  });
  pages.push({
    url: ORIGIN + BROKEN_PATH, path: BROKEN_PATH, fetch: { status: 'http_error', httpStatus: 404, error: 'HTTP 404', finalUrl: N, ttfbMs: 180, bytes: N, fromCache: false },
    metrics: N, type: N, phrase: N, rank: N, ageMonths: N, words: 0, criteria: criteriaOf(N), citability: N, elementsToChange: 0, judgmentStatus: 'none',
  });
  return pages;
}

// ───────────────────────── buyer questions (panel 03) ─────────────────────────
// Rows are in rounds of the six stages (stage = index % 6). No page → "no_page"; a page that matches below ANSWER_MATCH.answeredAt → "weak".

type QuestionRow = readonly [text: string, volume: number | null, bestPath: string | null, match: number | null, nextStep: NextStep, source: QuestionSource];
const QUESTION_ROWS: readonly QuestionRow[] = [
  ['Коя е най-добрата фирма за изработка на уебсайт в България?', 880, '/', 0.35, 'add_proof', 'llm'],
  ['WordPress или сайт по поръчка — кое е по-добре за малка фирма?', 1300, '/blog/wordpress-ili-sait-po-poruchka', 0.41, 'answer_at_top', 'paa'],
  ['Колко струва изработката на уебсайт през 2026?', 2400, '/blog/kolko-struva-sait', 0.88, 'none', 'suggest'],
  ['Моето студио добра фирма ли е? Има ли отзиви?', 90, '/za-nas', 0.34, 'add_proof', 'template'],
  ['Как да направя сайт за малък бизнес стъпка по стъпка?', 1900, '/blog/kak-da-izberem-firma-za-sait', 0.52, 'answer_at_top', 'related'],
  ['Изработка на сайт София — кого да избера?', 480, '/', 0.38, 'add_local', 'suggest'],
  ['Кой прави онлайн магазини за малък бизнес в София?', 320, N, N, 'write_guide', 'llm'],
  ['Wix или професионален уебсайт — какво да избера?', 720, N, N, 'write_versus', 'paa'],
  ['Колко струва онлайн магазин по поръчка?', 1100, '/uslugi/onlain-magazin', 0.46, 'add_prices', 'suggest'],
  ['Какви гаранции дават фирмите за изработка на уебсайт?', 170, '/chesti-vaprosi', 0.71, 'none', 'template'],
  ['Колко време отнема изработката на уебсайт?', 650, '/chesti-vaprosi', 0.91, 'none', 'paa'],
  ['Фирма за изработка на уебсайт в Пловдив', 210, N, N, 'add_local', 'template'],
  ['Къде да поръчам уебсайт за фирмата си?', 590, '/uslugi/izrabotka-na-sait', 0.62, 'none', 'related'],
  ['Агенция или фрийлансър за уебсайт — кое е по-изгодно?', 410, N, N, 'write_versus', 'llm'],
  ['Има ли месечна такса за поддръжка на сайт?', 260, N, N, 'add_prices', 'paa'],
  ['Кой е собственик на сайта след изработката — аз или агенцията?', 140, '/chesti-vaprosi', 0.79, 'none', 'paa'],
  ['Какво да подготвя, преди да поръчам уебсайт?', N, N, N, 'write_guide', 'llm'],
  ['Уеб студио във Варна — цени и отзиви', 120, N, N, 'add_local', 'template'],
  ['Има ли студио, което прави и SEO, и уебсайт заедно?', N, '/uslugi/seo-optimizaciya', 0.48, 'add_proof', 'llm'],
  ['Как да сравня оферти за изработка на уебсайт?', N, '/blog/kak-da-izberem-firma-za-sait', 0.83, 'none', 'llm'],
  ['Колко струва SEO оптимизация на месец?', 590, '/uslugi/seo-optimizaciya', 0.34, 'add_prices', 'suggest'],
  ['Как да разбера дали агенцията ще си свърши работата?', N, N, N, 'write_guide', 'llm'],
  ['Как да оптимизирам сайта си за Google?', 1600, '/blog/seo-za-malkiya-biznes', 0.67, 'none', 'related'],
  ['Къде се намира Моето студио и как да се свържа?', N, '/kontakti', 0.94, 'none', 'template'],
];

function buildQuestions(): BuyerQuestion[] {
  return QUESTION_ROWS.map(([text, volume, bestPath, match, nextStep, source], i) => ({
    id: `q${String(i + 1).padStart(2, '0')}`, text, stage: must(STAGES[i % STAGES.length], 'stage'), source, volume,
    bestPage: bestPath === N ? N : ORIGIN + bestPath, match, verdict: bestPath === N ? 'no_page' : (match ?? 0) >= ANSWER_MATCH.answeredAt ? 'answered' : 'weak', nextStep, aiCites: [], citedBy: [],
  }));
}

// ───────────────────────── what the three engines say (GEO) ─────────────────────────
// One letter per question an engine was asked, in question order: c = cites us, n = names us, m = misses us, f = failed.
// ChatGPT: 14 questions · Claude: 13 (one failed) · Gemini: 9 (three failed) → rates 29% / 33% / 17%.

const STATUS_CODES: Record<EngineId, string> = { openai: 'mmcnmmmmmmcmnm', anthropic: 'mmcnmmmfmcnmm', gemini: 'mfcmfmmfm' };
const STATUS_OF: Record<string, AnswerRecord['status']> = { c: 'cited', n: 'named', m: 'missing', f: 'failed' };
// Skip analyses: [engine, question index, the source it cites instead, why it skips us]. Every pair is a "missing" answer above.
type SkipRow = readonly [engine: EngineId, question: number, winner: string, reasons: readonly SkipReason[]];
const SKIP_ROWS: readonly SkipRow[] = [
  ['openai', 7, 'top-agencii.example', ['no_page']],
  ['anthropic', 8, 'magazin-expert.example', ['too_thin', 'no_data']],
  ['gemini', 5, 'firmi-bg.example', ['wrong_angle', 'weak_trust']],
  ['openai', 1, 'digital-blog.example', ['no_answer_first', 'outdated']],
  ['anthropic', 6, 'dnevnik-biznes.example', ['no_page']],
  ['gemini', 0, 'pixel-studio.example', ['weak_trust', 'no_data']],
  ['openai', 11, 'forum-programisti.example', ['no_page']],
  ['anthropic', 4, 'biznes-gov.example', ['too_thin', 'no_answer_first', 'outdated']],
];

function buildAnswers(questions: readonly BuyerQuestion[], pages: readonly SitePage[]): AnswerRecord[] {
  const rnd = seeded(31);
  const out: AnswerRecord[] = [];
  for (const engine of ENGINES) {
    [...must(STATUS_CODES[engine], engine)].forEach((code, qi) => {
      const q = must(questions[qi], `question ${qi}`);
      const status = must(STATUS_OF[code], code);
      const forced = SKIP_ROWS.find((s) => s[0] === engine && s[1] === qi)?.[2];
      const pool = STAGE_SOURCES[q.stage].filter((d) => d !== forced);
      const from = rnd() < 0.5 ? 0 : 1;
      const domains = status === 'failed' ? [] : [...(forced ? [forced] : []), ...pool.slice(from, from + 2 + (rnd() < 0.5 ? 1 : 0))];
      const citations = domains.map((d) => ({ domain: d, url: `https://${d}${site(d).path}`, title: site(d).title }));
      let position: number | null = N;
      if (status === 'cited') {
        const page = must(pages.find((p) => p.url === q.bestPage), 'our cited page');
        position = 1 + Math.floor(rnd() * 3);
        citations.splice(position - 1, 0, { domain: DOMAIN, url: page.url, title: must(PAGE_ROWS.find((r) => r[0] === page.path), 'page row')[1] });
      }
      const brands = domains.slice(0, 2).map((d) => site(d).brand);
      const list = brands.join(' и ');
      const excerpt = {
        cited: `„${q.text}“ — накратко: зависи от целите и бюджета. Подробен отговор с числа дава ${BRAND} (${DOMAIN}); сред другите източници са ${list}.`,
        named: `„${q.text}“ — често препоръчвани са ${list}. Като по-малка алтернатива се споменава и ${BRAND}, която изработва уебсайтове и онлайн магазини.`,
        missing: `„${q.text}“ — най-често се препоръчват ${list}. Сравнете цената, срока, примерите и отзивите на клиентите.`,
        failed: '',
      }[status];
      out.push({
        engine, questionId: q.id, status, latencyMs: status === 'failed' ? (rnd() < 0.5 ? 30_000 : 900) : Math.round(2200 + rnd() * 6800), position,
        share: status === 'cited' ? r2(1 / citations.length) : 0, sentiment: status === 'named' || (status === 'cited' && qi % 2 === 0) ? r2(0.55 + 0.35 * rnd()) : N,
        citations, brands, excerpt, error: status === 'failed' ? (rnd() < 0.5 ? 'Времето за отговор изтече (30 с)' : 'Лимитът на заявките е изчерпан (429)') : N,
      });
    });
  }
  return out;
}

/** Who the engines cite for each question (never us) and which engines cite or name us. */
function withAi(questions: readonly BuyerQuestion[], answers: readonly AnswerRecord[]): BuyerQuestion[] {
  return questions.map((q) => {
    const mine = answers.filter((a) => a.questionId === q.id);
    const counts = new Map<string, number>();
    for (const a of mine) for (const c of a.citations) if (c.domain !== DOMAIN) counts.set(c.domain, (counts.get(c.domain) ?? 0) + 1);
    const aiCites = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([d]) => d);
    return { ...q, aiCites, citedBy: ENGINES.filter((e) => mine.some((a) => a.engine === e && (a.status === 'cited' || a.status === 'named'))) };
  });
}

function buildEngines(answers: readonly AnswerRecord[]): EngineRun[] {
  return ENGINES.map((engine) => {
    const mine = answers.filter((a) => a.engine === engine);
    const failed = mine.filter((a) => a.status === 'failed').length;
    const answered = mine.length - failed;
    const citing = mine.filter((a) => a.status === 'cited' || a.status === 'named').length;
    const counts = new Map<string, number>();
    for (const a of mine) for (const d of new Set(a.citations.map((c) => c.domain))) counts.set(d, (counts.get(d) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const instead = top.find(([d]) => d !== DOMAIN);
    const [rateLow, rateHigh] = wilson(citing, answered);
    return {
      engine, label: ENGINE_LABELS[engine], model: MODELS[engine], search: true, asked: mine.length, answered, failed, citingUs: citing, skippingUs: answered - citing,
      rate: r3(citing / answered), rateLow, rateHigh, citedInstead: instead ? { domain: instead[0], answers: instead[1] } : N,
      topCited: top.slice(0, 8).map(([domain, n]) => ({ domain, answers: n, share: r3(n / answered) })),
      usage: { calls: mine.length, inputTokens: mine.length * 1450, outputTokens: mine.length * 720, searches: mine.length * 2, estimatedCostUsd: ENGINE_COST[engine] },
    };
  });
}

function buildSkips(questions: readonly BuyerQuestion[], answers: readonly AnswerRecord[], pages: readonly SitePage[]): SkipAnalysis[] {
  return SKIP_ROWS.map(([engine, qi, winner, reasons]) => {
    const q = must(questions[qi], `question ${qi}`);
    const page = pages.find((p) => p.url === q.bestPage);
    const cited = must(answers.find((a) => a.engine === engine && a.questionId === q.id), 'answer').citations.find((c) => c.domain === winner);
    return {
      engine, questionId: q.id, question: q.text,
      ourPage: page
        ? { url: page.url, exists: true, words: page.words, ageMonths: page.ageMonths, detail: page.citability ? { criteria: page.criteria, score10: Math.round(page.citability.now * 100) / 10 } : N }
        : { url: N, exists: false, words: N, ageMonths: N, detail: N },
      winner: cited ? { domain: winner, url: cited.url, kind: site(winner).kind } : N, reasons: [...reasons], action: page ? 'rewrite' : 'create',
    };
  });
}

// engine, source, answers citing it, why it is cited, radar (answer, entity, faq, author, fresh, sources), score 0..10, words
type WinnerRow = readonly [engine: EngineId, domain: string, citedIn: number, why: readonly string[], radar: readonly [number, number, number, number, number, number], score10: number, words: number];
const WINNER_ROWS: readonly WinnerRow[] = [
  ['openai', 'digital-blog.example', 6, ['Отговор в първите 40 думи', 'Таблица за сравнение на 5 агенции', 'Контролен списък с 12 точки', 'Обновена преди 2 месеца'], [0.9, 0.7, 0.8, 0.7, 0.9, 0.6], 8.1, 1960],
  ['anthropic', 'pixel-studio.example', 5, ['Цена „от“ и срок в първите изречения', 'Service и FAQPage schema', 'Три отзива с име и фирма', 'Вътрешни връзки от 14 страници'], [0.85, 0.8, 0.75, 0.8, 0.7, 0.75], 7.8, 2100],
  ['gemini', 'forum-programisti.example', 4, ['Реални цени от хора, поръчвали сайт', 'Отговори с дата и опит', 'Кратки конкретни числа'], [0.6, 0.8, 0.2, 0.3, 0.5, 0.1], 5.2, 640],
  ['openai', 'top-agencii.example', 4, ['Таблица със цени и срокове', 'Критерии за избор над таблицата', 'Обновявана всеки квартал'], [0.7, 0.85, 0.3, 0.4, 0.8, 0.5], 6.4, 1480],
  ['anthropic', 'biznes-gov.example', 3, ['Държавен портал — авторитетен източник', 'Определения и стъпки с препратки', 'Обновена преди 3 месеца'], [0.75, 0.6, 0.5, 0.95, 0.75, 0.9], 7.4, 3200],
];

function buildWinners(): WinnerPage[] {
  return WINNER_ROWS.map(([engine, domain, citedIn, whyCited, r, score10, words]) => ({
    engine, domain, url: `https://${domain}${site(domain).path}`, title: site(domain).title, kind: site(domain).kind, citedIn, whyCited: [...whyCited],
    radar: { answer: r[0], entity: r[1], faq: r[2], author: r[3], fresh: r[4], sources: r[5] }, score10, words,
  }));
}

// ───────────────────────── competitor pages (panel 02) ─────────────────────────
// domain, phrase, our page that competes, Google rank, type, scores (answer, depth, proof, schema, fresh), verdict, why, techniques.

type Five = readonly [number | null, number | null, number | null, number | null, number | null];
type CompetitorRow = readonly [domain: string, phrase: string, ours: string | null, rank: number | null, type: PageType | null, scores: Five, verdict: 'steal' | 'skip', why: string, techniques: readonly string[]];
const COMPETITOR_ROWS: readonly CompetitorRow[] = [
  ['pixel-studio.example', 'изработка на уебсайт', '/uslugi/izrabotka-na-sait', 1, 'service_page', [0.9, 0.85, 0.8, 0.9, 0.75], 'steal', 'Отговаря с цена и срок още в първите изречения и подкрепя твърденията с отзиви', ['Цена „от“ и срок в първите 40 думи', 'Таблица „пакет · цена · срок“', 'FAQPage schema с 8 въпроса', 'Три отзива с име, фирма и резултат']],
  ['seo-pro.example', 'изработка на уебсайт и seo', '/uslugi/seo-optimizaciya', 2, 'service_page', [0.8, 0.7, 0.75, 0.85, 0.5], 'steal', 'Комбинира уебсайт и SEO в един пакет и показва резултати на клиенти', ['Резултати „преди/след“ с числа', 'Service и Review schema', 'Пакет „уебсайт + SEO“ с обща цена']],
  ['webmasters-bg.example', 'изработка на сайт', '/uslugi/izrabotka-na-sait', 3, 'service_page', [0.7, 0.65, 0.6, 0.55, 0.6], 'steal', 'Показва три пакета с цени и какво включва всеки', ['Три пакета в таблица с цена „от“', 'Срок за всеки пакет', 'Бутон „Заяви оферта“ след всеки пакет']],
  ['digital-blog.example', 'как да избера фирма за уебсайт', '/blog/kak-da-izberem-firma-za-sait', 5, 'blog_article', [0.85, 0.9, 0.7, 0.6, 0.8], 'steal', 'Контролен списък и сравнителна таблица, които ИИ цитира директно', ['Отговор в първите 40 думи', 'Контролен списък с 12 точки', 'Таблица за сравнение на 5 агенции', 'Дата на обновяване над статията']],
  ['magazin-expert.example', 'онлайн магазин по поръчка', '/uslugi/onlain-magazin', 7, 'service_page', [0.65, 0.7, 0.55, 0.6, 0.7], 'steal', 'Сравнява платформите за магазин по цена и интеграции', ['Таблица „платформа · цена · интеграции“', 'Списък с интеграции с куриери и плащания', 'Цена и срок по етапи']],
  ['top-agencii.example', 'топ фирми за изработка на сайт', N, 6, 'comparison_listicle', [0.6, 0.55, 0.35, 0.5, 0.7], 'skip', 'Класация, в която агенциите плащат за място — доверието е слабо', ['Таблица с критерии за избор']],
  ['firmi-bg.example', 'изработка на уебсайт', N, 4, 'directory_marketplace', [0.35, 0.3, 0.4, 0.2, 0.5], 'skip', 'Каталог с обяви — няма съдържание, което да копираме', []],
  ['forum-programisti.example', 'колко струва уебсайт', '/blog/kolko-struva-sait', 8, 'forum_or_social', [0.5, 0.45, 0.3, 0, 0.4], 'skip', 'Форумна тема: ценна заради реални цени, но не е техника, която да копираме', ['Реални цени от клиенти с дата']],
  ['sait-ot-nulata.example', 'изработка на уебсайт', '/', 11, 'company_homepage', [0.25, 0.2, 0.15, 0.1, 0.3], 'skip', 'Тънка страница без цени и доказателства — няма какво да научим', []],
  ['fabrika-za-saitove.example', 'изработка на сайтове', N, 16, N, [N, N, N, N, N], 'skip', 'Страницата не се чете без JavaScript — не може да бъде оценена', []],
];

/** Weighted by COMPETITOR_PAGE_WEIGHTS over the scores that exist; a verdict of "steal" goes with an overall at or above STEAL_AT (checked in the test). */
function overallOf(s: Five): number | null {
  const w = [COMPETITOR_PAGE_WEIGHTS.answer, COMPETITOR_PAGE_WEIGHTS.depth, COMPETITOR_PAGE_WEIGHTS.proof, COMPETITOR_PAGE_WEIGHTS.schema, COMPETITOR_PAGE_WEIGHTS.fresh];
  const have = s.flatMap((v, i) => (v === N ? [] : [{ v, w: must(w[i], 'weight') }]));
  const total = have.reduce((a, b) => a + b.w, 0);
  return total === 0 ? N : r2(have.reduce((a, b) => a + b.v * b.w, 0) / total);
}

function buildCompetitors(answers: readonly AnswerRecord[]): CompetitorPage[] {
  const answered = answers.filter((a) => a.status !== 'failed');
  return COMPETITOR_ROWS.map(([domain, phrase, ours, rank, type, s, verdict, why, techniques]) => ({
    domain, url: `https://${domain}${site(domain).path}`, title: site(domain).title, phrase, ourUrl: ours === N ? N : ORIGIN + ours, googleRank: rank,
    aiShare: r2(answered.filter((a) => a.citations.some((c) => c.domain === domain)).length / answered.length), type,
    scores: { answer: s[0], depth: s[1], proof: s[2], schema: s[3], fresh: s[4] },
    overall: overallOf(s),
    verdict, why, techniques: [...techniques],
  }));
}

// ───────────────────────── the plan ─────────────────────────
// id, kind, our page (rewrite) or suggested path (create), title, question indexes, engines, priority, checklist [step, why], written by.

type PlanRow = readonly [id: string, kind: 'create' | 'rewrite', where: string, title: string, questions: readonly number[], engines: readonly EngineId[], priority: number, steps: ReadonlyArray<readonly [string, string]>, by: 'rules' | 'llm'];
const PLAN_ROWS: readonly PlanRow[] = [
  ['wix-vs-custom', 'create', '/blog/wix-ili-sait-po-poruchka', 'Wix или сайт по поръчка: сравнение за малък бизнес', [7, 13, 1], ['openai', 'anthropic', 'gemini'], 0.92, [
    ['Прочети страницата, която ИИ цитира най-често за този въпрос', 'Виж как отговаря и какво показва в първите 40 думи'],
    ['Отговори на въпроса в първите 40 думи', 'ИИ взима отговора от началото на страницата'],
    ['Добави таблица „Wix · WordPress · сайт по поръчка“ с цена, срок и ограничения', 'Таблиците се цитират най-често в сравнения'],
    ['Добави 6 въпроса и отговора с FAQPage schema', 'Така ИИ намира готови формулировки'],
    ['Цитирай 3 източника с връзки', 'Страниците с източници изглеждат по-надеждни'],
    ['Свържи статията от /tsenoraz и /uslugi/izrabotka-na-sait', 'Вътрешните връзки показват, че страницата е част от темата'],
  ], 'llm'],
  ['prices', 'rewrite', '/tsenoraz', 'Ценоразпис: цена на уебсайт, онлайн магазин и SEO', [8, 14, 20], ['openai', 'gemini'], 0.81, [
    ['Започни страницата с цени „от“ за всеки пакет', 'Купувачът и ИИ търсят число, а не описание'],
    ['Добави таблица „пакет · цена · срок · какво включва“', 'Таблицата е най-лесното нещо за цитиране'],
    ['Отговори за месечната такса за поддръжка и SEO', 'Три от въпросите питат точно за това'],
    ['Добави Offer schema за всеки пакет', 'Структурираните цени се четат от машини'],
    ['Добави „цените са актуални към“ и дата', 'ИИ предпочита скорошни цени'],
  ], 'llm'],
  ['local-pages', 'create', '/uslugi/izrabotka-na-sait-plovdiv', 'Изработка на уебсайт в Пловдив и Варна', [11, 17, 5], ['openai', 'anthropic'], 0.64, [
    ['Създай отделна страница за всеки град', 'Местните въпроси търсят страница за конкретния град'],
    ['Започни с отговор: какво предлагате в града и от каква цена', 'ИИ цитира първите изречения'],
    ['Добави адрес, телефон и работно време с LocalBusiness schema', 'Така градът се свързва с фирмата'],
    ['Покажи 2 проекта на клиенти от града с резултат', 'Местните доказателства вдъхват доверие'],
    ['Свържи от началната страница и от /kontakti', 'Нова страница без връзки не се открива'],
  ], 'rules'],
  ['about', 'rewrite', '/za-nas', 'За нас: екип, опит и клиенти на Моето студио', [3, 21], ['openai', 'anthropic', 'gemini'], 0.55, [
    ['Покажи екипа с имена, роли и опит', 'ИИ проверява кой стои зад сайта'],
    ['Добави 3 отзива с име, фирма и резултат', 'Въпросите за доверие търсят доказателства'],
    ['Добави числа: от кога работите, колко проекта и клиенти', 'Конкретните факти се цитират'],
    ['Добави Organization и Person schema', 'Машините разпознават фирмата и хората'],
    ['Сложи дата на последна промяна', 'Страницата е на над две години'],
  ], 'rules'],
  ['shop', 'rewrite', '/uslugi/onlain-magazin', 'Онлайн магазин по поръчка: цена, срок и пример', [6, 8], ['anthropic', 'gemini'], 0.47, [
    ['Отговори с цена „от“ и срок в първите 40 думи', 'Купувачите питат за цена и срок'],
    ['Добави таблица с платформи и интеграции (куриери, плащания)', 'Конкурентите сравняват платформите'],
    ['Покажи един завършен магазин с числа за поръчки', 'Доказателствата липсват'],
    ['Свържи със /tsenoraz и /portfolio', 'Страницата има само 3 вътрешни връзки'],
  ], 'llm'],
];

function buildPlan(questions: readonly BuyerQuestion[], pages: readonly SitePage[]): FixPlan[] {
  return PLAN_ROWS.map(([id, kind, where, title, qs, engines, priority, steps, by]) => {
    const page = kind === 'rewrite' ? pages.find((p) => p.path === where) : undefined;
    return {
      id, kind, url: kind === 'rewrite' ? ORIGIN + where : N, suggestedPath: kind === 'create' ? where : N, title, questions: qs.map((i) => must(questions[i], `question ${i}`).text), engines: [...engines], priority,
      citability: page?.citability ? { now: page.citability.now, after: r2(Math.min(0.92, page.citability.now + 0.34)) } : N,
      checklist: steps.map(([text, why], i) => ({ id: `${id}-${i + 1}`, text, why })), writtenBy: by,
    };
  });
}

// ───────────────────────── the report ─────────────────────────

export function sampleSiteAudit(): SiteAuditReport {
  const elements = buildElements(PAGE_ORDER);
  const pages = buildPages(elements);
  const baseQuestions = buildQuestions();
  const answers = buildAnswers(baseQuestions, pages);
  const questions = withAi(baseQuestions, answers);
  const engines = buildEngines(answers);
  const competitorPages = buildCompetitors(answers);
  const judged = pages.flatMap((p) => (p.citability ? [p.citability] : []));
  const mean = (xs: readonly number[]): number | null => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : N);
  return {
    version: 1, id: SAMPLE_AUDIT_ID, kind: 'site', status: 'complete', mode: 'demo', createdAt: CREATED, finishedAt: new Date(Date.parse(CREATED) + DURATION_MS).toISOString(),
    request: {
      domain: DOMAIN, market: 'bg', businessDescription: 'Малко студио в България, което изработва уебсайтове и онлайн магазини за малък и среден бизнес и предлага SEO оптимизация и поддръжка.',
      brandNames: [BRAND, 'My Studio', DOMAIN], competitors: ['pixel-studio.example', 'webmasters-bg.example', 'seo-pro.example', 'firmi-bg.example', 'digital-blog.example', 'forum-programisti.example'],
      options: { maxPages: 40, competitorPages: 12, questions: 24, engines: [...ENGINES], rankChecks: 10 },
    },
    providers: { serp: 'demo', jev: { model: 'jev-demo (mock)', endpoint: 'demo (без мрежа)' }, engines: ENGINES.map((engine) => ({ engine, model: MODELS[engine], search: true })), writer: MODELS.anthropic },
    usage: { jevRequests: 260, jevInputTokens: 390_000, jevOutputTokens: 52_000, jevFailures: 2, estimatedJevCostUsd: 0.02, serpCalls: 18, pagesFetched: 22, pagesFailed: 2, engineCalls: answers.length, estimatedEngineCostUsd: N, writerCalls: 11, durationMs: DURATION_MS },
    site: { domain: DOMAIN, pagesFound: pages.length, pagesAudited: pages.length, source: 'sitemap', truncated: false },
    pages, elements, competitorPages, questions,
    geo: { engines, answers, skips: buildSkips(questions, answers, pages), winners: buildWinners() },
    plan: buildPlan(questions, pages),
    figures: {
      elementsToChange: elements.filter((e) => e.verdict === 'change').length, elementsTotal: elements.length,
      pagesToSteal: competitorPages.filter((c) => c.verdict === 'steal').length, competitorPagesTotal: competitorPages.length,
      questionsNoPage: questions.filter((q) => q.verdict === 'no_page').length, questionsTotal: questions.length,
      citabilityNow: mean(judged.map((c) => c.now)), citabilityAfter: mean(judged.map((c) => c.after)), citationRate: mean(engines.map((e) => e.rate)),
    },
    warnings: ['Страницата /stari-ceni върна грешка 404 и не е оценена.', 'Gemini не отговори на 3 от 9 въпроса (лимит на заявките) — резултатът за него е по-малко сигурен.'],
  };
}

/** What GET /api/audits returns: this audit and two older ones (newest first). */
export function sampleAuditList(): SiteAuditListItem[] {
  const a = sampleSiteAudit();
  return [
    { id: a.id, domain: a.site.domain, market: a.request.market, mode: a.mode, status: a.status, createdAt: a.createdAt, pagesAudited: a.site.pagesAudited, figures: a.figures },
    { id: 'a_old7m2k9q4x1', domain: DOMAIN, market: 'bg', mode: 'demo', status: 'partial', createdAt: '2026-09-21T14:40:00.000Z', pagesAudited: 9, figures: { elementsToChange: 31, elementsTotal: 44, pagesToSteal: 3, competitorPagesTotal: 8, questionsNoPage: 11, questionsTotal: 24, citabilityNow: 0.31, citabilityAfter: 0.49, citationRate: N } },
    { id: 'a_cvetya0d5r8w', domain: 'cvetya-bg.example', market: 'bg', mode: 'live', status: 'complete', createdAt: '2026-08-30T08:05:00.000Z', pagesAudited: 27, figures: { elementsToChange: 58, elementsTotal: 140, pagesToSteal: 6, competitorPagesTotal: 12, questionsNoPage: 5, questionsTotal: 20, citabilityNow: 0.52, citabilityAfter: 0.67, citationRate: 0.4 } },
  ];
}
