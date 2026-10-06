import type { FetchedPage, PageFetcher, TextResult } from '../crawl/fetcher';
import type { SerpData } from '../../shared/schemas';
import { createDemoEngines } from '../geo/engines/demo';
import type { AnswerEngine } from '../geo/engines/types';
import { fnv1a } from '../util/hash';
import { buildSerpData, domainOf, type CallOptions, type SerpProvider, type SerpQuery, type VolumeProvider } from '../providers/serp/types';
import { FAQ, REVIEWS, SUBTOPICS, type SubtopicId } from './content';
import { createDemoWorld, DEMO_BUSINESS, DEMO_OWN_DOMAIN, SITES } from './world';

// The demo's "own site": a fictional small web studio with fourteen pages, each with a few believable flaws — a
// missing title, a duplicated one, a thin about page, a stale article, an FAQ without schema, a page marked noindex —
// so every panel of the audit has something to show. Everything is fictional and deterministic; all domains end in
// ".example" and can never resolve.

export const DEMO_SITE_BRAND = 'Моето студио';
export const DEMO_AUDIT_DEFAULTS = {
  domain: DEMO_OWN_DOMAIN,
  brandNames: [DEMO_SITE_BRAND, 'My Studio'],
  competitors: ['pixel-studio.example', 'webmasters-bg.example', 'seo-pro.example', 'firmi-bg.example'],
  businessDescription: DEMO_BUSINESS,
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const p = (xs: readonly string[]): string => xs.map((x) => `<p>${esc(x)}</p>`).join('');
const h2 = (text: string): string => `<h2>${esc(text)}</h2>`;

function section(id: SubtopicId, version: 'strong' | 'generic'): string {
  const t = SUBTOPICS[id];
  const text = version === 'strong' && t.strong.length > 0 ? t.strong : t.generic;
  return `${h2(t.headings[0] as string)}${p(text)}`;
}

interface OwnPage {
  path: string;
  title?: string;
  description?: string;
  h1: string;
  body: string;
  /** JSON-LD graph nodes (without @context). */
  schema?: Array<Record<string, unknown>>;
  noindex?: boolean;
  canonical?: string | null;
  /** Show the full navigation (a bare page has only the logo). */
  nav?: boolean;
  /** Google position of the page for its main phrase in the demo SERP; absent = not in the top 20. */
  rank?: number;
}

const NAV: ReadonlyArray<readonly [string, string]> = [
  ['Начало', '/'],
  ['Услуги', '/izrabotka-na-sait'],
  ['Цени', '/tseni'],
  ['Портфолио', '/portfolio'],
  ['Блог', '/blog/kolko-struva-sait'],
  ['За нас', '/za-nas'],
  ['Контакти', '/kontakti'],
];

const CONTACT_FOOTER = `<p>${DEMO_SITE_BRAND} ЕООД, ЕИК 987654321. гр. София, ул. Раковски 42. Тел: <a href="tel:+359888123456">+359 888 123 456</a>, <a href="mailto:hello@${DEMO_OWN_DOMAIN}">hello@${DEMO_OWN_DOMAIN}</a></p>`;
const FORM = '<form action="/send" method="post"><input type="text" name="name"><input type="email" name="email"><input type="tel" name="phone"><textarea name="message"></textarea><input type="submit" value="Изпрати запитване"></form>';
const imgs = (n: number, withAlt: number): string => Array.from({ length: n }, (_, i) => `<img src="/img/${i}.jpg" ${i < withAlt ? `alt="Проект ${i + 1}: уебсайт на клиент"` : ''}>`).join('');
const faqSection = (n: number): string => `${h2('Често задавани въпроси')}${FAQ.slice(0, n).map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('')}`;
const faqSchema = (n: number): Record<string, unknown> => ({ '@type': 'FAQPage', mainEntity: FAQ.slice(0, n).map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
const table = (rows: ReadonlyArray<readonly string[]>): string => `<table>${rows.map((r, i) => `<tr>${r.map((c) => `<${i === 0 ? 'th' : 'td'}>${esc(c)}</${i === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</table>`;

function pagesFor(now: Date): OwnPage[] {
  const monthsAgo = (m: number): string => new Date(now.getTime() - m * 30.44 * 24 * 3_600_000).toISOString().slice(0, 10);
  const author = { '@type': 'Person', name: 'Георги Иванов' };

  return [
    {
      path: '/',
      title: 'Моето студио – уеб дизайн и сайтове',
      description: 'Моето студио изработва уебсайтове и онлайн магазини за малък и среден бизнес в България – със SEO оптимизация и поддръжка. Поискайте безплатна оферта.',
      h1: 'Уебсайтове и онлайн магазини за малък бизнес',
      nav: true,
      rank: 8,
      schema: [{ '@type': 'Organization', name: DEMO_SITE_BRAND, url: `https://${DEMO_OWN_DOMAIN}/` }],
      body:
        p(['Добре дошли в Моето студио! Ние сме екип от професионалисти, които обичат да създават красиви сайтове за вашия бизнес.']) +
        h2('Какво правим') +
        '<ul><li>Изработка на уебсайт</li><li>Онлайн магазини</li><li>SEO оптимизация</li><li>Поддръжка на сайт</li></ul>' +
        p(['Работим с малки и средни фирми от цялата страна. Всеки проект започва с разговор за вашите цели.']) +
        imgs(2, 2) +
        '<a href="/kontakti">Поискайте безплатна оферта</a>',
    },
    {
      path: '/izrabotka-na-sait',
      title: 'Изработка на уебсайтове | Моето студио',
      description: 'Правим сайтове за малък бизнес.',
      h1: 'Изработка на уебсайт',
      nav: true,
      rank: 12,
      body: p(['Правим сайтове за малък бизнес с WordPress.', 'Работим бързо и коректно.']) + section('process', 'generic') + section('portfolio', 'generic') + '<a href="/kontakti">Свържете се с нас</a>',
    },
    {
      path: '/uslugi/onlain-magazin',
      // no <title> and no meta description on purpose
      h1: 'Изработка на онлайн магазин',
      nav: true,
      body: p(['Изработваме онлайн магазини за малки и средни фирми.']) + section('ecommerce', 'strong') + imgs(2, 0),
    },
    {
      path: '/uslugi/seo-optimizatsiya',
      title: 'Услуги за уебсайтове | Моето студио',
      description: 'Оптимизираме сайтове за търсачките.',
      h1: 'SEO оптимизация на сайт',
      nav: true,
      rank: 11,
      schema: [{ '@type': 'Service', name: 'SEO оптимизация', provider: { '@type': 'Organization', name: DEMO_SITE_BRAND } }],
      body: p(['Помагаме на сайта ви да се покаже в Google, когато клиентите търсят това, което предлагате.']) + section('seo', 'strong') + section('hosting', 'strong') + '<a href="/tseni">Вижте цените</a>',
    },
    {
      path: '/uslugi/podrazhka',
      title: 'Услуги за уебсайтове | Моето студио',
      description: 'Месечна поддръжка на сайтове: резервни копия, обновления и мониторинг на достъпността, с реакция в рамките на четири работни часа.',
      h1: 'Поддръжка на уебсайт',
      nav: true,
      body: p(['Поддръжката започва от 49 лв. на месец.']) + section('maintenance', 'strong') + section('responsive', 'strong'),
    },
    {
      path: '/tseni',
      title: 'Цени за изработка на уебсайт 2026 – от 490 лв.',
      description: 'Колко струва изработката на уебсайт: представителен сайт от 490 лв., корпоративен от 990 лв., онлайн магазин от 1 490 лв. Фиксирана цена, без скрити такси.',
      h1: 'Цени за изработка на уебсайт',
      nav: true,
      rank: 4,
      schema: [{ '@type': 'Service', name: 'Изработка на уебсайт' }, { '@type': 'WebPage', dateModified: monthsAgo(2) }, faqSchema(4)],
      body:
        p(['Изработката на уебсайт при нас струва от 490 лв. за представителен сайт, от 990 лв. за корпоративен и от 1 490 лв. за онлайн магазин. Цената е фиксирана и без скрити такси.']) +
        h2('Пакети и цени') +
        table([['Пакет', 'От', 'Срок', 'Включва'], ['Представителен сайт', '490 лв.', '2–3 седмици', 'до 5 страници, хостинг за година'], ['Корпоративен сайт', '990 лв.', '4–6 седмици', 'до 15 страници, SEO основа'], ['Онлайн магазин', '1 490 лв.', '6–10 седмици', 'каталог, плащане с карта, куриери']]) +
        section('pricing', 'strong') +
        section('timeline', 'strong') +
        section('included', 'strong') +
        section('process', 'strong') +
        section('responsive', 'strong') +
        section('hosting', 'strong') +
        faqSection(4) +
        `<h2>Отзиви на клиенти</h2>${p(REVIEWS)}` +
        '<a href="/kontakti">Заяви безплатна оферта</a><a href="/portfolio">Виж портфолиото</a><a href="/blog/kolko-struva-sait">Прочети ръководството</a>' +
        imgs(3, 3),
    },
    {
      path: '/za-nas',
      title: 'За нас | Моето студио',
      h1: 'За нас',
      nav: true,
      body: p(['Ние сме малко студио за уеб дизайн.', 'Работим с клиенти от цялата страна и обичаме да създаваме сайтове.']),
    },
    {
      path: '/blog/kolko-struva-sait',
      title: 'Колко струва изработката на сайт през 2026: пълно ръководство | Моето студио',
      description: 'Какво определя цената на един сайт, колко е реалистично да платите и как да сравните офертите. Ориентировъчни цени за визитка, фирмен сайт и онлайн магазин.',
      h1: 'Колко струва изработката на сайт',
      nav: true,
      rank: 6,
      schema: [{ '@type': 'Article', headline: 'Колко струва изработката на сайт', datePublished: monthsAgo(21), dateModified: monthsAgo(19), author }],
      body:
        p(['Изработката на сайт струва между 300 и 5 000 лв., а за повечето малки фирми реалистичната цена е 500 до 1 500 лв. Ето от какво зависи и как да не платите повече от нужното.']) +
        '<p>Автор: Георги Иванов, уеб разработчик с девет години опит.</p>' +
        section('pricing', 'strong') +
        h2('Ориентировъчни цени') +
        table([['Тип сайт', 'Цена', 'Срок'], ['Визитка', '300–600 лв.', '1–2 седмици'], ['Фирмен сайт', '700–1 500 лв.', '3–5 седмици'], ['Онлайн магазин', '1 500–5 000 лв.', '6–10 седмици']]) +
        section('included', 'strong') +
        section('hosting', 'strong') +
        section('maintenance', 'strong') +
        section('timeline', 'strong') +
        section('process', 'strong') +
        faqSection(3) +
        '<a href="/tseni">Вижте нашите цени</a><a href="https://stat.bg.example/it-uslugi">Данни за пазара</a><a href="https://digital-blog.example/ceni">Сравнение на цени</a><a href="https://konsumator-bg.example/uslugi">Съвети за потребители</a>',
    },
    {
      path: '/blog/wordpress-ili-individualen-sait',
      title: 'WordPress или индивидуален сайт: кое е по-добро?',
      description: 'Сравнение на WordPress и индивидуално разработен сайт по цена, скорост, сигурност и гъвкавост — и кога кое се препоръчва за малък бизнес.',
      h1: 'WordPress или индивидуален сайт',
      nav: true,
      rank: 9,
      schema: [{ '@type': 'Article', headline: 'WordPress или индивидуален сайт', datePublished: monthsAgo(2), dateModified: monthsAgo(1), author }, faqSchema(3)],
      body:
        p(['За повечето малки фирми WordPress е по-добрият избор: по-евтин е, по-бърз за пускане и се редактира лесно. Индивидуален сайт има смисъл при нестандартна логика или голям трафик.']) +
        '<p>Автор: Георги Иванов, уеб разработчик.</p>' +
        h2('Сравнение накратко') +
        table([['Критерий', 'WordPress', 'Индивидуален сайт'], ['Цена', 'от 490 лв.', 'от 3 000 лв.'], ['Срок', '2–4 седмици', '2–4 месеца'], ['Гъвкавост', 'добра, с приставки', 'пълна'], ['Поддръжка', 'обновления на приставки', 'зависи от разработчика']]) +
        '<ul><li>По-ниска начална цена</li><li>Богата екосистема от приставки</li><li>Лесно редактиране без програмист</li></ul>' +
        section('tech', 'strong') +
        section('responsive', 'strong') +
        section('hosting', 'strong') +
        section('included', 'strong') +
        section('maintenance', 'strong') +
        faqSection(3) +
        '<a href="/tseni">Вижте цените</a><a href="https://wordpress.org.example/about">Какво е WordPress</a><a href="https://digital-blog.example/cms">Сравнение на CMS</a>',
    },
    {
      path: '/blog/kak-da-izberem-firma-za-sait',
      title: 'Как да изберем фирма за изработка на сайт',
      description: 'Седем критерия, по които да сравните фирмите за изработка на сайт, преди да поръчате: портфолио, цена, договор, срокове, поддръжка и собственост.',
      h1: 'Как да изберем фирма за изработка на сайт',
      nav: true,
      schema: [{ '@type': 'Article', headline: 'Как да изберем фирма', datePublished: monthsAgo(22) }],
      body:
        p(['Изборът на фирма за сайт е по-важен от самата технология. Ето седем критерия, които да проверите, преди да подпишете договор.']) +
        ['Портфолио и референции', 'Прозрачна цена', 'Договор и срокове', 'Поддръжка след пускане', 'Собственост върху сайта', 'Технологии', 'Отзиви от клиенти']
          .map((h, i) => `<h2>${i + 1}. ${esc(h)}</h2>${p([`Обърнете внимание на ${h.toLowerCase()}: поискайте конкретни примери и писмено потвърждение.`, 'Не се доверявайте на общи обещания без числа и срокове. Попитайте как фирмата реагира, когато нещо не е наред, и какво е записано в договора за такива случаи.', 'Сравнете поне три оферти и ги подредете по едни и същи критерии, за да не сравнявате ябълки с круши.'])}`)
          .join('') +
        '<a href="/tseni">Вижте нашите цени</a>',
    },
    {
      path: '/chesto-zadavani-vaprosi',
      title: 'Често задавани въпроси за изработка на сайт | Моето студио',
      description: 'Отговори на най-честите въпроси за изработка на сайт: колко време отнема, какво включва цената, кой е собственик и може ли да го редактирате сами.',
      h1: 'Често задавани въпроси за изработка на сайт',
      nav: true,
      body: faqSection(4) + `${h2('Още въпроси')}<h3>Работите ли с клиенти извън София?</h3><p>Да, работим с клиенти от цялата страна по телефон и видеоразговор.</p><h3>Как плащам?</h3><p>На три вноски: 40% аванс, 40% при одобрение на дизайна и 20% при пускане.</p>`,
    },
    {
      path: '/portfolio',
      title: 'Портфолио | Моето студио',
      h1: 'Нашето портфолио',
      nav: true,
      body: p(['Разгледайте част от нашите проекти.']) + imgs(6, 0),
    },
    {
      path: '/kontakti',
      title: 'Контакти – Моето студио, София',
      description: 'Свържете се с Моето студио за безплатна консултация и оферта: телефон, имейл и адрес в София.',
      h1: 'Контакти',
      nav: false,
      body: p(['Пишете ни или се обадете и ще ви отговорим в рамките на един работен ден.']) + FORM,
    },
    {
      path: '/blog/seo-za-malak-biznes',
      title: 'SEO за малък бизнес: 7 стъпки | Моето студио',
      description: 'Седем практични стъпки за видимост в Google, които малък бизнес може да направи сам, без да плаща за агенция.',
      h1: 'SEO за малък бизнес: 7 стъпки',
      nav: true,
      noindex: true,
      canonical: `https://${DEMO_OWN_DOMAIN}/blog/kolko-struva-sait`,
      schema: [{ '@type': 'Article', headline: 'SEO за малък бизнес', dateModified: monthsAgo(8), author }],
      body: p(['Видимостта в Google започва от три неща: правилните фрази, ясни заглавия и полезно съдържание.']) + section('seo', 'strong') + section('process', 'strong'),
    },
  ];
}

function renderPage(page: OwnPage): string {
  const head = [
    page.title ? `<title>${esc(page.title)}</title>` : '',
    page.description ? `<meta name="description" content="${esc(page.description)}">` : '',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    page.canonical === undefined ? `<link rel="canonical" href="https://${DEMO_OWN_DOMAIN}${page.path}">` : page.canonical ? `<link rel="canonical" href="${esc(page.canonical)}">` : '',
    page.noindex ? '<meta name="robots" content="noindex,follow">' : '',
    page.schema ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': page.schema })}</script>` : '',
  ].join('');
  const nav = page.nav === false ? '' : `<nav>${NAV.map(([label, href]) => `<a href="${href}">${esc(label)}</a>`).join(' ')}</nav>`;
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">${head}</head><body><header>${nav}</header><main><h1>${esc(page.h1)}</h1>${page.body}</main><footer>${CONTACT_FOOTER}</footer></body></html>`;
}

/** Questions buyers ask that no page of the demo site covers, so the audit has gaps to find. */
const BEYOND_THE_SITE = [
  'Как да защитя сайта си от хакери?',
  'Какво е SSL сертификат и нужен ли ми е?',
  'Колко струва реклама в Google?',
  'Нужна ли е политика за бисквитките на сайта?',
  'Как се прави онлайн магазин с WooCommerce?',
  'Може ли сайтът да е на два езика?',
  'Колко струва домейн и хостинг на година?',
  'Как да добавя плащане с карта в сайта?',
  'Какво е CMS и коя да избера?',
  'Каква е разликата между уебсайт и онлайн магазин?',
];

const normalizePhrase = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface DemoSiteWorld {
  serp: SerpProvider;
  volume: VolumeProvider;
  fetcher: PageFetcher;
  engines: AnswerEngine[];
  /** Names the competitors go by in prose, for recognising them in AI answers. */
  brandHints: Record<string, string[]>;
  /** Every address of the demo site, for tests and for the sitemap. */
  urls: string[];
}

export function createDemoSiteWorld(options: { now?: () => Date } = {}): DemoSiteWorld {
  const clock = options.now ?? (() => new Date());
  const base = createDemoWorld();
  const origin = `https://${DEMO_OWN_DOMAIN}`;
  const pageByPath = (path: string): OwnPage | undefined => pagesFor(clock()).find((x) => x.path === path);
  const allPaths = pagesFor(clock()).map((x) => x.path);
  const urls = allPaths.map((x) => `${origin}${x}`);

  const own = (url: string): OwnPage | null => {
    try {
      const u = new URL(url);
      if (domainOf(url) !== DEMO_OWN_DOMAIN) return null;
      return pageByPath(u.pathname.replace(/\/+$/, '') || '/') ?? null;
    } catch {
      return null;
    }
  };

  const fetcher: PageFetcher = {
    async fetchPage(url: string): Promise<FetchedPage> {
      const page = own(url);
      if (!page) {
        if (domainOf(url) === DEMO_OWN_DOMAIN) return { status: 'http_error', httpStatus: 404, finalUrl: url, html: null, error: 'HTTP 404', ttfbMs: 80, bytes: null, fromCache: false };
        return base.fetcher.fetchPage(url);
      }
      const html = renderPage(page);
      return { status: 'ok', httpStatus: 200, finalUrl: url, html, error: null, ttfbMs: 90 + (fnv1a(url) % 400), bytes: html.length, fromCache: false };
    },
    async fetchText(url: string): Promise<TextResult> {
      const u = new URL(url);
      if (domainOf(url) === DEMO_OWN_DOMAIN && u.pathname === '/robots.txt') return { status: 'ok', httpStatus: 200, text: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, finalUrl: url, error: null };
      if (domainOf(url) === DEMO_OWN_DOMAIN && u.pathname === '/sitemap.xml') {
        const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((x) => `<url><loc>${x}</loc></url>`).join('')}</urlset>`;
        return { status: 'ok', httpStatus: 200, text: xml, finalUrl: url, error: null };
      }
      return { status: 'http_error', httpStatus: 404, text: null, finalUrl: url, error: 'HTTP 404' };
    },
  };

  // The base demo SERP knows the competitors; our own pages are slipped in at the position the page is "ranked" at.
  const serp: SerpProvider = {
    id: 'demo',
    async search(query: SerpQuery, callOptions?: CallOptions): Promise<SerpData> {
      const data = await base.serp.search(query, callOptions);
      const phrase = normalizePhrase(query.keyword);
      const hit = pagesFor(clock()).find((x) => x.rank !== undefined && normalizePhrase(x.h1) === phrase);
      const rows = data.results.filter((r) => r.domain !== DEMO_OWN_DOMAIN);
      if (hit?.rank !== undefined && hit.rank <= query.depth) {
        rows.splice(Math.min(hit.rank - 1, rows.length), 0, { position: 0, url: `${origin}${hit.path}`, domain: DEMO_OWN_DOMAIN, title: hit.title ?? hit.h1, snippet: hit.description ?? '' });
      }
      return buildSerpData({
        provider: 'demo',
        keyword: data.keyword,
        market: query.market,
        organic: rows.slice(0, query.depth).map((r, i) => ({ url: r.url, title: r.title, snippet: r.snippet, position: i + 1 })),
        peopleAlsoAsk: [...data.peopleAlsoAsk.map((q) => q.question), ...BEYOND_THE_SITE].map((question) => ({ question })),
        relatedSearches: data.relatedSearches,
        now: new Date(data.fetchedAt),
      });
    },
    async suggest(keyword: string) {
      return [`как да избера ${keyword}`, `колко време отнема ${keyword}`, `какво включва ${keyword}`, `${keyword} цена`, `${keyword} варна`];
    },
  };

  const competitors = SITES.filter((s) => s.domain !== DEMO_OWN_DOMAIN).map((s) => ({
    domain: s.domain,
    url: `https://${s.domain}${s.path}`,
    title: s.brand,
    kind: ({ agency_strong: 'brand', agency_mid: 'brand', shop_agency: 'brand', freelancer_thin: 'brand', boilerplate: 'brand', builder: 'brand', directory: 'compare', listicle: 'compare', forum: 'community', blog: 'guide', own: 'brand' } as const)[s.kind],
  }));

  return {
    serp,
    volume: base.volume,
    fetcher,
    engines: createDemoEngines({ ownDomain: DEMO_OWN_DOMAIN, brandNames: [...DEMO_AUDIT_DEFAULTS.brandNames], competitors, seed: 'demo-site' }),
    brandHints: Object.fromEntries(SITES.filter((s) => s.domain !== DEMO_OWN_DOMAIN).map((s) => [s.domain, [s.brand]])),
    urls,
  };
}
