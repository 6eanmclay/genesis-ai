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

// Automatic retry for transient failures (2026-08-09) — real mobile
// production finding: a real 18-photo batch reported "Uploaded 8 of 18"
// with the rest failing on a generic connection/timeout message. Confirmed
// against Vercel's own current docs before writing this: @vercel/blob's
// client upload() has no built-in whole-request retry (multipart's own
// internal part-retry only applies to one large file split into chunks,
// not a dropped connection on an ordinary single-file PUT) — so a mobile
// network blip mid-batch was a real, permanent failure with nothing to
// recover it beyond the owner noticing and tapping Retry by hand.
// By the time a file reaches the network call this wraps, it has already
// passed local validation (content type, size) — every remaining failure
// here really is transient (dropped connection, timeout, a momentary 5xx),
// so retrying automatically is safe and correct, not something that needs
// per-error-type sniffing. Exponential backoff, not a tight loop, so a
// brief real network hiccup gets a real chance to clear before the next
// attempt.
export async function withRetry<T>(
  task: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; onRetry?: (attempt: number, error: unknown) => void } = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 800;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      options.onRetry?.(attempt, error);
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastError;
}
