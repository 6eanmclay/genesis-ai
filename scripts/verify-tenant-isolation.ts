import { hasValidScope, TENANT_SCOPED_MODEL_KEYS } from "@/lib/tenantIsolation";

// Structural tenant isolation. No database, no network:
//
//   npx tsx scripts/verify-tenant-isolation.ts
//
// This existed for a long time with NO test, and COMPLIANCE.md marked it
// compliant on the strength of the file being there — exactly the standard this
// audit is supposed to reject. Writing the assertions found two real bypasses,
// both of which selected other tenants' rows while passing the check:
//
//   { storeId: { not: "mine" } }      every store EXCEPT mine
//   { store: { published: true } }    every published store on the platform
//
// The first passed because `storeId` was merely PRESENT. The second because
// `store` was merely a non-empty object. Presence is not scoping.

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

const SCOPE = ["storeId"] as const;

// ---------------------------------------------------------------------------
console.log("\n1. The two bypasses");
{
  // Reads as scoped. Selects every store except the caller's.
  assert("a negated storeId is NOT scoping", !hasValidScope({ storeId: { not: "store_mine" } }, SCOPE));
  assert("nor is notIn", !hasValidScope({ storeId: { notIn: ["store_mine"] } }, SCOPE));
  // Reads as scoped. Selects every published store on the platform.
  assert("a store filter naming no store is NOT scoping", !hasValidScope({ store: { published: true } }, ["storeId"]));
  assert("nor an empty one", !hasValidScope({ store: {} }, ["storeId"]));
}

// ---------------------------------------------------------------------------
console.log("\n2. Real scoping still passes — the queries the app actually makes");
{
  assert("a plain storeId", hasValidScope({ storeId: "store_1" }, SCOPE));
  assert("with other filters alongside", hasValidScope({ storeId: "store_1", status: "paid" }, SCOPE));
  assert("the explicit equals form", hasValidScope({ storeId: { equals: "store_1" } }, SCOPE));
  // Several stores a person owns is legitimate scoping.
  assert("an in-list", hasValidScope({ storeId: { in: ["store_1", "store_2"] } }, SCOPE));
  // Empty `in` matches no rows, so it cannot leak — rejecting it would fail a
  // legitimate query over an empty list.
  assert("an empty in-list is allowed, because it matches nothing",
    hasValidScope({ storeId: { in: [] } }, SCOPE));
  // The storefront's real product lookup.
  assert("a store relation naming a slug",
    hasValidScope({ id: "prod_1", active: true, store: { slug: "cubit-and-coil", published: true } }, SCOPE));
  assert("or naming an id", hasValidScope({ store: { id: "store_1" } }, SCOPE));
}

// ---------------------------------------------------------------------------
console.log("\n3. Nothing at all is never scoped");
{
  check("an empty where", hasValidScope({}, SCOPE), false);
  check("a missing where", hasValidScope(undefined, SCOPE), false);
  check("a null where", hasValidScope(null, SCOPE), false);
  check("an unrelated filter", hasValidScope({ status: "paid" }, SCOPE), false);
  // `undefined` is how an optional variable arrives when it was never set —
  // the single most likely way an unscoped query gets written by accident.
  check("storeId explicitly undefined", hasValidScope({ storeId: undefined }, SCOPE), false);
  check("and a NOT-only filter", hasValidScope({ NOT: { storeId: "store_1" } }, SCOPE), false);
}

// ---------------------------------------------------------------------------
console.log("\n4. AND and OR compose the way the leak requires");
{
  // AND: every branch must match, so ONE scoped branch confines the whole query.
  assert("AND with one scoped branch", hasValidScope({ AND: [{ status: "paid" }, { storeId: "store_1" }] }, SCOPE));
  assert("AND with none is unscoped", !hasValidScope({ AND: [{ status: "paid" }] }, SCOPE));
  assert("AND nested two deep", hasValidScope({ AND: [{ AND: [{ storeId: "store_1" }] }] }, SCOPE));

  // OR: any branch can match on its own, so EVERY branch must be scoped. This
  // is the asymmetry that matters — one unscoped branch returns other stores'
  // rows regardless of how well-scoped its siblings are.
  assert("OR with every branch scoped",
    hasValidScope({ OR: [{ storeId: "store_1" }, { storeId: "store_2" }] }, SCOPE));
  assert("OR with ONE unscoped branch is unscoped",
    !hasValidScope({ OR: [{ storeId: "store_1" }, { status: "paid" }] }, SCOPE));
  assert("an empty OR is unscoped", !hasValidScope({ OR: [] }, SCOPE));
  // And the bypass must not sneak back in through a branch.
  assert("OR containing a negated branch is unscoped",
    !hasValidScope({ OR: [{ storeId: "store_1" }, { storeId: { not: "store_1" } }] }, SCOPE));
}

// ---------------------------------------------------------------------------
console.log("\n5. Models with more than one legitimate scope key");
{
  // Draft-phase rows have storeDraftId and no storeId yet; either is real.
  const dual = ["storeId", "storeDraftId"] as const;
  assert("the live key scopes", hasValidScope({ storeId: "store_1" }, dual));
  assert("the draft key scopes", hasValidScope({ storeDraftId: "draft_1" }, dual));
  assert("neither present is unscoped", !hasValidScope({ action: "x" }, dual));
  // A key that is not a scope key for THIS model must not count.
  assert("a foreign key does not scope", !hasValidScope({ storeDraftId: "draft_1" }, SCOPE));
}

// ---------------------------------------------------------------------------
console.log("\n6. The models under guard");
{
  const models = Object.keys(TENANT_SCOPED_MODEL_KEYS);
  // The ones holding customer and money data. If any is ever dropped from the
  // list, its collection reads stop being guarded silently.
  for (const critical of ["order", "product", "storeIntegration", "businessRecord", "storeMessage", "newsletterSignup"]) {
    assert(`${critical} is guarded`, models.includes(critical));
  }
  assert("every guarded model names at least one scope key",
    models.every((m) => (TENANT_SCOPED_MODEL_KEYS as Record<string, readonly string[]>)[m].length > 0));
}

// ---------------------------------------------------------------------------
console.log("\nStoreMember is scoped by the person as well as the business");
{
  // Added 2026-08-20 for business context. "Which businesses can this account
  // reach" is inherently a cross-store question, and StoreMember is where it is
  // answered — so `userId` is a real scope key there, the same dual-key shape
  // productEvent and aiUsageEvent already had.
  const MEMBER = TENANT_SCOPED_MODEL_KEYS.storeMember;
  assert("userId is a recognised scope", MEMBER.includes("userId"), MEMBER.join(", "));
  assert("and so is storeId", MEMBER.includes("storeId"), MEMBER.join(", "));

  assert("one person's own memberships are scoped", hasValidScope({ userId: "user_1" }, MEMBER));
  assert("as is one business's members", hasValidScope({ storeId: "store_1" }, MEMBER));

  // THE PART THAT MATTERS. Widening the map must not widen the rule: every
  // bypass closed for storeId has to still be closed for userId, or this became
  // a hole rather than a completion.
  assert("everybody except me is NOT scoping", !hasValidScope({ userId: { not: "user_1" } }, MEMBER));
  assert("nor notIn", !hasValidScope({ userId: { notIn: ["user_1"] } }, MEMBER));
  assert("nor a bare presence", !hasValidScope({ userId: {} }, MEMBER));
  assert("nor a role filter alone", !hasValidScope({ role: "OWNER" }, MEMBER));
  assert("nor nothing at all", !hasValidScope({}, MEMBER));
  // An OR with one unscoped branch still selects other people's rows.
  assert("an OR needs every branch scoped",
    !hasValidScope({ OR: [{ userId: "user_1" }, { role: "OWNER" }] }, MEMBER));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
