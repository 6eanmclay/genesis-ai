"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { verifyPasswordResetToken, consumePasswordResetToken } from "@/lib/auth/passwordReset";
import { RecoverableError } from "@/lib/actionState";

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
      data: { password: hashedPassword },
    });
    await consumePasswordResetToken(token);
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
