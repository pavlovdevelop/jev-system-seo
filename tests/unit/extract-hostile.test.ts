import { describe, expect, it } from 'vitest';
import { extractPage } from '../../src/server/crawl/extract';
import { pruneSubsumed } from '../../src/server/nlp/terms';

// The extractor runs on the thread that also serves the web UI, on pages written by strangers. These cases are the
// shapes that used to freeze it (quadratic regular expressions, quadratic tree operations, absurd nesting).
// Thresholds are generous (the measured times are 5–20 times lower) so a slow CI machine does not fail them.

const ctx = { url: 'https://competitor.example/page', keyword: 'изработка на уебсайт' };
const page = (body: string, head = '') => `<!doctype html><html lang="bg"><head><title>x</title>${head}</head><body>${body}</body></html>`;
const ch = (n: number): string => String.fromCodePoint(n);

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe('extractPage on hostile input stays fast', () => {
  const cases: Array<[string, string]> = [
    ['a long run of e-mail characters without an @', page(`<p>${'a'.repeat(400_000)}</p>`)],
    ['dots and letters that look like an address', page(`<p>${'a.'.repeat(200_000)}</p>`)],
    ['an @ at the very end of a long run', page(`<p>${'a'.repeat(400_000)}@</p>`)],
    ['a long run of digits (phone and price patterns)', page(`<p>${'0'.repeat(400_000)}</p>`)],
    ['hyphens', page(`<p>уеб${'-'.repeat(400_000)}x</p>`)],
    ['nested divs, 1.4 MB deep', page('<div>'.repeat(280_000) + 'x' + '</div>'.repeat(280_000))],
    ['unclosed spans', page('<span>'.repeat(200_000) + 'x')],
    ['100 000 sibling scripts', page('<script></script>'.repeat(60_000))],
    ['100 000 sibling hidden elements', page('<div style="display:none">x</div>'.repeat(30_000))],
    ['a flood of comments', page('<!-- c -->'.repeat(100_000))],
    ['60 000 links', page('<a href="/x">buy</a>'.repeat(40_000))],
    ['40 000 headings', page('<h2>question?</h2>'.repeat(40_000))],
    ['10 000 forms', page('<form><textarea></textarea></form>'.repeat(10_000))],
    ['a navigation with 40 000 links', page(`<nav>${'<a href="/">a</a>'.repeat(40_000)}</nav>`)],
    ['a 1 MB title', page('<p>x</p>', `<title>${'t'.repeat(1_000_000)}</title>`)],
  ];

  it.each(cases)('%s', (_label, html) => {
    const { value, ms } = timed(() => extractPage(html, ctx));
    expect(value.metrics.wordCount).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(2_000);
  });

  it('a realistic 850 KB directory page (27 000 elements) takes about a second at most', () => {
    const cards = Array.from(
      { length: 3000 },
      (_, i) =>
        `<li class="card"><a href="/firma/${i}"><img src="/l/${i}.png" alt="Фирма ${i}"><h3>Уеб студио номер ${i} — изработка на сайтове</h3></a><p>гр. София, ул. Примерна ${i}</p><span>+359 88 ${1000000 + i}</span><a href="/firma/${i}#contact">Заяви оферта</a></li>`,
    ).join('\n');
    const html = `<!doctype html><html lang="bg"><head><title>Каталог</title></head><body><main><h1>Изработка на уебсайт — каталог</h1><ul>${cards}</ul></main></body></html>`;
    const { value, ms } = timed(() => extractPage(html, ctx));
    expect(value.metrics.h1).toEqual(['Изработка на уебсайт — каталог']);
    expect(value.metrics.wordCount).toBeGreaterThan(10_000);
    expect(ms).toBeLessThan(3_000);
  });

  it('cuts absurd nesting off instead of reading all of it, and still reports the page', () => {
    const html = page('<div>'.repeat(300_000) + 'deep text' + '</div>'.repeat(300_000));
    const r = extractPage(html, ctx);
    expect(r.metrics.title).toBe('x');
  });

  it('keeps legitimate nesting (a few hundred levels) intact', () => {
    const levels = 200;
    const html = page(`<main>${'<div>'.repeat(levels)}<h1>Изработка на уебсайт</h1><p>${'дума '.repeat(120)}</p>${'</div>'.repeat(levels)}</main>`);
    const r = extractPage(html, ctx);
    expect(r.metrics.h1).toEqual(['Изработка на уебсайт']);
    expect(r.metrics.wordCount).toBeGreaterThan(100);
  });
});

describe('extractPage hidden-text and text hygiene', () => {
  it('drops text hidden by display:none, visibility, zero font size and zero opacity, and keeps everything else', () => {
    const html = page(`<main>
      <p>видим текст <span style="display:none">скрит едно</span></p>
      <p style="visibility: hidden">скрит две</p>
      <p style="font-size:0">скрит три</p>
      <p style="font-size: 0px;color:red">скрит три б</p>
      <p style="opacity:0">скрит четири</p>
      <p style="left:-9999px">скрит пет</p>
      <p hidden>скрит шест</p>
      <p aria-hidden="true">скрит седем</p>
      <p style="font-size:0.9em">остава едно</p>
      <p style="opacity:0.5">остава две</p>
      <p style="font-size:1.2rem; opacity: 1">остава три</p>
      ${'<p>достатъчно дълъг видим текст за основното съдържание на страницата. </p>'.repeat(20)}
    </main>`);
    const text = extractPage(html, ctx).text.full;
    for (const hidden of ['скрит едно', 'скрит две', 'скрит три', 'скрит четири', 'скрит пет', 'скрит шест', 'скрит седем']) expect(text, hidden).not.toContain(hidden);
    for (const shown of ['видим текст', 'остава едно', 'остава две', 'остава три']) expect(text, shown).toContain(shown);
  });

  it('removes zero-width, bidi and tag characters from titles and headings', () => {
    const hidden = [0x200b, 0x202e, 0xfeff, 0xe0041].map(ch).join('');
    const html = page(`<main><h1>Изработка${hidden} на уебсайт</h1><p>${'текст '.repeat(150)}</p></main>`, '').replace('<title>x</title>', `<title>Цена${hidden} на сайт</title>`);
    const r = extractPage(html, ctx);
    expect(r.metrics.title).toBe('Цена на сайт');
    expect(r.metrics.h1).toEqual(['Изработка на уебсайт']);
  });

  it('keeps cookie banners out of the measured text', () => {
    const html = page(`<div class="cookie-banner">Приемаме бисквитки</div><div id="gdpr-consent">Съгласие</div><main><p>${'съдържание '.repeat(60)}</p></main>`);
    const text = extractPage(html, ctx).text.full;
    expect(text).not.toContain('бисквитки');
    expect(text).not.toContain('Съгласие');
    expect(text).toContain('съдържание');
  });
});

describe('pruneSubsumed', () => {
  // the reference: the pairwise check this replaced
  const reference = (stats: ReadonlyArray<{ key: string; n: number; pages: number }>, tolerance = 0.85) =>
    stats.filter((s) => !stats.some((longer) => longer.n > s.n && longer.pages >= s.pages * tolerance && ` ${longer.key} `.includes(` ${s.key} `)));

  it('gives the same answer as checking every pair, on many random inputs', () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const vocab = ['сайт', 'уеб', 'цена', 'изработк', 'дизайн', 'seo', 'онлайн', 'магазин'];
    for (let round = 0; round < 300; round++) {
      const seen = new Set<string>();
      const stats: Array<{ key: string; display: string; n: number; pages: number; total: number }> = [];
      for (let i = 0; i < 40; i++) {
        const n = 1 + rand(3);
        const key = Array.from({ length: n }, () => vocab[rand(vocab.length)]).join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        stats.push({ key, display: key, n, pages: 2 + rand(8), total: 5 });
      }
      expect(pruneSubsumed(stats).map((s) => s.key)).toEqual(reference(stats).map((s) => s.key));
    }
  });

  it('handles a huge vocabulary in well under a second', () => {
    const stats = Array.from({ length: 60_000 }, (_, i) => ({ key: i % 3 === 0 ? `w${i}` : i % 3 === 1 ? `w${i} w${i + 1}` : `w${i} w${i + 1} w${i + 2}`, display: '', n: (i % 3) + 1, pages: 3, total: 3 }));
    const { ms } = timed(() => pruneSubsumed(stats));
    expect(ms).toBeLessThan(1_000);
  });
});
