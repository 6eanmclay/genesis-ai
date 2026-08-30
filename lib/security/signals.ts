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
  /** The far end of the window. An investigation is usually a range. */
  until?: Date;
  kinds?: string[];
  severities?: Severity[];
  storeId?: string;
  actorId?: string;
  actorKind?: ActorKind;
  /** The route, action or job. Prefix-matched, so "http:" finds every boundary. */
  surface?: string;
  correlationId?: string;
  limit?: number;
  /**
   * Continue after this row.
   *
   * ============ WHY A CURSOR AND NOT AN OFFSET (2026-08-30) ========
   *
   * The stream is append-heavy: signals arrive while somebody is reading. An
   * offset shifts under new rows, so page two silently repeats or skips
   * entries — and the entries it skips are the newest, which during an incident
   * are the ones being looked for.
   *
   * The cursor is the id of the last row seen, and paging walks strictly
   * backwards in time from it. It stays correct however many rows arrive.
   */
  after?: string;
  /**
   * Include the caller's address.
   *
   * OFF BY DEFAULT, like userAgent. An address is personal data about somebody
   * who has usually done nothing wrong, and most reading of this stream —
   * counting, filtering, spotting a shape — does not need one. A caller that
   * genuinely needs it asks, and the asking is the record that they did.
   */
  includeAddress?: boolean;
}

export interface SignalPage {
  rows: SignalRow[];
  /** Pass as `after` to continue. Null when the end has been reached. */
  nextCursor: string | null;
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
  return (await readSignalPage(query)).rows;
}

/** The largest page anybody may ask for, however loudly. */
export const MAX_PAGE = 500;

/**
 * One page of the stream, with a cursor for the next.
 *
 * ============ WHAT NEVER COMES BACK ==============================
 *
 * `userAgent`, always — recorded for forensics, high-cardinality noise for
 * reasoning. `ipAddress` unless explicitly asked for. And `detail` only after
 * redaction, because it is the one free-form field: everything writing to it
 * today puts field NAMES and counts there, and "today" is not a guarantee
 * about a caller somebody adds next month.
 */
export async function readSignalPage(query: SignalQuery = {}): Promise<SignalPage> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_PAGE);

  // The cursor is an id; paging walks backwards from the row it names. Prisma's
  // own cursor handles the tie-breaking that a bare `occurredAt < x` would get
  // wrong when two signals share a millisecond — which, on a burst of refusals
  // from one script, is exactly what happens.
  const rows = await prismaSystem.securitySignal.findMany({
    where: {
      ...(query.since || query.until
        ? {
            occurredAt: {
              ...(query.since ? { gte: query.since } : {}),
              ...(query.until ? { lte: query.until } : {}),
            },
          }
        : {}),
      ...(query.kinds?.length ? { kind: { in: query.kinds } } : {}),
      ...(query.severities?.length ? { severity: { in: query.severities } } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.actorKind ? { actorKind: query.actorKind } : {}),
      ...(query.surface ? { surface: { startsWith: query.surface } } : {}),
      ...(query.correlationId ? { correlationId: query.correlationId } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.after ? { cursor: { id: query.after }, skip: 1 } : {}),
    select: {
      id: true, correlationId: true, kind: true, severity: true, actorKind: true,
      actorId: true, storeId: true, surface: true, ipAddress: true, detail: true,
      occurredAt: true,
    },
  });

  // One more than asked for is how "is there another page" is answered without
  // a second count query over a table that is being written to.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    rows: page.map((row) => ({
      ...row,
      ipAddress: query.includeAddress ? row.ipAddress : null,
      detail: redactDetail(row.detail),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/** Keys whose VALUE must never leave this stream, whatever put them there. */
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|apikey|api_key|credential|signature|bearer|card|cvv|ssn/i;

/** Any single value longer than this is a payload, not a fact about one. */
const MAX_VALUE_LENGTH = 500;

/**
 * Make a detail object safe to hand to a reader.
 *
 * ============ WHY THIS EXISTS AT WRITE-TIME'S EXPENSE ============
 *
 * Everything writing a signal today puts field names, counts and reasons in
 * `detail` — never a value — and the boundary suite asserts exactly that by
 * sending a password through and proving it never lands. But `detail` is typed
 * as an open record, and the assertion covers the callers that exist.
 *
 * This is the second half of that guarantee, on the read side, where it
 * protects against the caller nobody has written yet. Belt and braces, and the
 * braces are the ones tested.
 */
export function redactDetail(detail: unknown): unknown {
  if (detail === null || detail === undefined) return detail;
  if (Array.isArray(detail)) return detail.map(redactDetail);
  if (typeof detail === "string") {
    return detail.length > MAX_VALUE_LENGTH ? `${detail.slice(0, MAX_VALUE_LENGTH)}…[truncated]` : detail;
  }
  if (typeof detail !== "object") return detail;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    // The KEY is kept. Knowing a token was involved is useful; knowing which is
    // a liability, and the difference is the whole point.
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactDetail(value);
  }
  return out;
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
  // MAX_PAGE, not more. This asked for a thousand before the page cap existed;
  // saying so plainly beats asking for a number that is silently reduced.
  //
  // Five hundred security signals under one correlation id is already
  // pathological — it means one request was refused hundreds of times — and a
  // trace that shows the first five hundred of those has told the story.
  return readSignals({ correlationId: id, limit: MAX_PAGE });
}
