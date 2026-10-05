import type { PageAnalysis, SerpResult } from '../../shared/schemas';
import { domainOf } from '../providers/serp/types';

// Which pages are worth crawling and judging in depth? One page per domain from the top of the SERP,
// plus the user's own page, plus any competitor URLs the user pasted in by hand.

export interface Target {
  url: string;
  position: number | null;
  title: string;
  snippet: string;
  domain: string;
  role: PageAnalysis['role'];
}

export interface TargetInput {
  results: readonly SerpResult[];
  deepPages: number;
  ownDomain: string | null;
  ownUrl: string | null;
  tracked: ReadonlySet<string>;
  manualUrls: readonly string[];
  /** Hard cap on the total number of pages for the run. */
  maxPages: number;
}

export function selectTargets(input: TargetInput): Target[] {
  const targets: Target[] = [];
  const seenDomains = new Set<string>();
  const seenUrls = new Set<string>();
  const add = (t: Target): void => {
    if (seenUrls.has(t.url)) return;
    seenUrls.add(t.url);
    targets.push(t);
  };
  const roleFor = (domain: string): Target['role'] => (domain === input.ownDomain ? 'own' : input.tracked.has(domain) ? 'tracked' : 'serp');

  const sorted = [...input.results].sort((a, b) => a.position - b.position);
  for (const r of sorted) {
    if (targets.filter((t) => t.role !== 'manual').length >= input.deepPages) break;
    if (seenDomains.has(r.domain)) continue;
    seenDomains.add(r.domain);
    add({ url: r.url, position: r.position, title: r.title, snippet: r.snippet, domain: r.domain, role: roleFor(r.domain) });
  }

  // The user's own page, even when it ranks outside the crawled top results.
  if (input.ownUrl) {
    const existing = targets.find((t) => t.url === input.ownUrl);
    if (existing) existing.role = 'own';
    else {
      const hit = sorted.find((r) => r.url === input.ownUrl);
      add({ url: input.ownUrl, position: hit?.position ?? null, title: hit?.title ?? '', snippet: hit?.snippet ?? '', domain: domainOf(input.ownUrl), role: 'own' });
    }
  } else if (input.ownDomain && !targets.some((t) => t.role === 'own')) {
    const hit = sorted.find((r) => r.domain === input.ownDomain);
    if (hit) add({ url: hit.url, position: hit.position, title: hit.title, snippet: hit.snippet, domain: hit.domain, role: 'own' });
  }

  for (const url of input.manualUrls) {
    const domain = domainOf(url);
    const hit = sorted.find((r) => r.url === url);
    add({ url, position: hit?.position ?? null, title: hit?.title ?? '', snippet: hit?.snippet ?? '', domain, role: domain === input.ownDomain ? 'own' : 'manual' });
  }

  // Keep the order (SERP first), but respect the cap; own/manual pages are never dropped in favour of lower SERP rows.
  if (targets.length <= input.maxPages) return targets;
  const keep = targets.filter((t) => t.role === 'own' || t.role === 'manual');
  const rest = targets.filter((t) => t.role !== 'own' && t.role !== 'manual').slice(0, Math.max(0, input.maxPages - keep.length));
  return [...rest, ...keep].sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
}
