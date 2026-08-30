import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";

// HOW OFTEN ONE CALLER MAY DO ONE THING.
//
// ============ THE TABLE ALREADY EXISTED (2026-08-30) ===================
//
// `AuthAttempt` is a hashed bucket and a timestamp with an index on both. Its
// name is historical — it was written for sign-in brute force — but the shape
// is a general fixed-window rate-limit ledger, it already has a scheduled prune
// (`auth.pruneAttempts`), and it already refuses to store the thing being
// limited in plaintext.
//
// A second table would have been a second sweep, a second hashing discipline
// and a second answer to "how many times has this happened" — the
// mirrored-registry problem in the one place where being wrong means either
// letting an attack through or locking a real customer out. So this reuses it,
// and the `kind` prefix inside the hash keeps an endpoint's bucket from ever
// colliding with a sign-in bucket for the same address.
//
// ============ FIXED WINDOW, AND WHAT THAT COSTS ======================
//
// A count of rows in the last N minutes. Simple, and honestly imprecise at the
// boundary: a caller can send `max` requests at the end of one window and `max`
// again at the start of the next, so the true worst case is twice the limit
// over a short span. A sliding window costs a heavier query on every request.
//
// Stated rather than hidden, because the limits here are set to stop scripted
// abuse rather than to meter a paying API, and double the limit for a few
// seconds does not change that. Anywhere it would matter, the limit should be
// low enough that twice it is still safe.
//
// ============ COUNTED BEFORE THE WORK, NOT AFTER =====================
//
// Every attempt is recorded, not only the ones that fail. Sign-in throttling
// counts failures on purpose — a person signing in successfully forty times is
// not an attack — but an endpoint that creates accounts or spends money on a
// model call is expensive whether or not it succeeds, and counting only
// failures would leave the expensive path unlimited.

/** How long a window lasts when a rule does not say. */
export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

export interface RateLimitRule {
  /**
   * What is being limited — "register:ip", "chat:user". Part of the hash, so
   * two rules over the same value never share a bucket.
   */
  kind: string;
  /** The thing being limited. Hashed before it is stored, never kept raw. */
  value: string;
  /** How many are allowed in the window. */
  max: number;
  windowMs?: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Which rule refused, for the response and the signal. Never the value. */
  trippedKind?: string;
  /** How many were already counted when the refusal happened. */
  count?: number;
  /** Seconds until the window frees up, for a Retry-After header. */
  retryAfterSeconds?: number;
}

/** The stored key. One-way, and never the address or email itself. */
export function bucketFor(kind: string, value: string): string {
  return createHash("sha256").update(`${kind}:${value.trim().toLowerCase()}`).digest("hex");
}

/**
 * Check every rule, and record the attempt against all of them.
 *
 * ============ ALL RULES, NOT THE FIRST FAILURE ===================
 *
 * A caller who trips the per-address rule still has their per-email attempt
 * counted, because the next request may come from a different address and the
 * email rule is the one that catches that. Short-circuiting would let a
 * distributed attempt spend an unlimited number of tries against one account.
 */
export async function checkRateLimit(
  rules: RateLimitRule[],
  options: { surface: string; actorId?: string | null; now?: Date } = { surface: "unknown" },
): Promise<RateLimitVerdict> {
  if (rules.length === 0) return { allowed: true };
  const now = options.now ?? new Date();

  const buckets = rules.map((rule) => ({ rule, bucket: bucketFor(rule.kind, rule.value) }));

  const counts = await Promise.all(
    buckets.map(({ rule, bucket }) =>
      prisma.authAttempt.count({
        where: { bucket, occurredAt: { gte: new Date(now.getTime() - (rule.windowMs ?? DEFAULT_WINDOW_MS)) } },
      }),
    ),
  );

  // Recorded before the verdict is returned, so a refused request still counts
  // against the caller. Otherwise a caller who is already over the limit could
  // hammer the endpoint for free for ever, since none of those attempts would
  // extend the window.
  await recordAttempts(buckets.map((b) => b.bucket));

  const trippedAt = counts.findIndex((count, i) => count >= buckets[i].rule.max);
  if (trippedAt === -1) return { allowed: true };

  const rule = buckets[trippedAt].rule;
  const windowMs = rule.windowMs ?? DEFAULT_WINDOW_MS;

  // ============ RECORDED, BUT NEVER THE THING LIMITED ============
  //
  // The kind, the count and the limit. Not the email, not the address, not the
  // body. A security stream that quietly accumulates the credentials people
  // typed at it is a breach waiting to be found.
  await recordSignal({
    kind: SIGNAL_KINDS.rateLimited,
    severity: "warning",
    actorKind: options.actorId ? "user" : "anonymous",
    actorId: options.actorId ?? null,
    surface: `http:${options.surface}`,
    detail: { rule: rule.kind, limit: rule.max, counted: counts[trippedAt], windowMs },
  });

  return {
    allowed: false,
    trippedKind: rule.kind,
    count: counts[trippedAt],
    retryAfterSeconds: Math.ceil(windowMs / 1000),
  };
}

/** Record attempts. Never throws — a limiter that cannot write is not an outage. */
async function recordAttempts(buckets: string[]): Promise<void> {
  try {
    await prisma.authAttempt.createMany({ data: buckets.map((bucket) => ({ bucket })) });
  } catch (error) {
    // ============ FAILS OPEN, DELIBERATELY =======================
    //
    // The opposite of the authorization guards, and for a different reason: a
    // rate limiter exists to shape load, not to decide who may act. If the
    // database is unreachable the endpoint's real authorization still stands,
    // and refusing every request because the counter is broken turns a
    // degraded database into a total outage on the sign-up page.
    console.error("[rateLimit] could not record attempt:", error);
  }
}
