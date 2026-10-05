import { isLoopbackHost, type AppConfig } from '../config';

/**
 * Host name of a Host header value, without the port: "Localhost:8787" → "localhost", "[::1]:8787" → "[::1]".
 * null = no header at all, '' = unreadable.
 */
export function hostnameOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : '';
  }
  return h.split(':')[0] ?? '';
}

/**
 * DNS rebinding: a page on evil.example can point its own name at 127.0.0.1 and then talk to this server as if it were
 * same-origin, passing the CSRF check. An instance that has no password therefore answers only to the host names it is
 * really reached by. With a password the browser holds no credentials for the attacker's origin, so no check is needed.
 * Returns null when no check applies.
 */
export function hostAllowList(config: Pick<AppConfig, 'appPassword' | 'host' | 'allowedHosts'>): ReadonlySet<string> | null {
  if (config.appPassword) return null;
  if (isLoopbackHost(config.host)) return new Set(['localhost', '127.0.0.1', '[::1]', config.host.trim().toLowerCase(), ...config.allowedHosts]);
  return config.allowedHosts.length > 0 ? new Set(config.allowedHosts) : null;
}

/** A request without a Host header cannot come from a browser (they always send one), so only a present, unlisted name is refused. */
export function isAllowedHost(allowed: ReadonlySet<string>, header: string | undefined): boolean {
  const name = hostnameOf(header);
  return name === null || allowed.has(name);
}
