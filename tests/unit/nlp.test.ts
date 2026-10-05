import { describe, expect, it } from 'vitest';
import {
  containsKeyword,
  coverage,
  keywordKey,
  keywordTerms,
  looksLikeQuestion,
  looseLatin,
  normalizeText,
  slugMatchesKeyword,
  startsWithKeyword,
  stem,
  terms,
} from '../../src/server/nlp/bg';
import { clusterHeadings, extractPhrases, minePhrases, pruneSubsumed } from '../../src/server/nlp/terms';

describe('Bulgarian stemming', () => {
  // Every form in a family must collapse to the same stem.
  const families: Record<string, string[]> = {
    сайт: ['сайт', 'сайта', 'сайтът', 'сайтове', 'сайтовете'],
    изработк: ['изработка', 'изработката', 'изработки', 'изработките'],
    цен: ['цена', 'цената', 'цени', 'цените'],
    магазин: ['магазин', 'магазина', 'магазинът', 'магазини', 'магазините'],
    агенц: ['агенция', 'агенцията', 'агенции', 'агенциите'],
    дизайн: ['дизайн', 'дизайна', 'дизайнът', 'дизайни', 'дизайните'],
    страниц: ['страница', 'страницата', 'страници', 'страниците'],
    услуг: ['услуга', 'услугата', 'услуги', 'услугите'],
    клиент: ['клиент', 'клиента', 'клиентът', 'клиенти', 'клиентите'],
    оптимизац: ['оптимизация', 'оптимизацията', 'оптимизации'],
    безплатн: ['безплатен', 'безплатна', 'безплатно', 'безплатни', 'безплатната', 'безплатните'],
    българск: ['български', 'българска', 'българско', 'българските'],
    решен: ['решение', 'решението', 'решения', 'решенията'],
  };

  for (const [expected, forms] of Object.entries(families)) {
    it(`collapses ${forms.join(', ')} → ${expected}`, () => {
      for (const form of forms) expect(stem(form), form).toBe(expected);
    });
  }

  it('does not mangle short words or stems ending in a letter that looks like an article', () => {
    expect(stem('сайта')).toBe('сайт'); // not "сай"
    expect(stem('уеб')).toBe('уеб');
    expect(stem('seo')).toBe('seo');
  });

  it('keeps clearly different words apart', () => {
    expect(stem('цена')).not.toBe(stem('цел'));
    expect(stem('сайт')).not.toBe(stem('магазин'));
    expect(stem('дизайн')).not.toBe(stem('оптимизация'));
  });

  it('stems simple English plurals', () => {
    expect(stem('agencies')).toBe('agency');
    expect(stem('services')).toBe('service');
    expect(stem('design')).toBe('дизайн'); // synonym map
    expect(stem('business')).toBe('business');
  });
});

describe('text normalisation', () => {
  it('collapses every spelling of "web site" into "сайт"', () => {
    for (const s of ['уеб сайт', 'веб сайт', 'уебсайт', 'веб-сайт', 'web site', 'website', 'Уеб Сайт']) {
      expect(normalizeText(s), s).toBe('сайт');
    }
    expect(normalizeText('изработка на уебсайтове')).toBe('изработка на сайтове');
    expect(normalizeText('websites')).toBe('сайт');
  });

  it('does not touch words that merely contain "web"', () => {
    expect(normalizeText('cobweb')).toBe('cobweb');
  });
});

describe('keyword handling', () => {
  it('drops function words and dedupes terms', () => {
    expect(keywordTerms('изработка на веб сайт')).toEqual(['изработк', 'сайт']);
    expect(keywordTerms('изработка на уебсайтове')).toEqual(['изработк', 'сайт']);
  });

  it('falls back to all tokens when a keyword is only function words', () => {
    expect(keywordTerms('как да').length).toBeGreaterThan(0);
  });

  it('treats reorderings and inflections as the same keyword', () => {
    expect(keywordKey('изработка на уеб сайт цена')).toBe(keywordKey('цени изработка сайтове'));
    expect(keywordKey('изработка на сайт')).not.toBe(keywordKey('изработка на онлайн магазин'));
  });

  it('measures coverage across inflections and spellings', () => {
    expect(coverage('изработка на веб сайт', 'Изработка на уебсайтове за малък бизнес')).toBe(1);
    expect(coverage('изработка на веб сайт', 'Професионален дизайн на сайтове')).toBe(0.5);
    expect(coverage('изработка на веб сайт', 'Рецепта за баница')).toBe(0);
    expect(containsKeyword('изработка на сайт', 'Цени за изработката на вашия сайт')).toBe(true);
  });

  it('detects whether a title starts with the keyword', () => {
    expect(startsWithKeyword('Изработка на уебсайт | Студио Х', 'изработка на веб сайт')).toBe(true);
    expect(startsWithKeyword('Студио Х – изработка на уебсайт', 'изработка на веб сайт')).toBe(false);
  });

  it('recognises questions', () => {
    expect(looksLikeQuestion('Колко струва изработката на сайт')).toBe(true);
    expect(looksLikeQuestion('Изработка на сайт?')).toBe(true);
    expect(looksLikeQuestion('Изработка на сайт')).toBe(false);
    expect(looksLikeQuestion('How much does a website cost')).toBe(true);
  });
});

describe('URL slug matching', () => {
  it('matches transliterated Bulgarian slugs and Latin keywords', () => {
    expect(slugMatchesKeyword('https://example.bg/izrabotka-na-sait', 'изработка на сайт')).toBe(true);
    expect(slugMatchesKeyword('https://example.bg/uslugi/izrabotka-na-uebsajt/', 'изработка на уеб сайт')).toBe(true);
    expect(slugMatchesKeyword('https://example.com/web-design-sofia', 'web design')).toBe(true);
  });

  it('does not match unrelated URLs', () => {
    expect(slugMatchesKeyword('https://example.bg/kontakti', 'изработка на сайт')).toBe(false);
    expect(slugMatchesKeyword('not a url', 'изработка на сайт')).toBe(false);
  });

  it('transliterates loosely and consistently', () => {
    expect(looseLatin('изработка')).toBe(looseLatin('izrabotka'));
    expect(looseLatin('щастие')).toBe(looseLatin('shtastie'));
  });
});

describe('phrase mining', () => {
  const docs = [
    'Изработка на сайт за малък бизнес. Цена на сайт: от 500 евро. Професионален дизайн и SEO оптимизация.',
    'Изработката на сайтове включва дизайн, програмиране и SEO оптимизация. Поддръжка на сайт.',
    'Нашият екип прави изработка на сайт и онлайн магазини. SEO оптимизация е включена в цената.',
  ];

  it('counts pages, not repetitions, and merges inflected forms', () => {
    const stats = minePhrases(docs, { minPages: 2 });
    const byDisplay = (d: string) => stats.find((s) => s.display.toLowerCase().includes(d));
    expect(byDisplay('изработка на сайт')?.pages).toBe(3);
    expect(stats.find((s) => s.key === 'seo оптимизац')?.pages).toBe(3);
    // a phrase repeated many times on a single page must not count as "shared"
    const single = minePhrases(['кафе кафе кафе кафе', 'чай'], { minPages: 2 });
    expect(single.find((s) => s.key === 'кафе')).toBeUndefined();
  });

  it('never builds phrases across punctuation', () => {
    const phrases = extractPhrases('изработка, поддръжка. Сайт');
    expect([...phrases.keys()]).not.toContain('изработк поддръжк');
    expect([...phrases.keys()]).not.toContain('поддръжк сайт');
  });

  it('prunes phrases that are fully covered by a longer, equally common one', () => {
    const stats = minePhrases(docs, { minPages: 3 });
    const pruned = pruneSubsumed(stats);
    expect(pruned.map((s) => s.key)).toContain('изработк на сайт');
    expect(pruned.map((s) => s.key)).not.toContain('изработк');
  });

  it('ignores numbers and stopword-only fragments', () => {
    const keys = [...extractPhrases('от 500 евро и за на').keys()];
    expect(keys.some((k) => /\b500\b/.test(k))).toBe(false);
    expect(keys).not.toContain('и за на');
  });
});

describe('heading clustering', () => {
  it('groups headings that discuss the same subtopic across pages', () => {
    const clusters = clusterHeadings([
      ['Цени за изработка на сайт', 'Процес на работа', 'Често задавани въпроси'],
      ['Колко струва изработката на сайт', 'Как работим', 'Портфолио'],
      ['Цена на изработка на сайт', 'Портфолио с проекти'],
    ]);
    const pricing = clusters.find((c) => c.terms.includes('цен') || c.terms.includes('струв'));
    expect(pricing).toBeDefined();
    expect(pricing!.pages).toBeGreaterThanOrEqual(2);
    const portfolio = clusters.find((c) => c.examples.some((e) => e.startsWith('Портфолио')));
    expect(portfolio?.pages).toBe(2);
  });
});

describe('terms()', () => {
  it('removes stopwords and numbers', () => {
    expect(terms('Изработка на сайт от 2024 година')).toEqual(['изработк', 'сайт']);
  });
});
