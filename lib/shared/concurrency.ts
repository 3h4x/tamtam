/**
 * Map over `items` with bounded concurrency, preserving input order in the
 * output array. At most `limit` invocations of `fn` run at once.
 *
 * Use this instead of `Promise.all(items.map(fn))` whenever `fn` fans out heavy
 * work — subprocess spawns (git/gh shell-outs), DB round-trips, network calls —
 * over a list large enough that running them all at once saturates CPU / the
 * event loop / a connection pool and starves *other* concurrent work. An
 * unbounded fan-out of dozens of `git` subprocesses is a thundering herd: it can
 * balloon wall-clock under host contention and stall unrelated requests that
 * happen to run during the storm.
 *
 * Semantics mirror `Promise.all`: results come back in input order, and the
 * first rejection rejects the whole call (remaining not-yet-started items are
 * never scheduled; in-flight ones are left to settle). Pass a `fn` that catches
 * its own errors when you want partial results instead.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
