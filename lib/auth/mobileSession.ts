import crypto from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";

// THE J4 PHONE APP'S SESSION (MOBILE_SIGN_IN_CONTRACT.md D1 + D2, approved 2026-09-27).
//
// ============ A ROW IN THE LIST THE OWNER ALREADY HAS ==================
//
// A phone session is a UserSession row with kind = "mobile" and the SHA-256 of a
// random key in tokenHash. Nothing else. Because it is that row:
//
//   - it appears in the website's "where am I signed in" list as "iPhone · J4";
//   - "End session" and "Sign out of all other devices" end it through
//     lib/security/sessions.ts with no code of their own for phones;
//   - account closure deletes it with every other UserSession.
//
// ============ WHY A RANDOM KEY, NOT A JWT =============================
//
// The website already reads UserSession on every request to ask "has this been
// revoked", so a self-contained token would save no query. A random key has no
// signing secret to leak and no clock rules to get wrong. It is hashed at rest
// with SHA-256 — fast, deliberately, for the reason password-reset tokens are:
// 256 random bits need no brute-force resistance, a person's password does.
//
// ============ THE FOUR WAYS A KEY STOPS WORKING ======================
//
//   revoked           the owner ended it, from the website or by signing out
//   idle              unused for longer than MOBILE_IDLE_LIMIT_MS (D2)
//   password_changed  the password changed after this phone signed in — the
//                     same eviction auth.ts applies to every browser
//   not_found         no such key: never issued, or the account was closed
//
// There is no "unknown" here, unlike the web's standingOf. That state exists
// for JWTs minted before UserSession did; every phone key is born with its row.

/** D2: ninety days without opening J4, and the phone is signed out. Every use renews it. */
export const MOBILE_IDLE_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;

/** The key's length in bytes. 256 bits, the same as a password-reset token. */
const KEY_BYTES = 32;

export function hashMobileKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export type MobileStanding = "live" | "revoked" | "idle" | "password_changed" | "not_found";

/**
 * Is this phone session still allowed in?
 *
 * Pure, and takes `now`, so every boundary is testable rather than hoped for —
 * the discipline isReauthenticationFresh and isTokenIssuedBeforePasswordChange
 * already hold.
 */
export function mobileStandingOf(
  session: { revokedAt: Date | null; lastSeenAt: Date; createdAt: Date } | null,
  passwordChangedAt: Date | null | undefined,
  now: Date,
  idleLimitMs = MOBILE_IDLE_LIMIT_MS
): MobileStanding {
  if (!session) return "not_found";
  if (session.revokedAt) return "revoked";
  // Strictly after: a sign-in in the same millisecond as a password change was
  // made WITH the new password, which is the only way it could have succeeded.
  if (passwordChangedAt && passwordChangedAt.getTime() > session.createdAt.getTime()) {
    return "password_changed";
  }
  if (now.getTime() - session.lastSeenAt.getTime() >= idleLimitMs) return "idle";
  return "live";
}

/**
 * Start a phone session for a user whose sign-in has ALREADY been verified by
 * verifyCredentialSignIn. Returns the key, which exists nowhere else afterwards.
 */
export async function issueMobileSession(input: {
  userId: string;
  device: string | null;
}): Promise<{ key: string; sessionInstanceId: string }> {
  const key = crypto.randomBytes(KEY_BYTES).toString("base64url");
  const sessionInstanceId = crypto.randomUUID();
  await prisma.userSession.create({
    data: {
      userId: input.userId,
      sessionInstanceId,
      kind: "mobile",
      tokenHash: hashMobileKey(key),
      // "iPhone · J4" when the app sent its user-agent; null otherwise, and the
      // sessions screen already says "unknown device" for null.
      device: input.device,
    },
  });
  return { key, sessionInstanceId };
}

/** Pull the key out of `Authorization: Bearer <key>`, or null. */
export function bearerKey(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(header.trim());
  return match ? match[1] : null;
}

export type MobileAuthentication =
  | { ok: true; userId: string; sessionInstanceId: string }
  /** The key is no good. The phone should forget it and show sign-in. */
  | { ok: false; reason: "signed_out" }
  /**
   * We could not check. The phone must KEEP its key and try again later — a
   * database blip signing every phone out would be the security feature denying
   * service to the accounts it protects, the rule standingFor already follows.
   */
  | { ok: false; reason: "unavailable" };

/**
 * Who is this phone? The single gate every mobile route passes through.
 *
 * Moves lastSeenAt forward on success, which is what makes D2's ninety days
 * "ninety days of not using it" rather than "ninety days since sign-in".
 */
export async function authenticateMobile(request: Request, now: Date = new Date()): Promise<MobileAuthentication> {
  const key = bearerKey(request.headers);
  if (!key) return { ok: false, reason: "signed_out" };

  let session;
  try {
    session = await prisma.userSession.findUnique({
      where: { tokenHash: hashMobileKey(key) },
      select: {
        userId: true,
        sessionInstanceId: true,
        kind: true,
        revokedAt: true,
        lastSeenAt: true,
        createdAt: true,
        user: { select: { passwordChangedAt: true } },
      },
    });
  } catch (error) {
    reportIssue("mobile session could not be read", error, {
      subsystem: "security",
      stage: "mobile.authenticate",
    });
    return { ok: false, reason: "unavailable" };
  }

  // A web row can never carry a tokenHash, but the kind is checked anyway: this
  // gate admits phone sessions and nothing else.
  if (session && session.kind !== "mobile") return { ok: false, reason: "signed_out" };

  const standing = mobileStandingOf(session, session?.user.passwordChangedAt, now);
  if (standing !== "live" || !session) return { ok: false, reason: "signed_out" };

  try {
    await prisma.userSession.update({
      where: { sessionInstanceId: session.sessionInstanceId },
      data: { lastSeenAt: now },
    });
  } catch (error) {
    // Bookkeeping, not the gate. The key was valid; refusing it because a
    // timestamp would not write would sign a real owner out for our failure.
    reportIssue("mobile session could not be touched", error, {
      subsystem: "security",
      stage: "mobile.touch",
      extra: { userId: session.userId },
    });
  }
  return { ok: true, userId: session.userId, sessionInstanceId: session.sessionInstanceId };
}

/**
 * The phone signing itself out. Revokes the row rather than deleting it, so the
 * key is dead even if a copy of it survives somewhere.
 *
 * No security event, deliberately — the website records none for signing out
 * either, and the only nearby label ("Signed out of another device") would
 * describe this wrongly.
 */
export async function endMobileSession(input: { userId: string; sessionInstanceId: string }): Promise<void> {
  await prisma.userSession.updateMany({
    where: { userId: input.userId, sessionInstanceId: input.sessionInstanceId, kind: "mobile", revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * The response a mobile route sends when authenticateMobile says no.
 *
 * Two different statuses on purpose: 401 tells the app to forget its key and
 * show sign-in; 503 tells it to keep the key and try again. Collapsing them
 * would sign a phone out every time the database hiccupped.
 */
export function mobileAuthFailure(result: Extract<MobileAuthentication, { ok: false }>): NextResponse {
  return result.reason === "unavailable"
    ? NextResponse.json({ error: "unavailable" }, { status: 503 })
    : NextResponse.json({ error: "signed_out" }, { status: 401 });
}
