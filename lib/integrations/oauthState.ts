import { createHmac, randomBytes, timingSafeEqual } from "crypto";

// Phase 0 — the OAuth `state` parameter, doing the job it exists for.
//
// THE DEFECT THIS REPLACES. Every OAuth connector set `state: storeId` and the
// shared callback read the storeId straight back out of it. That repurposed the
// one parameter whose entire purpose is proving the callback belongs to a flow
// this server started, so nothing was doing that job at all.
//
// The callback is a public GET. With storeId-as-state, a crafted
// `?state=<storeId>&code=<attacker's code>` clicked by a signed-in owner would
// bind the ATTACKER'S provider account to the victim's store — and for Stripe,
// with read_write scope, that is the account payouts answer to. The existing
// permission re-check in execute() means the victim must already have rights on
// that store, so it was a one-click CSRF against an authorised user rather than
// an open takeover. Still the most serious finding of the audit, and it was
// framework-wide rather than Stripe-specific.
//
// FOUR PROPERTIES, all of which storeId-as-state lacked:
//   signed       — the payload cannot be forged or edited without AUTH_SECRET
//   single-use   — the nonce lives in an httpOnly cookie that is cleared on use
//   session-bound— the payload names the user who started the flow, re-checked
//                  against the live session at the callback
//   expiring     — ten minutes, so a leaked link stops working
//
// NO MIGRATION. The nonce lives in a cookie rather than a table: single-use is
// achieved by clearing the cookie, and a cookie is already per-browser, which
// is exactly the binding this needs.

/**
 * How long a connection handoff may stay open.
 *
 * SIXTY MINUTES, RAISED FROM TEN (2026-08-19) after a real failure in
 * production. The ten-minute window assumed a merchant walks straight through a
 * consent screen. They don't: Stripe puts account onboarding and verification
 * requirements INSIDE that same handoff, and a merchant filling in business
 * details, bank details and identity documents is legitimately gone far longer
 * than ten minutes. The callback then came back to a state that had already
 * expired, and Genesis rejected its own valid connection.
 *
 * Only the window changes. The state is still signed, still single-use, still
 * session-bound, still expiring — an hour is short enough that a leaked link is
 * useless well before anyone could find it, and long enough for real onboarding.
 */
export const OAUTH_STATE_TTL_MS = 60 * 60 * 1000;

/** The httpOnly cookie holding this flow's nonce. */
export const OAUTH_STATE_COOKIE = "genesis_oauth_state";

export interface OAuthStatePayload {
  /** The store this handoff belongs to. Empty for a draft-phase flow. */
  storeId: string;
  /**
   * Set INSTEAD of storeId when the flow starts during onboarding, before any
   * Store exists (2026-08-20).
   *
   * The onboarding fulfillment callback used `state = "${draftId}:PRINTFUL"` —
   * unsigned, not single-use, not session-bound — which is precisely the defect
   * described at the top of this file, still open on that one route after Phase
   * 0 fixed every other. It checked that the draft belonged to the signed-in
   * user, so it was not an open takeover, but a crafted callback clicked by a
   * signed-in owner would still have stored the ATTACKER'S Printful credentials
   * on the victim's draft — and every fulfillment order that store later placed
   * would have gone to the attacker's account.
   */
  storeDraftId?: string;
  /** Uppercase IntegrationProvider name — a state minted for one provider must not work for another. */
  provider: string;
  /** Who started the flow. Re-checked against the live session at the callback. */
  userId: string;
  /**
   * The ExecutionLog row this handoff belongs to. Carried here so the callback
   * closes ITS OWN attempt rather than "the most recent PENDING row for this
   * action" — the guess that left 18 orphaned rows on one real store.
   */
  executionId: string;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

/** Constant-time comparison that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Build the signed `state` value for an authorize URL — pure.
 *
 * The caller is responsible for setting `payload.nonce` into the httpOnly
 * cookie; the two halves are useless apart, which is the point.
 */
export function signOAuthState(payload: OAuthStatePayload, secret: string): string {
  if (!secret) throw new Error("Cannot sign OAuth state without a secret");
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export type OAuthStateFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "provider_mismatch"
  | "nonce_mismatch"
  | "user_mismatch";

export type OAuthStateResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: OAuthStateFailure };

/**
 * Verify a `state` returned by a provider — pure, and the whole security
 * decision in one testable function.
 *
 * Every check is a hard failure. There is deliberately no "close enough" path:
 * a state that cannot be fully accounted for is rejected, because the cost of
 * accepting a bad one is connecting someone else's payment account.
 */
export function verifyOAuthState(
  state: string | null | undefined,
  opts: {
    secret: string;
    provider: string;
    /** The nonce read back from the httpOnly cookie. */
    cookieNonce: string | null | undefined;
    /** The user id from the live session at callback time. */
    sessionUserId: string | null | undefined;
    now?: Date;
  }
): OAuthStateResult {
  if (!state || !opts.secret) return { ok: false, reason: "malformed" };

  const dot = state.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const encoded = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  if (!safeEqual(signature, sign(encoded, opts.secret))) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload?.storeId !== "string" ||
    typeof payload?.provider !== "string" ||
    typeof payload?.userId !== "string" ||
    typeof payload?.executionId !== "string" ||
    typeof payload?.nonce !== "string" ||
    typeof payload?.expiresAt !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const now = (opts.now ?? new Date()).getTime();
  if (payload.expiresAt <= now) return { ok: false, reason: "expired" };

  // A state minted for Stripe must not complete a Square connection.
  if (payload.provider.toUpperCase() !== opts.provider.toUpperCase()) {
    return { ok: false, reason: "provider_mismatch" };
  }

  // Single-use: this nonce must match the cookie set when the flow started,
  // and the caller clears that cookie immediately after.
  if (!opts.cookieNonce || !safeEqual(payload.nonce, opts.cookieNonce)) {
    return { ok: false, reason: "nonce_mismatch" };
  }

  // Session-bound: the person finishing the flow must be the one who began it.
  if (!opts.sessionUserId || payload.userId !== opts.sessionUserId) {
    return { ok: false, reason: "user_mismatch" };
  }

  return { ok: true, payload };
}

/** Human sentence for a rejected callback. Never names the specific check. */
export function oauthStateFailureMessage(reason: OAuthStateFailure): string {
  switch (reason) {
    case "expired":
      return "That connection link expired before it was finished. Please start the connection again.";
    case "user_mismatch":
      return "That connection was started by a different account. Please start it again while signed in.";
    default:
      // Deliberately vague for the forgery-shaped failures: a precise error
      // message is a hint to whoever is probing.
      return "That connection link wasn't valid. Please start the connection again.";
  }
}

// ---------------------------------------------------------------------------
// Request-context helpers. Kept below the pure core so the security decision
// above stays testable without a Next.js request.

import { cookies } from "next/headers";

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required to sign an OAuth handoff");
  return value;
}

/**
 * Mint the `state` for an authorize URL and set its single-use nonce cookie.
 *
 * Called by every OAuth connector in place of `state: storeId`.
 */
export async function beginOAuthHandoff(params: {
  /** One of these. `storeDraftId` is for onboarding, before a Store exists. */
  storeId?: string;
  storeDraftId?: string;
  userId: string;
  provider: string;
  executionId?: string;
}): Promise<string> {
  const nonce = newNonce();
  const state = signOAuthState(
    {
      storeId: params.storeId ?? "",
      ...(params.storeDraftId ? { storeDraftId: params.storeDraftId } : {}),
      provider: params.provider.toUpperCase(),
      userId: params.userId,
      executionId: params.executionId ?? "",
      nonce,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    },
    secret()
  );

  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    // SameSite=Lax still sends on the top-level GET redirect a provider makes
    // back to us, which is exactly the one navigation this cookie must survive.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
  });

  return state;
}

/**
 * Verify a callback's `state` against the cookie and live session, then clear
 * the cookie so the same state can never be replayed.
 */
export async function completeOAuthHandoff(params: {
  state: string | null;
  provider: string;
  sessionUserId: string | null | undefined;
}): Promise<OAuthStateResult> {
  const jar = await cookies();
  const cookieNonce = jar.get(OAUTH_STATE_COOKIE)?.value ?? null;

  const result = verifyOAuthState(params.state, {
    secret: secret(),
    provider: params.provider,
    cookieNonce,
    sessionUserId: params.sessionUserId,
  });

  // Single-use: cleared whether or not verification passed, so a failed probe
  // cannot be retried against the same nonce.
  jar.delete(OAUTH_STATE_COOKIE);
  return result;
}
