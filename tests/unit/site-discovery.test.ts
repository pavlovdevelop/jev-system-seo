import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SafeFetcher, type FetchedPage, type PageFetcher, type TextResult } from '../../src/server/crawl/fetcher';
import { discoverSite, normalizePageUrl, type Discovery } from '../../src/server/site/discover';
import { MAX_LOC_LENGTH, MAX_SITEMAP_CHILDREN, MAX_SITEMAP_URLS, parseSitemap, sitemapsFromRobots } from '../../src/server/site/sitemap';

// The sitemap parser and the discovery of a site's pages. The discovery is tested against an in-memory fetcher: a table of
// address → text (sitemaps, robots.txt) and address → HTML, which also records every request it gets.

const urlset = (...locs: string[]): string => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
const index = (...locs: string[]): string => `<sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hasCyrillic = (s: string): boolean => /[Ѐ-ӿ]/.test(s);

type TextEntry = string | Partial<TextResult>;
type PageEntry = string | Partial<FetchedPage>;
interface World {
  texts?: Record<string, TextEntry>;
  pages?: Record<string, PageEntry>;
}

const notFoundText = (url: string): TextResult => ({ status: 'http_error', httpStatus: 404, text: null, finalUrl: url, error: 'HTTP 404' });
const notFoundPage = (url: string): FetchedPage => ({ status: 'http_error', httpStatus: 404, finalUrl: url, html: null, error: 'HTTP 404', ttfbMs: 1, bytes: null, fromCache: false });

function fakeFetcher(world: World, options: { text?: boolean; delayMs?: number } = {}) {
  const log = { texts: [] as string[], pages: [] as string[], inFlight: 0, maxInFlight: 0 };
  const fetcher: PageFetcher = {
    async fetchPage(url) {
      log.pages.push(url);
      log.inFlight++;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      try {
        if (options.delayMs) await sleep(options.delayMs);
        const entry = world.pages?.[url];
        if (entry === undefined) return notFoundPage(url);
        const ok = (html: string): FetchedPage => ({ status: 'ok', httpStatus: 200, finalUrl: url, html, error: null, ttfbMs: 1, bytes: html.length, fromCache: false });
        if (typeof entry === 'string') return ok(entry);
        return { ...(typeof entry.html === 'string' ? ok(entry.html) : notFoundPage(url)), ...entry };
      } finally {
        log.inFlight--;
      }
    },
    ...(options.text === false
      ? {}
      : {
          async fetchText(url: string) {
            log.texts.push(url);
            const entry = world.texts?.[url];
            if (entry === undefined) return notFoundText(url);
            if (typeof entry === 'string') return { status: 'ok' as const, httpStatus: 200, text: entry, finalUrl: url, error: null };
            return { ...notFoundText(url), ...entry };
          },
        }),
  };
  return { fetcher, log };
}

const discover = (world: World, over: Partial<Parameters<typeof discoverSite>[0]> = {}, fakeOptions: Parameters<typeof fakeFetcher>[1] = {}) => {
  const { fetcher, log } = fakeFetcher(world, fakeOptions);
  const progress: string[] = [];
  const result = discoverSite({ domain: 'example.com', fetcher, maxPages: 100, onProgress: (m) => progress.push(m), ...over });
  return { result, log, progress };
};
const run = async (world: World, over: Partial<Parameters<typeof discoverSite>[0]> = {}): Promise<Discovery> => discover(world, over).result;

// ─────────────────────────────── parseSitemap ───────────────────────────────

describe('parseSitemap', () => {
  it('reads a sitemap: namespaces, whitespace, CDATA, entities, upper-case tags and the date', () => {
    const xml = `﻿<?xml version="1.0"?>
      <!-- generated -->
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">
        <url>
          <loc>
            https://example.com/a?x=1&amp;y=2
          </loc>
          <lastmod>2024-05-01</lastmod>
          <image:image><image:loc>https://example.com/img.jpg</image:loc></image:image>
          <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/a"/>
        </url>
        <url><loc><![CDATA[https://example.com/b?c=1&d=2]]></loc><lastmod>2024-05-02T10:00:00+03:00</lastmod></url>
        <URL><LOC>https://example.com/UPPER</LOC><LASTMOD>2023-01-01</LASTMOD></URL>
        <url><loc>https://example.com/&#1089;&#x44a;&apos;</loc></url>
        <url><loc>https://example.com/c?a=1&b=2</loc><lastmod>not a date</lastmod></url>
      </urlset>`;
    expect(parseSitemap(xml)).toEqual({
      kind: 'urlset',
      urls: [
        { loc: 'https://example.com/a?x=1&y=2', lastmod: '2024-05-01' },
        { loc: 'https://example.com/b?c=1&d=2', lastmod: '2024-05-02T10:00:00+03:00' },
        { loc: 'https://example.com/UPPER', lastmod: '2023-01-01' },
        { loc: "https://example.com/съ'", lastmod: null },
        { loc: 'https://example.com/c?a=1&b=2', lastmod: null }, // an unescaped & is common and is kept
      ],
      sitemaps: [],
    });
  });

  it('understands a prefixed namespace for the sitemap elements themselves', () => {
    const xml = '<ns0:urlset xmlns:ns0="http://www.sitemaps.org/schemas/sitemap/0.9"><ns0:url><ns0:loc>https://example.com/p</ns0:loc></ns0:url></ns0:urlset>';
    expect(parseSitemap(xml).urls).toEqual([{ loc: 'https://example.com/p', lastmod: null }]);
  });

  it('does not mistake an extension element for the page, whatever the order inside <url>', () => {
    const xml = `<urlset xmlns:image="i" xmlns:video="v">
      <url>
        <image:image><image:loc>https://example.com/img.jpg</image:loc></image:image>
        <video:video><video:content_loc>https://example.com/v.mp4</video:content_loc><video:player_loc>https://example.com/player</video:player_loc></video:video>
        <loc>https://example.com/page</loc><lastmod>2024-01-01</lastmod>
      </url>
      <url><image:image><image:loc>https://example.com/only-an-image.jpg</image:loc></image:image></url>
    </urlset>`;
    expect(parseSitemap(xml).urls).toEqual([{ loc: 'https://example.com/page', lastmod: '2024-01-01' }]);
  });

  it('reads a sitemap index', () => {
    const parsed = parseSitemap(index('https://example.com/post-sitemap.xml', 'https://example.com/page-sitemap.xml.gz'));
    expect(parsed).toEqual({ kind: 'index', urls: [], sitemaps: ['https://example.com/post-sitemap.xml', 'https://example.com/page-sitemap.xml.gz'] });
  });

  it('says "unknown" for anything that is not a sitemap, and returns nothing', () => {
    for (const text of ['', '   \n ', '<html><body><h1>404</h1><a href="https://example.com/x">x</a></body></html>', 'not xml at all', '{"error":"not found"}', '<rss><channel><item><link>https://example.com/x</link></item></channel></rss>']) {
      expect(parseSitemap(text), text).toEqual({ kind: 'unknown', urls: [], sitemaps: [] });
    }
  });

  it('reads the plain-text format: one address per line', () => {
    const parsed = parseSitemap('https://example.com/1\r\n  http://example.com/2  \n\nthis is not an address\nftp://example.com/3\nhttps://example.com/with space\nhttps://example.com/4');
    expect(parsed.kind).toBe('urlset');
    expect(parsed.urls.map((u) => u.loc)).toEqual(['https://example.com/1', 'http://example.com/2', 'https://example.com/4']);
  });

  it('copes with what broken generators write', () => {
    // a PHP warning above the XML, an unclosed <url>, an element inside <loc>, a duplicate <loc>, empty values, a comment holding a page
    const xml = `<br /><b>Warning</b>: something in /var/www on line 3<br />
      <urlset>
        <url><loc>https://example.com/1</loc>
        <url><loc>https://example.com/2</loc></url>
        <url><loc>https://example.com/3<b>x</b></loc></url>
        <url><loc>https://example.com/4</loc><loc>https://example.com/5</loc></url>
        <url><loc></loc></url><url/><url><loc/></url>
        <!-- <url><loc>https://example.com/commented</loc></url> -->
        <url><loc>https://example.com/6</loc></url>`; // and the file stops here: no </urlset>
    expect(parseSitemap(xml).urls.map((u) => u.loc)).toEqual(['https://example.com/1', 'https://example.com/2', 'https://example.com/4', 'https://example.com/6']);
  });

  it('keeps what was complete when the file is cut off in the middle of a value', () => {
    expect(parseSitemap('<urlset><url><loc>https://example.com/ok</loc></url><url><loc>https://example.com/cu').urls.map((u) => u.loc)).toEqual(['https://example.com/ok']);
    expect(parseSitemap('<urlset><url><loc><![CDATA[https://example.com/cut').urls).toEqual([]);
  });

  describe('caps', () => {
    it(`lists at most ${MAX_SITEMAP_URLS} pages`, () => {
      const xml = urlset(...Array.from({ length: MAX_SITEMAP_URLS + 1 }, (_, i) => `https://example.com/p${i}`));
      const parsed = parseSitemap(xml);
      expect(parsed.urls).toHaveLength(MAX_SITEMAP_URLS);
      expect(parsed.urls.at(-1)?.loc).toBe(`https://example.com/p${MAX_SITEMAP_URLS - 1}`);
    });

    it(`lists at most ${MAX_SITEMAP_CHILDREN} child sitemaps`, () => {
      const parsed = parseSitemap(index(...Array.from({ length: MAX_SITEMAP_CHILDREN + 5 }, (_, i) => `https://example.com/s${i}.xml`)));
      expect(parsed.kind).toBe('index');
      expect(parsed.sitemaps).toHaveLength(MAX_SITEMAP_CHILDREN);
    });

    it(`drops an address longer than ${MAX_LOC_LENGTH} characters instead of cutting it`, () => {
      const exact = `https://example.com/${'a'.repeat(MAX_LOC_LENGTH - 'https://example.com/'.length)}`;
      expect(exact).toHaveLength(MAX_LOC_LENGTH);
      const parsed = parseSitemap(urlset(exact, `${exact}b`, 'https://example.com/after'));
      expect(parsed.urls.map((u) => u.loc)).toEqual([exact, 'https://example.com/after']);
    });
  });

  it('stops after three million tags: a legitimate file of 5 MB has far fewer', () => {
    expect(parseSitemap(`<urlset>${'<a/>'.repeat(3_100_000)}<url><loc>https://example.com/late</loc></url></urlset>`).urls).toEqual([]);
    expect(parseSitemap(`<urlset><url><loc>https://example.com/early</loc></url>${'<a/>'.repeat(1_000)}</urlset>`).urls).toHaveLength(1);
  });

  describe('hostile input stays linear', () => {
    const timed = (text: string) => {
      const t0 = performance.now();
      const parsed = parseSitemap(text);
      return { parsed, ms: performance.now() - t0 };
    };
    const shapes: Array<[string, string]> = [
      ['20 MB of letters', 'a'.repeat(20_000_000)],
      ['20 MB of "<"', '<'.repeat(20_000_000)],
      ['20 MB of tags', '<a>'.repeat(6_700_000)],
      ['20 MB of closing tags', '</a>'.repeat(5_000_000)],
      ['20 MB of blanks', ' '.repeat(20_000_000)],
      ['two million unclosed <url>', `<urlset>${'<url>'.repeat(2_000_000)}`],
      ['two million comments', `<urlset>${'<!---->'.repeat(2_000_000)}`],
      ['5 MB of "&" inside one <loc>', `<urlset><url><loc>${'&'.repeat(5_000_000)}</loc></url></urlset>`],
      ['thousands of <loc> full of "&"', `<urlset>${`<url><loc>${'&'.repeat(2_000)}</loc></url>`.repeat(2_000)}</urlset>`],
      ['a 5 MB address', `<urlset><url><loc>${'x'.repeat(5_000_000)}</loc></url></urlset>`],
      ['an unterminated CDATA', `<urlset><url><loc><![CDATA[${'x'.repeat(5_000_000)}`],
      ['an unterminated comment', `<urlset><!-- ${'x'.repeat(5_000_000)}`],
      ['a 5 MB tag name', `<urlset><${'x'.repeat(5_000_000)}></urlset>`],
      ['20 MB on one line of plain text', `https://${'a'.repeat(20_000_000)}`],
      ['hundreds of thousands of text lines', 'https://example.com/x\n'.repeat(800_000)],
      ['nested index loops', index(...Array.from({ length: 2_000 }, () => 'https://example.com/sitemap.xml'))],
    ];
    it.each(shapes)('%s', (_label, text) => {
      const { parsed, ms } = timed(text);
      expect(parsed.urls.length).toBeLessThanOrEqual(MAX_SITEMAP_URLS);
      expect(parsed.sitemaps.length).toBeLessThanOrEqual(MAX_SITEMAP_CHILDREN);
      expect(ms).toBeLessThan(2_000);
    });
  });
});

// ─────────────────────────────── sitemapsFromRobots ───────────────────────────────

describe('sitemapsFromRobots', () => {
  it('finds Sitemap lines in any case, with blanks and comments, http and https only, each once', () => {
    const robots = [
      'User-agent: *',
      'Disallow: /private',
      'Sitemap: https://example.com/sitemap.xml',
      '  SITEMAP:https://example.com/two.xml   # the second',
      'sitemap : http://example.com/three.xml',
      'Sitemap: https://example.com/sitemap.xml',
      'Sitemap: ftp://example.com/four.xml',
      'Sitemap: javascript:alert(1)',
      'Sitemap: not a url',
      'Sitemap:',
      'Sitemaps: https://example.com/plural.xml',
      '# Sitemap: https://example.com/commented.xml',
      'Disallow: /Sitemap: https://example.com/inside-a-rule.xml',
    ].join('\r\n');
    expect(sitemapsFromRobots(robots)).toEqual(['https://example.com/sitemap.xml', 'https://example.com/two.xml', 'http://example.com/three.xml']);
  });

  it('copes with the BOM and every kind of line end', () => {
    expect(sitemapsFromRobots('﻿Sitemap: https://example.com/a.xml\rSitemap: https://example.com/b.xml\nSitemap: https://example.com/c.xml')).toEqual([
      'https://example.com/a.xml',
      'https://example.com/b.xml',
      'https://example.com/c.xml',
    ]);
  });

  it('takes at most 20', () => {
    const robots = Array.from({ length: 100 }, (_, i) => `Sitemap: https://example.com/s${i}.xml`).join('\n');
    const found = sitemapsFromRobots(robots);
    expect(found).toHaveLength(20);
    expect(found[19]).toBe('https://example.com/s19.xml');
  });

  it('resolves a root-relative value against the robots.txt address when one is given, and otherwise drops it', () => {
    expect(sitemapsFromRobots('Sitemap: /sitemap.xml', 'https://example.com/robots.txt')).toEqual(['https://example.com/sitemap.xml']);
    expect(sitemapsFromRobots('Sitemap: /sitemap.xml')).toEqual([]);
    expect(sitemapsFromRobots('Sitemap: sitemap.xml', 'https://example.com/robots.txt')).toEqual([]);
  });

  it('stays linear on a huge file', () => {
    const t0 = performance.now();
    expect(sitemapsFromRobots('User-agent: *\n'.repeat(400_000))).toEqual([]);
    expect(sitemapsFromRobots('a'.repeat(5_000_000))).toEqual([]);
    expect(sitemapsFromRobots(`Sitemap: ${'x'.repeat(5_000_000)}`)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

// ─────────────────────────────── normalizePageUrl ───────────────────────────────

describe('normalizePageUrl', () => {
  const site = (host: string): boolean => host === 'example.com' || host.endsWith('.example.com');
  const norm = (raw: string, base?: string) => normalizePageUrl(raw, site, base)?.url ?? null;

  it('drops the fragment, tracking parameters, the default port and the case of the host, and keeps the rest of the query as written', () => {
    expect(norm('HTTPS://Example.COM:443/Page#section')).toBe('https://example.com/Page');
    expect(norm('http://example.com:80/x')).toBe('http://example.com/x');
    expect(norm('https://example.com:8443/x')).toBe('https://example.com:8443/x');
    expect(norm('https://example.com/a?utm_source=x&utm_medium=y&gclid=1&fbclid=2&ref=home')).toBe('https://example.com/a');
    expect(norm('https://example.com/q?id=5&utm_campaign=z')).toBe('https://example.com/q?id=5');
    expect(norm('https://example.com/q?name=a%20b&x=%D1%8F')).toBe('https://example.com/q?name=a%20b&x=%D1%8F');
  });

  it('gives a trailing slash and www the same key, and the same key to the homepage however it is written', () => {
    const keys = ['https://example.com/a', 'https://example.com/a/', 'https://www.example.com/a', 'http://example.com/a#x'].map((u) => normalizePageUrl(u, site)?.key);
    expect(new Set(keys).size).toBe(1);
    expect(normalizePageUrl('https://example.com', site)?.key).toBe(normalizePageUrl('https://www.example.com/', site)?.key);
    expect(normalizePageUrl('https://example.com/a', site)?.key).not.toBe(normalizePageUrl('https://example.com/a?x=1', site)?.key);
    expect(normalizePageUrl('https://blog.example.com/a', site)?.key).not.toBe(normalizePageUrl('https://example.com/a', site)?.key);
  });

  it('counts the path segments', () => {
    expect(normalizePageUrl('https://example.com/', site)?.depth).toBe(0);
    expect(normalizePageUrl('https://example.com/a/b/', site)?.depth).toBe(2);
  });

  it('refuses what is not a page of the site', () => {
    for (const raw of ['ftp://example.com/a', 'mailto:a@example.com', 'javascript:void(0)', 'https://other.com/a', 'https://user:pw@example.com/a', 'not a url', '', `https://example.com/${'a'.repeat(3_000)}`]) {
      expect(norm(raw), raw).toBeNull();
    }
  });

  it('refuses more than two query parameters (after the tracking ones are gone)', () => {
    expect(norm('https://example.com/a?x=1&y=2')).toBe('https://example.com/a?x=1&y=2');
    expect(norm('https://example.com/a?x=1&y=2&z=3')).toBeNull();
    expect(norm('https://example.com/a?x=1&y=2&utm_source=3')).toBe('https://example.com/a?x=1&y=2');
  });

  it('resolves a relative address against the base', () => {
    expect(norm('../b?x=1', 'https://example.com/a/c/')).toBe('https://example.com/a/b?x=1');
    expect(norm('/z', 'https://www.example.com/a/')).toBe('https://www.example.com/z');
  });

  it('keeps the homepage even when its address would be refused (force)', () => {
    expect(normalizePageUrl('https://example.com/?a=1&b=2&c=3', site)).toBeNull();
    expect(normalizePageUrl('https://example.com/?a=1&b=2&c=3', site, undefined, true)?.url).toBe('https://example.com/?a=1&b=2&c=3');
  });
});

// ─────────────────────────────── discoverSite: sitemaps ───────────────────────────────

describe('discoverSite — sitemaps', () => {
  it('reads the sitemaps robots.txt names, with fetchText, and does not look further when they give pages', async () => {
    const { result, log } = discover({
      texts: {
        'https://example.com/robots.txt': 'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/main.xml\nsitemap: https://example.com/more.xml',
        'https://example.com/main.xml': urlset('https://example.com/', 'https://example.com/a'),
        'https://example.com/more.xml': urlset('https://example.com/b'),
        'https://example.com/sitemap.xml': urlset('https://example.com/never-read'),
      },
    });
    const d = await result;
    expect(d).toMatchObject({ source: 'sitemap', found: 3, truncated: false, notes: [] });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/a', 'https://example.com/b']);
    expect(log.texts).toEqual(['https://example.com/robots.txt', 'https://example.com/main.xml', 'https://example.com/more.xml']);
    expect(log.pages).toEqual([]); // no page is downloaded while a sitemap does the job
  });

  it('tries /sitemap.xml, then /sitemap_index.xml, then /wp-sitemap.xml, and stops at the first that gives pages', async () => {
    const world = (found: string): World => ({ texts: { [`https://example.com/${found}`]: urlset('https://example.com/', `https://example.com/from-${found.replace(/\W/g, '-')}`) } });
    for (const file of ['sitemap.xml', 'sitemap_index.xml', 'wp-sitemap.xml']) {
      const { result, log } = discover(world(file));
      const d = await result;
      expect(d.urls, file).toEqual(['https://example.com/', `https://example.com/from-${file.replace(/\W/g, '-')}`]);
      expect(d.source).toBe('sitemap');
      expect(d.notes, 'a file nobody promised may be missing without a warning').toEqual([]);
      const order = ['robots.txt', 'sitemap.xml', 'sitemap_index.xml', 'wp-sitemap.xml'];
      expect(log.texts, file).toEqual(order.slice(0, order.indexOf(file) + 1).map((f) => `https://example.com/${f}`));
    }
  });

  it('reads a sitemap once: not again as one of the usual places, and not again under the address a redirect led to', async () => {
    const named = discover({
      texts: {
        'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap.xml',
        'https://example.com/sitemap.xml': urlset(), // named by robots.txt, and empty
        'https://example.com/wp-sitemap.xml': urlset('https://example.com/real'),
      },
    });
    expect((await named.result).urls).toEqual(['https://example.com/', 'https://example.com/real']);
    expect(named.log.texts).toEqual([
      'https://example.com/robots.txt',
      'https://example.com/sitemap.xml',
      'https://example.com/sitemap_index.xml',
      'https://example.com/wp-sitemap.xml',
    ]);
    const redirected = discover({
      texts: {
        'https://example.com/sitemap.xml': { status: 'ok', httpStatus: 200, text: urlset(), finalUrl: 'https://example.com/sitemap_index.xml', error: null }, // a redirect to the index, which is empty
        'https://example.com/wp-sitemap.xml': urlset('https://example.com/real'),
      },
    });
    await redirected.result;
    expect(redirected.log.texts).toEqual(['https://example.com/robots.txt', 'https://example.com/sitemap.xml', 'https://example.com/wp-sitemap.xml']);
  });

  it('goes on to the usual places when what robots.txt names is empty or missing', async () => {
    const d = await run({
      texts: {
        'https://example.com/robots.txt': 'Sitemap: https://example.com/gone.xml\nSitemap: https://example.com/empty.xml',
        'https://example.com/empty.xml': urlset(),
        'https://example.com/sitemap.xml': urlset('https://example.com/real'),
      },
    });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/real']);
    expect(d.notes).toEqual(['Sitemap „example.com/gone.xml“ не може да се прочете (HTTP 404) — пропуснат.']);
  });

  it('follows an index: its children, a gzipped child, and an index inside an index, but no deeper', async () => {
    const d = await run({
      texts: {
        'https://example.com/sitemap.xml': index('https://example.com/posts.xml', 'https://example.com/pages.xml.gz', 'https://example.com/nested.xml'),
        'https://example.com/posts.xml': urlset('https://example.com/blog/a', 'https://example.com/blog/b'),
        'https://example.com/pages.xml.gz': urlset('https://example.com/', 'https://example.com/about'),
        'https://example.com/nested.xml': index('https://example.com/level2.xml'),
        'https://example.com/level2.xml': index('https://example.com/level3.xml', 'https://example.com/level2-pages.xml'),
        'https://example.com/level2-pages.xml': urlset('https://example.com/deep'),
        'https://example.com/level3.xml': urlset('https://example.com/too-deep'),
      },
    });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/about', 'https://example.com/blog/a', 'https://example.com/blog/b']);
    expect(d.truncated).toBe(true);
    expect(d.notes).toEqual(['Sitemap индексът е вложен твърде дълбоко (над 2 нива) — вътрешните файлове са пропуснати.']);
  });

  it('reads at most 20 child sitemaps in total, in order, and says so', async () => {
    const children = Array.from({ length: 30 }, (_, i) => `https://example.com/part-${i}.xml`);
    const texts: Record<string, string> = { 'https://example.com/sitemap.xml': index(...children) };
    children.forEach((c, i) => (texts[c] = urlset(`https://example.com/page-${i}`)));
    const { result, log } = discover({ texts });
    const d = await result;
    expect(log.texts.filter((u) => u.includes('/part-'))).toEqual(children.slice(0, 20));
    expect(d.found).toBe(21); // 20 pages and the homepage the sitemap did not list
    expect(d.truncated).toBe(true);
    expect(d.notes).toEqual(['Индексът на sitemap е голям — прочетени са само първите 20 файла.']);
  });

  it('survives indexes that name each other and themselves: every file is read once', async () => {
    const { result, log } = discover({
      texts: {
        'https://example.com/sitemap.xml': index('https://example.com/sitemap.xml', 'https://example.com/b.xml', 'https://www.example.com/sitemap.xml'),
        'https://example.com/b.xml': index('https://example.com/sitemap.xml', 'https://example.com/b.xml', 'https://example.com/c.xml'),
        'https://example.com/c.xml': urlset('https://example.com/c-page'),
      },
    });
    const d = await result;
    expect(d.urls).toContain('https://example.com/c-page');
    for (const url of new Set(log.texts)) expect(log.texts.filter((u) => u === url), url).toHaveLength(1);
  });

  it('keeps going when one child cannot be read, and warns in Bulgarian', async () => {
    const d = await run({
      texts: {
        'https://example.com/sitemap.xml': index('https://example.com/a.xml', 'https://example.com/b.xml', 'https://example.com/c.xml', 'https://example.com/d.xml'),
        'https://example.com/a.xml': urlset('https://example.com/from-a'),
        'https://example.com/b.xml': { status: 'error', httpStatus: null, text: null, error: 'Изтече времето за изчакване' },
        'https://example.com/c.xml': { status: 'not_text', httpStatus: 200, text: null, error: 'Не е XML или текст (text/html)' },
        'https://example.com/d.xml': '<html><body>sorry</body></html>',
      },
    });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/from-a']);
    expect(d.notes).toEqual([
      'Sitemap „example.com/b.xml“ не може да се прочете (Изтече времето за изчакване) — пропуснат.',
      'Sitemap „example.com/c.xml“ не може да се прочете (Не е XML или текст (text/html)) — пропуснат.',
      '„example.com/d.xml“ не изглежда като sitemap — пропуснат.',
    ]);
  });

  it('reads only sitemaps of the site itself', async () => {
    const { result, log } = discover({
      texts: {
        'https://example.com/robots.txt': 'Sitemap: https://cdn.elsewhere.net/sitemap.xml\nSitemap: https://www.example.com/sitemap-www.xml',
        'https://cdn.elsewhere.net/sitemap.xml': urlset('https://example.com/from-cdn'),
        'https://www.example.com/sitemap-www.xml': index('https://evil.example.org/child.xml', 'https://shop.example.com/shop.xml'),
        'https://evil.example.org/child.xml': urlset('https://example.com/from-evil'),
        'https://shop.example.com/shop.xml': urlset('https://shop.example.com/item'),
      },
    });
    const d = await result;
    expect(d.urls).toEqual(['https://example.com/', 'https://shop.example.com/item']);
    expect(log.texts).not.toContain('https://cdn.elsewhere.net/sitemap.xml');
    expect(log.texts).not.toContain('https://evil.example.org/child.xml');
    expect(d.notes).toEqual(['Sitemap „cdn.elsewhere.net/sitemap.xml“ е извън сайта — пропуснат.', 'Sitemap „evil.example.org/child.xml“ е извън сайта — пропуснат.']);
  });

  it('reads a plain-text sitemap', async () => {
    const d = await run({ texts: { 'https://example.com/sitemap.xml': 'https://example.com/\nhttps://example.com/one\nhttps://example.com/two\n' } });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/one', 'https://example.com/two']);
  });

  it('tries http when https gives no answer at all, and then uses http for everything', async () => {
    const { result, log } = discover({
      texts: {
        'https://example.com/robots.txt': { status: 'error', httpStatus: null, text: null, error: 'Връзката е отказана' },
        'http://example.com/robots.txt': 'User-agent: *',
        'http://example.com/sitemap.xml': urlset('http://example.com/about'),
      },
    });
    const d = await result;
    expect(log.texts).toEqual(['https://example.com/robots.txt', 'http://example.com/robots.txt', 'http://example.com/sitemap.xml']);
    expect(d.urls).toEqual(['http://example.com/', 'http://example.com/about']);
  });

  it('does not try http when https answered, even with an error status', async () => {
    const { result, log } = discover({
      texts: {
        'https://example.com/robots.txt': { status: 'http_error', httpStatus: 500, text: null, error: 'HTTP 500' },
        'https://example.com/sitemap.xml': urlset('https://example.com/a'),
      },
    });
    const d = await result;
    expect(log.texts).toEqual(['https://example.com/robots.txt', 'https://example.com/sitemap.xml']);
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/a']);
  });
});

// ─────────────────────────────── discoverSite: which addresses count ───────────────────────────────

describe('discoverSite — the site and its pages', () => {
  const sitemapOf = (domain: string, locs: string[]): World => ({ texts: { [`https://${domain}/sitemap.xml`]: urlset(...locs) } });

  it('counts www, other subdomains and ports of the registrable domain as the site, and nothing else', async () => {
    const d = await run(
      sitemapOf('example.com', [
        'https://example.com/',
        'https://www.example.com/a',
        'https://blog.example.com/b',
        'http://shop.example.com:8080/c',
        'https://example.com.evil.com/d',
        'https://notexample.com/e',
        'https://example.org/f',
        'https://evilexample.com/g',
        'https://sub.example.co.uk/h',
      ]),
    );
    expect(d.urls).toEqual(['https://example.com/', 'https://www.example.com/a', 'https://blog.example.com/b', 'http://shop.example.com:8080/c']);
    expect(d.found).toBe(4);
  });

  it('knows multi-part suffixes and hosting platforms: example.co.uk is a site, co.uk and other blogspot blogs are not', async () => {
    const co = await run(sitemapOf('example.co.uk', ['https://www.example.co.uk/a', 'https://shop.example.co.uk/b', 'https://other.co.uk/c', 'https://example.co.uk.evil.com/d', 'https://co.uk/e']), { domain: 'example.co.uk' });
    expect(co.urls).toEqual(['https://example.co.uk/', 'https://www.example.co.uk/a', 'https://shop.example.co.uk/b']);
    const blog = await run(sitemapOf('mysite.blogspot.com', ['https://mysite.blogspot.com/p/one', 'https://other.blogspot.com/p/two']), { domain: 'mysite.blogspot.com' });
    expect(blog.urls).toEqual(['https://mysite.blogspot.com/', 'https://mysite.blogspot.com/p/one']);
  });

  it('accepts the domain the way a person writes it', async () => {
    for (const domain of ['Example.COM', 'https://example.com/', ' example.com ', 'https://example.com/some/path?x=1']) {
      const d = await run(sitemapOf('example.com', ['https://example.com/a']), { domain });
      expect(d.urls, domain).toEqual(['https://example.com/', 'https://example.com/a']);
    }
    for (const domain of ['', '   ', 'http://']) {
      const d = await run({}, { domain });
      expect(d).toMatchObject({ urls: [], found: 0, source: 'single' });
      expect(d.notes.every(hasCyrillic)).toBe(true);
    }
  });

  it('normalises and de-duplicates', async () => {
    const d = await run(
      sitemapOf('example.com', [
        'https://Example.COM/Page#section',
        'https://example.com:443/port/',
        'http://example.com:80/http-port',
        'https://example.com/a?utm_source=x&utm_medium=y&gclid=1&fbclid=2&ref=home',
        'https://example.com/q?id=5&utm_source=x',
        'https://example.com/q2?a=1&b=2',
        'https://example.com/q3?a=1&b=2&c=3',
        'https://example.com/dup',
        'https://example.com/dup/',
        'https://www.example.com/dup',
        'https://example.com/a#again',
        'https://example.com/услуги/',
        'https://user:pw@example.com/secret',
        'ftp://example.com/ftp',
        'mailto:info@example.com',
      ]),
    );
    expect(d.urls).toEqual([
      'https://example.com/',
      'https://example.com/Page',
      'https://example.com/port/',
      'http://example.com/http-port',
      'https://example.com/a',
      'https://example.com/q?id=5',
      'https://example.com/q2?a=1&b=2',
      'https://example.com/dup',
      'https://example.com/%D1%83%D1%81%D0%BB%D1%83%D0%B3%D0%B8/',
    ]);
    expect(d.found).toBe(9);
  });

  it('leaves out images, documents, scripts, data, feeds and system or shop-flow addresses, and keeps look-alikes', async () => {
    const dropped = [
      '/logo.png', '/photo.JPG', '/a.pdf', '/files.zip', '/s.css', '/app.js', '/data.json', '/sitemap-2.xml', '/video.mp4', '/notes.txt',
      '/feed/', '/blog/feed', '/blog/post/feed/', '/feed.xml', '/wp-json/wp/v2/posts', '/wp-admin/', '/wp-admin/admin-ajax.php', '/wp-content/uploads/x',
      '/wp-login.php', '/cart', '/cart/', '/checkout/', '/shop/checkout', '/my-account/orders', '/post?replytocom=5', '/shop/item?add-to-cart=7', '/?feed=rss2',
    ];
    const kept = ['/cartoons', '/about.html', '/contact.php', '/feedback', '/pdf-guide', '/my-accounts', '/services/', '/blog/checkout-guide', '/page.v2/x']; // shallow first, as the discovery orders them
    const d = await run(sitemapOf('example.com', [...dropped, ...kept].map((p) => `https://example.com${p}`)));
    expect(d.urls).toEqual(['https://example.com/', ...kept.map((p) => `https://example.com${p}`)]);
    expect(d.found).toBe(kept.length + 1);
  });

  it('treats a sitemap that has only addresses of other sites as no sitemap', async () => {
    const { result, log } = discover(
      { texts: { 'https://example.com/sitemap.xml': urlset('https://other.com/a') }, pages: { 'https://example.com/': '<a href="/x">x</a>' } },
      {},
    );
    const d = await result;
    expect(d.source).toBe('links');
    expect(log.pages[0]).toBe('https://example.com/');
  });
});

// ─────────────────────────────── discoverSite: order and cap ───────────────────────────────

describe('discoverSite — order and cap', () => {
  const locs = ['/z/y/x', '/b', '/', '/a/b', '/a', '/c/', '/m/n', '/d?x=1'].map((p) => `https://example.com${p}`);
  const world: World = { texts: { 'https://example.com/sitemap.xml': urlset(...locs) } };

  it('puts the homepage first, then the shallower pages, and keeps the order of the sitemap among equals', async () => {
    const d = await run(world);
    expect(d.urls).toEqual([
      'https://example.com/',
      'https://example.com/b',
      'https://example.com/a',
      'https://example.com/c/',
      'https://example.com/d?x=1',
      'https://example.com/a/b',
      'https://example.com/m/n',
      'https://example.com/z/y/x',
    ]);
    expect(d).toMatchObject({ found: 8, truncated: false });
  });

  it('cuts to maxPages keeping that order, and says how many there were', async () => {
    const d = await run(world, { maxPages: 3 });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/b', 'https://example.com/a']);
    expect(d).toMatchObject({ found: 8, truncated: true, source: 'sitemap' });
    expect((await run(world, { maxPages: 8 })).truncated).toBe(false);
    expect((await run(world, { maxPages: 7 })).truncated).toBe(true);
    expect((await run(world, { maxPages: 1 })).urls).toEqual(['https://example.com/']);
  });

  it('lists the homepage even when the sitemap does not, and counts it as found', async () => {
    const d = await run({ texts: { 'https://example.com/sitemap.xml': urlset('https://example.com/a', 'https://example.com/b/c') } }, { maxPages: 2 });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/a']);
    expect(d.found).toBe(3);
    expect(d.truncated).toBe(true);
  });

  it('takes the homepage in the form the sitemap gives it (www), without adding a second one', async () => {
    const d = await run({ texts: { 'https://example.com/sitemap.xml': urlset('https://www.example.com/about', 'https://www.example.com/') } });
    expect(d.urls).toEqual(['https://www.example.com/', 'https://www.example.com/about']);
    expect(d.found).toBe(2);
  });

  it('treats a nonsense maxPages as 1', async () => {
    for (const maxPages of [0, -3, Number.NaN, 0.4]) expect((await run(world, { maxPages })).urls, String(maxPages)).toEqual(['https://example.com/']);
    expect((await run(world, { maxPages: 2.9 })).urls).toHaveLength(2);
  });

  it('reports progress in Bulgarian', async () => {
    const { result, progress } = discover(world);
    await result;
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.every(hasCyrillic)).toBe(true);
    expect(progress.some((m) => /sitemap/i.test(m))).toBe(true);
    expect(progress.at(-1)).toBe('Намерени страници: 8');
  });
});

// ─────────────────────────────── discoverSite: no sitemap → the links of the homepage ───────────────────────────────

describe('discoverSite — links of the homepage', () => {
  const page = (...links: string[]): string => `<!doctype html><html><head><title>t</title></head><body>${links.map((l) => `<a href="${l}">x</a>`).join('')}</body></html>`;

  it('crawls from the homepage when there is no sitemap: depth 2, the site only, relative links against the final address', async () => {
    const { result, log, progress } = discover({
      pages: {
        'https://example.com/': {
          finalUrl: 'https://www.example.com/start/', // the homepage redirects, so every relative link belongs to /start/ on www
          html: `<!doctype html><html><head><title>t</title><link href="/link-tag"></head><body>
            <a href="/about">about</a><a href="services/">relative</a><a href="../up">up</a>
            <a href="https://www.example.com/contact?utm_source=n">contact</a><a href="https://other.com/x">other</a>
            <a href="mailto:a@b.co">m</a><a href="tel:+359">t</a><a href="javascript:void(0)">j</a><a href="#top">top</a><a href="/files/a.pdf">pdf</a><a href="/about#team">dup</a>
            <script>var s = '<a href="/in-script">x</a>';</script><!-- <a href="/in-comment">x</a> -->
            <form action="/form-action"></form><img src="/img.png"><area href="/area-link">
            </body></html>`,
        },
        'https://www.example.com/about': page('/about/history', '/services/seo'),
        'https://www.example.com/start/services/': page('/start/services/web'),
        'https://www.example.com/up': page('/up/two'),
        'https://www.example.com/contact': page('/contact/map'),
        'https://www.example.com/about/history': page('/depth-3-must-not-appear'),
      },
    });
    const d = await result;
    expect(d.source).toBe('links');
    expect(d.urls).toEqual([
      'https://www.example.com/start/', // the homepage, wherever "/" leads
      'https://www.example.com/about',
      'https://www.example.com/up',
      'https://www.example.com/contact',
      'https://www.example.com/start/services/',
      'https://www.example.com/about/history',
      'https://www.example.com/services/seo',
      'https://www.example.com/up/two',
      'https://www.example.com/contact/map',
      'https://www.example.com/start/services/web',
    ]);
    expect(d.found).toBe(10);
    expect(d.truncated).toBe(false);
    // the pages at depth 2 are listed, not read, so nothing at depth 3 is ever found
    expect(log.pages).toEqual([
      'https://example.com/',
      'https://www.example.com/about',
      'https://www.example.com/start/services/',
      'https://www.example.com/up',
      'https://www.example.com/contact',
    ]);
    expect(d.urls.join(' ')).not.toContain('depth-3');
    for (const absent of ['in-script', 'in-comment', 'link-tag', 'form-action', 'img.png', 'area-link', 'a.pdf', 'other.com']) expect(d.urls.join(' '), absent).not.toContain(absent);
    expect(d.notes).toEqual(['Не е намерен sitemap — страниците са открити чрез връзките от началната страница, затова списъкът може да е непълен.']);
    expect(progress.some((m) => m.startsWith('Обхождам'))).toBe(true);
  });

  it('lists the homepage once when "/" leads somewhere else (the logo links to "/"), and keeps it first', async () => {
    const d = await run({ pages: { 'https://example.com/': { finalUrl: 'https://example.com/bg/', html: page('/', '/bg/', '/about', 'https://blog.example.com/') } } });
    expect(d.urls).toEqual(['https://example.com/bg/', 'https://blog.example.com/', 'https://example.com/about']);
    expect(d.found).toBe(3);
  });

  it('honours <base href> like a browser, and ignores links inside <template>', async () => {
    const d = await run({
      pages: { 'https://example.com/': '<html><head><base href="https://example.com/shop/"></head><body><a href="item">i</a><a href="/root">r</a><template><a href="/in-template">t</a></template></body></html>' },
    });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/root', 'https://example.com/shop/item']);
  });

  it('reads robots.txt only for its Sitemap lines: whether a page may be fetched is the fetcher\'s business, through fetchPage', async () => {
    const { result, log } = discover({ pages: { 'https://example.com/': page('/a') } });
    await result;
    expect(log.pages).toEqual(['https://example.com/', 'https://example.com/a']);
    expect(log.texts.filter((u) => u.endsWith('robots.txt'))).toHaveLength(1); // read for its Sitemap lines only
  });

  it('stops reading pages as soon as it has maxPages', async () => {
    const links = Array.from({ length: 100 }, (_, i) => `/p${i}`);
    const { result, log } = discover({ pages: { 'https://example.com/': page(...links) } }, { maxPages: 10 });
    const d = await result;
    expect(d.urls).toHaveLength(10);
    expect(d.urls[0]).toBe('https://example.com/');
    expect(d).toMatchObject({ found: 101, truncated: true, source: 'links' });
    expect(log.pages).toEqual(['https://example.com/']); // the homepage alone already gave more than enough
  });

  it('makes at most 60 requests, 4 at a time, and says that it stopped', async () => {
    const pages: Record<string, string> = {};
    const links = Array.from({ length: 100 }, (_, i) => `/p${i}`);
    pages['https://example.com/'] = page(...links);
    links.forEach((l, i) => (pages[`https://example.com${l}`] = page(`/deeper-${i}`)));
    const { result, log } = discover({ pages }, { maxPages: 500 }, { delayMs: 3 });
    const d = await result;
    expect(log.pages).toHaveLength(60);
    expect(log.maxInFlight).toBeLessThanOrEqual(4);
    expect(log.maxInFlight).toBeGreaterThan(1);
    expect(d.found).toBe(101 + 59);
    expect(d).toMatchObject({ source: 'links', truncated: true });
    expect(d.notes.some((n) => n.includes('най-много 60 страници'))).toBe(true);
    expect(d.urls).toHaveLength(160);
  });

  it('is complete (and not "truncated") when it read every page it could', async () => {
    const d = await run({ pages: { 'https://example.com/': page('/a', '/b'), 'https://example.com/a': page('/b', '/c'), 'https://example.com/b': page('/') } });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
    expect(d.truncated).toBe(false);
  });

  it('puts the homepage first and the shallower pages before the deeper ones', async () => {
    const d = await run({ pages: { 'https://example.com/': page('/x/y/z', '/x/y', '/x'), 'https://example.com/x/y/z': '', 'https://example.com/x/y': '', 'https://example.com/x': '' } });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/x', 'https://example.com/x/y', 'https://example.com/x/y/z']);
  });

  it('works with a fetcher that cannot read text, and falls back to http when https gives no answer', async () => {
    const { result, log } = discover(
      { pages: { 'https://example.com/': { status: 'error', httpStatus: null, error: 'Връзката е отказана', html: null }, 'http://example.com/': page('/a') } },
      {},
      { text: false },
    );
    const d = await result;
    expect(log.texts).toEqual([]);
    expect(log.pages.slice(0, 2)).toEqual(['https://example.com/', 'http://example.com/']);
    expect(d.urls).toEqual(['http://example.com/', 'http://example.com/a']);
    expect(d.source).toBe('links');
  });

  it('lists just the homepage, and says so, when the page has no links', async () => {
    const d = await run({ pages: { 'https://example.com/': '<html><body><p>Една страница.</p></body></html>' } });
    expect(d).toMatchObject({ urls: ['https://example.com/'], found: 1, source: 'single', truncated: false });
    expect(d.notes).toContain('Не са намерени вътрешни връзки — одитира се само началната страница.');
  });

  it('does not follow a homepage that leaves for another site', async () => {
    const d = await run({ pages: { 'https://example.com/': { finalUrl: 'https://new-brand.org/', html: page('/a') } } });
    expect(d).toMatchObject({ urls: [], found: 0, source: 'single' });
    expect(d.notes.some((n) => n.includes('пренасочва към друг сайт') && n.includes('new-brand.org'))).toBe(true);
  });
});

// ─────────────────────────────── discoverSite: failures ───────────────────────────────

describe('discoverSite — failures', () => {
  it('returns no pages and says why, in Bulgarian, when not even the homepage can be read', async () => {
    const cases: Array<[string, Partial<FetchedPage>, string]> = [
      ['a missing domain', { status: 'error', error: 'Домейнът не е намерен (DNS)' }, 'Домейнът не е намерен (DNS)'],
      ['robots.txt forbidding it', { status: 'blocked_robots', error: 'robots.txt забранява достъпа до тази страница' }, 'robots.txt забранява достъпа до тази страница'],
      ['a bot block', { status: 'http_error', httpStatus: 403, error: 'HTTP 403' }, 'HTTP 403'],
      ['not HTML', { status: 'not_html', error: 'Не е HTML (application/json)' }, 'Не е HTML (application/json)'],
    ];
    for (const [label, failure, reason] of cases) {
      const d = await run({ pages: { 'https://example.com/': failure, 'http://example.com/': failure } });
      expect(d, label).toMatchObject({ urls: [], found: 0, source: 'single', truncated: false });
      expect(d.notes.some((n) => n.includes(reason) && hasCyrillic(n)), label).toBe(true);
    }
  });

  it('tries http once for the homepage after a network error, and not after an answer', async () => {
    const dns = discover({ pages: {} });
    await dns.result;
    expect(dns.log.pages).toEqual(['https://example.com/']); // an HTTP 404 is an answer
    const down = discover({ pages: { 'https://example.com/': { status: 'error', error: 'Връзката е отказана' }, 'http://example.com/': { status: 'error', error: 'Връзката е отказана' } } });
    expect((await down.result).urls).toEqual([]);
    expect(down.log.pages).toEqual(['https://example.com/', 'http://example.com/']);
  });

  it('does not throw when a fetcher throws instead of returning a failure', async () => {
    const throwing: PageFetcher = {
      fetchPage: async () => {
        throw new Error('boom page');
      },
      fetchText: async () => {
        throw new Error('boom text');
      },
    };
    const d = await discoverSite({ domain: 'example.com', fetcher: throwing, maxPages: 10 });
    expect(d).toMatchObject({ urls: [], source: 'single' });
    expect(d.notes.some((n) => n.includes('boom page'))).toBe(true);
  });

  it('keeps the pages of a sitemap even when the homepage itself is unreachable', async () => {
    const d = await run({ texts: { 'https://example.com/sitemap.xml': urlset('https://example.com/a') }, pages: {} });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/a']);
  });
});

describe('discoverSite — abort', () => {
  it('throws, and asks for nothing, when the signal is already aborted', async () => {
    const { fetcher, log } = fakeFetcher({});
    await expect(discoverSite({ domain: 'example.com', fetcher, maxPages: 10, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(log.texts).toEqual([]);
    expect(log.pages).toEqual([]);
  });

  it('throws when the signal is aborted during a sitemap request (and does not report it as a fetch problem)', async () => {
    const ctrl = new AbortController();
    const fetcher: PageFetcher = {
      fetchPage: async () => notFoundPage('x'),
      fetchText: async () => {
        ctrl.abort();
        return { status: 'error', httpStatus: null, text: null, finalUrl: null, error: 'Заявката е прекратена' };
      },
    };
    await expect(discoverSite({ domain: 'example.com', fetcher, maxPages: 10, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws when the signal is aborted during the crawl, and passes the signal on to the fetcher', async () => {
    const ctrl = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const fetcher: PageFetcher = {
      fetchPage: async (url, options) => {
        seen.push(options?.signal);
        if (++calls === 2) ctrl.abort();
        return { status: 'ok', httpStatus: 200, finalUrl: url, html: '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>', error: null, ttfbMs: 1, bytes: 10, fromCache: false };
      },
    };
    await expect(discoverSite({ domain: 'example.com', fetcher, maxPages: 100, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen.every((s) => s === ctrl.signal)).toBe(true);
    expect(calls).toBeLessThan(6);
  });

  it('throws if the signal was aborted by the time the answer arrives', async () => {
    const ctrl = new AbortController();
    const fetcher: PageFetcher = {
      fetchPage: async () => notFoundPage('x'),
      fetchText: async (url) => {
        const result: TextResult = { status: 'ok', httpStatus: 200, text: urlset('https://example.com/a'), finalUrl: url, error: null };
        queueMicrotask(() => ctrl.abort());
        return result;
      },
    };
    await expect(discoverSite({ domain: 'example.com', fetcher, maxPages: 10, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ─────────────────────────────── discoverSite: hostile sitemaps ───────────────────────────────

describe('discoverSite — hostile sitemaps stay bounded and fast', () => {
  it('50 001 addresses in one file: the first 50 000 are read, quickly, and the report says so', async () => {
    const locs = ['https://example.com/', ...Array.from({ length: MAX_SITEMAP_URLS }, (_, i) => `https://example.com/section-${i % 50}/page-${i}/?utm_source=a`)];
    const t0 = performance.now();
    const d = await run({ texts: { 'https://example.com/sitemap.xml': urlset(...locs) } }, { maxPages: 40 });
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(d.urls).toHaveLength(40);
    expect(d.urls[0]).toBe('https://example.com/');
    expect(d).toMatchObject({ found: MAX_SITEMAP_URLS, truncated: true, source: 'sitemap' });
    expect(d.notes).toEqual(['Sitemap „example.com/sitemap.xml“ има 50 000 или повече адреса — прочетени са първите 50 000.']);
    expect(d.urls.every((u) => !u.includes('utm_'))).toBe(true);
  });

  it('twenty files of 50 000 each stop at the limit of pages, with a warning', async () => {
    const children = Array.from({ length: 20 }, (_, i) => `https://example.com/part-${i}.xml`);
    const texts: Record<string, string> = { 'https://example.com/sitemap.xml': index(...children) };
    children.forEach((c, i) => (texts[c] = urlset(...Array.from({ length: 8_000 }, (_, j) => `https://example.com/p/${i}/${j}`))));
    const { result, log } = discover({ texts }, { maxPages: 50 });
    const t0 = performance.now();
    const d = await result;
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(d.found).toBe(100_000);
    expect(d.urls).toHaveLength(50);
    expect(d.truncated).toBe(true);
    expect(d.notes).toContain('Намерени са над 100 000 страници — списъкът е съкратен.');
    expect(log.texts.length).toBeLessThanOrEqual(1 + 1 + 20);
  });

  it('text that is not a sitemap, even 20 MB of it, gives nothing and falls through to the crawl', async () => {
    for (const text of ['a'.repeat(20_000_000), '<'.repeat(20_000_000), '<a>'.repeat(6_000_000), `<urlset>${'<url>'.repeat(2_000_000)}`]) {
      const t0 = performance.now();
      const d = await run({ texts: { 'https://example.com/sitemap.xml': text }, pages: { 'https://example.com/': '<a href="/only">x</a>' } });
      expect(performance.now() - t0).toBeLessThan(3_000);
      expect(d.source).toBe('links');
      expect(d.urls).toEqual(['https://example.com/', 'https://example.com/only']);
    }
  });

  it('a file full of the same address, an address of 5 MB and a thousand huge children are all cheap', async () => {
    const same = await run({ texts: { 'https://example.com/sitemap.xml': urlset(...Array.from({ length: 20_000 }, () => 'https://example.com/same')) } });
    expect(same).toMatchObject({ found: 2, source: 'sitemap' });
    const huge = await run({ texts: { 'https://example.com/sitemap.xml': `<urlset><url><loc>https://example.com/${'x'.repeat(5_000_000)}</loc></url><url><loc>https://example.com/ok</loc></url></urlset>` } });
    expect(huge.urls).toEqual(['https://example.com/', 'https://example.com/ok']);
    const { result, log } = discover({ texts: { 'https://example.com/sitemap.xml': index(...Array.from({ length: 1_000 }, (_, i) => `https://example.com/c${i}.xml`)) } });
    await result;
    expect(log.texts.length).toBeLessThanOrEqual(1 + 1 + 20 + 3);
  });

  it('never reaches a private address through a sitemap: not when robots.txt names it, not when a sitemap of the site redirects there', async () => {
    const metadata = 'http://169.254.169.254/latest/meta-data/';
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === 'https://example.com/robots.txt') return new Response(`Sitemap: ${metadata}\nSitemap: https://example.com/redirecting.xml`, { status: 200 });
      if (url === 'https://example.com/redirecting.xml') return new Response(null, { status: 302, headers: { location: metadata } });
      if (url === 'https://example.com/sitemap.xml') return new Response(urlset('https://example.com/ok'), { status: 200, headers: { 'content-type': 'application/xml' } });
      return new Response('nope', { status: 404 });
    }) as never;
    const fetcher = new SafeFetcher({ userAgent: 'JevSeoRadar/0.1', timeoutMs: 5_000, maxBytes: 100_000, fetchImpl });
    const d = await discoverSite({ domain: 'example.com', fetcher, maxPages: 10 });
    expect(requested).not.toContain(metadata);
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/ok']);
    expect(d.notes.every(hasCyrillic)).toBe(true);
    expect(d.notes.some((n) => n.includes('redirecting.xml') && n.includes('не може да се прочете'))).toBe(true);
    await fetcher.close();
  });
});

// ─────────────────────────────── with the real fetcher (fake network) ───────────────────────────────

describe('discoverSite with SafeFetcher', () => {
  it('reads robots.txt, a gzipped sitemap index and its children over the (fake) network, whatever robots.txt forbids', async () => {
    const routes: Record<string, () => Response> = {
      'https://example.com/robots.txt': () => new Response('User-agent: *\nDisallow: /\nSitemap: https://example.com/index.xml.gz', { status: 200, headers: { 'content-type': 'text/plain' } }),
      'https://example.com/index.xml.gz': () => new Response(gzipSync(index('https://example.com/posts.xml', 'https://example.com/pages.xml.gz')), { status: 200, headers: { 'content-type': 'application/gzip' } }),
      'https://example.com/posts.xml': () => new Response(urlset('https://example.com/blog/one', 'https://www.example.com/blog/two/'), { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } }),
      'https://example.com/pages.xml.gz': () => new Response(gzipSync(urlset('https://example.com/', 'https://example.com/contacts')), { status: 200, headers: { 'content-type': 'application/x-gzip' } }),
    };
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return routes[String(input)]?.() ?? new Response('not found', { status: 404 });
    }) as never;
    const fetcher = new SafeFetcher({ userAgent: 'JevSeoRadar/0.1', timeoutMs: 5_000, maxBytes: 100_000, fetchImpl });
    const d = await discoverSite({ domain: 'example.com', fetcher, maxPages: 10 });
    expect(d).toMatchObject({ source: 'sitemap', found: 4, truncated: false, notes: [] });
    expect(d.urls).toEqual(['https://example.com/', 'https://example.com/contacts', 'https://example.com/blog/one', 'https://www.example.com/blog/two/']);
    expect(requested).toEqual(['https://example.com/robots.txt', 'https://example.com/index.xml.gz', 'https://example.com/posts.xml', 'https://example.com/pages.xml.gz']);
    await fetcher.close();
  });

  it('crawls with fetchPage (which honours robots.txt) when there is no sitemap, and reports a homepage that robots.txt forbids', async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://example.com/robots.txt') return new Response('User-agent: *\nDisallow: /', { status: 200 });
      return new Response('<a href="/a">a</a>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as never;
    const fetcher = new SafeFetcher({ userAgent: 'JevSeoRadar/0.1', timeoutMs: 5_000, maxBytes: 100_000, fetchImpl });
    const d = await discoverSite({ domain: 'example.com', fetcher, maxPages: 10 });
    expect(d).toMatchObject({ urls: [], found: 0, source: 'single' });
    expect(d.notes.some((n) => n.includes('robots.txt забранява достъпа'))).toBe(true);
    await fetcher.close();
  });
});

// every note the discovery can produce is Bulgarian, whichever way it was reached
describe('discoverSite — the notes', () => {
  it('are all in Bulgarian', async () => {
    const worlds: World[] = [
      { texts: { 'https://example.com/robots.txt': 'Sitemap: https://example.com/x.xml\nSitemap: https://other.net/y.xml', 'https://example.com/sitemap.xml': index('https://example.com/a.xml', 'https://elsewhere.net/b.xml'), 'https://example.com/a.xml': '<html></html>' } },
      { pages: {} },
      { pages: { 'https://example.com/': '<p>nothing</p>' } },
      { pages: { 'https://example.com/': '<a href="/a">a</a>' } },
    ];
    for (const world of worlds) {
      const d = await run(world);
      expect(d.notes.length).toBeGreaterThan(0);
      for (const n of d.notes) expect(hasCyrillic(n), n).toBe(true);
    }
  });
});
