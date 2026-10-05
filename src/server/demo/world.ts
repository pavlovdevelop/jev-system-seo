import type { FetchedPage, PageFetcher } from '../crawl/fetcher';
import type { Market } from '../../shared/markets';
import type { SerpData } from '../../shared/schemas';
import { fnv1a, mulberry32 } from '../util/hash';
import { buildSerpData, domainOf, type CallOptions, type KeywordVolume, type SerpProvider, type SerpQuery, type VolumeProvider } from '../providers/serp/types';
import { FAQ, FORUM_POSTS, GENERIC_FILLER, REVIEWS, SUBTOPICS, type SubtopicId } from './content';

// A fictional, deterministic corner of the Bulgarian web-agency market. Every domain ends in ".example"
// (a reserved TLD that can never resolve), so nothing here can be mistaken for a real business.

export type Kind =
  | 'agency_strong'
  | 'agency_mid'
  | 'shop_agency'
  | 'freelancer_thin'
  | 'boilerplate'
  | 'directory'
  | 'forum'
  | 'builder'
  | 'blog'
  | 'listicle'
  | 'own';

export interface Site {
  domain: string;
  brand: string;
  kind: Kind;
  path: string;
}

export const DEMO_OWN_DOMAIN = 'my-studio.example';
export const DEMO_KEYWORD = 'изработка на уебсайт';
export const DEMO_BUSINESS = 'Малко студио в България, което изработва уебсайтове и онлайн магазини за малък и среден бизнес и предлага SEO оптимизация и поддръжка.';

export const SITES: readonly Site[] = [
  { domain: 'pixel-studio.example', brand: 'Пиксел Студио', kind: 'agency_strong', path: '/uslugi/izrabotka-na-uebsait/' },
  { domain: 'webmasters-bg.example', brand: 'Уебмастърс', kind: 'agency_mid', path: '/izrabotka-na-sait' },
  { domain: 'seo-pro.example', brand: 'СЕО Про', kind: 'agency_strong', path: '/izrabotka-i-seo/' },
  { domain: 'nova-agenciya.example', brand: 'Нова агенция', kind: 'agency_mid', path: '/uebsait' },
  { domain: 'magazin-expert.example', brand: 'Магазин Експерт', kind: 'shop_agency', path: '/izrabotka-na-onlain-magazin' },
  { domain: 'sait-ot-nulata.example', brand: 'Сайт от нулата', kind: 'freelancer_thin', path: '/' },
  { domain: 'zaedno-dizain.example', brand: 'Заедно Дизайн', kind: 'freelancer_thin', path: '/' },
  { domain: 'fabrika-za-saitove.example', brand: 'Фабрика за сайтове', kind: 'boilerplate', path: '/izrabotka-na-saitove.html' },
  { domain: 'firmi-bg.example', brand: 'Фирми.бг', kind: 'directory', path: '/kategoria/izrabotka-na-saitove' },
  { domain: 'forum-programisti.example', brand: 'Форум Програмисти', kind: 'forum', path: '/t/kolko-struva-sait-12345' },
  { domain: 'build-your-site.example', brand: 'Build Your Site', kind: 'builder', path: '/' },
  { domain: 'digital-blog.example', brand: 'Дигитален блог', kind: 'blog', path: '/blog/kak-da-izberem-firma-za-sait' },
  { domain: 'top-agencii.example', brand: 'Топ агенции', kind: 'listicle', path: '/klasaciya/top-10-firmi-za-saitove' },
  { domain: 'portal-za-biznes.example', brand: 'Портал за бизнес', kind: 'blog', path: '/news/uebsait-za-malkiya-biznes' },
  { domain: DEMO_OWN_DOMAIN, brand: 'Моето студио', kind: 'own', path: '/izrabotka-na-sait' },
];

const siteByDomain = new Map(SITES.map((s) => [s.domain, s]));
const urlOf = (s: Site): string => `https://${s.domain}${s.path}`;
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ───────────────────────── page rendering ─────────────────────────

interface Doc {
  title: string;
  description?: string;
  head?: string;
  nav?: string[];
  body: string;
  footer?: string;
  viewport?: boolean;
}

function renderDoc(d: Doc): string {
  const nav = d.nav?.length ? `<nav>${d.nav.map((n) => `<a href="/${n.toLowerCase()}/">${esc(n)}</a>`).join(' ')}</nav>` : '';
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><title>${esc(d.title)}</title>${
    d.description ? `<meta name="description" content="${esc(d.description)}">` : ''
  }${d.viewport === false ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">'}${d.head ?? ''}</head><body><header>${nav}</header><main>${d.body}</main><footer>${d.footer ?? ''}</footer></body></html>`;
}

const paragraphs = (xs: readonly string[]): string => xs.map((x) => `<p>${esc(x)}</p>`).join('');

function section(id: SubtopicId, version: 'strong' | 'generic', siteIndex: number): string {
  const t = SUBTOPICS[id];
  const heading = t.headings[siteIndex % t.headings.length] as string;
  const text = version === 'strong' && t.strong.length > 0 ? t.strong : t.generic;
  return `<h2>${esc(heading)}</h2>${paragraphs(text)}`;
}

function jsonLd(types: string[]): string {
  const graph = types.map((t) => (t === 'FAQPage' ? { '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) } : { '@type': t, name: 'Demo' }));
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script>`;
}

function images(n: number, withAlt: number): string {
  return Array.from({ length: n }, (_, i) => `<img src="/img/${i}.jpg" ${i < withAlt ? `alt="Проект ${i + 1}: уебсайт"` : ''}>`).join('');
}

function contactFooter(site: Site, full: boolean): string {
  return full
    ? `<p>${esc(site.brand)} ЕООД, ЕИК 123456789. гр. София, ул. Витоша 15. Тел: <a href="tel:+359881234567">+359 88 123 4567</a>, <a href="mailto:hello@${site.domain}">hello@${site.domain}</a></p>`
    : `<p>Тел: <a href="tel:+359887654321">0887 654 321</a></p>`;
}

const contactForm = '<form action="/send" method="post"><input type="text" name="name"><input type="email" name="email"><input type="tel" name="phone"><textarea name="message"></textarea><input type="submit" value="Изпрати запитване"></form>';

function faqBlock(n: number, withHeadings = true): string {
  return `<h2>Често задавани въпроси</h2>${FAQ.slice(0, n).map(([q, a]) => `${withHeadings ? `<h3>${esc(q)}</h3>` : `<p><strong>${esc(q)}</strong></p>`}<p>${esc(a)}</p>`).join('')}`;
}

export function renderSite(site: Site, keyword: string): string {
  const kw = keyword;
  const K = cap(kw);
  const idx = fnv1a(site.domain);
  const nav = ['Начало', 'Услуги', 'Портфолио', 'За нас', 'Блог', 'Контакти'];

  switch (site.kind) {
    case 'agency_strong': {
      const ids: SubtopicId[] = ['pricing', 'process', 'timeline', 'included', 'seo', 'hosting', 'responsive', 'maintenance', 'portfolio', 'tech'];
      return renderDoc({
        title: `${K} – цени, срокове и примери | ${site.brand}`,
        description: `${K} за малък и среден бизнес: ясна цена от 490 лв., срок 2–4 седмици и безплатна консултация. Вижте нашето портфолио.`,
        head: jsonLd(['Organization', 'Service', 'FAQPage', 'BreadcrumbList']),
        nav,
        body:
          `<h1>${esc(K)} за вашия бизнес</h1>` +
          paragraphs([`${site.brand} изработва уебсайтове за малки и средни фирми в България вече над 8 години. Всеки проект започва с разговор за вашите цели и клиенти.`]) +
          ids.map((id, i) => section(id, 'strong', idx + i)).join('') +
          faqBlock(4) +
          `<h2>Отзиви на клиенти</h2>${paragraphs(REVIEWS)}` +
          images(6, 6) +
          `<a href="/kontakti/">Заяви безплатна оферта</a><a href="/portfolio/">Виж портфолиото</a><button>Свържи се с нас</button>${contactForm}` +
          `<a href="https://facebook.com/${site.domain}">Facebook</a>`,
        footer: contactFooter(site, true),
      });
    }
    case 'agency_mid': {
      const ids: SubtopicId[] = ['process', 'included', 'portfolio', 'responsive'];
      return renderDoc({
        title: `${K} | ${site.brand}`,
        description: `${site.brand} изработва сайтове за бизнеса. Свържете се с нас за оферта.`,
        head: jsonLd(['Organization']),
        nav,
        body:
          `<h1>${esc(K)}</h1>` +
          paragraphs([`${site.brand} е студио за уеб дизайн и разработка. Работим с фирми от различни браншове и изграждаме сайтове, които се зареждат бързо и се редактират лесно.`]) +
          ids.map((id, i) => section(id, 'strong', idx + i)).join('') +
          section('seo', 'generic', idx) +
          faqBlock(2, false) +
          images(3, 2) +
          `<a href="/kontakti/">Свържете се с нас</a>`,
        footer: contactFooter(site, false),
      });
    }
    case 'shop_agency': {
      const ids: SubtopicId[] = ['ecommerce', 'process', 'timeline', 'pricing', 'tech'];
      return renderDoc({
        title: `Изработка на онлайн магазин и ${kw} | ${site.brand}`,
        description: 'Онлайн магазини с плащане с карта, куриери и интеграция със склад.',
        head: jsonLd(['Organization', 'Service']),
        nav,
        body:
          `<h1>Изработка на онлайн магазин</h1>` +
          paragraphs([`${site.brand} се занимава само с онлайн търговия: от първия каталог до хиляди поръчки месечно.`]) +
          ids.map((id, i) => section(id, 'strong', idx + i)).join('') +
          section('portfolio', 'strong', idx) +
          images(4, 4) +
          `<a href="/kontakti/">Заяви оферта</a><button>Обадете ни се</button>${contactForm}`,
        footer: contactFooter(site, true),
      });
    }
    case 'freelancer_thin':
      return renderDoc({
        title: `${site.brand} – уеб дизайн и сайтове`,
        viewport: false,
        body: `<h1>Здравейте!</h1>${paragraphs([`Аз съм ${site.brand} и правя сайтове от 2016 г.`, 'Пишете ми за повече информация.'])}<a href="/kontakti/">Пишете ми</a>`,
        footer: contactFooter(site, false),
      });
    case 'boilerplate': {
      const stuffed = [kw, `${kw} цена`, `${kw} фирма`];
      return renderDoc({
        title: `${stuffed.join(', ')} | ${site.brand}`,
        head: '',
        nav: ['Начало', 'Контакти'],
        body:
          `<h1>${esc(K)} – ${esc(kw)} цена – ${esc(kw)} фирма</h1>` +
          [kw, `${kw}ове`, `цена на ${kw}`, `фирма за ${kw}`, 'защо да изберете нас']
            .map((h, i) => `<h2>${esc(cap(h))}</h2>${paragraphs([GENERIC_FILLER[i % GENERIC_FILLER.length] as string, `${K} е важна стъпка за всяка фирма. ${K} от ${site.brand} е най-доброто решение.`, GENERIC_FILLER[(i + 1) % GENERIC_FILLER.length] as string])}`)
            .join('') +
          section('whyus', 'generic', idx),
        footer: contactFooter(site, false),
      });
    }
    case 'directory': {
      const firms = SITES.filter((s) => ['agency_strong', 'agency_mid', 'shop_agency', 'boilerplate', 'freelancer_thin'].includes(s.kind));
      return renderDoc({
        title: `Фирми за ${kw} – каталог | ${site.brand}`,
        description: `Каталог с фирми за ${kw} в България. Сравнете по рейтинг и град.`,
        nav: ['Начало', 'Категории', 'Добавете фирма'],
        body:
          `<h1>Фирми за ${esc(kw)} в България</h1>${paragraphs([`Намерихме 124 фирми в категория „Изработка на сайтове“. Филтрирайте по град и рейтинг.`])}` +
          `<ul>${firms.map((f, i) => `<li><a href="https://${f.domain}/">${esc(f.brand)}</a> – София – рейтинг ${(4.8 - i * 0.2).toFixed(1).replace('.', ',')} (${32 - i * 3} отзива)</li>`).join('')}</ul>` +
          `<a href="/dobavete-firma">Добавете вашата фирма безплатно</a>`,
        footer: '',
      });
    }
    case 'forum':
      return renderDoc({
        title: `Тема: ${kw}? – ${site.brand}`,
        nav: ['Форум', 'Нови теми'],
        body: `<h1>Колко струва сайт за малка фирма?</h1>${FORUM_POSTS.map(([user, text]) => `<div class="post"><strong>${esc(user)}</strong>${paragraphs([text])}</div>`).join('')}<h2>Отговори (4)</h2>`,
        footer: '',
      });
    case 'builder':
      return renderDoc({
        title: `Създайте сайт безплатно с ${site.brand}`,
        description: 'Конструктор за сайтове: изберете шаблон и публикувайте за минути.',
        nav: ['Шаблони', 'Цени', 'Вход'],
        body: `<h1>Създайте професионален сайт за минути</h1>${paragraphs(['Изберете от над 500 шаблона и редактирайте с влачене и пускане, без програмиране.', 'Планове от 9 лв. на месец. Домейнът е включен в платените планове.'])}<h2>Цени</h2>${paragraphs(['Безплатен план, Стандартен от 9 лв. на месец, Професионален от 19 лв. на месец.'])}<a href="/start">Започнете безплатно</a>`,
        footer: '',
      });
    case 'blog': {
      const isNews = site.domain === 'portal-za-biznes.example';
      return renderDoc({
        title: isNews ? `Уебсайт за малкия бизнес: какво да знаем – ${site.brand}` : `Как да изберем фирма: ${kw} – ръководство | ${site.brand}`,
        description: 'Седем критерия, по които да сравните фирмите, преди да поръчате.',
        nav: ['Блог', 'За нас'],
        body:
          `<h1>${isNews ? 'Уебсайт за малкия бизнес: какво да знаем' : `Как да изберем фирма за ${esc(kw)}: 7 критерия`}</h1>` +
          paragraphs(['Автор: Георги Иванов. Прочетете как да сравните офертите и да избегнете най-честите грешки.']) +
          ['Портфолио и референции', 'Прозрачна цена', 'Договор и срокове', 'Поддръжка след пускане', 'Собственост върху сайта', 'Технологии', 'Отзиви от клиенти']
            .map((h, i) => `<h2>${i + 1}. ${esc(h)}</h2>${paragraphs([`Обърнете внимание на ${h.toLowerCase()}: поискайте конкретни примери и писмено потвърждение.`, 'Не се доверявайте на общи обещания без числа и срокове.'])}`)
            .join('') +
          `<h2>Често задавани въпроси</h2>${paragraphs([FAQ[0]![0], FAQ[0]![1]])}`,
        footer: '',
      });
    }
    case 'listicle':
      return renderDoc({
        title: `Топ 10 фирми: ${kw} през 2026 | ${site.brand}`,
        description: 'Класация на фирмите за изработка на сайтове според цена, срокове и отзиви.',
        nav: ['Класации', 'За нас'],
        body:
          `<h1>Топ 10 фирми за ${esc(kw)} през 2026</h1>${paragraphs(['Сравнихме цени, срокове и отзиви на водещите студиа.'])}` +
          SITES.filter((s) => ['agency_strong', 'agency_mid', 'shop_agency'].includes(s.kind))
            .map((f, i) => `<h2>${i + 1}. ${esc(f.brand)}</h2>${paragraphs([`Подходящ за малък бизнес. Цена от ${490 + i * 100} лв. Оценка ${(9.4 - i * 0.3).toFixed(1).replace('.', ',')} от 10.`])}`)
            .join(''),
        footer: '',
      });
    case 'own':
      return renderDoc({
        title: `Изработка на уебсайтове | ${site.brand}`,
        description: 'Правим сайтове за малък бизнес.',
        nav: ['Начало', 'Контакти'],
        body: `<h1>${esc(K)}</h1>${paragraphs(['Правим сайтове за малък бизнес с WordPress.', 'Работим бързо и коректно.'])}${section('process', 'generic', 0)}${section('portfolio', 'generic', 0)}<a href="/kontakti/">Свържете се с нас</a>`,
        footer: contactFooter(site, false),
      });
  }
}

// ───────────────────────── SERP generation ─────────────────────────

const BASE_STRENGTH: Record<Exclude<Kind, 'own'>, number> = {
  agency_strong: 0.9,
  agency_mid: 0.7,
  shop_agency: 0.62,
  listicle: 0.55,
  blog: 0.5,
  directory: 0.5,
  builder: 0.48,
  boilerplate: 0.44,
  freelancer_thin: 0.34,
  forum: 0.3,
};

// Queries about a specific niche or place ("… за ресторант", "… варна"). Big agencies rarely have a page for
// each niche, so for these queries their results fall back to a generic title that does not mention the
// modifier — exactly the kind of mismatch that makes a long-tail SERP beatable.
const NICHE_STRONG_RE = /(ресторант|клиника|хотел|адвокат|салон|стомато|автосервиз)/i; // a specific industry
const NICHE_WEAK_RE = /(за малък бизнес|от нулата|wordpress|безплатно|сам$|софия|пловдив|варна|бургас|русе|стара загора|плевен)/i; // place or approach
const isNicheStrong = (kw: string): boolean => NICHE_STRONG_RE.test(kw);
const isNiche = (kw: string): boolean => isNicheStrong(kw) || NICHE_WEAK_RE.test(kw);
const GENERIC_KINDS: readonly Kind[] = ['agency_strong', 'agency_mid', 'shop_agency', 'boilerplate'];
// For a very specific industry nobody has a dedicated page, so every result falls back to the generic topic —
// the textbook shape of a quick win. For softer niches (a city, WordPress) only the agencies stay generic.
const topicFor = (site: Site, kw: string): string => (isNicheStrong(kw) || (isNiche(kw) && GENERIC_KINDS.includes(site.kind)) ? DEMO_KEYWORD : kw);

function titleFor(site: Site, rawKeyword: string): string {
  const kw = topicFor(site, rawKeyword);
  const K = cap(kw);
  switch (site.kind) {
    case 'agency_strong': return `${K} – цени, срокове и примери | ${site.brand}`;
    case 'agency_mid': return `${K} | ${site.brand}`;
    case 'shop_agency': return `Изработка на онлайн магазин и ${kw} | ${site.brand}`;
    case 'freelancer_thin': return `${site.brand} – уеб дизайн и сайтове`;
    case 'boilerplate': return `${kw}, ${kw} цена, ${kw} фирма | ${site.brand}`;
    case 'directory': return `Фирми за ${kw} – каталог | ${site.brand}`;
    case 'forum': return `Тема: ${kw}? – ${site.brand}`;
    case 'builder': return `Създайте сайт безплатно с ${site.brand}`;
    case 'blog': return site.domain === 'portal-za-biznes.example' ? `Уебсайт за малкия бизнес: какво да знаем – ${site.brand}` : `Как да изберем фирма: ${kw} – ръководство | ${site.brand}`;
    case 'listicle': return `Топ 10 фирми: ${kw} през 2026 | ${site.brand}`;
    case 'own': return `Изработка на уебсайтове | ${site.brand}`;
  }
}

function snippetFor(site: Site, rawKeyword: string): string {
  const kw = topicFor(site, rawKeyword);
  switch (site.kind) {
    case 'agency_strong': return `${cap(kw)} за малък и среден бизнес: ясна цена от 490 лв., срок 2–4 седмици и безплатна консултация.`;
    case 'agency_mid': return `${site.brand} изработва сайтове за бизнеса. Свържете се с нас за оферта.`;
    case 'shop_agency': return 'Онлайн магазини с плащане с карта, куриери и интеграция със склад.';
    case 'freelancer_thin': return 'Здравейте! Аз съм уеб дизайнер и правя сайтове от 2016 г.';
    case 'boilerplate': return `${cap(kw)} – качествени услуги на достъпни цени. Лидер на пазара.`;
    case 'directory': return `Каталог с фирми за ${kw} в България. Сравнете по рейтинг и град.`;
    case 'forum': return 'Здравейте, търся фирма за сайт на малък магазин. Колко е нормално да струва…';
    case 'builder': return 'Конструктор за сайтове: изберете шаблон и публикувайте за минути.';
    case 'blog': return 'Седем критерия, по които да сравните фирмите, преди да поръчате.';
    case 'listicle': return 'Класация на фирмите за изработка на сайтове според цена, срокове и отзиви.';
    case 'own': return 'Правим сайтове за малък бизнес.';
  }
}

export function demoSerp(query: SerpQuery, urlKeywords: Map<string, string>, now = new Date()): SerpData {
  const kw = query.keyword.trim().toLowerCase();
  const words = kw.split(/\s+/).length;
  const rand = mulberry32(fnv1a(`${kw}|${query.market.id}`));
  const competitors = SITES.filter((s) => s.kind !== 'own');

  const scored = competitors.map((s) => {
    let strength = BASE_STRENGTH[s.kind as Exclude<Kind, 'own'>];
    const agency = s.kind === 'agency_strong' || s.kind === 'agency_mid' || s.kind === 'shop_agency';
    if (words <= 3 && (s.kind === 'agency_strong' || s.kind === 'agency_mid')) strength *= 1.15;
    if (words >= 5) {
      if (s.kind === 'agency_strong') strength *= 0.7;
      if (s.kind === 'forum' || s.kind === 'blog' || s.kind === 'directory') strength *= 1.3;
    }
    if (isNicheStrong(kw)) strength *= agency ? 0.5 : 1.6;
    else if (isNiche(kw)) strength *= agency ? 0.8 : 1.15;
    return { site: s, score: strength + (rand() - 0.5) * 0.24 };
  });
  scored.sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, Math.min(query.depth, 10)).map((x) => x.site);
  const rows = picked.map((s) => ({ site: s, position: 0 }));
  // The user's own site shows up at position 13 for broad queries when the SERP is requested 20 deep.
  const extra: Site[] = query.depth >= 20 ? [...scored.slice(10, 12).map((x) => x.site)] : [];
  const ordered: Site[] = [...rows.map((r) => r.site), ...extra];
  if (query.depth >= 13 && words <= 4) ordered.splice(12, 0, siteByDomain.get(DEMO_OWN_DOMAIN) as Site);

  const organic = ordered.map((site, i) => {
    const url = urlOf(site);
    urlKeywords.set(url, query.keyword);
    return { url, title: titleFor(site, query.keyword), snippet: snippetFor(site, query.keyword), position: i + 1 };
  });

  const base = query.keyword;
  return buildSerpData({
    provider: 'demo',
    keyword: query.keyword,
    market: query.market,
    organic,
    peopleAlsoAsk: [
      { question: 'Колко струва изработката на сайт?' },
      { question: 'Колко време отнема изработката на сайт?' },
      { question: 'Нужен ли е хостинг за сайт?' },
      { question: 'Може ли да направя сайт сам?' },
      { question: 'Как да избера фирма за изработка на сайт?' },
    ],
    relatedSearches: [`${base} цена`, `${base} цени`, `${base} за малък бизнес`, `${base} онлайн магазин`, `${base} wordpress`, `${base} софия`, `${base} пловдив`, `${base} от нулата`, `фирми за ${base}`, `${base} безплатно`],
    now,
  });
}

// ───────────────────────── providers ─────────────────────────

export interface DemoWorld {
  serp: SerpProvider;
  volume: VolumeProvider;
  fetcher: PageFetcher;
}

function volumeOf(keyword: string): KeywordVolume {
  const h = fnv1a(keyword.toLowerCase());
  const words = keyword.trim().split(/\s+/).length;
  if (h % 100 < 12) return { volume: null, cpc: null, competitionIndex: null };
  const base = 3200 / words ** 1.7;
  const volume = Math.max(10, Math.round((base * (0.5 + ((h >> 3) % 110) / 100)) / 10) * 10);
  return { volume, cpc: Math.round((0.4 + ((h >> 7) % 160) / 100) * 100) / 100, competitionIndex: 20 + ((h >> 11) % 70) };
}

export function createDemoWorld(): DemoWorld {
  // url → the keyword whose SERP produced it, so the page we "fetch" can mention what the user searched for
  const urlKeywords = new Map<string, string>();

  const serp: SerpProvider = {
    id: 'demo',
    async search(query: SerpQuery, _options?: CallOptions) {
      return demoSerp(query, urlKeywords);
    },
    async suggest(keyword: string, _market: Market) {
      return [`${keyword} цена`, `${keyword} с wordpress`, `${keyword} за ресторант`, `${keyword} за клиника`, `${keyword} варна`, `${keyword} безплатно`];
    },
  };

  const volume: VolumeProvider = {
    id: 'demo',
    async volumes(keywords) {
      const out = new Map<string, KeywordVolume>();
      for (const k of keywords) {
        const v = volumeOf(k);
        if (v.volume !== null) out.set(k.trim().toLowerCase(), v);
      }
      return out;
    },
  };

  const fetcher: PageFetcher = {
    async fetchPage(url: string): Promise<FetchedPage> {
      const site = siteByDomain.get(domainOf(url));
      const ok = (html: string): FetchedPage => ({ status: 'ok', httpStatus: 200, finalUrl: url, html, error: null, ttfbMs: 120 + (fnv1a(url) % 700), bytes: html.length, fromCache: false });
      const fail = (status: FetchedPage['status'], httpStatus: number | null, error: string): FetchedPage => ({ status, httpStatus, finalUrl: url, html: null, error, ttfbMs: 90, bytes: null, fromCache: false });
      if (!site) return fail('error', null, 'Непознат демо домейн');
      // A realistic mix of obstacles: a robots.txt block and a bot-protection 403.
      if (site.domain === 'top-agencii.example') return fail('blocked_robots', null, 'robots.txt забранява достъпа до тази страница');
      if (site.domain === 'build-your-site.example') return fail('http_error', 403, 'HTTP 403');
      return ok(renderSite(site, urlKeywords.get(url) ?? DEMO_KEYWORD));
    },
  };

  return { serp, volume, fetcher };
}
