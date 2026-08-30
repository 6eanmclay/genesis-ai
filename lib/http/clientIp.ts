import { createHash } from "crypto";

// WHO SENT THIS, AS WELL AS ANYONE CAN KNOW.
//
// ============ ONE PLACE, BECAUSE IT IS EASY TO GET WRONG (2026-08-30) ==
//
// Exactly one site in this codebase read a caller's address before now, in
// app/forgot-password/actions.ts, and it took `x-forwarded-for` whole — which
// on a multi-proxy path is a comma-separated list, so the bucket key became
// "1.2.3.4, 10.0.0.1" and two requests through different proxy paths counted as
// two different callers. Correct enough for one throttle; not a thing to copy
// eleven more times.
//
// ============ WHAT THIS HEADER IS AND IS NOT =========================
//
// `x-forwarded-for` is CLIENT-SUPPLIED unless something trustworthy overwrote
// it. Behind Vercel it is rewritten at the edge, so the leftmost entry is the
// real client and can be trusted about as far as an IP ever can be. Run this
// anywhere else and an attacker sets it to whatever they like, and a rate limit
// keyed on it becomes decorative.
//
// That is a real limitation of IP-based limiting rather than of this function,
// and it is why nothing here treats an address as identity. It is one input to
// a limit, always paired with a second key — an email, an account — that a
// caller cannot invent as freely.

/**
 * The caller's address, or null when nothing claims to know.
 *
 * The LEFTMOST entry of x-forwarded-for: proxies append, so the first is the
 * original client and everything after it is infrastructure.
 */
export function clientIp(headers: Headers): string | null {
  // Vercel's own header first — it is set by the platform and not forwarded
  // from the request, so it cannot be supplied by the caller.
  const vercel = headers.get("x-vercel-forwarded-for");
  if (vercel) return firstAddress(vercel);

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return firstAddress(forwarded);

  const real = headers.get("x-real-ip");
  return real ? real.trim() || null : null;
}

function firstAddress(value: string): string | null {
  const first = value.split(",")[0]?.trim();
  return first ? first : null;
}

/**
 * A stable, non-reversible label for an address.
 *
 * ============ WHY THE RAW ADDRESS IS NEVER STORED ==================
 *
 * The same reasoning lib/auth/attemptThrottle.ts already applies to email: a
 * table full of the IP addresses of people who mostly did nothing wrong is a
 * liability created in the name of security. A hash counts just as well and
 * cannot be read back.
 *
 * Not a secret — an attacker who guesses an address can confirm it. That is
 * fine; the purpose is to avoid HOLDING addresses, not to hide them from
 * somebody who already has one.
 */
export function addressLabel(ip: string | null): string {
  if (!ip) return "unknown";
  return createHash("sha256").update(`ip:${ip}`).digest("hex").slice(0, 32);
}
