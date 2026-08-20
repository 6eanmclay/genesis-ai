import {
  signOAuthState,
  verifyOAuthState,
  newNonce,
  OAUTH_STATE_TTL_MS,
  type OAuthStatePayload,
} from "@/lib/integrations/oauthState";
import { toStatusView } from "@/lib/integrations/types";
import type { IntegrationProvider } from "@prisma/client";

// PHASE 1 removed the placeholder that used to be needed here: stripe.ts built
// its client at module scope, so importing the registry threw without a key.
// It is lazy now, and this suite importing the registry with NO Stripe key set
// is the proof — if that regresses, this file stops running.

// Phase 0 — the integration framework's security and contract tests.
// No database, no environment, no network:
//
//   npx tsx scripts/verify-integration-framework.ts
//
// The headline case is the one the audit found: `state` used to be the storeId
// in plain sight, so a crafted callback could bind an attacker's provider
// account to someone else's store. Section 1 is that attack, and every variant
// of it, failing.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const SECRET = "test-secret-not-a-real-one";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const NONCE = newNonce();

function payload(over: Partial<OAuthStatePayload> = {}): OAuthStatePayload {
  return {
    storeId: "store_victim",
    provider: "STRIPE",
    userId: "user_owner",
    executionId: "exec_1",
    nonce: NONCE,
    expiresAt: NOW.getTime() + OAUTH_STATE_TTL_MS,
    ...over,
  };
}

const good = signOAuthState(payload(), SECRET);
const verifyGood = (over: Parameters<typeof verifyOAuthState>[1] extends never ? never : Partial<Record<string, unknown>> = {}) =>
  verifyOAuthState(good, {
    secret: SECRET,
    provider: "STRIPE",
    cookieNonce: NONCE,
    sessionUserId: "user_owner",
    now: NOW,
    ...over,
  });

// ---------------------------------------------------------------------------
console.log("\n1. The attack the audit found, failing");
{
  // Before Phase 0 this WAS the mechanism: state was the storeId, so anyone
  // could name any store and the callback believed it.
  const forged = "store_victim";
  const result = verifyOAuthState(forged, {
    secret: SECRET,
    provider: "STRIPE",
    cookieNonce: NONCE,
    sessionUserId: "user_owner",
    now: NOW,
  });
  check("a bare storeId as state is rejected", result, { ok: false, reason: "malformed" });

  // Forged payload signed with the wrong key.
  const attackerSigned = signOAuthState(payload({ storeId: "store_victim" }), "attacker-secret");
  check(
    "a state signed with the wrong secret is rejected",
    verifyOAuthState(attackerSigned, { secret: SECRET, provider: "STRIPE", cookieNonce: NONCE, sessionUserId: "user_owner", now: NOW }),
    { ok: false, reason: "bad_signature" }
  );

  // Payload edited to point at another store, signature left alone.
  const parts = good.split(".");
  const edited = Buffer.from(JSON.stringify(payload({ storeId: "store_attacker" }))).toString("base64url");
  check(
    "editing the storeId invalidates the signature",
    verifyOAuthState(`${edited}.${parts[1]}`, { secret: SECRET, provider: "STRIPE", cookieNonce: NONCE, sessionUserId: "user_owner", now: NOW }),
    { ok: false, reason: "bad_signature" }
  );
}

// ---------------------------------------------------------------------------
console.log("\n2. A genuine handoff succeeds");
{
  const result = verifyGood();
  assert("the real state verifies", result.ok);
  if (result.ok) {
    check("and yields the store it was minted for", result.payload.storeId, "store_victim");
    check("and its own execution id", result.payload.executionId, "exec_1");
  }
}

// ---------------------------------------------------------------------------
console.log("\n3. Single-use");
{
  // The cookie is cleared on use, so the second attempt has no nonce at all.
  check("replaying a used state has no cookie to match", verifyGood({ cookieNonce: null }), {
    ok: false,
    reason: "nonce_mismatch",
  });
  check("a different browser's nonce does not match", verifyGood({ cookieNonce: newNonce() }), {
    ok: false,
    reason: "nonce_mismatch",
  });
}

// ---------------------------------------------------------------------------
console.log("\n4. Session-bound");
{
  check("a different signed-in user cannot finish it", verifyGood({ sessionUserId: "user_attacker" }), {
    ok: false,
    reason: "user_mismatch",
  });
  check("and a signed-out caller cannot", verifyGood({ sessionUserId: null }), {
    ok: false,
    reason: "user_mismatch",
  });
}

// ---------------------------------------------------------------------------
console.log("\n5. Expiring, and provider-bound");
{
  check(
    "a state past its expiry is rejected",
    verifyGood({ now: new Date(NOW.getTime() + OAUTH_STATE_TTL_MS + 1000) }),
    { ok: false, reason: "expired" }
  );
  check("a Stripe state cannot complete a Square connection", verifyGood({ provider: "SQUARE" }), {
    ok: false,
    reason: "provider_mismatch",
  });
  check("provider matching is case-insensitive", verifyOAuthState(good, {
    secret: SECRET, provider: "stripe", cookieNonce: NONCE, sessionUserId: "user_owner", now: NOW,
  }).ok, true);
}

// ---------------------------------------------------------------------------
console.log("\n6. status() never carries credentials");
{
  const row = {
    id: "int_1",
    storeId: "store_1",
    provider: "STRIPE" as IntegrationProvider,
    status: "CONNECTED" as const,
    externalAccountId: "acct_123",
    credentials: { ciphertext: "SHOULD-NEVER-APPEAR", iv: "x", tag: "y" },
    connectedByUserId: "user_1",
    connectedAt: NOW,
    lastVerifiedAt: NOW,
    lastError: null,
    lastSyncedAt: null,
    nextSyncDueAt: null,
    syncFailureCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const view = toStatusView(row as never);
  const serialized = JSON.stringify(view);
  check("the credentials blob is gone", serialized.includes("SHOULD-NEVER-APPEAR"), false);
  check("no credentials key survives", Object.keys(view ?? {}).includes("credentials"), false);
  check(
    "and the useful fields do",
    Object.keys(view ?? {}).sort(),
    ["connectedAt", "externalAccountId", "lastError", "lastSyncedAt", "lastVerifiedAt", "provider", "status", "syncFailureCount"]
  );
  check("a missing integration stays null", toStatusView(null), null);
}

// ---------------------------------------------------------------------------
console.log("\n7. Every connector declares what it can do");
async function connectorSections() {
  // Dynamic import kept for section ordering, not for env setup — see the note
  // at the top of this file about stripe.ts no longer needing a key to load.
  const { getConnector } = await import("@/lib/integrations/registry");

  const providers: IntegrationProvider[] = [
    "STRIPE", "PAYPAL", "GOOGLE_CALENDAR", "QUICKBOOKS", "MAILCHIMP",
    "PRINTFUL", "FACEBOOK", "INSTAGRAM", "TIKTOK", "EASYPOST",
  ];
  for (const p of providers) {
    const c = getConnector(p);
    const caps = c.capabilities;
    const declared = caps !== undefined && Array.isArray(caps.scopes) && Array.isArray(caps.reads) && Array.isArray(caps.writes);
    assert(`${p} declares capabilities`, declared);
    // An API-key connector must justify itself rather than default to one.
    if (caps?.authKind === "api_key") {
      assert(`${p} justifies its API-key exception`, !!caps.apiKeyExceptionReason, caps.apiKeyExceptionReason?.slice(0, 60));
    }
    // An OAuth connector must name the scopes it asks for — or say why there
    // are none. Two providers genuinely take no scope parameter, and an empty
    // array must mean "none exist", never "nobody filled this in". This used
    // to exempt Printful by name, which would have silently swallowed the next
    // connector that shipped with scopes: [] by accident.
    if (caps?.authKind === "oauth") {
      if (caps.scopes.length > 0) {
        assert(`${p} names its scopes`, true, caps.scopes.join(" "));
      } else {
        assert(`${p} explains why it has no scopes`, !!caps.noScopesReason, caps.noScopesReason?.slice(0, 60));
      }
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n8. Contract surface exists where it should");
  const withRefresh = (["QUICKBOOKS", "GOOGLE_CALENDAR", "PRINTFUL"] as IntegrationProvider[])
    .filter((p) => typeof getConnector(p).refresh === "function");
  console.log(`      connectors implementing refresh(): ${withRefresh.join(", ") || "(none yet)"}`);
  // Stripe Connect tokens do not expire and an API key has nothing to renew —
  // absence here is a real answer, not an oversight.
  check("Stripe correctly declares no refresh", typeof getConnector("STRIPE").refresh, "undefined");
  check("EasyPost correctly declares no refresh", typeof getConnector("EASYPOST").refresh, "undefined");

  // -------------------------------------------------------------------------
  console.log("\n9. Disconnect ends the grant at the provider, where it can");
  //
  // Deleting a stored token is not revoking it. A provider that still holds a
  // live grant is still connected, whatever Genesis's own row says — and the
  // owner has just been told access ended. Intuit and Google both require real
  // revocation; this asserts the three connectors that now do it, and keeps the
  // honest "not yet" of the others visible instead of buried.
  const revoking = providers.filter((p) => getConnector(p).capabilities.revokesOnDisconnect);
  check(
    "the connectors that revoke at the provider",
    revoking.sort(),
    ["FACEBOOK", "GOOGLE_CALENDAR", "INSTAGRAM", "QUICKBOOKS", "STRIPE", "TIKTOK"]
  );
  for (const p of providers) {
    const caps = getConnector(p).capabilities;
    // An API-key connector has no grant to revoke — the merchant rotates the
    // key at the provider. Declaring false there is correct, not a gap.
    if (caps.authKind === "api_key") {
      check(`${p} (api key) correctly declares no revocation`, caps.revokesOnDisconnect, false);
    }
  }
  // Two OAuth connectors do not revoke, and in both cases that is a fact about
  // the provider rather than a shortcut here: neither Printful nor Mailchimp
  // documents a revocation endpoint (Mailchimp's own words: a token "will
  // remain valid unless the user revokes your application's permission" — from
  // their account settings, not from an API). An earlier version of this suite
  // called Printful a gap; reading the docs is what corrected it. Asserted so
  // that if either ever ships one, this fails and says so.
  const oauthWithoutRevoke = providers.filter(
    (p) => getConnector(p).capabilities.authKind === "oauth" && !getConnector(p).capabilities.revokesOnDisconnect
  );
  check("the only two lacking revocation are the two that offer none", oauthWithoutRevoke.sort(), [
    "MAILCHIMP",
    "PRINTFUL",
  ]);

  // Webhook support is declared, not assumed. None today: Stripe's own routes
  // are deliberately left in place until Phase 1 migrates them.
  const withWebhooks = providers.filter((p) => getConnector(p).webhooks !== undefined);
  console.log(`      connectors declaring webhooks(): ${withWebhooks.join(", ") || "(none yet — Phase 1)"}`);
}

connectorSections()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
