import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobots, RobotsChecker, rulesFor } from '../../src/server/crawl/robots';

const UA = 'JevSeoRadar/0.1 (+https://example.com)';
const allowed = (txt: string, path: string, ua = UA) => isPathAllowed(rulesFor(parseRobots(txt), ua), path);

describe('robots.txt', () => {
  it('allows everything when there are no rules or an empty Disallow', () => {
    expect(allowed('', '/anything')).toBe(true);
    expect(allowed('User-agent: *\nDisallow:', '/anything')).toBe(true);
  });

  it('applies prefix rules from the * group', () => {
    const txt = 'User-agent: *\nDisallow: /admin\nDisallow: /search?';
    expect(allowed(txt, '/admin/users')).toBe(false);
    expect(allowed(txt, '/administrator')).toBe(false); // prefix semantics
    expect(allowed(txt, '/search?q=x')).toBe(false);
    expect(allowed(txt, '/services')).toBe(true);
  });

  it('prefers the group that names our bot over *', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: jevseoradar\nDisallow: /private';
    expect(allowed(txt, '/public')).toBe(true);
    expect(allowed(txt, '/private/x')).toBe(false);
  });

  it('uses the longest matching rule, with Allow winning ties', () => {
    const txt = 'User-agent: *\nDisallow: /shop\nAllow: /shop/public\nDisallow: /tie\nAllow: /tie';
    expect(allowed(txt, '/shop/cart')).toBe(false);
    expect(allowed(txt, '/shop/public/item')).toBe(true);
    expect(allowed(txt, '/tie')).toBe(true);
  });

  it('supports * wildcards and the $ anchor', () => {
    const txt = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*/cache';
    expect(allowed(txt, '/files/a.pdf')).toBe(false);
    expect(allowed(txt, '/files/a.pdf?x=1')).toBe(true);
    expect(allowed(txt, '/tmp/abc/cache')).toBe(false);
    expect(allowed(txt, '/tmp/cache')).toBe(true);
  });

  it('handles stacked user-agent lines, comments, BOM and CRLF', () => {
    const txt = `${String.fromCharCode(0xfeff)}# comment\r\nUser-agent: googlebot\r\nUser-agent: jevseoradar # us\r\nDisallow: /x\r\nSitemap: https://e.com/s.xml\r\n`;
    expect(allowed(txt, '/x')).toBe(false);
    expect(allowed(txt, '/y')).toBe(true);
  });
});

describe('RobotsChecker', () => {
  const make = (res: { status: number; text: string } | null) => {
    let calls = 0;
    const checker = new RobotsChecker(async () => {
      calls++;
      return res;
    }, UA);
    return { checker, calls: () => calls };
  };

  it('fetches robots.txt once per origin and caches the verdict', async () => {
    const { checker, calls } = make({ status: 200, text: 'User-agent: *\nDisallow: /nope' });
    expect((await checker.check(new URL('https://a.example/nope'))).allowed).toBe(false);
    expect((await checker.check(new URL('https://a.example/ok'))).allowed).toBe(true);
    await checker.check(new URL('https://b.example/ok'));
    expect(calls()).toBe(2);
  });

  it('treats a missing robots.txt (4xx) or an unreachable one as allowed, but 5xx as disallow-all (RFC 9309)', async () => {
    expect((await make({ status: 404, text: '' }).checker.check(new URL('https://a.example/x'))).allowed).toBe(true);
    expect((await make(null).checker.check(new URL('https://a.example/x'))).allowed).toBe(true);
    const blocked = await make({ status: 503, text: '' }).checker.check(new URL('https://a.example/x'));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/503/);
  });
});
