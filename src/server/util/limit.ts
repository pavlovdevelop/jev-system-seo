/** Minimal concurrency limiter: at most `concurrency` tasks run at once; waiting tasks inherit freed slots in FIFO order. */
export function createLimiter(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next(); // hand the slot over directly so a newcomer cannot sneak in between
    else active--;
  };

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active < concurrency) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/** Maps `items` with bounded concurrency, preserving order. Rejects on the first error (like Promise.all). */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = createLimiter(Math.max(1, Math.min(concurrency, items.length || 1)));
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
