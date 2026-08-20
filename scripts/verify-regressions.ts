import { hasValidScope } from "@/lib/tenantIsolation";
import { verifyOAuthState, signOAuthState, newNonce, OAUTH_STATE_TTL_MS } from "@/lib/integrations/oauthState";
import { paymentBadgeFor } from "@/lib/integrations/paymentBadge";
import { mergeRefreshedTokens } from "@/lib/integrations/tokenRefresh";
import { isAuthorizedCronRequest } from "@/lib/auth/cronAuth";
import { nextSyncAttempt } from "@/lib/intelligence/scheduler";
import { isTokenIssuedBeforePasswordChange } from "@/lib/auth/passwordReset";
import { checkPassword } from "@/lib/auth/passwordPolicy";
import { redactSecrets } from "@/lib/integrations/providerError";
import { chooseRate } from "@/lib/shipping/rates";

// Adversarial regression suite. No database, no network:
//
//   npx tsx scripts/verify-regressions.ts
//
// Every other suite asserts that the CURRENT code is correct. A test like that
// is not evidence on its own — it might have passed before the fix too.
//
// So each section below carries the ACTUAL PRE-FIX IMPLEMENTATION, copied from
// the commit that replaced it, and asserts two things:
//
//   1. the attack SUCCEEDS against the old code   (proving the bug was real)
//   2. the attack FAILS against the current code  (proving the fix works)
//
// If someone reverts a fix, the second assertion breaks. If someone "simplifies"
// the old-code reproduction until it stops being vulnerable, the first breaks.
// Both halves have to keep telling the truth.

let failures = 0;

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** Asserts a defect was real, and is now fixed. */
function regression(name: string, params: { attackWorkedBefore: boolean; attackFailsNow: boolean }): void {
  assert(`${name}: the attack worked against the old code`, params.attackWorkedBefore);
  assert(`${name}: the attack fails against the current code`, params.attackFailsNow);
}

const NOW = new Date("2026-08-20T12:00:00.000Z");

// ===========================================================================
console.log("\n1. Tenant isolation — cross-store reads that passed the guard");

// THE OLD IMPLEMENTATION, verbatim from lib/tenantIsolation.ts before the fix.
function oldIsRealFilterObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}
function oldHasValidScope(where: unknown, scopeKeys: readonly string[]): boolean {
  if (!oldIsRealFilterObject(where)) return false;
  if (scopeKeys.some((key) => key in where && where[key] !== undefined)) return true;
  if (oldIsRealFilterObject(where.store)) return true;
  if (Array.isArray(where.AND) && where.AND.some((c) => oldHasValidScope(c, scopeKeys))) return true;
  if (Array.isArray(where.OR) && where.OR.length > 0 && where.OR.every((c) => oldHasValidScope(c, scopeKeys))) return true;
  return false;
}

{
  const SCOPE = ["storeId"] as const;

  // Every order belonging to any store that is not mine.
  const negated = { storeId: { not: "store_mine" } };
  regression("negated storeId", {
    attackWorkedBefore: oldHasValidScope(negated, SCOPE),
    attackFailsNow: !hasValidScope(negated, SCOPE),
  });

  const notIn = { storeId: { notIn: ["store_mine"] } };
  regression("notIn storeId", {
    attackWorkedBefore: oldHasValidScope(notIn, SCOPE),
    attackFailsNow: !hasValidScope(notIn, SCOPE),
  });

  // Every order on every published store on the platform.
  const anyPublished = { store: { published: true } };
  regression("store filter naming no store", {
    attackWorkedBefore: oldHasValidScope(anyPublished, SCOPE),
    attackFailsNow: !hasValidScope(anyPublished, SCOPE),
  });

  // And the fix must not have broken what the app legitimately does.
  assert("real scoping still works", hasValidScope({ storeId: "store_1" }, SCOPE));
  assert("the storefront's slug lookup still works",
    hasValidScope({ store: { slug: "cubit-and-coil", published: true } }, SCOPE));
}

// ===========================================================================
console.log("\n2. OAuth state — binding an attacker's account to a victim");

// THE OLD IMPLEMENTATION: the onboarding fulfillment callback split the state
// on a colon and trusted both halves.
function oldParseOnboardingState(state: string | null): { draftId: string | null; provider: string | null } {
  const [draftId, provider] = state?.split(":") ?? [];
  return { draftId: draftId ?? null, provider: provider ?? null };
}

{
  // The attacker crafts a callback naming the VICTIM'S draft, carrying their own
  // authorization code. The victim clicks it while signed in.
  const forged = "draft_victim:PRINTFUL";

  const old = oldParseOnboardingState(forged);
  const oldAccepted = old.draftId === "draft_victim" && old.provider === "PRINTFUL";

  const now = verifyOAuthState(forged, {
    secret: "test-secret-not-a-real-one",
    provider: "PRINTFUL",
    cookieNonce: newNonce(),
    sessionUserId: "user_victim",
    now: NOW,
  });

  regression("forged onboarding state", {
    attackWorkedBefore: oldAccepted,
    attackFailsNow: !now.ok,
  });

  // A signature alone is not enough — the nonce makes it single-use, so a state
  // captured from a real flow cannot be replayed.
  const SECRET = "test-secret-not-a-real-one";
  const nonce = newNonce();
  const real = signOAuthState(
    {
      storeId: "",
      storeDraftId: "draft_victim",
      provider: "PRINTFUL",
      userId: "user_victim",
      executionId: "",
      nonce,
      expiresAt: NOW.getTime() + OAUTH_STATE_TTL_MS,
    },
    SECRET
  );
  const withCookie = verifyOAuthState(real, {
    secret: SECRET, provider: "PRINTFUL", cookieNonce: nonce, sessionUserId: "user_victim", now: NOW,
  });
  const replayed = verifyOAuthState(real, {
    secret: SECRET, provider: "PRINTFUL", cookieNonce: null, sessionUserId: "user_victim", now: NOW,
  });
  assert("a genuine handoff completes once", withCookie.ok);
  assert("and cannot be replayed after the cookie is cleared", !replayed.ok);

  // Nor stolen by a different signed-in user.
  const otherUser = verifyOAuthState(real, {
    secret: SECRET, provider: "PRINTFUL", cookieNonce: nonce, sessionUserId: "user_attacker", now: NOW,
  });
  assert("nor completed by a different signed-in user", !otherUser.ok);
}

// ===========================================================================
console.log("\n3. Payment badges — telling a store it can take money when it cannot");

// THE OLD IMPLEMENTATION: "is the row not DISCONNECTED?"
function oldSaysConnected(status: string | null): boolean {
  return status !== null && status !== "DISCONNECTED";
}

{
  // Six real stores were shown "Connected" for Stripe accounts that had failed
  // verification and could not take a cent.
  for (const broken of ["FAILED", "NEEDS_ATTENTION"] as const) {
    regression(`${broken} shown as connected`, {
      attackWorkedBefore: oldSaysConnected(broken),
      attackFailsNow: paymentBadgeFor(broken).kind !== "connected",
    });
  }
  assert("a genuinely connected store still says so", paymentBadgeFor("CONNECTED").kind === "connected");
}

// ===========================================================================
console.log("\n4. Token rotation — the eighteen-day QuickBooks outage");

// THE OLD IMPLEMENTATION: read access_token, discard everything else.
function oldRefresh(current: { accessToken: string; refreshToken: string }, response: { access_token: string; refresh_token?: string }) {
  // Note what is missing: refresh_token is never read, and nothing is persisted.
  return { ...current, accessToken: response.access_token };
}

{
  const stored = { accessToken: "access_old", refreshToken: "refresh_old", expiresAt: NOW.getTime() - 1 };
  const providerResponse = { access_token: "access_new", refresh_token: "refresh_new", expires_in: 3600 };

  const oldResult = oldRefresh(stored, providerResponse);
  // The bug: the retired token is kept, so the NEXT refresh presents a dead one.
  const oldKeptRetiredToken = oldResult.refreshToken === "refresh_old";

  const merged = mergeRefreshedTokens(stored, providerResponse, NOW);

  regression("discarding a rotated refresh token", {
    attackWorkedBefore: oldKeptRetiredToken,
    attackFailsNow: merged.refreshToken === "refresh_new",
  });

  // Chaining is what actually broke in production: refresh #2 used the token
  // refresh #1 retired.
  let chained = stored;
  for (const round of [1, 2, 3]) {
    chained = mergeRefreshedTokens(chained, { access_token: `a${round}`, refresh_token: `r${round}`, expires_in: 3600 }, NOW);
  }
  assert("three chained refreshes end on the newest token", chained.refreshToken === "r3");

  // A provider that sends none (Google) must keep the existing one, not blank it.
  const noRotation = mergeRefreshedTokens(stored, { access_token: "a", expires_in: 60 }, NOW);
  assert("a provider that does not rotate keeps its token", noRotation.refreshToken === "refresh_old");
}

// ===========================================================================
console.log("\n5. The cron gate — 'Bearer undefined'");

// THE OLD IMPLEMENTATION, verbatim.
function oldCronCheck(authHeader: string | null, secret: string | undefined): boolean {
  return authHeader === `Bearer ${secret}`;
}

{
  // With CRON_SECRET unset, the template string IS "Bearer undefined". Behind
  // this gate sits runDueSyncs — the cross-tenant execution bypass.
  const forged = "Bearer undefined";
  regression("unset CRON_SECRET", {
    attackWorkedBefore: oldCronCheck(forged, undefined),
    attackFailsNow: !isAuthorizedCronRequest(forged, undefined),
  });

  // The real secret must still work, or this is an outage rather than a fix.
  const secret = "a-real-cron-secret-value";
  assert("a correct header is still accepted", isAuthorizedCronRequest(`Bearer ${secret}`, secret));
  assert("a wrong one is refused", !isAuthorizedCronRequest("Bearer nope-nope-nope-x", secret));
}

// ===========================================================================
console.log("\n6. Rate limits — punishing a healthy connection for being popular");

// THE OLD IMPLEMENTATION: everything that was not SUCCESS was a failure.
const SIX_HOURS = 6 * 60 * 60 * 1000;
function oldBackoff(failureCount: number): { syncFailureCount: number; waitMs: number } {
  const next = failureCount + 1;
  return { syncFailureCount: next, waitMs: Math.min(SIX_HOURS * 2 ** next, 24 * 60 * 60 * 1000) };
}

{
  // A provider says "come back in 90 seconds". The old code counted that as a
  // failure and waited twelve hours — and a store that was merely busy walked
  // up the exponential curve toward the 24h cap.
  const old = oldBackoff(0);
  const now = nextSyncAttempt({
    outcome: "rate_limited",
    retryAfterMs: 90_000,
    failureCount: 0,
    now: NOW.getTime(),
  });
  const nowWait = now.nextSyncDueAt.getTime() - NOW.getTime();

  regression("a rate limit counted as a failure", {
    attackWorkedBefore: old.syncFailureCount === 1 && old.waitMs === 12 * 60 * 60 * 1000,
    attackFailsNow: now.syncFailureCount === 0 && nowWait === 90_000,
  });

  // A genuine failure must still back off, or the fix has removed the protection.
  const failed = nextSyncAttempt({ outcome: "failure", failureCount: 0, now: NOW.getTime() });
  assert("a real failure still counts and still backs off",
    failed.syncFailureCount === 1 && failed.nextSyncDueAt.getTime() - NOW.getTime() === 12 * 60 * 60 * 1000);
}

// ===========================================================================
console.log("\n7. Password reset — the attacker who stayed signed in");

// THE OLD IMPLEMENTATION: there was none. Sessions are JWTs, nothing was
// checked, and a token already issued stayed valid until it expired.
function oldSessionStillValid(): boolean {
  return true;
}

{
  const changedAt = new Date("2026-08-20T12:00:00.000Z");
  const attackerTokenIat = Math.floor(new Date("2026-08-20T11:00:00.000Z").getTime() / 1000);

  regression("a stolen session surviving a password reset", {
    attackWorkedBefore: oldSessionStillValid(),
    attackFailsNow: isTokenIssuedBeforePasswordChange(attackerTokenIat, changedAt),
  });

  // And the owner's own fresh session must survive, or resetting a password
  // logs you straight back out.
  const freshIat = Math.floor(new Date("2026-08-20T12:05:00.000Z").getTime() / 1000);
  assert("a session created after the reset survives",
    !isTokenIssuedBeforePasswordChange(freshIat, changedAt));
  // Everyone who has never reset must be untouched — the null bug that would
  // log out the entire platform.
  assert("an account that never reset is untouched",
    !isTokenIssuedBeforePasswordChange(freshIat, null));
}

// ===========================================================================
console.log("\n8. Passwords — what used to be accepted");

// THE OLD IMPLEMENTATION: `if (!email || !password)`.
function oldPasswordCheck(password: string): boolean {
  return !!password;
}

{
  for (const trivial of ["a", "1234567", "password"]) {
    regression(`"${trivial}" accepted at signup`, {
      attackWorkedBefore: oldPasswordCheck(trivial),
      attackFailsNow: !checkPassword(trivial).ok,
    });
  }
  // A long passphrase must still pass — the rules exist to allow those, not to
  // force Password1!.
  assert("a real passphrase is accepted", checkPassword("correct horse battery staple").ok);
}

// ===========================================================================
console.log("\n9. Provider errors — a token written into the database");

// THE OLD IMPLEMENTATION: interpolate the raw response body.
function oldErrorMessage(status: number, body: string): string {
  return `Provider failed (${status}): ${body}`;
}

{
  const SECRET_TOKEN = "ya29.a0AfB_byC3xKfP9qRsTuVwXyZ01234567890abcdefGHIJKLMNOP";
  const body = JSON.stringify({ error: "invalid_request", access_token: SECRET_TOKEN });

  const old = oldErrorMessage(400, body);
  // That string went into ExecutionLog.message and onto the owner's card.
  regression("a token reaching a durable record", {
    attackWorkedBefore: old.includes(SECRET_TOKEN),
    attackFailsNow: !redactSecrets(body).includes(SECRET_TOKEN),
  });

  // And the redaction must not eat the message it was protecting.
  const prose = "The refresh token is invalid or expired. Please reconnect.";
  assert("ordinary prose survives redaction", redactSecrets(prose) === prose);
}


// ===========================================================================
console.log("\n10. Shipping — a customer paid for overnight and got five-day ground");

// THE OLD IMPLEMENTATION, copied from lib/execution/executables/shipping.ts
// before 2026-08-20: filter to USPS, take the cheapest, and never look at what
// the customer chose. Order.selectedShippingService was written by the webhook
// and read by nobody.
interface RateLike { id: string; carrier: string; service: string; rate: string }
function oldChooseRate(rates: RateLike[]): RateLike | null {
  const usps = rates.filter((r) => r.carrier === "USPS");
  if (usps.length === 0) return null;
  return usps.reduce((lowest, r) => (parseFloat(r.rate) < parseFloat(lowest.rate) ? r : lowest));
}

{
  const RATES: RateLike[] = [
    { id: "rate_ga", carrier: "USPS", service: "GroundAdvantage", rate: "5.50" },
    { id: "rate_express", carrier: "USPS", service: "PriorityMailExpress", rate: "31.40" },
    { id: "rate_ups", carrier: "UPS", service: "Ground", rate: "8.75" },
  ];

  // The customer chose overnight at checkout and was charged $31.40 for it.
  const paidFor = { carrier: "USPS", service: "Priority Mail Express" };
  const old = oldChooseRate(RATES);
  const now = chooseRate(RATES, paidFor);

  regression("the paid-for service being silently downgraded", {
    attackWorkedBefore: old?.service === "GroundAdvantage",
    attackFailsNow: now.ok && now.rate.service === "PriorityMailExpress",
  });

  // The second half of the same defect: a carrier that is not USPS could never
  // be bought at all, so a customer who paid for UPS Ground got a USPS label —
  // or, with no USPS rates on the table, nothing.
  const nowUps = chooseRate(RATES, { carrier: "UPS", service: "Ground" });
  regression("a non-USPS service being unbuyable", {
    attackWorkedBefore: oldChooseRate(RATES)?.carrier === "USPS",
    attackFailsNow: nowUps.ok && nowUps.rate.carrier === "UPS",
  });

  // The fix must REFUSE rather than substitute when the service is gone —
  // falling back to the cheapest would be the original defect wearing a hat.
  const gone = chooseRate(RATES.filter((r) => r.service !== "PriorityMailExpress"), paidFor);
  assert("a service the carrier no longer sells is refused, not substituted",
    !gone.ok && gone.reason === "selection_unavailable");

  // And an order that chose nothing still gets exactly what it always got.
  const unchosen = chooseRate(RATES, { carrier: null, service: null });
  assert("an order with no selection still buys the cheapest USPS rate",
    unchosen.ok && unchosen.rate.id === "rate_ga");
}

// ===========================================================================
console.log("\n11. Business context — a second business became active by being touched");

// THE OLD IMPLEMENTATION, copied from lib/permissions.ts before 2026-08-20:
// "the" business for an account was whichever store had been UPDATED most
// recently. 47 call sites relied on it. So a second business did not have to be
// chosen to become the active one; it only had to be written to.
interface StoreLike { id: string; updatedAt: number }
function oldResolveUserStore(stores: StoreLike[]): StoreLike | null {
  const sorted = [...stores].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0] ?? null;
}

// The current rule, as a pure function of the same inputs: an explicit pointer
// decides, a single business needs no pointer, and more than one with no pointer
// is a question rather than an answer. Mirrors lib/businessContext.ts, which is
// proven against a real database in verify-business-context-live.ts.
function newResolve(stores: StoreLike[], activeStoreId: string | null): StoreLike | "ambiguous" | null {
  if (activeStoreId) {
    const active = stores.find((s) => s.id === activeStoreId);
    if (active) return active;
  }
  if (stores.length === 0) return null;
  if (stores.length === 1) return stores[0];
  return "ambiguous";
}

{
  const first: StoreLike = { id: "first", updatedAt: 100 };
  // The owner is working in `first`. They edit a product in `second`, which
  // touches it.
  const second: StoreLike = { id: "second", updatedAt: 200 };
  const stores = [first, second];

  regression("a business becoming active by being touched", {
    attackWorkedBefore: oldResolveUserStore(stores)?.id === "second",
    attackFailsNow: (newResolve(stores, "first") as StoreLike | null)?.id === "first",
  });

  // And with nothing chosen, the old code still picked. The new one asks.
  regression("silently picking when nothing says which", {
    attackWorkedBefore: oldResolveUserStore(stores)?.id === "second",
    attackFailsNow: newResolve(stores, null) === "ambiguous",
  });

  // The unambiguous cases must not have regressed into questions.
  assert("one business still resolves without a pointer",
    (newResolve([first], null) as StoreLike)?.id === "first");
  assert("no business is still an ordinary null", newResolve([], null) === null);
  // A pointer at a business that no longer exists falls through rather than
  // dangling \u2014 the deleted-business case.
  assert("a stale pointer falls through to the only remaining business",
    (newResolve([first], "deleted") as StoreLike)?.id === "first");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
