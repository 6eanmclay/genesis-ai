import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "crypto";

// ONE THREAD THROUGH EVERYTHING ONE REQUEST CAUSES.
//
// ============ THE GAP THIS CLOSES (2026-08-30) =========================
//
// There are three event tables and three different ways of tying rows together:
//
//   ExecutionLog    keys on executionId
//   ProductEvent    keys on sessionInstanceId + attemptKey
//   SecurityEvent   keys on sessionInstanceId, and requires a userId
//
// No column joins all three. So "a request arrived, J4 executed, verification
// failed, the owner was told" cannot be assembled from the database — not
// because the rows are missing, but because nothing connects them. An incident
// is reconstructed by reading timestamps and guessing, which is exactly the
// method that produces confident wrong answers.
//
// ============ WHY AsyncLocalStorage, NOT A PARAMETER ===================
//
// The alternative is threading an id through every function between the route
// and the write. That is a large edit to working code, it is forgotten the
// first time somebody adds a call site, and a correlation id that is usually
// present is barely better than none.
//
// lib/sourcing/sourcingBudget.ts already establishes the pattern in this
// codebase for exactly this reason, so this is a second use of a known tool
// rather than a new one.
//
// ============ IT IS NEVER REQUIRED ====================================
//
// `current()` returns null outside a run scope, and every writer treats null as
// an ordinary value. A background job, a script, a test and a cron all live
// outside a request, and none of them should have to invent an id to satisfy a
// column. What matters is that everything INSIDE one unit of work shares one,
// not that every row in the database has one.

export interface Correlation {
  /** Shared by every row one unit of work produces. */
  id: string;
  /** "http", "job", "cron", "script" — what kind of thing started it. */
  origin: string;
  /** The route, action or job kind, when it is known. */
  surface?: string;
}

const scope = new AsyncLocalStorage<Correlation>();

/** The correlation in effect, or null outside any run scope. */
export function currentCorrelation(): Correlation | null {
  return scope.getStore() ?? null;
}

/** Just the id, which is what most writers want. */
export function correlationId(): string | null {
  return scope.getStore()?.id ?? null;
}

/**
 * Run something inside a fresh correlation.
 *
 * Nesting deliberately REUSES the outer id rather than starting a new one: a
 * job enqueued by a request and the request that enqueued it are one causal
 * chain, and giving the inner half its own id is how a trace gets cut in two
 * at the most interesting moment.
 */
export function withCorrelation<T>(
  init: { origin: string; surface?: string; id?: string },
  fn: () => T,
): T {
  const existing = scope.getStore();
  const correlation: Correlation = {
    id: init.id ?? existing?.id ?? randomUUID(),
    origin: init.origin,
    surface: init.surface ?? existing?.surface,
  };
  return scope.run(correlation, fn);
}

/**
 * A fresh id, for a caller that is starting a chain rather than joining one.
 *
 * Separate from withCorrelation because an enqueuer often needs to WRITE the id
 * onto a job row before anything runs inside the scope.
 */
export function newCorrelationId(): string {
  return randomUUID();
}
