import { prismaSystem } from "@/lib/prisma";

// EVERYTHING THAT HAPPENED BECAUSE OF ONE THING.
//
// ============ THE GAP THE CORRELATION ID OPENED (2026-08-30) ===========
//
// Item 1 put one id on six tables. Nothing assembled them, so the ability to
// answer "a request arrived, J4 executed, verification failed, the owner was
// told" existed in the database and in nobody's hands.
//
// This is that assembly and nothing more: six indexed reads on one column,
// merged into one timeline. No interpretation, no inference about causality
// beyond the order things happened — an operator reading a trace is doing the
// reasoning, and a viewer that guessed at cause would be putting its guess
// where their judgement should be.
//
// ============ EACH ROW KEEPS ITS OWN MEANING =========================
//
// The six sources answer different questions and the merge does not flatten
// them into one shape:
//
//   ExecutionLog       what an action did, and whether it VERIFIED
//   OutboundOperation  whether an external effect actually happened
//   WebhookDelivery    what a provider sent us, verbatim
//   Job                what was queued, retried, or gave up
//   SecuritySignal     what a security layer would want to know
//   ProductEvent       the observation beside all of it
//
// Collapsing them to "events" would lose exactly the distinctions that make a
// trace worth reading. So each entry carries its source and its own detail.

export type TraceSource =
  | "execution"
  | "outbound"
  | "webhook"
  | "job"
  | "security"
  | "telemetry";

export interface TraceEntry {
  at: Date;
  source: TraceSource;
  /** What happened, in that source's own vocabulary. */
  label: string;
  /** success | failure | pending | null — normalised only this far. */
  outcome: string | null;
  storeId: string | null;
  detail: Record<string, unknown>;
}

export interface Trace {
  correlationId: string;
  entries: TraceEntry[];
  /** Which sources contributed. An absent one is a fact worth seeing. */
  sources: TraceSource[];
  startedAt: Date | null;
  endedAt: Date | null;
}

/**
 * Assemble one chain.
 *
 * Six indexed reads in parallel, merged by time. Bounded per source, because a
 * pathological chain should produce a long page rather than a timed-out one.
 */
export async function traceFor(correlationId: string, limitPerSource = 200): Promise<Trace> {
  const [executions, outbound, deliveries, jobs, signals, telemetry] = await Promise.all([
    prismaSystem.executionLog.findMany({
      where: { correlationId },
      orderBy: { createdAt: "asc" },
      take: limitPerSource,
      select: {
        createdAt: true, action: true, status: true, verified: true,
        message: true, actorType: true, storeId: true, executionId: true,
      },
    }),
    prismaSystem.outboundOperation.findMany({
      where: { correlationId },
      orderBy: { createdAt: "asc" },
      take: limitPerSource,
      select: {
        createdAt: true, operation: true, status: true, externalRef: true,
        attempts: true, storeId: true, idempotencyKey: true, lastError: true,
      },
    }),
    prismaSystem.webhookDelivery.findMany({
      where: { correlationId },
      orderBy: { receivedAt: "asc" },
      take: limitPerSource,
      select: {
        receivedAt: true, provider: true, status: true, signatureValid: true,
        externalEventId: true, attempts: true, storeId: true, error: true,
      },
    }),
    prismaSystem.job.findMany({
      where: { correlationId },
      orderBy: { createdAt: "asc" },
      take: limitPerSource,
      select: {
        createdAt: true, kind: true, status: true, attempts: true,
        storeId: true, lastError: true, idempotencyKey: true,
      },
    }),
    prismaSystem.securitySignal.findMany({
      where: { correlationId },
      orderBy: { occurredAt: "asc" },
      take: limitPerSource,
      select: { occurredAt: true, kind: true, severity: true, actorKind: true, storeId: true, surface: true },
    }),
    prismaSystem.productEvent.findMany({
      where: { correlationId },
      orderBy: { createdAt: "asc" },
      take: limitPerSource,
      select: { createdAt: true, name: true, subsystem: true, outcome: true, durationMs: true, storeId: true },
    }),
  ]);

  const entries: TraceEntry[] = [
    ...executions.map((e) => ({
      at: e.createdAt,
      source: "execution" as const,
      label: e.action,
      outcome: e.status,
      storeId: e.storeId,
      // `verified` is carried because it is the distinction this codebase
      // spent a milestone on: a SUCCESS that was not read back is not the same
      // fact as one that was.
      detail: { verified: e.verified, actor: e.actorType, message: e.message, executionId: e.executionId },
    })),
    ...outbound.map((o) => ({
      at: o.createdAt,
      source: "outbound" as const,
      label: o.operation,
      outcome: o.status,
      storeId: o.storeId,
      detail: {
        externalRef: o.externalRef, attempts: o.attempts,
        key: o.idempotencyKey, error: o.lastError,
      },
    })),
    ...deliveries.map((d) => ({
      at: d.receivedAt,
      source: "webhook" as const,
      label: d.provider,
      outcome: d.status,
      storeId: d.storeId,
      detail: {
        signatureValid: d.signatureValid, eventId: d.externalEventId,
        arrivals: d.attempts, error: d.error,
      },
    })),
    ...jobs.map((j) => ({
      at: j.createdAt,
      source: "job" as const,
      label: j.kind,
      outcome: j.status,
      storeId: j.storeId,
      detail: { attempts: j.attempts, key: j.idempotencyKey, error: j.lastError },
    })),
    ...signals.map((s) => ({
      at: s.occurredAt,
      source: "security" as const,
      label: s.kind,
      outcome: s.severity,
      storeId: s.storeId,
      detail: { actorKind: s.actorKind, surface: s.surface },
    })),
    ...telemetry.map((t) => ({
      at: t.createdAt,
      source: "telemetry" as const,
      label: t.name,
      outcome: t.outcome,
      storeId: t.storeId,
      detail: { subsystem: t.subsystem, durationMs: t.durationMs },
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    correlationId,
    entries,
    sources: [...new Set(entries.map((e) => e.source))],
    startedAt: entries[0]?.at ?? null,
    endedAt: entries[entries.length - 1]?.at ?? null,
  };
}

/**
 * Recent chains worth looking at.
 *
 * FAILURES FIRST, because an operator opening this is looking for something
 * that went wrong. A list ordered purely by time buries the one interesting
 * chain under a hundred healthy ones.
 */
export async function recentTraces(limit = 25): Promise<
  { correlationId: string; at: Date; label: string; source: TraceSource }[]
> {
  const [failedExecutions, failedOutbound, failedDeliveries] = await Promise.all([
    prismaSystem.executionLog.findMany({
      where: { correlationId: { not: null }, status: { in: ["FAILED", "WARNING"] } },
      orderBy: { createdAt: "desc" }, take: limit,
      select: { correlationId: true, createdAt: true, action: true },
    }),
    prismaSystem.outboundOperation.findMany({
      where: { correlationId: { not: null }, status: { in: ["failed", "indeterminate"] } },
      orderBy: { createdAt: "desc" }, take: limit,
      select: { correlationId: true, createdAt: true, operation: true },
    }),
    prismaSystem.webhookDelivery.findMany({
      where: { correlationId: { not: null }, status: "failed" },
      orderBy: { receivedAt: "desc" }, take: limit,
      select: { correlationId: true, receivedAt: true, provider: true },
    }),
  ]);

  const rows = [
    ...failedExecutions.map((e) => ({ correlationId: e.correlationId!, at: e.createdAt, label: e.action, source: "execution" as const })),
    ...failedOutbound.map((o) => ({ correlationId: o.correlationId!, at: o.createdAt, label: o.operation, source: "outbound" as const })),
    ...failedDeliveries.map((d) => ({ correlationId: d.correlationId!, at: d.receivedAt, label: d.provider, source: "webhook" as const })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  // One row per chain: a chain with four failures is one thing to look at.
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.correlationId) ? false : (seen.add(r.correlationId), true))).slice(0, limit);
}
