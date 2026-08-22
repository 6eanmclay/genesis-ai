import { prisma } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";
import { recordSecurityEvent, SECURITY_EVENTS } from "./events";

// SESSIONS AN OWNER CAN SEE AND END (Security & Trust step 2, D1 approved).
//
// THE SPINE OF THIS MILESTONE. 2FA is worth much less without it: discovering
// that somebody is in your account and being unable to put them out is threat
// case T2 with the stakes raised, and it is the position every Genesis owner
// was in until this shipped. Their only lever was a password change, which ends
// EVERY session including their own.
//
// SESSIONS STAY JWTs. D1 was approved on that basis — auth.ts already refuses a
// token whose `iat` predates User.passwordChangedAt, verified against Auth.js
// internals, and that mechanism kills a session on its NEXT REQUEST rather than
// at expiry. This extends it rather than replacing it with database sessions,
// which would have been a rewrite of authentication for every user to gain what
// an extension gains.
//
// So a UserSession row is not the session. It is a RECORD of one, keyed by the
// sessionInstanceId the JWT already carries, answering the two questions a
// stateless token cannot: what is signed in, and has this one been revoked.

/**
 * The three answers an eviction check can get, told apart deliberately.
 *
 * `unknown` is the one that matters and the one a boolean would have lost. A
 * token minted before this table existed carries a sessionInstanceId with no
 * row behind it — and refusing those would sign out every existing user on
 * deploy, which is a self-inflicted outage delivered by a security feature.
 */
export type SessionStanding = "live" | "revoked" | "unknown";

/**
 * Has this session been ended?
 *
 * Pure, so the decision is testable without a database and without a request —
 * the same reason isTokenIssuedBeforePasswordChange is its own function. The
 * `iat`-versus-milliseconds trap that comment warns about does not arise here,
 * because this compares a stored timestamp against nothing.
 */
export function standingOf(session: { revokedAt: Date | null } | null): SessionStanding {
  if (!session) return "unknown";
  return session.revokedAt ? "revoked" : "live";
}

/**
 * Record that a sign-in happened, or that an existing one is still in use.
 *
 * Called from the jwt callback on both branches: minting on sign-in, and moving
 * `lastSeenAt` on refresh. An upsert rather than a create because the refresh
 * branch has no way to know whether the sign-in branch already ran — and two
 * rows for one instance would mean two answers to "is this revoked".
 *
 * NEVER THROWS, for the reason recordSecurityEvent does not: failing a sign-in
 * because a bookkeeping row would not write is the security feature denying
 * service to the account it protects.
 */
export async function touchSession(input: {
  userId: string;
  sessionInstanceId: string;
  /**
   * The coarse label, already reduced. Takes the LABEL rather than a raw
   * user-agent because the only caller that has a request is auth.ts's
   * authorize, and the jwt callback it hands off to has none — so the
   * reduction happens once, where the agent actually is, and the raw string
   * never travels.
   */
  device?: string | null;
}): Promise<void> {
  try {
    const device = input.device ?? null;
    await prisma.userSession.upsert({
      where: { sessionInstanceId: input.sessionInstanceId },
      create: {
        userId: input.userId,
        sessionInstanceId: input.sessionInstanceId,
        device,
      },
      // Device is written only when this refresh actually knows one. Writing
      // `null` over a real label — which every refresh without a user-agent
      // would do — would erase the only thing that makes a session
      // recognisable to the person deciding whether to end it.
      update: { lastSeenAt: new Date(), ...(device ? { device } : {}) },
    });
  } catch (error) {
    reportIssue("session could not be recorded", error, {
      subsystem: "security",
      stage: "session.touch",
      extra: { userId: input.userId },
    });
  }
}

/**
 * Is this session still allowed to make requests?
 *
 * Read on token refresh, so it runs on every authenticated request. A failure
 * here returns `unknown` rather than `revoked`: a database blip must not sign
 * the platform out, and the honest reading of "we could not check" is not "this
 * person is an intruder".
 */
export async function standingFor(sessionInstanceId: string | null | undefined): Promise<SessionStanding> {
  if (!sessionInstanceId) return "unknown";
  try {
    const row = await prisma.userSession.findUnique({
      where: { sessionInstanceId },
      select: { revokedAt: true },
    });
    return standingOf(row);
  } catch (error) {
    reportIssue("session standing could not be read", error, {
      subsystem: "security",
      stage: "session.standing",
      extra: { sessionInstanceId },
    });
    return "unknown";
  }
}

export interface ListedSession {
  id: string;
  sessionInstanceId: string;
  device: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  /** True for the session doing the asking, so the screen never offers to end it as "another device". */
  current: boolean;
}

/**
 * Everything currently signed in to this account.
 *
 * Revoked rows are excluded: this answers "where am I signed in", and a list
 * that included sessions the owner already ended would make the act of ending
 * one look like it had not worked.
 */
export async function listSessions(
  userId: string,
  currentSessionInstanceId: string | null
): Promise<{ available: boolean; sessions: ListedSession[] }> {
  try {
    const rows = await prisma.userSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: "desc" },
    });
    return {
      available: true,
      sessions: rows.map((row) => ({
        id: row.id,
        sessionInstanceId: row.sessionInstanceId,
        device: row.device,
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
        current: row.sessionInstanceId === currentSessionInstanceId,
      })),
    };
  } catch (error) {
    reportIssue("sessions could not be listed", error, {
      subsystem: "security",
      stage: "session.list",
      extra: { userId },
    });
    // Same rule as the security history: an empty list and an unreadable one
    // are different answers, and showing "you are signed in nowhere else" to an
    // owner checking for an intruder would be the worst possible wrong answer.
    return { available: false, sessions: [] };
  }
}

export type RevokeOutcome =
  | { revoked: true; count: number }
  /** No such session for this account — already ended, or never theirs. */
  | { revoked: false; reason: "not_found" }
  /** Refused: a session cannot end itself through this path. */
  | { revoked: false; reason: "is_current" };

/**
 * End one other session.
 *
 * SCOPED BY userId IN THE WHERE CLAUSE, not checked after the read. A session
 * id is not a capability, and one account must never be able to end another's
 * session by guessing an id — the same structural-scoping rule the order
 * notifications already hold.
 *
 * REFUSES THE CURRENT SESSION on purpose. Ending the session you are using is
 * signing out, which is a different act with a different affordance; offering
 * it here as "end this device" would leave an owner unexpectedly logged out
 * while they were in the middle of securing their account.
 */
export async function revokeSession(input: {
  userId: string;
  sessionInstanceId: string;
  currentSessionInstanceId: string | null;
  userAgent?: string | null;
}): Promise<RevokeOutcome> {
  if (input.sessionInstanceId === input.currentSessionInstanceId) {
    return { revoked: false, reason: "is_current" };
  }

  const result = await prisma.userSession.updateMany({
    where: { userId: input.userId, sessionInstanceId: input.sessionInstanceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) return { revoked: false, reason: "not_found" };

  await recordSecurityEvent({
    userId: input.userId,
    kind: SECURITY_EVENTS.sessionRevoked,
    userAgent: input.userAgent,
    sessionInstanceId: input.currentSessionInstanceId,
  });
  return { revoked: true, count: result.count };
}

/**
 * End every session except the one asking.
 *
 * KEEPING THE CURRENT ONE IS THE POINT, and it is the gap this closes. A
 * password change already evicts everything through `passwordChangedAt`,
 * including the owner's own session — correct and safe, but it means the only
 * tool available for "somebody is in my account" also throws the owner out
 * while they are using it. This is the surgical version.
 */
export async function revokeOtherSessions(input: {
  userId: string;
  currentSessionInstanceId: string | null;
  userAgent?: string | null;
}): Promise<{ count: number }> {
  const result = await prisma.userSession.updateMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      ...(input.currentSessionInstanceId
        ? { sessionInstanceId: { not: input.currentSessionInstanceId } }
        : {}),
    },
    data: { revokedAt: new Date() },
  });

  // Recorded even at zero. "I signed out of all other devices and there were
  // none" is a real thing an owner did, and a history that only shows it when
  // it changed something would be missing the times they checked.
  await recordSecurityEvent({
    userId: input.userId,
    kind: SECURITY_EVENTS.allSessionsRevoked,
    userAgent: input.userAgent,
    sessionInstanceId: input.currentSessionInstanceId,
    detail: { endedCount: result.count },
  });
  return { count: result.count };
}
