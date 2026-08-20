import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";

// Brute-force protection for the auth endpoints (2026-08-20).
//
// Found during the production-readiness audit: there was none. Login, signup and
// password-reset requests could all be hammered at whatever rate a script could
// manage, against a platform that holds merchants' connected payment accounts.
//
// Two limits, because they stop different attacks:
//
//   - PER IDENTIFIER, tight. Someone working through a password list against
//     one known email address.
//   - PER SOURCE, loose. Someone spraying one common password across many
//     addresses, which never trips a per-identifier limit at all.
//
// Both are needed; either alone leaves the other attack untouched.

/** Failures against one email before it stops being tried. */
export const PER_IDENTIFIER_LIMIT = 10;
/** Failures from one source across all emails. Higher: offices share an IP. */
export const PER_SOURCE_LIMIT = 30;
export const WINDOW_MS = 15 * 60 * 1000;

/**
 * The stored key for a thing being limited — pure, and a one-way hash.
 *
 * Never the email or IP itself. An attempts table full of plaintext addresses
 * typed by attackers — belonging to real people who never signed up here —
 * would be a liability created in the name of security. The `kind` prefix is
 * inside the hash so a login bucket and a reset bucket for the same address
 * cannot collide.
 */
export function attemptBucket(kind: string, value: string): string {
  const normalized = value.trim().toLowerCase();
  return createHash("sha256").update(`${kind}:${normalized}`).digest("hex");
}

/** Is this bucket over its limit right now? */
export async function isThrottled(bucket: string, limit: number, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const count = await prisma.authAttempt.count({
    where: { bucket, occurredAt: { gte: since } },
  });
  return count >= limit;
}

/** Record one failure. Never throws into the caller's own flow. */
export async function recordFailedAttempt(buckets: string[]): Promise<void> {
  try {
    await prisma.authAttempt.createMany({
      data: buckets.map((bucket) => ({ bucket })),
    });
  } catch (error) {
    // A throttle that cannot write must not become an outage on the login page.
    console.error("[authThrottle] could not record attempt:", error);
  }
}

/**
 * Clear a bucket's history. Called after a SUCCESSFUL sign-in, so a person who
 * mistypes their password nine times and then gets it right is not left one
 * mistake away from a lockout for the next quarter of an hour.
 */
export async function clearAttempts(buckets: string[]): Promise<void> {
  try {
    await prisma.authAttempt.deleteMany({ where: { bucket: { in: buckets } } });
  } catch (error) {
    console.error("[authThrottle] could not clear attempts:", error);
  }
}

/**
 * Both checks for a credentials sign-in, as one call.
 *
 * Returns the buckets alongside the verdict so the caller can record a failure
 * or clear the history without re-deriving them — and cannot accidentally
 * record against a different bucket than it checked.
 */
export async function checkSignInThrottle(params: {
  email: string;
  ip: string | null;
  now?: Date;
}): Promise<{ throttled: boolean; buckets: string[] }> {
  const identifierBucket = attemptBucket("signin:email", params.email);
  const buckets = [identifierBucket];
  if (params.ip) buckets.push(attemptBucket("signin:ip", params.ip));

  const now = params.now ?? new Date();
  if (await isThrottled(identifierBucket, PER_IDENTIFIER_LIMIT, now)) {
    return { throttled: true, buckets };
  }
  if (params.ip && (await isThrottled(attemptBucket("signin:ip", params.ip), PER_SOURCE_LIMIT, now))) {
    return { throttled: true, buckets };
  }
  return { throttled: false, buckets };
}

/**
 * Drop expired rows. Called from the daily cron rather than on every request —
 * the count query is already bounded by `occurredAt`, so stale rows are a
 * storage concern, not a correctness one.
 */
export async function pruneExpiredAttempts(now: Date = new Date()): Promise<number> {
  const result = await prisma.authAttempt.deleteMany({
    where: { occurredAt: { lt: new Date(now.getTime() - WINDOW_MS) } },
  });
  return result.count;
}
