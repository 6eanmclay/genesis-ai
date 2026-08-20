import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/prisma";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// The raw token only ever exists here (to embed in the email link) and in
// the URL the owner clicks — never persisted. Only its hash is stored (see
// PasswordResetToken's own schema comment for why SHA-256, not bcrypt, is
// correct here).
export async function createPasswordResetToken(userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });
  return rawToken;
}

// Real, not just "exists" — unused and unexpired. Returns the userId so the
// caller never has to re-derive it, and never leaks *why* a token is
// invalid (expired vs. used vs. never existed) to the caller, which would
// be a real, if minor, information leak about account activity.
export async function verifyPasswordResetToken(rawToken: string): Promise<string | null> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return null;
  }
  return record.userId;
}

export async function consumePasswordResetToken(rawToken: string): Promise<void> {
  await prisma.passwordResetToken.update({
    where: { tokenHash: hashToken(rawToken) },
    data: { usedAt: new Date() },
  });
}

/**
 * Burn every outstanding reset link for this account except ones already used.
 *
 * Added 2026-08-20. Without it, a reset link an attacker requested stayed live
 * after the real owner reset their password — so the very act of securing the
 * account left a working back door open for the rest of the hour.
 */
export async function invalidateOtherResetTokens(userId: string): Promise<void> {
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
}

/**
 * Is a JWT older than the account's last password change? — pure.
 *
 * Extracted because the units are a trap worth proving rather than trusting.
 * A JWT's `iat` is in SECONDS; a Date is in MILLISECONDS. Comparing them
 * directly puts 1.7e9 against 1.7e12, which is always "older", which would
 * sign out every user on the platform on their next request.
 */
export function isTokenIssuedBeforePasswordChange(
  iatSeconds: number | undefined,
  passwordChangedAt: Date | null | undefined
): boolean {
  // No stamp means the account has never reset, so there is nothing to refuse.
  if (!passwordChangedAt) return false;
  // A token with no issued-at cannot be placed in time. Refusing it would log
  // out anyone whose token predates this field existing.
  if (typeof iatSeconds !== "number") return false;
  return iatSeconds * 1000 < passwordChangedAt.getTime();
}
