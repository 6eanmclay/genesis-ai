import "server-only";
import { encode, decode } from "@auth/core/jwt";
import { cookies } from "next/headers";
import { randomUUID } from "crypto";

// Experience-First Onboarding — the anonymous visitor's identity before any
// real account exists. Deliberately NOT a NextAuth session and NOT a shadow
// User row (see EXPERIENCE_FIRST_ONBOARDING.md's confirmed "no shadow
// users" decision) — just a signed, opaque identifier proving "this
// browser is the same one that started this draft," reused as the value
// stored in StoreDraft.anonymousSessionToken.
//
// Reuses @auth/core/jwt's standalone encode/decode rather than hand-rolling
// HMAC signing — the same AUTH_SECRET already trusted in production, with
// its own cookie name doubling as the `salt`, which is what keeps this
// token cryptographically distinct from NextAuth's own real session JWT
// even though both derive from the same secret. An anonymous visitor never
// has a NextAuth session; this cookie is the only thing identifying them.
const COOKIE_NAME = "genesis_anon_session";
// 30 days — long enough for someone to close the tab and come back to
// finish deciding without losing what Genesis already built with them.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

interface AnonymousSessionPayload {
  sub: string;
}

function requireSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set — required to mint or verify anonymous session identities.");
  }
  return secret;
}

async function mintAnonymousSessionId(): Promise<string> {
  const sub = randomUUID();
  const token = await encode<AnonymousSessionPayload>({
    secret: requireSecret(),
    salt: COOKIE_NAME,
    maxAge: MAX_AGE_SECONDS,
    token: { sub },
  });
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
  return sub;
}

// Reads and verifies the real, already-issued cookie — returns the stable
// anonymous identity, or null for a genuinely new visitor (no cookie) or a
// tampered/expired one (decode fails closed, never throws to the caller).
async function readAnonymousSessionId(): Promise<string | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const payload = await decode<AnonymousSessionPayload>({
      secret: requireSecret(),
      salt: COOKIE_NAME,
      token: raw,
    });
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

// The one entry point real callers use — reads an existing valid identity
// if present, mints a fresh one (and sets its cookie) otherwise. Never
// returns null, matching getOrCreateDraft's own "always get something back"
// shape for the real-user path.
export async function getOrCreateAnonymousSessionId(): Promise<string> {
  const existing = await readAnonymousSessionId();
  if (existing) return existing;
  return mintAnonymousSessionId();
}

// Called once a draft has been claimed by a real account (see the claim
// step in app/onboarding/actions.ts) — the browser shouldn't keep sending a
// token for an identity that no longer owns an unclaimed draft.
export async function clearAnonymousSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
