import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isBlockedAddress, SsrfError, ssrfLookup } from '../../src/server/crawl/ssrf';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '64:ff9b::7f00:1',
    'not-an-ip', '',
  ])('blocks %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
    'javascript:alert(1)',
    'http://localhost/',
    'http://LOCALHOST:8080/',
    'http://foo.localhost/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/', // decimal form of 127.0.0.1
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.5/admin',
    'http://192.168.0.1/',
    'http://intranet/',
    'http://printer.local/',
    'https://user:pass@example.com/',
    'https://example.com:22/',
    'https://example.com:6379/',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertPublicUrl(url)).toThrow(SsrfError);
  });

  it.each(['https://example.com/', 'http://www.example.bg/page?x=1', 'https://example.bg:443/', 'http://example.com:8080/a'])('accepts %s', (url) => {
    expect(assertPublicUrl(url).hostname).toMatch(/example/);
  });

  it('allows private targets only when explicitly enabled (tests)', () => {
    expect(() => assertPublicUrl('http://127.0.0.1:3000/', { allowPrivateNetworks: true })).not.toThrow();
    expect(() => assertPublicUrl('file:///etc/passwd', { allowPrivateNetworks: true })).toThrow(SsrfError);
  });
});

describe('ssrfLookup', () => {
  const resolve = (host: string, allowPrivate: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown }>((done) => {
      ssrfLookup(allowPrivate)(host, { all: false }, (err, address) => done({ err, address }));
    });

  it('refuses hostnames that resolve to loopback', async () => {
    const { err } = await resolve('localhost', false);
    expect(err?.code).toBe('ESSRF');
  });

  it('resolves loopback when private networks are allowed', async () => {
    const { err, address } = await resolve('localhost', true);
    expect(err).toBeNull();
    expect(String(address)).toMatch(/127\.0\.0\.1|::1/);
  });

  it('supports the `all: true` calling convention used by happy-eyeballs', async () => {
    const out = await new Promise<{ err: NodeJS.ErrnoException | null; list?: unknown }>((done) => {
      ssrfLookup(true)('localhost', { all: true }, (err, list) => done({ err, list }));
    });
    expect(out.err).toBeNull();
    expect(Array.isArray(out.list)).toBe(true);
  });
});
