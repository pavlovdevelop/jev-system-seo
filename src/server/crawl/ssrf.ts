import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

// SSRF protection for the crawler. The server fetches URLs that come from search results and from the
// user; none of them may reach loopback, private networks, link-local ranges (cloud metadata at
// 169.254.169.254!) or other internal addresses. Two layers:
//   1. assertPublicUrl(): structural checks before any network I/O. It must run for EVERY request, including each
//      redirect hop and robots.txt: it is the only check for IP literals (Node never calls the DNS hook for them).
//   2. ssrfLookup(): a DNS `lookup` hook used by the HTTP agent, so the address a host NAME resolves to is validated at
//      connect time (no TOCTOU / DNS-rebinding gap).

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const blocked = new BlockList();
const v4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
  ['168.63.129.16', 32], // Azure WireServer / host agent: a "public" address that is really the platform's control plane
];
for (const [net, prefix] of v4) blocked.addSubnet(net, prefix, 'ipv4');
const v6: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible range (::a.b.c.d)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // benchmarking
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated, still routed inside some networks)
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of v6) blocked.addSubnet(net, prefix, 'ipv6');

/** The 16 bytes of a valid IPv6 address in any textual form (compressed, with an embedded dotted IPv4, mixed case). */
function ipv6Bytes(address: string): Uint8Array | null {
  let a = address.toLowerCase();
  const dot = a.lastIndexOf('.');
  if (dot !== -1) {
    const colon = a.lastIndexOf(':');
    const v4 = a.slice(colon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    a = `${a.slice(0, colon + 1)}${(((v4[0] as number) << 8) | (v4[1] as number)).toString(16)}:${(((v4[2] as number) << 8) | (v4[3] as number)).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 255;
  });
  return bytes;
}

const dotted = (b: Uint8Array, at: number): string => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

/**
 * An IPv6 address that only wraps an IPv4 one is judged by the IPv4 inside. IPv4-mapped (::ffff:a.b.c.d), IPv4-translated
 * (::ffff:0:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16, the IPv4 sits in bits 16–47) all reach the same host
 * as the IPv4 address would. Returns null when the address does not wrap one.
 */
function embeddedIpv4(b: Uint8Array): string | null {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return dotted(b, 12); // ::ffff:a.b.c.d
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return dotted(b, 12); // ::ffff:0:a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return dotted(b, 12); // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return dotted(b, 2); // 2002::/16
  return null;
}

/** True for any address that must never be fetched. Unparseable input counts as unsafe. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = isIP(bare);
  if (family === 0) return true;
  if (family === 6) {
    const bytes = ipv6Bytes(bare);
    if (!bytes) return true;
    const v4 = embeddedIpv4(bytes);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(bare, 'ipv6');
  }
  return blocked.check(bare, 'ipv4');
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet'];

/** Structural validation of a URL we are about to fetch. Returns the parsed URL or throws SsrfError. */
export function assertPublicUrl(input: string | URL, options: { allowPrivateNetworks?: boolean } = {}): URL {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    throw new SsrfError('Невалиден URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('Разрешени са само http и https');
  if (url.username || url.password) throw new SsrfError('URL с потребител/парола не е разрешен');
  if (options.allowPrivateNetworks) return url;

  if (!ALLOWED_PORTS.has(url.port)) throw new SsrfError(`Портът ${url.port} не е разрешен`);

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new SsrfError('Липсва име на хост');
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) throw new SsrfError('Вътрешни хостове не са разрешени');
  // The URL parser has already normalised decimal/hex/octal IPv4 spellings into dotted form.
  if (isIP(host) !== 0 && isBlockedAddress(host)) throw new SsrfError('IP адресът е в частна или резервирана мрежа');
  if (isIP(host) === 0 && !host.includes('.')) throw new SsrfError('Хостът не изглежда публичен');
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/**
 * DNS lookup that refuses to resolve to blocked addresses. If ANY resolved address is blocked the whole
 * lookup fails, which also defeats mixed public/private A-record tricks.
 */
export function ssrfLookup(allowPrivateNetworks = false) {
  return (hostname: string, options: { all?: boolean; family?: number; hints?: number } | number, callback: LookupCallback): void => {
    const opts = typeof options === 'number' ? { family: options } : { ...options };
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as LookupAddress[];
      if (!allowPrivateNetworks) {
        const bad = list.find((a) => isBlockedAddress(a.address));
        if (bad) {
          // The resolved address stays out of the message: it would tell whoever can start an analysis what their DNS says inside.
          const e: NodeJS.ErrnoException = new SsrfError('Хостът сочи към вътрешен адрес — отказан');
          e.code = 'ESSRF';
          return callback(e);
        }
      }
      if (opts.all) return callback(null, list);
      const first = list[0];
      if (!first) return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException);
      return callback(null, first.address, first.family);
    });
  };
}
