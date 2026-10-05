import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { hostAllowList, hostnameOf, isAllowedHost } from '../../src/server/util/host';
import { FailureLimiter } from '../../src/server/util/throttle';

describe('FailureLimiter', () => {
  it('allows `max` failures per window, then names the wait, and forgets old failures', () => {
    let now = 0;
    const l = new FailureLimiter(3, 10_000, 100, () => now);
    expect(l.blockedFor('a')).toBe(0);
    l.fail('a');
    now += 1_000;
    l.fail('a');
    now += 1_000;
    l.fail('a');
    expect(l.blockedFor('a')).toBe(8); // the first failure leaves the window 8 s from now
    expect(l.blockedFor('b')).toBe(0);
    now += 8_001;
    expect(l.blockedFor('a')).toBe(0);
  });

  it('reset clears a key, and spoofed keys cannot grow the memory without bound', () => {
    const l = new FailureLimiter(1, 60_000, 3);
    l.fail('a');
    expect(l.blockedFor('a')).toBeGreaterThan(0);
    l.reset('a');
    expect(l.blockedFor('a')).toBe(0);
    for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) l.fail(k);
    expect(l.blockedFor('k1')).toBe(0); // evicted
    expect(l.blockedFor('k5')).toBeGreaterThan(0);
  });
});

describe('Host header', () => {
  it('extracts the host name without the port', () => {
    expect(hostnameOf('Localhost:8787')).toBe('localhost');
    expect(hostnameOf('[::1]:8787')).toBe('[::1]');
    expect(hostnameOf('[::1')).toBe('');
    expect(hostnameOf(undefined)).toBeNull();
  });

  it('is only enforced for instances without a password', () => {
    const base = { appPassword: null, host: '127.0.0.1', allowedHosts: [] as string[] };
    const list = hostAllowList(base)!;
    expect(isAllowedHost(list, 'localhost:1')).toBe(true);
    expect(isAllowedHost(list, 'evil.example')).toBe(false);
    expect(isAllowedHost(list, undefined)).toBe(true);
    expect(hostAllowList({ ...base, appPassword: 'x'.repeat(20) })).toBeNull();
    // public bind without a password: only an explicit list restricts, otherwise nothing is known about the right names
    expect(hostAllowList({ ...base, host: '0.0.0.0' })).toBeNull();
    expect(hostAllowList({ ...base, host: '0.0.0.0', allowedHosts: ['radar.example'] })!.has('radar.example')).toBe(true);
  });
});

describe('config: network exposure', () => {
  const env = (o: Record<string, string>): NodeJS.ProcessEnv => o;

  it('refuses a short password when the server is reachable from the network', () => {
    expect(() => loadConfig(env({ HOST: '0.0.0.0', APP_PASSWORD: 'short' }), [])).toThrow(/APP_PASSWORD.*12/);
    expect(loadConfig(env({ HOST: '0.0.0.0', APP_PASSWORD: 'a-long-enough-password' }), []).appPassword).toBe('a-long-enough-password');
    expect(loadConfig(env({ HOST: '127.0.0.1', APP_PASSWORD: 'short' }), []).appPassword).toBe('short'); // local only: any length
  });

  it('recognises exactly the loopback addresses, not names that merely start with 127.', () => {
    expect(() => loadConfig(env({ HOST: '127.example.com', APP_PASSWORD: 'short' }), [])).toThrow(/APP_PASSWORD/);
    expect(() => loadConfig(env({ HOST: '127.0.0.300', APP_PASSWORD: 'short' }), [])).toThrow(/APP_PASSWORD/);
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) expect(() => loadConfig(env({ HOST: host, APP_PASSWORD: 'short' }), []), host).not.toThrow();
  });

  it('validates ALLOWED_HOSTS and MAX_REPORTS', () => {
    expect(loadConfig(env({ ALLOWED_HOSTS: 'Radar.Local, [::1] ,' }), []).allowedHosts).toEqual(['radar.local', '[::1]']);
    expect(() => loadConfig(env({ ALLOWED_HOSTS: 'https://radar.example' }), [])).toThrow(/ALLOWED_HOSTS/);
    expect(() => loadConfig(env({ ALLOWED_HOSTS: 'radar.example:8080' }), [])).toThrow(/ALLOWED_HOSTS/);
    expect(loadConfig(env({}), []).limits.maxReports).toBe(500);
    expect(() => loadConfig(env({ MAX_REPORTS: '0' }), [])).toThrow(/MAX_REPORTS/);
  });
});
