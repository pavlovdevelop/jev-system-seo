import type { FetchInfo } from '../../shared/schemas';
import { InProcessExtractor, type PageExtractor } from '../crawl/extract-pool';
import type { FetchedPage, PageFetcher } from '../crawl/fetcher';
import type { ExtractedPage } from '../jev/questions';
import type { Meter } from '../util/meter';
import { mapLimit } from '../util/limit';
import type { Target } from './targets';

export interface Crawled {
  target: Target;
  fetch: FetchInfo;
  extracted: ExtractedPage | null;
  /** The URL actually crawled (after redirects). */
  url: string;
}

export function toFetchInfo(p: FetchedPage): FetchInfo {
  return { status: p.status, httpStatus: p.httpStatus, error: p.error, finalUrl: p.finalUrl, ttfbMs: p.ttfbMs, bytes: p.bytes, fromCache: p.fromCache };
}

/** Used when the caller does not bring its own extractor (tests, demo). */
const inProcess = new InProcessExtractor();

const skipped = (error: string): FetchInfo => ({ status: 'skipped', httpStatus: null, error, finalUrl: null, ttfbMs: null, bytes: null, fromCache: false });

export async function crawlTargets(
  targets: readonly Target[],
  options: { keyword: string; fetcher: PageFetcher; extractor?: PageExtractor; meter: Meter; now: Date; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<Crawled[]> {
  let done = 0;
  return mapLimit(targets, 4, async (target): Promise<Crawled> => {
    options.signal?.throwIfAborted();
    let result: Crawled;
    if (!options.meter.canFetchPage()) {
      result = { target, fetch: skipped('Достигнат е лимитът на страници за един анализ (MAX_PAGES_PER_RUN)'), extracted: null, url: target.url };
    } else {
      const fetched = await options.fetcher.fetchPage(target.url, options.signal ? { signal: options.signal } : undefined);
      if (fetched.fromCache) options.meter.pageCacheHits++;
      else if (fetched.status === 'ok') options.meter.pagesFetched++;
      else if (fetched.status === 'blocked_robots') options.meter.pagesBlocked++;
      else options.meter.pagesFailed++;
      const url = fetched.finalUrl ?? target.url;
      let extracted: ExtractedPage | null = null;
      let fetchInfo = toFetchInfo(fetched);
      if (fetched.status === 'ok' && fetched.html) {
        try {
          extracted = await (options.extractor ?? inProcess).extract(fetched.html, { url, keyword: options.keyword, now: options.now });
        } catch (err) {
          fetchInfo = { ...fetchInfo, status: 'error', error: `Грешка при разбор на HTML: ${err instanceof Error ? err.message.slice(0, 120) : 'неизвестна'}` };
        }
      }
      result = { target, fetch: fetchInfo, extracted, url };
    }
    options.onProgress?.(++done, targets.length);
    return result;
  });
}
