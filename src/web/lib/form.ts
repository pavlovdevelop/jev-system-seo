import { isValidHostname, normalizeDomainInput } from '../../shared/urls';

export interface Parsed {
  ok: string[];
  bad: string[];
}

/** Free text (one per line, or separated by commas, semicolons, spaces) into trimmed non-empty tokens. */
export function tokens(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Domains typed in any form ("https://www.Site.bg/page") become "site.bg"; duplicates are dropped. */
export function parseDomains(text: string): Parsed {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const raw of tokens(text)) {
    const d = normalizeDomainInput(raw);
    if (isValidHostname(d)) {
      if (!ok.includes(d)) ok.push(d);
    } else bad.push(raw);
  }
  return { ok, bad };
}

/** A bare "site.bg/page" is accepted and gets https://; only http(s) addresses pass. */
export function parseUrls(text: string): Parsed {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const raw of tokens(text)) {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(candidate);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && isValidHostname(normalizeDomainInput(u.hostname))) {
        if (!ok.includes(candidate)) ok.push(candidate);
        continue;
      }
    } catch {
      // falls through to "bad"
    }
    bad.push(raw);
  }
  return { ok, bad };
}

export interface EstimateInput {
  deepPages: number;
  expandKeywords: boolean;
  maxCandidates: number;
  serpDepth: number;
  hasOwnUrl: boolean;
  manualMode: boolean;
  extraCompetitors: number;
  /** The server stops fetching pages at this many per run. */
  pageCap: number;
}

export interface Estimate {
  serpCalls: number;
  jevRequests: number;
  pages: number;
}

/**
 * Upper bounds taken from how the pipeline fans out (so the number is a ceiling, not a promise):
 * up to 3 Jev requests per deeply analysed page, 1 for the query itself, 1 relevance check for each of up to 80
 * generated phrases and one quick judgement per result for every checked phrase. Cached answers cost nothing.
 */
export function estimateRun(i: EstimateInput): Estimate {
  const phrases = i.expandKeywords ? i.maxCandidates : 0;
  const pages = Math.min(i.pageCap, i.deepPages + (i.hasOwnUrl ? 1 : 0) + i.extraCompetitors);
  const serpCalls = i.manualMode ? 0 : 1 + phrases;
  const screening = phrases > 0 ? 80 : 0;
  const seedQuick = i.manualMode ? 0 : Math.max(0, i.serpDepth - i.deepPages);
  const jevRequests = pages * 3 + 1 + screening + phrases * 10 + seedQuick;
  return { serpCalls, jevRequests, pages };
}
