import crypto from "crypto";
import bcrypt from "bcryptjs";
import { generateSecret, verifySync, generateURI } from "otplib";
import { prisma } from "@/lib/prisma";
import { encryptCredentials, decryptCredentials } from "@/lib/integrations/credentials";
import { recordSecurityEvent, SECURITY_EVENTS } from "./events";

// TWO-FACTOR AUTHENTICATION (Security & Trust step 4, D6: opt-in for v1).
//
// Threat case T1 — a phished or reused password — and the reason this milestone
// exists. Until now a password was the whole of the defence around an owner's
// payments, connected credentials and every document Genesis holds for them.
//
// ENROLMENT AND RECOVERY SHIP TOGETHER, NEVER SPLIT. Threat case T5 (a lost
// phone) is by volume the likeliest real incident once 2FA exists — far more
// common than T1 — and shipping enrolment first would mean the first owner to
// lose their phone loses their business.
//
// THE SEED IS ENCRYPTED AT REST with the same AES-256 helper that protects
// integration credentials. It is a bearer secret in exactly the same sense:
// anyone holding it can mint valid codes forever, so a database leak without
// this is a leak of everyone's second factor.
//
// A SECRET IS NOT AN ENROLMENT. `totpSecret` without `totpEnabledAt` is an
// abandoned setup, and it must never be treated as protection — turning it on
// before the owner has produced a real code would lock them out with a factor
// they never proved they had.

/** Codes are 6 digits; a step is 30s. The defaults, and no reason to differ. */
export const RECOVERY_CODE_COUNT = 8;

interface StoredSecret {
  secret: string;
}

/**
 * Begin enrolment: a fresh seed and the URI an authenticator app scans.
 *
 * Nothing is enabled here. The secret is stored so the verification step can
 * check the owner's first code against it, and `totpEnabledAt` stays null until
 * they produce one — see the header.
 */
export async function beginTwoFactorSetup(input: {
  userId: string;
  accountEmail: string;
}): Promise<{ secret: string; uri: string }> {
  const secret = generateSecret();
  await prisma.user.update({
    where: { id: input.userId },
    data: {
      totpSecret: JSON.stringify(encryptCredentials({ secret } satisfies StoredSecret)),
      // Cleared, so restarting setup cannot leave an account "enabled" against
      // a seed the owner has just replaced and no longer has in their app.
      totpEnabledAt: null,
    },
  });
  return {
    secret,
    uri: generateURI({ issuer: "Genesis", label: input.accountEmail, secret }),
  };
}

/** The stored seed, or null when there is none. Never leaves this module. */
async function secretFor(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true },
  });
  if (!user?.totpSecret) return null;
  try {
    return decryptCredentials<StoredSecret>(JSON.parse(user.totpSecret)).secret;
  } catch {
    // A seed that cannot be decrypted is not a seed. Returning null makes every
    // caller treat the account as un-enrolled, which fails toward "ask for the
    // password" rather than toward "let them in".
    return null;
  }
}

/** Is a code valid for this account's seed right now? */
export function isCodeValid(token: string, secret: string): boolean {
  // Trimmed and stripped of the spaces authenticator apps display them with —
  // "123 456" is what the owner reads off their phone, and refusing it would be
  // refusing the correct code.
  const cleaned = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return verifySync({ token: cleaned, secret }).valid === true;
  } catch {
    return false;
  }
}

export type EnableOutcome =
  | { enabled: true; recoveryCodes: string[] }
  | { enabled: false; reason: "no_setup_in_progress" }
  | { enabled: false; reason: "incorrect_code" };

/**
 * Finish enrolment by proving the owner can produce a code.
 *
 * Returns the recovery codes ONCE. They are hashed on the way in and are not
 * recoverable afterwards — regenerating is the only path back, and it
 * invalidates every previous code.
 */
export async function enableTwoFactor(input: {
  userId: string;
  token: string;
  userAgent?: string | null;
}): Promise<EnableOutcome> {
  const secret = await secretFor(input.userId);
  if (!secret) return { enabled: false, reason: "no_setup_in_progress" };

  if (!isCodeValid(input.token, secret)) {
    await recordSecurityEvent({
      userId: input.userId,
      kind: SECURITY_EVENTS.twoFactorChallengeFailed,
      userAgent: input.userAgent,
    });
    return { enabled: false, reason: "incorrect_code" };
  }

  const recoveryCodes = await replaceRecoveryCodes(input.userId);
  await prisma.user.update({
    where: { id: input.userId },
    data: { totpEnabledAt: new Date() },
  });
  await recordSecurityEvent({
    userId: input.userId,
    kind: SECURITY_EVENTS.twoFactorEnabled,
    userAgent: input.userAgent,
  });
  return { enabled: true, recoveryCodes };
}

/**
 * Turn it off.
 *
 * The caller is responsible for having a fresh confirmation — see
 * lib/security/reauthentication.ts. That guard is not applied here because this
 * module must not decide policy about a request it cannot see; the server
 * action that owns the request does, and verify-two-factor asserts it.
 *
 * The seed AND every recovery code go. Leaving either behind would mean a
 * re-enable silently accepted a phone the owner may have already wiped.
 */
export async function disableTwoFactor(input: {
  userId: string;
  userAgent?: string | null;
}): Promise<void> {
  await prisma.user.update({
    where: { id: input.userId },
    data: { totpSecret: null, totpEnabledAt: null },
  });
  await prisma.recoveryCode.deleteMany({ where: { userId: input.userId } });
  await recordSecurityEvent({
    userId: input.userId,
    kind: SECURITY_EVENTS.twoFactorDisabled,
    userAgent: input.userAgent,
  });
}

/** Is 2FA actually protecting this account? */
export async function isTwoFactorEnabled(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpEnabledAt: true, totpSecret: true },
  });
  // BOTH, deliberately. A stamp without a seed cannot verify anything, and a
  // seed without a stamp is an abandoned setup. Either alone would be a wrong
  // answer in a different direction.
  return Boolean(user?.totpEnabledAt && user.totpSecret);
}

/**
 * One human-readable recovery code.
 *
 * Crockford-style alphabet: no O/0, I/1, L, or U. These get written on paper in
 * a hurry and typed back months later under stress, and a code an owner cannot
 * transcribe is a code that does not work.
 */
function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5, 10).join("")}`;
}

/**
 * Issue a fresh set, invalidating every previous one.
 *
 * Deleting the old set is the point: "regenerate" exists because the owner
 * believes the old ones are compromised or lost, and leaving them usable would
 * make the act meaningless.
 */
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await prisma.recoveryCode.deleteMany({ where: { userId } });
  await prisma.recoveryCode.createMany({
    data: await Promise.all(
      codes.map(async (code) => ({ userId, codeHash: await bcrypt.hash(code, 10) }))
    ),
  });
  return codes;
}

export async function regenerateRecoveryCodes(input: {
  userId: string;
  userAgent?: string | null;
}): Promise<string[]> {
  const codes = await replaceRecoveryCodes(input.userId);
  await recordSecurityEvent({
    userId: input.userId,
    kind: SECURITY_EVENTS.recoveryCodesRegenerated,
    userAgent: input.userAgent,
  });
  return codes;
}

/** How many are left, so a screen can warn before the last one is gone. */
export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  return prisma.recoveryCode.count({ where: { userId, usedAt: null } });
}

export type ChallengeOutcome =
  | { passed: true; usedRecoveryCode: boolean; recoveryCodesRemaining: number }
  | { passed: false; reason: "incorrect" }
  | { passed: false; reason: "not_enrolled" };

/**
 * The second factor itself: a TOTP code, or a recovery code.
 *
 * A RECOVERY CODE WORKS EXACTLY ONCE. Claimed with a conditional update on
 * `usedAt`, the same claim-then-use discipline the order notifications hold, so
 * two concurrent attempts cannot both spend the same code.
 */
export async function verifySecondFactor(input: {
  userId: string;
  token: string;
  userAgent?: string | null;
}): Promise<ChallengeOutcome> {
  const secret = await secretFor(input.userId);
  if (!secret) return { passed: false, reason: "not_enrolled" };

  if (isCodeValid(input.token, secret)) {
    return {
      passed: true,
      usedRecoveryCode: false,
      recoveryCodesRemaining: await countUnusedRecoveryCodes(input.userId),
    };
  }

  // Not a valid TOTP code — try the recovery codes. Compared against every
  // unused one because they are bcrypt hashes and there is nothing to look up
  // by; the set is 8, so this is bounded and small.
  const cleaned = input.token.replace(/\s+/g, "").toUpperCase();
  const candidates = await prisma.recoveryCode.findMany({
    where: { userId: input.userId, usedAt: null },
    select: { id: true, codeHash: true },
  });
  for (const candidate of candidates) {
    if (!(await bcrypt.compare(cleaned, candidate.codeHash))) continue;

    // Claimed, not checked-then-marked: two concurrent attempts with the same
    // code must not both succeed.
    const claimed = await prisma.recoveryCode.updateMany({
      where: { id: candidate.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) break;

    await recordSecurityEvent({
      userId: input.userId,
      kind: SECURITY_EVENTS.recoveryCodeUsed,
      userAgent: input.userAgent,
    });
    return {
      passed: true,
      usedRecoveryCode: true,
      recoveryCodesRemaining: await countUnusedRecoveryCodes(input.userId),
    };
  }

  await recordSecurityEvent({
    userId: input.userId,
    kind: SECURITY_EVENTS.twoFactorChallengeFailed,
    userAgent: input.userAgent,
  });
  return { passed: false, reason: "incorrect" };
}
