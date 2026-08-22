import { prisma } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";

// THE ACCOUNT'S OWN HISTORY (Security & Trust, 2026-08-22).
//
// Step 1 of the milestone, and first for a reason that is about sequence rather
// than importance: every feature after this one emits into it. Built last, each
// of those would need retrofitting, and the retrofit is exactly where events go
// missing — the owner ends up with a history that is silently partial, which is
// worse than no history, because they would trust it.
//
// WHY NOT ExecutionLog. That table answers "what did Genesis do to this
// business": it is keyed by storeId and its actors are USER/GENESIS/SYSTEM.
// "Somebody signed in as me at 4am" is not about a business and has no store to
// hang on — an account with three businesses has ONE sign-in history, not
// three. Reusing it would have made every security question a per-business
// question, which is the wrong shape for the only question an owner asks.
//
// RECORDING NEVER BREAKS THE THING IT RECORDS. A failure to write history must
// not fail a sign-in, a password change, or a session revocation — locking
// somebody out of their own account because an audit row could not be inserted
// is a worse outcome than a missing row. So every write is caught and reported,
// and the caller is never made to care. That is the one place this module is
// deliberately lenient, and §5 of the suite asserts it.

/**
 * The closed vocabulary. A free String in the column (matching
 * ExecutionLog.action's convention), but closed HERE — and every value is
 * asserted to carry an owner-facing label, so a new kind cannot reach a
 * merchant as a raw identifier like "two_factor.disabled".
 */
export const SECURITY_EVENTS = {
  signedIn: "sign_in.succeeded",
  signInFailed: "sign_in.failed",
  signInBlocked: "sign_in.throttled",
  passwordChanged: "password.changed",
  passwordResetRequested: "password.reset_requested",
  twoFactorEnabled: "two_factor.enabled",
  twoFactorDisabled: "two_factor.disabled",
  twoFactorChallengeFailed: "two_factor.challenge_failed",
  recoveryCodesRegenerated: "two_factor.recovery_codes_regenerated",
  recoveryCodeUsed: "two_factor.recovery_code_used",
  sessionRevoked: "session.revoked",
  allSessionsRevoked: "session.revoked_all",
  reauthenticated: "reauthentication.succeeded",
  reauthenticationFailed: "reauthentication.failed",
  memberAdded: "member.added",
  memberRoleChanged: "member.role_changed",
  memberRemoved: "member.removed",
} as const;

export type SecurityEventKind = (typeof SECURITY_EVENTS)[keyof typeof SECURITY_EVENTS];

/**
 * What each event says to the person it happened to.
 *
 * Written in the owner's terms, not the system's — "You signed in", not
 * "sign_in.succeeded". A missing label is a real defect rather than a cosmetic
 * one: it would render the raw identifier on a security screen, which is both
 * unreadable and a small leak of internal vocabulary. Asserted complete in
 * scripts/verify-security-events.ts, in both directions.
 */
export const SECURITY_EVENT_LABEL: Record<SecurityEventKind, string> = {
  [SECURITY_EVENTS.signedIn]: "Signed in",
  [SECURITY_EVENTS.signInFailed]: "Failed sign-in attempt",
  [SECURITY_EVENTS.signInBlocked]: "Sign-in blocked after too many attempts",
  [SECURITY_EVENTS.passwordChanged]: "Password changed",
  [SECURITY_EVENTS.passwordResetRequested]: "Password reset requested",
  [SECURITY_EVENTS.twoFactorEnabled]: "Two-factor authentication turned on",
  [SECURITY_EVENTS.twoFactorDisabled]: "Two-factor authentication turned off",
  [SECURITY_EVENTS.twoFactorChallengeFailed]: "Incorrect two-factor code",
  [SECURITY_EVENTS.recoveryCodesRegenerated]: "New recovery codes generated",
  [SECURITY_EVENTS.recoveryCodeUsed]: "Signed in with a recovery code",
  [SECURITY_EVENTS.sessionRevoked]: "Signed out of another device",
  [SECURITY_EVENTS.allSessionsRevoked]: "Signed out of all other devices",
  [SECURITY_EVENTS.reauthenticated]: "Confirmed your password",
  [SECURITY_EVENTS.reauthenticationFailed]: "Failed to confirm your password",
  [SECURITY_EVENTS.memberAdded]: "Someone was given access to a business",
  [SECURITY_EVENTS.memberRoleChanged]: "Someone's access level changed",
  [SECURITY_EVENTS.memberRemoved]: "Someone's access was removed",
};

/**
 * The events that mean "something happened that you should look at twice".
 *
 * Used to mark a row in the history rather than to hide the others — an owner
 * scanning for trouble should not have to read every line at the same weight.
 * A failed sign-in is here; a successful one is not.
 */
export const NOTEWORTHY_EVENTS: readonly SecurityEventKind[] = [
  SECURITY_EVENTS.signInFailed,
  SECURITY_EVENTS.signInBlocked,
  SECURITY_EVENTS.twoFactorDisabled,
  SECURITY_EVENTS.twoFactorChallengeFailed,
  SECURITY_EVENTS.recoveryCodeUsed,
  SECURITY_EVENTS.recoveryCodesRegenerated,
  SECURITY_EVENTS.passwordChanged,
  SECURITY_EVENTS.reauthenticationFailed,
  SECURITY_EVENTS.memberAdded,
  SECURITY_EVENTS.memberRoleChanged,
  SECURITY_EVENTS.memberRemoved,
];

/**
 * A coarse, human device label from a user-agent.
 *
 * D4, approved: device and last-seen only, no IP and no location. The RAW
 * user-agent is never stored either — it is a fingerprint, and an owner
 * recognising their own session needs "Windows · Chrome", not 180 characters of
 * version strings.
 *
 * Returns null for an absent or unrecognisable agent, which is deliberately
 * distinct from a recognised one: "we do not know what this was" and "this was
 * a Mac" are different facts, and the screen says so.
 */
export function describeDevice(userAgent: string | null | undefined): string | null {
  if (!userAgent || userAgent.trim().length === 0) return null;
  const ua = userAgent;

  const os =
    /iPhone|iPad|iPod/i.test(ua) ? "iPhone"
    : /Android/i.test(ua) ? "Android"
    : /Mac OS X|Macintosh/i.test(ua) ? "Mac"
    : /Windows/i.test(ua) ? "Windows"
    : /Linux/i.test(ua) ? "Linux"
    : null;

  // Order matters: Edge and Opera both claim Chrome, and Chrome claims Safari.
  // Checked most-specific-first so a browser is not mislabelled as the one it
  // impersonates for compatibility.
  const browser =
    /Edg\//i.test(ua) ? "Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari"
    : null;

  if (!os && !browser) return null;
  return [os, browser].filter(Boolean).join(" · ");
}

export interface RecordSecurityEventInput {
  userId: string;
  kind: SecurityEventKind;
  /** The request's user-agent, if this event had a request behind it. */
  userAgent?: string | null;
  sessionInstanceId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Write one line of an account's history.
 *
 * NEVER THROWS. See the file header: a security log that can fail a sign-in is
 * a denial-of-service on the account it protects. Failures are reported through
 * the existing observability path so they are visible to an operator, and the
 * caller carries on.
 */
export async function recordSecurityEvent(input: RecordSecurityEventInput): Promise<void> {
  const device = describeDevice(input.userAgent);
  try {
    await prisma.securityEvent.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        device,
        sessionInstanceId: input.sessionInstanceId ?? null,
        detail: input.detail ? (input.detail as object) : undefined,
      },
    });
  } catch (error) {
    reportIssue(`security event ${input.kind} could not be recorded`, error, {
      subsystem: "security",
      stage: "security_event.write",
      extra: { kind: input.kind, userId: input.userId },
    });
  }

  // AND TELL THEM, when it is the kind of thing worth interrupting somebody
  // about. Deliberately here rather than at each call site: an event that is
  // recorded but not notified would be a silent decision made in whichever
  // caller forgot, and the list of what deserves a mail belongs in one place.
  //
  // Awaited but never allowed to throw — notifyOfSecurityEvent swallows its
  // own failures for the same reason this function does. Recording and
  // notifying are both bookkeeping around an act the owner asked for, and
  // neither may fail it.
  //
  // Imported lazily to keep a cycle out of the module graph: notifications
  // reads SECURITY_EVENT_LABEL from this file.
  try {
    const { notifyOfSecurityEvent } = await import("./notifications");
    await notifyOfSecurityEvent({ userId: input.userId, kind: input.kind, device });
  } catch (error) {
    reportIssue(`security notification ${input.kind} could not be attempted`, error, {
      subsystem: "security",
      stage: "security_notification.dispatch",
      extra: { kind: input.kind, userId: input.userId },
    });
  }
}

/** The shape the reader returns — the columns this module actually uses. */
export interface SecurityEventRow {
  id: string;
  kind: string;
  device: string | null;
  createdAt: Date;
}

function defaultRead({ userId, limit }: { userId: string; limit: number }): Promise<SecurityEventRow[]> {
  return prisma.securityEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, kind: true, device: true, createdAt: true },
  });
}

export interface SecurityHistoryEntry {
  id: string;
  kind: SecurityEventKind;
  label: string;
  device: string | null;
  noteworthy: boolean;
  createdAt: Date;
}

/**
 * What the owner reads.
 *
 * TWO SILENCES ARE NOT THE SAME SILENCE, and this is where that matters most.
 * An empty array here means "nothing has happened", which for a real account is
 * almost never true — so the caller must be able to tell it apart from "the log
 * is not working". `available` carries that: false when the read itself failed,
 * so the screen can say the history is unavailable instead of showing a clean
 * bill of health for an account nobody can see into.
 */
export async function getSecurityHistory(
  userId: string,
  limit = 50,
  // INJECTABLE, for the same reason sendOrderConfirmation's sender is: the
  // `available: false` branch exists for a database that is not answering, and
  // defensive code nobody can exercise is indistinguishable from defensive code
  // that does not work. Two earlier attempts tried to provoke a real failure
  // with an invalid `take` — Prisma accepted both, so the assertion was proving
  // nothing while appearing to prove the most important property in this file.
  read: (args: { userId: string; limit: number }) => Promise<SecurityEventRow[]> = defaultRead
): Promise<{ available: boolean; entries: SecurityHistoryEntry[] }> {
  try {
    const rows = await read({ userId, limit });
    return {
      available: true,
      entries: rows.map((row) => {
        const kind = row.kind as SecurityEventKind;
        return {
          id: row.id,
          kind,
          // An unlabelled kind falls back to nothing readable rather than to
          // the raw identifier — see SECURITY_EVENT_LABEL's own comment. The
          // suite asserts the map is complete, so this is a floor, not a plan.
          label: SECURITY_EVENT_LABEL[kind] ?? "Account activity",
          device: row.device,
          noteworthy: NOTEWORTHY_EVENTS.includes(kind),
          createdAt: row.createdAt,
        };
      }),
    };
  } catch (error) {
    reportIssue("security history could not be read", error, {
      subsystem: "security",
      stage: "security_event.read",
      extra: { userId },
    });
    return { available: false, entries: [] };
  }
}
