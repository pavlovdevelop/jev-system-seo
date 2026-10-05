import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

// SSRF protection for the crawler. The server fetches URLs that come from search results and from the
// user; none of them may reach loopback, private networks, link-local ranges (cloud metadata at
// 169.254.169.254!) or other internal addresses. Two layers:
//   1. assertPublicUrl(): cheap structural checks before any network I/O.
//   2. ssrfLookup(): a DNS `lookup` hook used by the HTTP agent, so the address that is actually
//      connected to is validated at connect time (no TOCTOU / DNS-rebinding gap).

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
];
for (const [net, prefix] of v4) blocked.addSubnet(net, prefix, 'ipv4');
const v6: Array<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (can embed private IPv4)
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of v6) blocked.addSubnet(net, prefix, 'ipv6');

/** Extracts the embedded IPv4 address of an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:aabb:ccdd). */
function mappedIpv4(address: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1] ?? null;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const hi = parseInt(hex[1] as string, 16);
    const lo = parseInt(hex[2] as string, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True for any address that must never be fetched. Unparseable input counts as unsafe. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = isIP(bare);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = mappedIpv4(bare);
    if (mapped) return blocked.check(mapped, 'ipv4');
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
          const e: NodeJS.ErrnoException = new SsrfError(`${hostname} сочи към вътрешен адрес (${bad.address})`);
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
