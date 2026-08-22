"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { recordSecurityEvent, SECURITY_EVENTS } from "@/lib/security/events";
import {
  verifyPasswordResetToken,
  consumePasswordResetToken,
  invalidateOtherResetTokens,
} from "@/lib/auth/passwordReset";
import { RecoverableError } from "@/lib/actionState";
import { checkPassword } from "@/lib/auth/passwordPolicy";

export type ResetPasswordState =
  | { status: "idle" }
  | { status: "error"; message: string };

// Same 10 salt rounds as the real signup path (app/api/register/route.ts)
// — one hashing policy for every place a password is ever set, not two
// independently-drifting copies.
const BCRYPT_SALT_ROUNDS = 10;

export async function resetPassword(
  _prevState: ResetPasswordState,
  formData: FormData
): Promise<ResetPasswordState> {
  try {
    const token = formData.get("token") as string | null;
    const password = formData.get("password") as string | null;
    const confirmPassword = formData.get("confirmPassword") as string | null;

    if (!token) {
      throw new RecoverableError("This reset link is missing its token — request a new one.");
    }
    if (!password || !confirmPassword) {
      throw new RecoverableError("Enter and confirm your new password.");
    }
    if (password !== confirmPassword) {
      throw new RecoverableError("Those passwords don't match.");
    }
    // The same policy as signup, from the same function. A reset path with
    // weaker rules than signup is a way around the rules.
    const passwordCheck = checkPassword(password);
    if (!passwordCheck.ok) {
      throw new RecoverableError(passwordCheck.message);
    }

    const userId = await verifyPasswordResetToken(token);
    if (!userId) {
      // Deliberately generic — never distinguishes "expired" from "already
      // used" from "never existed"; a stale/reused reset link isn't a
      // meaningful thing to diagnose for the person holding it, only a
      // reason to request a fresh one.
      throw new RecoverableError(
        "This reset link is invalid or has expired. Please request a new one."
      );
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        // Stamped so auth.ts can refuse every JWT minted before now. Without
        // this, an attacker already signed in stays signed in — see the note
        // in auth.ts's jwt callback.
        passwordChangedAt: new Date(),
      },
    });
    // The owner's own history. Written after the update rather than before,
    // so a recorded password change always corresponds to one that happened.
    await recordSecurityEvent({ userId, kind: SECURITY_EVENTS.passwordChanged });
    await consumePasswordResetToken(token);
    // Burn every OTHER outstanding reset link for this account, not just the
    // one used. If an attacker requested a reset and the real owner then reset
    // their password, the attacker's link would otherwise still work.
    await invalidateOtherResetTokens(userId);
  } catch (error) {
    if (error instanceof RecoverableError) {
      return { status: "error", message: error.message };
    }
    console.error("[password-reset-error]", error);
    return {
      status: "error",
      message: "Something went wrong on our end. Please try again, and let us know if this keeps happening.",
    };
  }

  redirect("/login?reset=success");
}
