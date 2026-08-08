// Resilient batch upload architecture (2026-08-08) — the real fix for a
// production finding: a 100+ photo selection sent every file to Vercel
// Blob simultaneously via Promise.all, which fails ALL-OR-NOTHING the
// instant a single one rejects (a real risk at that concurrency — each
// upload also invokes a serverless function to authenticate it). A
// business owner uploading a large batch needs the rest of the batch to
// keep going regardless of individual failures, with real progress and a
// way to retry just what failed — never "start over."
//
// A small, dependency-free concurrency pool: `limit` workers pull from a
// shared cursor over `items`, each processing one at a time, until the
// cursor is exhausted. Every item's outcome is caught individually — one
// failure never aborts the pool or discards results already collected,
// unlike Promise.all. Pure TypeScript, no browser or Node-specific APIs,
// so the same implementation is safe to import from both a "use client"
// component (throttling concurrent Blob uploads) and a Server Action
// (throttling concurrent DB writes).
export type SettledResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettle?: (index: number, result: SettledResult<R>) => void
): Promise<SettledResult<R>[]> {
  const results: SettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        const value = await worker(items[index], index);
        results[index] = { ok: true, value };
      } catch (error) {
        results[index] = { ok: false, error };
      }
      onSettle?.(index, results[index]);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
