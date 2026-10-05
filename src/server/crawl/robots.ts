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

// A robots.txt is untrusted input from the site we are about to visit. RFC 9309 asks crawlers to read at least 500 KiB;
// beyond these limits lines and rules are ignored rather than parsed, so a hostile file cannot make matching expensive.
const MAX_LINE = 2_048;
const MAX_PATTERN = 1_024;
const MAX_RULES = 5_000;

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  let ruleCount = 0;
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    if (rawLine.length > MAX_LINE) continue;
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
      if (current && value !== '' && value.length <= MAX_PATTERN && ruleCount < MAX_RULES) {
        current.rules.push({ allow: key === 'allow', pattern: value });
        ruleCount++;
      }
      lastWasAgent = false;
      continue;
    }
    // sitemap, crawl-delay, host, … do not end a group but are irrelevant to us
  }
  return groups;
}

/**
 * Does a robots.txt path pattern match the start of `path`? `*` matches any run of characters and a trailing `$`
 * anchors the end. Written without regular expressions on purpose: a pattern such as `/*a*a*a*a*b` becomes a regex
 * that backtracks for minutes on a long path, and the pattern comes from the site being crawled.
 * Each wildcard-separated piece is located with indexOf, leftmost first, which is exactly what `.*` allows and
 * costs O(path × pieces) in the worst case.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = pieces[0] as string;
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return anchored ? path === first : true;
  let position = first.length;
  for (let i = 1; i < pieces.length - 1; i++) {
    const found = path.indexOf(pieces[i] as string, position);
    if (found === -1) return false;
    position = found + (pieces[i] as string).length;
  }
  const last = pieces[pieces.length - 1] as string;
  // the last piece must end the path when anchored, and may otherwise sit anywhere after the previous pieces
  return anchored ? path.length - last.length >= position && path.endsWith(last) : path.indexOf(last, position) !== -1;
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
    if (!patternMatches(rule.pattern, pathWithQuery)) continue;
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
