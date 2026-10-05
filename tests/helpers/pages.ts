import { extractPage } from '../../src/server/crawl/extract';
import { pageSignals, type PeerStats } from '../../src/server/analysis/signals';
import { compositeScores } from '../../src/server/analysis/scoring';
import type { ExtractedPage } from '../../src/server/jev/questions';
import type { FetchInfo, PageAnalysis, PageJudgments } from '../../src/shared/schemas';

export interface PageSpec {
  url: string;
  position: number | null;
  title: string;
  h1?: string;
  h2s?: string[];
  paragraphs?: string[];
  metaDescription?: string;
  extraHead?: string;
  extraBody?: string;
  judgments?: PageJudgments;
  keyword: string;
  role?: PageAnalysis['role'];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function buildHtml(spec: Pick<PageSpec, 'title' | 'h1' | 'h2s' | 'paragraphs' | 'metaDescription' | 'extraHead' | 'extraBody'>): string {
  const h2s = spec.h2s ?? [];
  const paragraphs = spec.paragraphs ?? [];
  const body = [
    spec.h1 ? `<h1>${esc(spec.h1)}</h1>` : '',
    ...h2s.map((h, i) => `<h2>${esc(h)}</h2><p>${esc(paragraphs[i] ?? '')}</p>`),
    ...paragraphs.slice(h2s.length).map((p) => `<p>${esc(p)}</p>`),
    spec.extraBody ?? '',
  ].join('\n');
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><title>${esc(spec.title)}</title>${
    spec.metaDescription ? `<meta name="description" content="${esc(spec.metaDescription)}">` : ''
  }<meta name="viewport" content="width=device-width">${spec.extraHead ?? ''}</head><body><main>${body}</main></body></html>`;
}

const okFetch = (url: string): FetchInfo => ({ status: 'ok', httpStatus: 200, error: null, finalUrl: url, ttfbMs: 300, bytes: 4000, fromCache: false });

const PEERS: PeerStats = { pages: 5, medianWords: 900, faqShare: 0.4, dominantIntent: 'transactional', dominantPageType: 'service_page' };

export function makePage(spec: PageSpec): { analysis: PageAnalysis; extracted: ExtractedPage } {
  const url = spec.url;
  const extracted = extractPage(buildHtml(spec), { url, keyword: spec.keyword, now: new Date('2026-10-05') });
  const judgments = spec.judgments ?? {};
  const composite = compositeScores({ metrics: extracted.metrics, judgments });
  const fetch = okFetch(url);
  const host = new URL(url).hostname.replace(/^www\./, '');
  const analysis: PageAnalysis = {
    position: spec.position,
    url,
    domain: host,
    title: spec.title,
    snippet: '',
    role: spec.role ?? 'serp',
    fetch,
    metrics: extracted.metrics,
    judgments,
    judgmentStatus: spec.judgments ? 'complete' : 'none',
    composite,
    signals: pageSignals({ metrics: extracted.metrics, judgments, fetch, composite }, PEERS, new Date('2026-10-05')),
  };
  return { analysis, extracted };
}

/** Repeats filler so a page reaches a realistic word count. */
export const filler = (sentence: string, times: number): string => Array.from({ length: times }, () => sentence).join(' ');
