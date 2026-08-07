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
