import { resolveWebhookStore } from "@/lib/orders/webhookStore";
import { isPermanentOrderFailure } from "@/lib/orders/orderFailure";

// Forging Stripe webhook events at the trust boundary for money.
// No database, no network:
//
//   npx tsx scripts/verify-webhook-store.ts
//
// Session metadata is set by our own createCheckoutSession — but a CONNECTED
// merchant holds an API-key-equivalent access token for their own Stripe account
// and can create sessions directly, with any metadata they like. So the attack
// this file exists for is a merchant minting a session that claims someone
// else's storeId, and having a real order land in that store.
//
// `event.account` is set by Stripe, not the merchant. Metadata may only
// DISAMBIGUATE between stores that genuinely hold that account — never reach a
// store the account is not connected to.

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

const ATTACKER_ACCOUNT = "acct_attacker";
const VICTIM_STORE = "store_victim";

// ---------------------------------------------------------------------------
console.log("\n1. A merchant claiming another store's id");
{
  // The attacker creates a session on their OWN Stripe account, with metadata
  // naming the victim's store. Stripe stamps event.account with the attacker's
  // account, because that is where the session really lives.
  const forged = resolveWebhookStore({
    eventAccount: ATTACKER_ACCOUNT,
    metadataStoreId: VICTIM_STORE,
    // The victim's integration really exists — and is connected to a DIFFERENT
    // Stripe account, which is exactly what makes the claim false.
    claimed: { storeId: VICTIM_STORE, externalAccountId: "acct_victim" },
    // The attacker's own account resolves to their own store.
    byAccount: { storeId: "store_attacker" },
  });

  assert("the order does not land in the victim's store", forged.storeId !== VICTIM_STORE, forged.storeId ?? "null");
  check("it lands in the attacker's own store, where the money actually is", forged, {
    storeId: "store_attacker",
    via: "account_lookup",
  });
}

// ---------------------------------------------------------------------------
console.log("\n2. Claiming a store that has no Stripe connection at all");
{
  const forged = resolveWebhookStore({
    eventAccount: ATTACKER_ACCOUNT,
    metadataStoreId: VICTIM_STORE,
    claimed: null, // no integration row for that store
    byAccount: { storeId: "store_attacker" },
  });
  assert("the claim is ignored", forged.storeId !== VICTIM_STORE);

  // And with nothing to fall back to, it resolves to nothing rather than
  // guessing — which is what makes the money visible as unrecorded instead of
  // being filed under the wrong store.
  const nowhere = resolveWebhookStore({
    eventAccount: ATTACKER_ACCOUNT,
    metadataStoreId: VICTIM_STORE,
    claimed: null,
    byAccount: null,
  });
  check("an unmatched account resolves to nothing", nowhere, { storeId: null, via: "unresolved" });
}

// ---------------------------------------------------------------------------
console.log("\n3. A null externalAccountId must not match a null account");
{
  // A store that connected and later had its account id cleared has
  // externalAccountId null. If null were treated as "matches", any connected
  // event could be claimed for it.
  const forged = resolveWebhookStore({
    eventAccount: ATTACKER_ACCOUNT,
    metadataStoreId: VICTIM_STORE,
    claimed: { storeId: VICTIM_STORE, externalAccountId: null },
    byAccount: { storeId: "store_attacker" },
  });
  assert("a null stored account never confirms a claim", forged.storeId !== VICTIM_STORE, forged.via);
}

// ---------------------------------------------------------------------------
console.log("\n4. The legitimate case this disambiguation exists for");
{
  // externalAccountId has no unique constraint: one owner running two stores
  // can legitimately connect the same Stripe account to both. Metadata is what
  // says WHICH of their stores this sale belongs to.
  const shared = resolveWebhookStore({
    eventAccount: "acct_shared",
    metadataStoreId: "store_second",
    claimed: { storeId: "store_second", externalAccountId: "acct_shared" },
    // A bare account lookup would have returned whichever row Postgres felt
    // like — this is the ambiguity metadata resolves.
    byAccount: { storeId: "store_first" },
  });
  check("metadata picks the right one of two shared stores", shared, {
    storeId: "store_second",
    via: "metadata_confirmed",
  });
  assert("and it is NOT the arbitrary first row", shared.storeId !== "store_first");
}

// ---------------------------------------------------------------------------
console.log("\n5. Platform events, where metadata is genuinely ours");
{
  // No event.account means the platform key created it — our own code end to
  // end, so there is no merchant in a position to forge the metadata.
  check("platform metadata is trusted", resolveWebhookStore({
    eventAccount: null,
    metadataStoreId: "store_1",
    claimed: null,
    byAccount: null,
  }), { storeId: "store_1", via: "platform_metadata" });

  check("a platform event with no metadata resolves to nothing", resolveWebhookStore({
    eventAccount: null,
    metadataStoreId: undefined,
    claimed: null,
    byAccount: null,
  }), { storeId: null, via: "unresolved" });
}

// ---------------------------------------------------------------------------
console.log("\n6. Replays and duplicates resolve identically");
{
  // Stripe redelivers. Resolution must be a pure function of the event, or the
  // same event could land in different stores on different attempts — and the
  // order-level idempotency guard keys on the session id within ONE store.
  const event = {
    eventAccount: "acct_shared",
    metadataStoreId: "store_second",
    claimed: { storeId: "store_second", externalAccountId: "acct_shared" },
    byAccount: { storeId: "store_first" },
  };
  const first = resolveWebhookStore(event);
  const replay = resolveWebhookStore(event);
  const thirdTime = resolveWebhookStore(event);
  check("a replayed event resolves the same way", replay, first);
  check("and again", thirdTime, first);

  // Order matters not at all — there is no state carried between calls.
  const other = resolveWebhookStore({ ...event, metadataStoreId: "store_first", claimed: { storeId: "store_first", externalAccountId: "acct_shared" } });
  check("an interleaved different event does not disturb it", resolveWebhookStore(event), first);
  assert("and resolves on its own terms", other.storeId === "store_first");
}

// ---------------------------------------------------------------------------
console.log("\n7. Which failures Stripe should be asked to retry");
{
  // A webhook status code is an instruction to Stripe, not a description of
  // our mood. Getting it backwards is expensive in opposite directions: a
  // permanent failure answered 500 is retried for days and then silently given
  // up on; a transient one answered 200 throws away the mechanism that would
  // have recovered it.
  const prismaError = (code: string) => Object.assign(new Error("prisma"), { code });

  // The store or product is gone. Nothing brings it back.
  assert("a foreign key violation is permanent", isPermanentOrderFailure(prismaError("P2003")));
  assert("a missing record is permanent", isPermanentOrderFailure(prismaError("P2025")));

  // Everything else must be retried, because a retry is what recovers it.
  assert("a closed connection is transient", !isPermanentOrderFailure(prismaError("P1017")));
  assert("a timeout is transient", !isPermanentOrderFailure(prismaError("P2024")));
  assert("a unique-constraint clash is transient", !isPermanentOrderFailure(prismaError("P2002")));

  // The default direction is deliberate. Retrying a permanent failure wastes a
  // few days of Stripe's patience; NOT retrying a transient one loses a real
  // sale. Anything unrecognised must fall on the retry side.
  assert("an unknown Prisma code is transient", !isPermanentOrderFailure(prismaError("P9999")));
  assert("a plain Error is transient", !isPermanentOrderFailure(new Error("boom")));
  assert("a thrown string is transient", !isPermanentOrderFailure("something"));
  assert("null is transient", !isPermanentOrderFailure(null));
  assert("undefined is transient", !isPermanentOrderFailure(undefined));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
