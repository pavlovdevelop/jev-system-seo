import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPage } from '../../src/server/crawl/extract';
import { PageMetricsSchema } from '../../src/shared/schemas';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8');
const URL_SERVICE = 'https://www.studio-pixel.example/uslugi/izrabotka-na-uebsait/';
const KEYWORD = 'изработка на уеб сайт';

describe('extractPage — rich service page', () => {
  const page = extractPage(fixture('service-page.html'), { url: URL_SERVICE, keyword: KEYWORD, now: new Date('2026-10-05') });
  const m = page.metrics;

  it('produces metrics that satisfy the shared schema', () => {
    expect(() => PageMetricsSchema.parse(m)).not.toThrow();
  });

  it('reads head-level facts', () => {
    expect(m.title).toBe('Изработка на уебсайт – цени, срокове и примери | Студио Пиксел');
    expect(m.titleLength).toBe([...m.title!].length);
    expect(m.metaDescription).toContain('Изработка на уебсайт за малък бизнес');
    expect(m.lang).toBe('bg-BG');
    expect(m.hasViewport).toBe(true);
    expect(m.https).toBe(true);
    expect(m.noindex).toBe(false);
    expect(m.canonical).toBe('https://www.studio-pixel.example/uslugi/izrabotka-na-uebsait/');
    expect(m.canonicalIsSelf).toBe(true);
  });

  it('collects JSON-LD types including nested @graph entries and detects FAQ schema', () => {
    expect(m.schemaTypes).toEqual(expect.arrayContaining(['Organization', 'Service', 'FAQPage']));
    expect(m.hasFaqSchema).toBe(true);
    expect(m.hasFaqSection).toBe(true);
  });

  it('extracts the heading structure with levels', () => {
    expect(m.h1).toEqual(['Изработка на уебсайт за вашия бизнес']);
    expect(m.h2Count).toBe(4);
    expect(m.h3Count).toBe(2);
    expect(page.outline[0]).toBe('H1: Изработка на уебсайт за вашия бизнес');
    expect(page.outline).toContain('H2: Колко струва изработката на сайт?');
  });

  it('matches the keyword across spellings and inflections everywhere it appears', () => {
    expect(m.keyword).toMatchObject({ inTitle: true, inH1: true, inUrl: true, inMeta: true, startsTitleWithKeyword: true });
    expect(m.keyword.titleCoverage).toBe(1);
    expect(m.keyword.bodyCoverage).toBe(1);
  });

  it('removes scripts, styles, hidden text and cookie banners from the text Jev will see', () => {
    const all = `${page.text.full}\n${page.text.intro}\n${page.outline.join('\n')}`;
    expect(all).not.toContain('SCRIPT TEXT MUST NOT APPEAR');
    expect(all).not.toContain('HIDDEN-TEXT');
    expect(all).not.toContain('Ignore all previous instructions');
    expect(all).not.toContain('ARIA-HIDDEN-TEXT');
    expect(all).not.toContain('COOKIE-TEXT');
    expect(all).not.toContain('color:red');
  });

  it('keeps words from adjacent blocks apart', () => {
    expect(page.text.full).toContain('Как протича работата');
    expect(page.text.full).not.toMatch(/работатаРаботим/);
  });

  it('counts words in the main content only', () => {
    expect(m.wordCount).toBeGreaterThan(80);
    expect(m.wordCount).toBeLessThan(200);
  });

  it('measures images and links', () => {
    expect(m.images).toEqual({ total: 3, withAlt: 1 });
    expect(m.links.external).toBe(1); // facebook
    expect(m.links.internal).toBeGreaterThanOrEqual(4);
  });

  it('finds conversion and trust evidence', () => {
    expect(m.hasContactForm).toBe(true);
    expect(m.phones).toBe(1);
    expect(m.emails).toBe(1);
    expect(m.ctaTexts).toEqual(expect.arrayContaining(['Заяви безплатна оферта', 'Свържи се с нас']));
    expect(m.priceMentions.some((p) => p.includes('490 лв'))).toBe(true);
    // snippets must not overlap each other and must start on a word boundary
    expect(m.priceMentions.filter((p) => p.includes('1 490'))).toHaveLength(1);
    for (const p of m.priceMentions) expect(p).not.toMatch(/^[а-я]{1,3}\.\s/);
    expect(m.socialProof.some((s) => s.includes('150 доволни клиенти'))).toBe(true);
    expect(m.navLabels).toEqual(expect.arrayContaining(['Услуги', 'Портфолио', 'За нас']));
    expect(page.hints).toMatchObject({ aboutLink: true, companyRegistration: true, address: true });
    expect(page.hints.workHeadings).toContain('Нашето портфолио');
  });

  it('reports the latest year mentioned, ignoring far-future years', () => {
    expect(m.latestYear).toBe(2024);
    const future = extractPage('<body><main><p>Копирайт 2099 и 2021 година, изработка на сайт, много думи '.padEnd(400, 'дума ') + '</p></main></body>', { url: URL_SERVICE, keyword: KEYWORD, now: new Date('2026-10-05') });
    expect(future.metrics.latestYear).toBe(2021);
  });

  it('prepares text slices for Jev', () => {
    expect(page.text.intro.startsWith('Изработка на уебсайт за вашия бизнес')).toBe(true);
    expect(page.text.intro.length).toBeLessThanOrEqual(1500);
  });
});

describe('extractPage — thin page', () => {
  const page = extractPage(fixture('thin-page.html'), { url: 'http://thin.example/', keyword: KEYWORD });
  const m = page.metrics;

  it('flags the weaknesses a sloppy page has', () => {
    expect(m.title).toBe('Начало');
    expect(m.metaDescription).toBeNull();
    expect(m.h1).toHaveLength(2);
    expect(m.wordCount).toBeLessThan(20);
    expect(m.https).toBe(false);
    expect(m.hasViewport).toBe(false);
    expect(m.canonical).toBeNull();
    expect(m.canonicalIsSelf).toBeNull();
    expect(m.schemaTypes).toEqual([]);
    expect(m.keyword.inTitle).toBe(false);
    expect(m.keyword.bodyCoverage).toBe(0);
    expect(m.phones).toBe(0);
    expect(m.emails).toBe(0);
    expect(m.hasContactForm).toBe(false);
  });
});

describe('extractPage — robustness', () => {
  it('survives garbage and empty input', () => {
    for (const html of ['', 'not html at all', '<<<>>>', '<html><body><div><p>unclosed', '\u0000\u0001']) {
      const page = extractPage(html, { url: 'https://x.example/', keyword: 'сайт' });
      expect(() => PageMetricsSchema.parse(page.metrics)).not.toThrow();
    }
  });

  it('survives broken JSON-LD and detects noindex', () => {
    const page = extractPage('<head><meta name="robots" content="NOINDEX, follow"><script type="application/ld+json">{broken</script></head><body>x</body>', { url: 'https://x.example/', keyword: 'сайт' });
    expect(page.metrics.noindex).toBe(true);
    expect(page.metrics.schemaTypes).toEqual([]);
  });

  it('flags a canonical that points elsewhere', () => {
    const page = extractPage('<head><link rel="canonical" href="https://other.example/page"></head><body>x</body>', { url: 'https://x.example/page', keyword: 'сайт' });
    expect(page.metrics.canonicalIsSelf).toBe(false);
  });

  it('does not treat a search form as a contact form', () => {
    const page = extractPage('<body><form role="search"><input type="search" name="q"></form></body>', { url: 'https://x.example/', keyword: 'сайт' });
    expect(page.metrics.hasContactForm).toBe(false);
  });
});
