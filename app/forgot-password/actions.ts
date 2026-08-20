"use server";

import { prisma } from "@/lib/prisma";
import { getBaseUrl } from "@/lib/integrations/util";
import { createPasswordResetToken } from "@/lib/auth/passwordReset";
import { sendPasswordResetEmail } from "@/lib/email/passwordReset";
import { isEmailConfigured } from "@/lib/email/sendEmail";
import { RecoverableError } from "@/lib/actionState";
import { headers } from "next/headers";
import {
  attemptBucket,
  isThrottled,
  recordFailedAttempt,
  PER_IDENTIFIER_LIMIT,
  PER_SOURCE_LIMIT,
} from "@/lib/auth/attemptThrottle";

// Auth screens review (2026-08-07) — a real 3-state outcome (untouched /
// error / success-with-a-message), which lib/actionState.ts's shared
// ActionState type doesn't carry (its own ok:true has no message field,
// indistinguishable from the untouched initial state) — same "build a
// small dedicated shape" convention ActionForm's own comment already
// establishes for forms needing more than plain echo-on-failure.
export type RequestResetState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success" };

// Checked BEFORE looking up the email, deliberately: if this were checked
// only after finding a real user, the "email isn't configured" failure
// would only ever appear for real accounts, silently confirming which
// submitted emails are real — the exact enumeration leak the generic
// success outcome below exists to prevent. Checking first makes the
// failure identical regardless of whether the email matches anyone.
export async function requestPasswordReset(
  _prevState: RequestResetState,
  formData: FormData
): Promise<RequestResetState> {
  try {
    if (!isEmailConfigured()) {
      throw new RecoverableError(
        "Password reset isn't fully set up yet — email delivery isn't configured. Please contact support."
      );
    }

    const email = (formData.get("email") as string | null)?.trim().toLowerCase();
    if (!email) {
      throw new RecoverableError("Enter your email address.");
    }

    // Rate limited (2026-08-20). Unthrottled, this endpoint sends real email to
    // a real person on demand — so it is a way to flood someone's inbox using
    // the store's own sending domain, which is also how that domain gets its
    // reputation ruined.
    //
    // The outcome on refusal is the SAME success state as everything else here.
    // A distinct "too many requests" would answer the question this whole
    // action is built to avoid answering: whether the address has an account.
    const forwarded = (await headers()).get("x-forwarded-for");
    const ip = forwarded ? (forwarded.split(",")[0]?.trim() || null) : null;
    const emailBucket = attemptBucket("reset:email", email);
    const buckets = [emailBucket, ...(ip ? [attemptBucket("reset:ip", ip)] : [])];

    if (await isThrottled(emailBucket, PER_IDENTIFIER_LIMIT)) {
      return { status: "success" };
    }
    if (ip && (await isThrottled(attemptBucket("reset:ip", ip), PER_SOURCE_LIMIT))) {
      return { status: "success" };
    }
    // Counted whether or not the address matches an account — counting only
    // real ones would make the limit itself an oracle.
    await recordFailedAttempt(buckets);

    const user = await prisma.user.findUnique({ where: { email } });
    // Never reveal whether an account exists — same outcome either way.
    // Real work (token + email) only happens when a real user is found; a
    // non-existent email just returns the same success state with no real
    // side effect.
    if (user) {
      const rawToken = await createPasswordResetToken(user.id);
      const baseUrl = await getBaseUrl();
      const resetUrl = `${baseUrl}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail(email, resetUrl);
    }

    return { status: "success" };
  } catch (error) {
    if (error instanceof RecoverableError) {
      return { status: "error", message: error.message };
    }
    console.error("[password-reset-request-error]", error);
    return {
      status: "error",
      message: "Something went wrong on our end. Please try again, and let us know if this keeps happening.",
    };
  }
}
