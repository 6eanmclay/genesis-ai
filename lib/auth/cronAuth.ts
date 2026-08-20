import { timingSafeEqual } from "crypto";

// Guarding the cron routes (2026-08-20).
//
// Both routes did:
//
//     if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) return 401;
//
// which has a fail-open case. With CRON_SECRET unset, the template string is
// the literal "Bearer undefined", so anyone sending exactly that header passes
// the check — and what is behind it is runDueSyncs(), the scheduler's own
// unattended-execution bypass that runs across every tenant on the platform.
//
// CRON_SECRET is set in production today, so this was latent rather than live.
// But "the environment happens to be configured correctly" is not an access
// control, and a missing secret must fail CLOSED.
//
// The comparison is also constant-time now. That matters less than the fail-open
// case — the secret is long and random, and network jitter swamps the signal —
// but there is no reason to compare a secret with ===.

export function isAuthorizedCronRequest(
  authHeader: string | null | undefined,
  secret: string | undefined = process.env.CRON_SECRET
): boolean {
  // No secret configured: refuse everything. There is no correct value to
  // present, so nothing can be authorized.
  if (!secret) return false;
  if (!authHeader) return false;

  const expected = `Bearer ${secret}`;
  // timingSafeEqual throws on length mismatch, which is itself a length oracle,
  // so the lengths are compared first and deliberately — knowing the length of
  // a random secret buys an attacker nothing.
  if (authHeader.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(authHeader, "utf8"), Buffer.from(expected, "utf8"));
}
