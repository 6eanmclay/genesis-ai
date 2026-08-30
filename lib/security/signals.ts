import type { Prisma } from "@prisma/client";
import { prismaSystem } from "@/lib/prisma";
import { correlationId } from "@/lib/observability/correlation";

// THE SECURITY STREAM: OBSERVED HERE, ENFORCED ELSEWHERE.
//
// ============ THE PRINCIPLE THIS FILE IMPLEMENTS (2026-08-30) ==========
//
// Sean: "security intelligence observes and reasons; deterministic Genesis
// infrastructure enforces. Do not give a future security AI unrestricted
// administrative authority simply because it is intended to defend the system."
//
// So this module WRITES a stream and READS it back. It cannot enforce anything,
// and neither can anything that only has this module. The enforcement — IAM,
// the permission matrix, tenant isolation, secrets, rate limiting — stays where
// it is, deterministic, and is never asked what an intelligence thinks first.
//
// ============ WHY NOT WIDEN SecurityEvent ==============================
//
// SecurityEvent has a REQUIRED userId and no storeId, so it can only describe
// what a known signed-in person did to their own account. Most security events
// have no user: an unauthenticated prober, a forged webhook, a cron, J4 itself.
// Widening it would spoil the one table with a clean narrow meaning and would
// mix account history with attack telemetry in a way neither reader wants.
//
// ============ RECORDING NEVER BREAKS THE THING IT OBSERVES =============
//
// Every function swallows its own failure. A permission check must refuse in
// exactly the same way whether or not the signal write succeeded — otherwise
// the observability becomes a denial-of-service on the feature, and the first
// person to notice is a customer.

/**
 * The taxonomy.
 *
 * ONE NAMESPACE, so a future provider subscribes to a shape rather than to a
 * list somebody has to remember to update. Connections month adds providers,
 * and every one of them gets `provider.*` rather than inventing its own logging.
 */
export const SIGNAL_KINDS = {
  /** Someone asked for something their role does not allow. */
  authzDenied: "authz.denied",
  /** A query reached for another business's data. Should be impossible. */
  isolationViolation: "isolation.violation",
  /** A business could not be resolved, so nothing was allowed to proceed. */
  authzUnresolved: "authz.unresolved",
  /** A webhook arrived without a valid signature. */
  webhookUnsigned: "webhook.unsigned",
  /** A provider credential expired, was rotated away, or was revoked. */
  credentialLost: "credential.lost",
  /** Repeated failures from one origin. */
  rateLimited: "ratelimit.tripped",
  /** A tool or execution behaved in a way worth a second look. */
  executionAnomaly: "execution.anomaly",
  /** A person re-ran a failed delivery. Deliberate, and worth a record. */
  webhookReplayed: "webhook.replayed",
  /** Somebody tried to replay a delivery whose signature never verified. */
  webhookReplayRefused: "webhook.replay_refused",
  /**
   * A request was refused at the public boundary — too large, not JSON, or the
   * wrong shape.
   *
   * ============ ITS OWN KIND, NOT ratelimit.tripped (2026-08-30) ======
   *
   * The first draft of the boundary guard recorded these as rate limiting,
   * which would have made `ratelimit.tripped` useless for the thing it names:
   * a hundred malformed requests and a hundred throttled ones are different
   * facts, and an operator looking for an attack needs to tell them apart.
   *
   * Never carries the body. The reason and the field NAMES, never their values.
   */
  boundaryRejected: "http.rejected",
} as const;

export type SignalKind = (typeof SIGNAL_KINDS)[keyof typeof SIGNAL_KINDS];

export type Severity = "info" | "warning" | "critical";

/**
 * Who or what did the thing.
 *
 * NOT a userId. The most interesting actor is frequently not a user: an
 * unauthenticated request, a provider's webhook, a cron, or J4 acting on its
 * own authority. A schema that assumes a person cannot describe an attack.
 */
export type ActorKind = "user" | "system" | "genesis" | "anonymous" | "provider";

export interface SignalInput {
  kind: SignalKind | string;
  actorKind: ActorKind;
  severity?: Severity;
  actorId?: string | null;
  storeId?: string | null;
  /** Route, server action, tool or job kind. */
  surface?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
  /** Overrides the ambient correlation, for a caller that knows better. */
  correlationId?: string | null;
}

/**
 * Write one signal. Never throws.
 *
 * Deliberately not awaited-for-correctness anywhere: a caller may await it to
 * keep ordering tidy, but nothing depends on the result. See the header.
 */
export async function recordSignal(input: SignalInput): Promise<void> {
  try {
    await prismaSystem.securitySignal.create({
      data: {
        kind: input.kind,
        severity: input.severity ?? "info",
        actorKind: input.actorKind,
        actorId: input.actorId ?? null,
        storeId: input.storeId ?? null,
        surface: input.surface ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        // Ambient by default, so a route that established one gets it for free
        // and nothing has to thread an id through every call in between.
        correlationId: input.correlationId ?? correlationId(),
        // Prisma's Json input does not accept a bare Record; it wants its own
        // InputJsonValue. The cast is at the boundary rather than in the public
        // signature, so callers keep an ordinary object.
        ...(input.detail ? { detail: input.detail as Prisma.InputJsonValue } : {}),
      },
    });
  } catch {
    // Swallowed on purpose, and not even reported through reportIssue: an
    // unavailable database would otherwise turn every refused permission check
    // into a second error, and the refusal is the part that matters.
  }
}

// ---------------------------------------------------------------------------
// The read contract — what a security layer is given, and only this
// ---------------------------------------------------------------------------

export interface SignalQuery {
  since?: Date;
  kinds?: string[];
  severities?: Severity[];
  storeId?: string;
  actorId?: string;
  correlationId?: string;
  limit?: number;
}

export interface SignalRow {
  id: string;
  correlationId: string | null;
  kind: string;
  severity: string;
  actorKind: string;
  actorId: string | null;
  storeId: string | null;
  surface: string | null;
  ipAddress: string | null;
  detail: unknown;
  occurredAt: Date;
}

/**
 * Read the stream.
 *
 * ============ THIS IS THE WHOLE INTERFACE ==========================
 *
 * A security intelligence gets this function and the two below it. It does not
 * get a Prisma client, a credential, or a way to write. Everything it concludes
 * has to come back out as a proposal to a bounded, named action that performs
 * its own permission check — for the same reason J4 cannot execute arbitrary
 * work: an intelligence that can do anything is one whose mistakes can be
 * anything.
 *
 * `userAgent` is deliberately not returned. It is recorded for forensics and is
 * high-cardinality noise for reasoning; a reader that genuinely needs it can be
 * given a narrower function later, deliberately.
 */
export async function readSignals(query: SignalQuery = {}): Promise<SignalRow[]> {
  return prismaSystem.securitySignal.findMany({
    where: {
      ...(query.since ? { occurredAt: { gte: query.since } } : {}),
      ...(query.kinds?.length ? { kind: { in: query.kinds } } : {}),
      ...(query.severities?.length ? { severity: { in: query.severities } } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.correlationId ? { correlationId: query.correlationId } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: Math.min(query.limit ?? 200, 1000),
    select: {
      id: true, correlationId: true, kind: true, severity: true, actorKind: true,
      actorId: true, storeId: true, surface: true, ipAddress: true, detail: true,
      occurredAt: true,
    },
  });
}

export interface SignalTally {
  kind: string;
  severity: string;
  count: number;
  lastSeenAt: Date | null;
}

/** What has been happening, in aggregate. The cheap question. */
export async function tallySignals(since: Date): Promise<SignalTally[]> {
  const rows = await prismaSystem.securitySignal.groupBy({
    by: ["kind", "severity"],
    where: { occurredAt: { gte: since } },
    _count: true,
    _max: { occurredAt: true },
  });
  return rows
    .map((r) => ({ kind: r.kind, severity: r.severity, count: r._count, lastSeenAt: r._max.occurredAt }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Everything one unit of work produced, security-wise.
 *
 * The correlation id is what makes this possible at all, and it is the
 * difference between "there were four warnings around 3pm" and "this request,
 * from this address, was refused four times in a row while trying four
 * different businesses."
 */
export async function signalsForCorrelation(id: string): Promise<SignalRow[]> {
  return readSignals({ correlationId: id, limit: 1000 });
}
