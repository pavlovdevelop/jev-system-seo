import { SerpError } from '../providers/serp/types';

/** Counts what a single analysis run spends and enforces its budget. */
export class Meter {
  serpCalls = 0;
  serpCacheHits = 0;
  volumeCalls = 0;
  pagesFetched = 0;
  pagesBlocked = 0;
  pagesFailed = 0;
  pageCacheHits = 0;

  constructor(public readonly limits: { maxSerpCalls: number; maxPages: number }) {}

  /** Call right before a paid SERP request. Throws once the run's budget is used up. */
  takeSerpCall(): void {
    if (this.serpCalls >= this.limits.maxSerpCalls) {
      throw new SerpError('budget', `Достигнат е лимитът от ${this.limits.maxSerpCalls} SERP заявки за един анализ (MAX_SERP_CALLS_PER_RUN).`);
    }
    this.serpCalls++;
  }

  /** True while another page fetch is still within budget. */
  canFetchPage(): boolean {
    return this.pagesFetched + this.pagesBlocked + this.pagesFailed < this.limits.maxPages;
  }
}
