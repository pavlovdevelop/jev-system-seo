import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobots, patternMatches, RobotsChecker, rulesFor } from '../../src/server/crawl/robots';

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

  it('allows a missing robots.txt (4xx) but assumes complete disallow when it is unreachable or answers 5xx (RFC 9309)', async () => {
    expect((await make({ status: 404, text: '' }).checker.check(new URL('https://a.example/x'))).allowed).toBe(true);
    const blocked = await make({ status: 503, text: '' }).checker.check(new URL('https://a.example/x'));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/503/);
    const unreachable = await make(null).checker.check(new URL('https://a.example/x'));
    expect(unreachable.allowed).toBe(false);
    expect(unreachable.reason).toMatch(/robots\.txt/);
  });

  it('reads files that end lines with a bare carriage return (valid per RFC 9309)', () => {
    expect(allowed('User-agent: *\rDisallow: /private\r', '/private/data')).toBe(false);
    expect(allowed('User-agent: *\r\nDisallow: /private\r\n', '/private/data')).toBe(false);
  });

  it('matches a group on the crawler\'s product token only, not on the rest of the User-Agent header', () => {
    const ua = 'JevSeoRadar/0.1 (+https://github.com/pavlovdevelop/jev-system-seo)';
    // "seo" and "github" appear in the header's URL but are not our name
    expect(allowed('User-agent: seo\nAllow: /\n\nUser-agent: *\nDisallow: /', '/page', ua)).toBe(false);
    expect(allowed('User-agent: github\nAllow: /\n\nUser-agent: *\nDisallow: /', '/page', ua)).toBe(false);
    // our own token, in any case, addresses us and wins over *
    expect(allowed('User-agent: JEVSEORADAR\nAllow: /\n\nUser-agent: *\nDisallow: /', '/page', ua)).toBe(true);
    expect(allowed('User-agent: jevseoradar\nDisallow: /private\n\nUser-agent: *\nAllow: /', '/private/x', ua)).toBe(false);
  });
});

// The reference semantics: what the old regular-expression implementation computed (fine for small inputs).
function referenceMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

describe('patternMatches', () => {
  it('agrees with the regular-expression semantics on many random patterns and paths', () => {
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['a', 'b', '/', '*', '$', '.', '?'];
    const make = (max: number): string => Array.from({ length: rand(max) }, () => alphabet[rand(alphabet.length)]).join('');
    for (let i = 0; i < 20_000; i++) {
      const pattern = make(9);
      const path = make(12).replace(/[*$]/g, 'a');
      expect(patternMatches(pattern, path), `${JSON.stringify(pattern)} vs ${JSON.stringify(path)}`).toBe(referenceMatches(pattern, path));
    }
  });

  it('handles the documented examples', () => {
    expect(patternMatches('/fish', '/fish.html')).toBe(true);
    expect(patternMatches('/fish*', '/fish')).toBe(true);
    expect(patternMatches('/*.php', '/folder/filename.php?x=1')).toBe(true);
    expect(patternMatches('/*.php$', '/filename.php?x=1')).toBe(false);
    expect(patternMatches('/*.php$', '/filename.php')).toBe(true);
    expect(patternMatches('/fish$', '/fish/')).toBe(false);
    expect(patternMatches('/a*a$', '/a')).toBe(false); // the two a's must not overlap
  });

  it('stays instant on the pattern that made the regular expression backtrack for minutes', () => {
    const pattern = `/${'*a'.repeat(12)}*b`;
    const path = `/${'a'.repeat(5_000)}`;
    const t0 = performance.now();
    expect(patternMatches(pattern, path)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('a hostile robots.txt', () => {
  it('cannot make matching expensive, and nothing is dropped: the rule that forbids us counts however many rules precede it', () => {
    const lines = ['User-agent: *', `Disallow: /${'x'.repeat(5_000)}`];
    for (let i = 0; i < 20_000; i++) lines.push(`Disallow: /*a*a*a*a*b${i}`);
    for (let i = 0; i < 6_000; i++) lines.push(`Disallow: /other-bot-section-${i}/`);
    lines.push('Disallow: /private', 'Allow: /public');
    const t0 = performance.now();
    const rules = rulesFor(parseRobots(lines.join('\n')), 'JevSeoRadar/0.1');
    expect(rules.length).toBeGreaterThan(26_000);
    expect(isPathAllowed(rules, '/private/data')).toBe(false);
    expect(isPathAllowed(rules, `/${'x'.repeat(5_000)}/y`)).toBe(false); // a long pattern still applies
    expect(isPathAllowed(rules, '/public')).toBe(true);
    isPathAllowed(rules, `/${'a'.repeat(2_000)}`);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('a rule in another bot\'s group, however many there are, does not hide the rules that apply to us', () => {
    const lines = ['User-agent: otherbot'];
    for (let i = 0; i < 6_000; i++) lines.push(`Disallow: /other-bot-section-${i}/`);
    lines.push('', 'User-agent: *', 'Disallow: /private');
    expect(isPathAllowed(rulesFor(parseRobots(lines.join('\n')), 'JevSeoRadar/0.1'), '/private/data')).toBe(false);
  });
});
