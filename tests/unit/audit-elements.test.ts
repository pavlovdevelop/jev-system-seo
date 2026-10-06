import { describe, expect, it } from 'vitest';
import type { ElementVerdict, SeoElement } from '../../src/shared/audit';
import { extractPage } from '../../src/server/crawl/extract';
import { fitTitle, judgeElements, metaFromIntro, titleCore, urlProblem, type ElementInput } from '../../src/server/audit/elements';
import { buildHtml } from '../helpers/pages';

const NOW = new Date('2026-10-05T10:00:00Z');
const noul = (p: number) => ({ p });
const score = (value: number) => ({ value, raw: value * 4, levels: 5, confidence: 0.6, probabilities: [] });

function input(html: string, over: Partial<ElementInput> = {}, url = 'https://my-studio.example/uslugi/izrabotka-na-sait'): ElementInput {
  return {
    url,
    extracted: extractPage(html, { url, keyword: '', now: NOW }),
    phrase: 'изработка на уебсайт',
    type: 'service_page',
    rank: null,
    brand: 'Моето студио',
    jev: null,
    faqJev: null,
    duplicates: { title: 1, meta: 1, h1: 1 },
    ...over,
  };
}

const LONG = Array.from({ length: 40 }, (_, i) => `Изречение номер ${i + 1} разказва нещо конкретно за изработката на уебсайт и за цената ѝ.`).join(' ');
const good = (over: Parameters<typeof buildHtml>[0] extends infer T ? Partial<T> : never = {}) =>
  buildHtml({
    title: 'Изработка на уебсайт за малък бизнес | Моето студио',
    h1: 'Изработка на уебсайт',
    metaDescription: 'Изработка на уебсайт за малък бизнес: ясна цена от 490 лв., срок 2–4 седмици и безплатна консултация. Вижте цените и примери.',
    h2s: ['Цена', 'Срок', 'Процес'],
    paragraphs: [LONG, LONG, LONG],
    ...over,
  });

const find = (rows: ElementVerdict[], element: SeoElement): ElementVerdict => {
  const row = rows.find((r) => r.element === element);
  if (!row) throw new Error(`no ${element} verdict`);
  return row;
};

describe('titles', () => {
  it('a missing title is a certain change and comes with a proposal in the right shape', () => {
    const rows = judgeElements(input(buildHtml({ title: '', h1: 'Изработка на уебсайт', paragraphs: [LONG] }).replace('<title></title>', '')));
    const t = find(rows, 'title');
    expect(t).toMatchObject({ verdict: 'change', confidence: 1, source: 'rule', proposalBy: 'rule', now: 'липсва' });
    expect(t.proposal).toBe('Изработка на уебсайт | Моето студио');
  });

  it.each([
    ['too long', 'Изработка на уебсайт за малък и среден бизнес с оптимизация за Google и безплатна консултация | Моето студио', /знака/],
    ['too short', 'Сайтове', /само/],
  ])('flags a title that is %s', (_name, title, reason) => {
    const t = find(judgeElements(input(good({ title }))), 'title');
    expect(t.verdict).toBe('change');
    expect(t.reason).toMatch(reason);
    expect([...(t.proposal ?? '')].length).toBeLessThanOrEqual(62);
  });

  it('flags a title that several pages share and one that lacks the page phrase', () => {
    expect(find(judgeElements(input(good(), { duplicates: { title: 3, meta: 1, h1: 1 } })), 'title').reason).toMatch(/3 страници/);
    const off = find(judgeElements(input(good({ title: 'Нашите услуги и решения за вашия бизнес | Студио' }))), 'title');
    expect(off.verdict).toBe('change');
    expect(off.reason).toMatch(/основната фраза/);
  });

  it("follows Jev when the rules pass: both judgments good = keep, a vague one = change with Jev's confidence", () => {
    const keep = find(judgeElements(input(good(), { jev: { title_clear: noul(0.9), title_specific: noul(0.8) } })), 'title');
    expect(keep).toMatchObject({ verdict: 'keep', source: 'jev' });
    const vague = find(judgeElements(input(good(), { jev: { title_clear: noul(0.2), title_specific: noul(0.5) } })), 'title');
    expect(vague).toMatchObject({ verdict: 'change', source: 'jev' });
    expect(vague.confidence).toBeCloseTo(0.3, 2);
    expect(vague.reason).toMatch(/не казва ясно/);
    const generic = find(judgeElements(input(good(), { jev: { title_clear: noul(0.55), title_specific: noul(0.1) } })), 'title');
    expect(generic.reason).toMatch(/общо/);
  });
});

describe('meta description, H1 and the first paragraph', () => {
  it('a missing meta description gets a proposal cut from the first sentences', () => {
    const rows = judgeElements(input(good({ metaDescription: '' })));
    const meta = find(rows, 'meta');
    expect(meta).toMatchObject({ verdict: 'change', confidence: 1, now: 'липсва' });
    expect([...(meta.proposal ?? '')].length).toBeGreaterThanOrEqual(70);
    expect([...(meta.proposal ?? '')].length).toBeLessThanOrEqual(160);
  });

  it('flags a short meta description, a duplicate one and (through Jev) one that gives no reason to click', () => {
    expect(find(judgeElements(input(good({ metaDescription: 'Правим сайтове.' }))), 'meta').reason).toMatch(/само/);
    expect(find(judgeElements(input(good(), { duplicates: { title: 1, meta: 4, h1: 1 } })), 'meta').reason).toMatch(/4 страници/);
    expect(find(judgeElements(input(good(), { jev: { meta_inviting: noul(0.2) } })), 'meta')).toMatchObject({ verdict: 'change', source: 'jev' });
    expect(find(judgeElements(input(good(), { jev: { meta_inviting: noul(0.9) } })), 'meta')).toMatchObject({ verdict: 'keep' });
  });

  it('flags a missing H1 and several H1s', () => {
    expect(find(judgeElements(input(good({ h1: '' }).replace('<h1></h1>', ''))), 'h1')).toMatchObject({ verdict: 'change', now: 'липсва', proposal: 'Изработка на уебсайт за малък бизнес' });
    const two = good().replace('<main>', '<main><h1>Втори H1</h1>');
    expect(find(judgeElements(input(two)), 'h1').reason).toMatch(/2 H1/);
  });

  it('judges the first paragraph by Jev, and a page without an introduction by rule', () => {
    expect(find(judgeElements(input(good(), { jev: { intro_direct: noul(0.1) } })), 'intro')).toMatchObject({ verdict: 'change', source: 'jev' });
    expect(find(judgeElements(input(good(), { jev: { intro_direct: noul(0.9) } })), 'intro')).toMatchObject({ verdict: 'keep' });
    const thin = judgeElements(input(buildHtml({ title: 'Изработка на уебсайт за малък бизнес | Студио', h1: 'Изработка', paragraphs: ['Кратко.'] })));
    expect(find(thin, 'intro')).toMatchObject({ verdict: 'change', source: 'rule' });
  });
});

describe('structure, FAQ, structured data and housekeeping', () => {
  it('asks for subheadings in a long text, and defers to Jev about an existing outline', () => {
    const flat = good({ h2s: [], paragraphs: [LONG, LONG, LONG] });
    expect(find(judgeElements(input(flat)), 'h2')).toMatchObject({ verdict: 'change', source: 'rule' });
    expect(find(judgeElements(input(good(), { jev: { outline_logical: score(0.2) } })), 'h2')).toMatchObject({ verdict: 'change', source: 'jev' });
    expect(find(judgeElements(input(good(), { jev: { outline_logical: score(0.8) } })), 'h2')).toMatchObject({ verdict: 'keep' });
  });

  it('wants an FAQ on a service page, wants its schema when there is only a section, and accepts both', () => {
    expect(find(judgeElements(input(good())), 'faq')).toMatchObject({ verdict: 'change', now: 'няма' });
    const section = good({ extraBody: '<h2>Често задавани въпроси</h2><h3>Колко струва?</h3><p>От 490 лв.</p><h3>Колко време?</h3><p>Две седмици.</p>' });
    expect(find(judgeElements(input(section)), 'faq').now).toMatch(/без schema/);
    const full = good({
      extraHead: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Колко струва?","acceptedAnswer":{"@type":"Answer","text":"От 490 лв."}}]}</script>',
      extraBody: '<h2>Често задавани въпроси</h2><h3>Колко струва?</h3><p>От 490 лв.</p>',
    });
    expect(find(judgeElements(input(full, { faqJev: { faq_useful: noul(0.9) } })), 'faq').verdict).toBe('keep');
    expect(find(judgeElements(input(full, { faqJev: { faq_useful: noul(0.1) } })), 'faq').verdict).toBe('change');
  });

  it('does not ask a short contact page for an FAQ', () => {
    const contact = buildHtml({ title: 'Контакти – Моето студио, София', h1: 'Контакти', paragraphs: ['Пишете ни.'] });
    expect(judgeElements(input(contact, { type: 'other' })).some((r) => r.element === 'faq')).toBe(false);
  });

  it('checks structured data against the kind of page', () => {
    expect(find(judgeElements(input(good())), 'schema')).toMatchObject({ verdict: 'change', now: 'няма' });
    const wrong = good({ extraHead: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"x"}</script>' });
    expect(find(judgeElements(input(wrong)), 'schema').verdict).toBe('change');
    const right = good({ extraHead: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Service","name":"x"}</script>' });
    expect(find(judgeElements(input(right)), 'schema').verdict).toBe('keep');
  });

  it('flags noindex, a missing canonical and one that points elsewhere', () => {
    expect(find(judgeElements(input(good({ extraHead: '<meta name="robots" content="noindex">' }))), 'canonical')).toMatchObject({ verdict: 'change', confidence: 1, now: 'noindex' });
    expect(find(judgeElements(input(good())), 'canonical')).toMatchObject({ verdict: 'change', now: 'липсва' });
    expect(find(judgeElements(input(good({ extraHead: '<link rel="canonical" href="https://my-studio.example/drugo">' }))), 'canonical').reason).toMatch(/друга страница/);
    expect(find(judgeElements(input(good({ extraHead: '<link rel="canonical" href="https://my-studio.example/uslugi/izrabotka-na-sait">' }))), 'canonical').verdict).toBe('keep');
  });

  it('flags images without alt text and pages with hardly any internal links', () => {
    const imgs = good({ extraBody: '<img src="a.jpg"><img src="b.jpg"><img src="c.jpg" alt="проект">' });
    expect(find(judgeElements(input(imgs)), 'images')).toMatchObject({ verdict: 'change', now: '1 от 3 с alt' });
    expect(find(judgeElements(input(good())), 'links')).toMatchObject({ verdict: 'change' });
    const linked = good({ extraBody: Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">страница ${i}</a>`).join(' ') });
    expect(find(judgeElements(input(linked)), 'links').verdict).toBe('keep');
  });
});

describe('addresses', () => {
  it.each([
    ['https://x.example/', null],
    ['https://x.example/izrabotka-na-sait', null],
    ['https://x.example/Izrabotka', /главни/],
    ['https://x.example/izrabotka_na_sait', /_/],
    ['https://x.example/12345', /номер/],
    ['https://x.example/p?a=1&b=2', /параметъра/],
    [`https://x.example/${'dulg-'.repeat(25)}`, /дълъг/],
  ])('%s', (url, problem) => {
    const got = urlProblem(url);
    if (problem === null) expect(got).toBeNull();
    else expect(got).toMatch(problem);
  });
});

describe('impact', () => {
  const html = good({ title: '' }).replace(/<title><\/title>/, '');
  it('puts the homepage and a page just off the first page ahead of a page that already ranks in the top three', () => {
    const home = find(judgeElements(input(html, { type: 'company_homepage', rank: 8 }, 'https://x.example/')), 'title');
    const top = find(judgeElements(input(html, { type: 'blog_article', rank: 2 })), 'title');
    expect(home.impact).toBeGreaterThan(top.impact);
    expect(find(judgeElements(input(good(), { jev: { title_clear: noul(0.9), title_specific: noul(0.9) } })), 'title').impact).toBe(0); // keep has none
  });
});

describe('text helpers', () => {
  it('titleCore drops the site name', () => {
    expect(titleCore('Изработка на сайтове | Моето студио')).toBe('Изработка на сайтове');
    expect(titleCore('Цени – от 490 лв. - Студио')).toBe('Цени');
  });

  it('fitTitle adds the brand only when it fits and cuts on a word boundary otherwise', () => {
    expect(fitTitle('цени за изработка на сайт', 'Моето студио')).toBe('Цени за изработка на сайт | Моето студио');
    const long = fitTitle('изработка на уебсайт за малък и среден бизнес с оптимизация за google и безплатна консултация', 'Моето студио');
    expect([...long].length).toBeLessThanOrEqual(62);
    expect(long.endsWith(' ')).toBe(false);
  });

  it('metaFromIntro needs enough text and stops at a sentence', () => {
    expect(metaFromIntro('Кратко.')).toBeNull();
    const text = 'Изработваме уебсайтове за малък бизнес с ясна цена и срок. Работим с WordPress и WooCommerce за магазини. ' + 'Още едно изречение за доказателство. '.repeat(10);
    const out = metaFromIntro(text) as string;
    expect([...out].length).toBeLessThanOrEqual(160);
    expect(out.startsWith('Изработваме уебсайтове')).toBe(true);
  });
});
