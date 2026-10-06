import { describe, expect, it } from 'vitest';
import { bgCount } from '../../src/shared/plural';
import { estimateRun, parseDomains, parseUrls, tokens } from '../../src/web/lib/form';
import { AUDIT_TABS, isAuditTab, parseRoute } from '../../src/web/lib/hooks';

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

describe('parseRoute', () => {
  it('understands the app routes', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('#/competitors')).toEqual({ name: 'competitors' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('#/report/r_muvqmdncd33aad8e')).toEqual({ name: 'report', id: 'r_muvqmdncd33aad8e', tab: 'overview' });
    expect(parseRoute('#/report/r_muvqmdncd33aad8e/opportunities')).toEqual({ name: 'report', id: 'r_muvqmdncd33aad8e', tab: 'opportunities' });
    expect(parseRoute('#/run/j_muvqt11184fd7aeb')).toEqual({ name: 'run', jobId: 'j_muvqt11184fd7aeb' });
  });

  it('turns malformed escapes and path tricks into "not found" instead of a blank page or an odd API call', () => {
    for (const hash of ['#/%', '#/run/%E0%A4%A', '#/run/..', '#/report/..', '#/report/%2e%2e', '#/report/..%2F..%2Fetc', '#/report/r_UPPER', '#/run/x', '#/nope', '#/report/r_ab/../x']) {
      expect(parseRoute(hash), hash).toEqual({ name: 'notfound' });
    }
  });
});

describe('parseRoute: whole-site audits', () => {
  const id = 'a_demo5kq2m7x9';

  it('understands the site page and the audit with or without a tab', () => {
    expect(parseRoute('#/site')).toEqual({ name: 'site' });
    expect(parseRoute('#/site/')).toEqual({ name: 'site' });
    expect(parseRoute(`#/audit/${id}`)).toEqual({ name: 'audit', id, tab: 'overview' });
    expect(parseRoute(`#/audit/${id}/`)).toEqual({ name: 'audit', id, tab: 'overview' });
    for (const tab of ['overview', 'elements', 'competitors', 'questions', 'citability', 'geo', 'plan']) {
      expect(parseRoute(`#/audit/${id}/${tab}`), tab).toEqual({ name: 'audit', id, tab });
    }
    expect([...AUDIT_TABS]).toEqual(['overview', 'elements', 'competitors', 'questions', 'citability', 'geo', 'plan']);
    expect(isAuditTab('geo')).toBe(true);
    expect(isAuditTab('serp')).toBe(false);
    expect(isAuditTab('')).toBe(false);
  });

  it('turns a bad id, a bad tab or extra path into "not found"', () => {
    const bad = [
      '#/audit',
      '#/audit/',
      '#/audit/..',
      '#/audit/%2e%2e',
      '#/audit/a_ab',
      '#/audit/A_UPPER123',
      '#/audit/r_muvqmdncd33aad8e', // a keyword report id is not an audit id
      '#/audit/j_muvqt11184fd7aeb',
      `#/audit/${id}/nope`,
      `#/audit/${id}/serp`,
      `#/audit/${id}/OVERVIEW`,
      `#/audit/${id}/overview/extra`,
      `#/audit/${id}/..`,
      `#/audit/${id}/%E0%A4%A`,
      `#/audit/${id}%2F..%2Fetc`,
    ];
    for (const hash of bad) expect(parseRoute(hash), hash).toEqual({ name: 'notfound' });
  });

  it('leaves the keyword routes as they were', () => {
    expect(parseRoute('#/report/r_muvqmdncd33aad8e/brief')).toEqual({ name: 'report', id: 'r_muvqmdncd33aad8e', tab: 'brief' });
    expect(parseRoute(`#/run/${id}`)).toEqual({ name: 'run', jobId: id });
  });
});
