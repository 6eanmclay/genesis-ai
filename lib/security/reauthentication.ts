import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { recordSecurityEvent, SECURITY_EVENTS } from "./events";

// PROVING YOU ARE STILL YOU (Security & Trust step 3).
//
// BUILT BEFORE 2FA, NOT AFTER, and the order is the point. The moment a
// "turn off two-factor authentication" control exists, threat case T3 is live:
// an attacker holding a live session simply switches the defence off. Shipping
// the guard first means that button is never shipped naked.
//
// It also guards the things that already exist and were never protected:
// regenerating recovery codes, ending sessions, changing who has access to a
// business. Each of those is a step an attacker with a stolen session would
// take, and each of them was one click away.
//
// A PASSWORD, DELIBERATELY, EVEN WHEN 2FA IS ON. The question here is "are you
// the person who owns this account", and the password is the factor an attacker
// with a stolen SESSION does not have. Asking for a TOTP code instead would ask
// them for something their phone might still be able to produce if the phone is
// what was stolen — and it would make recovery-code exhaustion a way to lock
// somebody out of their own security settings.

/**
 * How long a confirmation lasts.
 *
 * Long enough to turn 2FA on and write down the recovery codes without being
 * asked twice; short enough that a walked-away-from laptop is not an open door
 * to the security settings. Five minutes is the conventional answer and there
 * is no reason here to be unconventional.
 */
export const REAUTHENTICATION_WINDOW_MS = 5 * 60 * 1000;

export type ReauthOutcome =
  | { confirmed: true; until: Date }
  /** Wrong password. Deliberately indistinguishable from every other refusal. */
  | { confirmed: false; reason: "incorrect" }
  /** This account signs in with Google and has no password to confirm. */
  | { confirmed: false; reason: "no_password" };

/**
 * Is a confirmation from `confirmedAt` still good at `now`?
 *
 * Pure, and takes `now` as an argument rather than reading the clock, so the
 * boundary is testable rather than hoped for — the same discipline
 * isTokenIssuedBeforePasswordChange holds, and for the same reason: a window
 * that is wrong in the lenient direction is a security hole nobody would see.
 */
export function isReauthenticationFresh(
  confirmedAt: Date | null | undefined,
  now: Date,
  windowMs = REAUTHENTICATION_WINDOW_MS
): boolean {
  if (!confirmedAt) return false;
  const age = now.getTime() - confirmedAt.getTime();
  // A confirmation from the future is not fresh, it is a clock problem. Refusing
  // it fails closed; accepting it would make a skewed clock into an indefinite
  // pass.
  if (age < 0) return false;
  return age < windowMs;
}

/**
 * Confirm a password, and record the attempt either way.
 *
 * Both outcomes are written to the account's history on purpose. A failed
 * confirmation is exactly what an owner needs to see if somebody with a stolen
 * session is probing their security settings, and it is invisible everywhere
 * else — the sign-in log would show nothing, because the attacker never signed
 * in.
 */
export async function confirmPassword(input: {
  userId: string;
  password: string;
  userAgent?: string | null;
  sessionInstanceId?: string | null;
  now?: Date;
}): Promise<ReauthOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { password: true },
  });

  if (!user?.password) {
    // An OAuth-only account. Not a failure to record against them — there is
    // nothing they could have typed that would have worked, so this is a
    // capability gap rather than a suspicious event. See the caller's own
    // handling; this is why the outcome is named rather than folded into
    // "incorrect".
    return { confirmed: false, reason: "no_password" };
  }

  const ok = await bcrypt.compare(input.password, user.password);
  if (!ok) {
    await recordSecurityEvent({
      userId: input.userId,
      kind: SECURITY_EVENTS.reauthenticationFailed,
      userAgent: input.userAgent,
      sessionInstanceId: input.sessionInstanceId,
    });
    return { confirmed: false, reason: "incorrect" };
  }

  const at = input.now ?? new Date();
  await prisma.user.update({
    where: { id: input.userId },
    data: { reauthenticatedAt: at },
  });
  await recordSecurityEvent({
    userId: input.userId,
    kind: SECURITY_EVENTS.reauthenticated,
    userAgent: input.userAgent,
    sessionInstanceId: input.sessionInstanceId,
  });
  return { confirmed: true, until: new Date(at.getTime() + REAUTHENTICATION_WINDOW_MS) };
}

/**
 * May this account perform a security-sensitive action right now?
 *
 * The one gate every such action goes through, so there is a single answer to
 * "is this person confirmed" rather than one per caller that could drift.
 */
export async function hasFreshConfirmation(userId: string, now = new Date()): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { reauthenticatedAt: true },
  });
  return isReauthenticationFresh(user?.reauthenticatedAt, now);
}

/**
 * Spend the confirmation.
 *
 * Called after a security-sensitive action succeeds, so one confirmation does
 * not authorise an unbounded series of them for the rest of the window. Turning
 * 2FA off and then removing a member are two decisions, and the second one asks
 * again.
 */
export async function clearConfirmation(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { reauthenticatedAt: null },
  });
}
