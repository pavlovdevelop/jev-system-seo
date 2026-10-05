/**
 * Counts failures per key inside a sliding window. Used to slow down password guessing: after `max` failures within
 * `windowMs` the key is refused until the oldest failure leaves the window.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  /** Seconds the caller has to wait (0 = it may try). */
  blockedFor(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil(((list[0] as number) + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
    // Spoofed keys must not grow the map without bound: drop the oldest entries first (Map keeps insertion order).
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
