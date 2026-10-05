// robots.txt support (RFC 9309 semantics): group selection by user agent, longest-match rule wins,
// Allow beats Disallow on ties, `*` wildcards and a `$` end anchor.

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (current && lastWasAgent) current.agents.push(value.toLowerCase());
      else {
        current = { agents: [value.toLowerCase()], rules: [] };
        groups.push(current);
      }
      lastWasAgent = true;
      continue;
    }
    if (key === 'allow' || key === 'disallow') {
      if (current && value !== '') current.rules.push({ allow: key === 'allow', pattern: value });
      lastWasAgent = false;
      continue;
    }
    // sitemap, crawl-delay, host, … do not end a group but are irrelevant to us
  }
  return groups;
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

/** Rules that apply to `userAgent`: the groups naming it (substring match, case-insensitive), else the `*` groups. */
export function rulesFor(groups: readonly RobotsGroup[], userAgent: string): RobotsRule[] {
  const ua = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && a !== '' && ua.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

export function isPathAllowed(rules: readonly RobotsRule[], pathWithQuery: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of rules) {
    if (!patternToRegExp(rule.pattern).test(pathWithQuery)) continue;
    const length = rule.pattern.replace(/\$$/, '').length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

export interface RobotsFetchResult {
  status: number;
  text: string;
}

/** Fetches (once per origin) and applies robots.txt. The transport is injected so it can share the SSRF-safe agent. */
export class RobotsChecker {
  private readonly cache = new Map<string, Promise<{ rules: RobotsRule[]; blockAll: boolean; note: string | null }>>();

  constructor(
    private readonly fetchRobots: (robotsUrl: string) => Promise<RobotsFetchResult | null>,
    private readonly userAgent: string,
  ) {}

  async check(url: URL): Promise<{ allowed: boolean; reason: string | null }> {
    const origin = url.origin;
    let entry = this.cache.get(origin);
    if (!entry) {
      entry = this.load(origin);
      this.cache.set(origin, entry);
    }
    const { rules, blockAll, note } = await entry;
    if (blockAll) return { allowed: false, reason: note };
    const allowed = isPathAllowed(rules, `${url.pathname}${url.search}`);
    return { allowed, reason: allowed ? null : 'robots.txt забранява достъпа до тази страница' };
  }

  private async load(origin: string) {
    const res = await this.fetchRobots(`${origin}/robots.txt`);
    if (res === null) return { rules: [], blockAll: false, note: null }; // unreachable: cannot tell, the page fetch will fail on its own
    if (res.status >= 500) return { rules: [], blockAll: true, note: `robots.txt е недостъпен (${res.status})` };
    if (res.status >= 400) return { rules: [], blockAll: false, note: null }; // no robots.txt → everything allowed
    return { rules: rulesFor(parseRobots(res.text), this.userAgent), blockAll: false, note: null };
  }
}
