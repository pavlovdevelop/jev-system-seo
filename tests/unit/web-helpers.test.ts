import { describe, expect, it } from 'vitest';
import { bgCount } from '../../src/shared/plural';
import { estimateRun, parseDomains, parseUrls, tokens } from '../../src/web/lib/form';

// The form helpers are pure functions, so they are tested here without a browser.

describe('tokens', () => {
  it('splits on whitespace, commas and semicolons and drops empties', () => {
    expect(tokens('a.bg, b.bg;\n  c.bg\t\n')).toEqual(['a.bg', 'b.bg', 'c.bg']);
    expect(tokens('   ')).toEqual([]);
  });
});

describe('parseDomains', () => {
  it('normalises whatever the user pasted and removes duplicates', () => {
    const r = parseDomains('https://www.Site.bg/page?x=1\nsite.bg, Other.com');
    expect(r.ok).toEqual(['site.bg', 'other.com']);
    expect(r.bad).toEqual([]);
  });

  it('reports what it could not read instead of dropping it silently', () => {
    const r = parseDomains('good.bg bad_domain localhost 127.0.0.1');
    expect(r.ok).toEqual(['good.bg']);
    expect(r.bad).toEqual(['bad_domain', 'localhost', '127.0.0.1']);
  });

  it('accepts Cyrillic domains (converted to punycode like the SERP data)', () => {
    const r = parseDomains('пример.бг');
    expect(r.bad).toEqual([]);
    expect(r.ok[0]).toMatch(/^xn--/);
  });
});

describe('parseUrls', () => {
  it('adds https:// to a bare address and keeps explicit http(s)', () => {
    const r = parseUrls('site.bg/uslugi http://old.example/page');
    expect(r.ok).toEqual(['https://site.bg/uslugi', 'http://old.example/page']);
    expect(r.bad).toEqual([]);
  });

  it('rejects other schemes, IPs and local names', () => {
    const r = parseUrls('javascript:alert(1) ftp://x.example/file http://localhost/admin https://10.0.0.1/');
    expect(r.ok).toEqual([]);
    expect(r.bad).toHaveLength(4);
  });
});

describe('estimateRun', () => {
  const base = { deepPages: 10, expandKeywords: true, maxCandidates: 20, serpDepth: 10, hasOwnUrl: false, manualMode: false, extraCompetitors: 0, pageCap: 16 };

  it('is an upper bound that grows with the number of phrases', () => {
    const small = estimateRun({ ...base, maxCandidates: 10 });
    const large = estimateRun({ ...base, maxCandidates: 40 });
    expect(large.serpCalls).toBe(41);
    expect(large.jevRequests).toBeGreaterThan(small.jevRequests);
  });

  it('needs no SERP calls and no keyword screening without a SERP provider or without expansion', () => {
    expect(estimateRun({ ...base, manualMode: true }).serpCalls).toBe(0);
    const off = estimateRun({ ...base, expandKeywords: false });
    expect(off.serpCalls).toBe(1);
    expect(off.jevRequests).toBe(10 * 3 + 1 + 0);
  });

  it('never counts more pages than the server will fetch', () => {
    expect(estimateRun({ ...base, deepPages: 15, hasOwnUrl: true, extraCompetitors: 12 }).pages).toBe(16);
  });
});

describe('bgCount', () => {
  it('agrees the noun with the number', () => {
    expect(bgCount(1, 'страница', 'страници')).toBe('1 страница');
    expect(bgCount(0, 'страница', 'страници')).toBe('0 страници');
    expect(bgCount(5, 'страница', 'страници')).toBe('5 страници');
  });
});
