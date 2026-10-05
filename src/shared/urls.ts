// URL helpers that work in both Node and the browser (no dependencies).

/** "https://www.Example.com:8080/path?x=1" → "example.com". Returns '' when nothing usable is left. */
export function normalizeDomainInput(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // protocol
  s = s.split(/[/?#]/)[0] ?? ''; // path, query, hash
  s = s.replace(/^[^@]*@/, ''); // userinfo
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/\.+$/, ''); // trailing dots
  s = s.replace(/^www\d?\./, '');
  if (!s) return '';
  try {
    // Converts IDN (кирилица) to punycode so SERP domains and user input compare equal.
    return new URL(`http://${s}`).hostname.replace(/^www\d?\./, '');
  } catch {
    return s;
  }
}

/** True for a public-looking ASCII hostname with at least one dot and an alphabetic TLD (rejects IPs and "localhost"). */
export function isValidHostname(host: string): boolean {
  if (host.length < 4 || host.length > 253) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host);
}

/** Returns the URL only when it is plain http(s); anything else (javascript:, data:, …) becomes null. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Hostname of a URL without a leading "www.", or null when the URL cannot be parsed. */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\d?\./, '');
  } catch {
    return null;
  }
}
