import { readFileSync } from "fs";
import { join } from "path";
import {
  hasValidScope,
  TENANT_SCOPED_MODEL_KEYS,
  GUARDED_READ_OPERATIONS,
  GUARDED_MUTATION_OPERATIONS,
} from "@/lib/tenantIsolation";

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
console.log("\n7. The operations under guard");
{
  // THE LIST OF OPERATIONS WAS ITSELF UNGUARDED. Every assertion above tests
  // hasValidScope and the model list; nothing tested WHICH operations consult
  // them, so dropping findMany from the read set would have left every
  // collection read unscoped with this suite still green.
  //
  // A collection read has no "authorize after" story the way a single-record
  // lookup does: an omitted filter returns another store's rows wholesale.
  for (const op of ["findMany", "count", "aggregate", "groupBy"]) {
    assert(`${op} is guarded as a collection read`, GUARDED_READ_OPERATIONS.has(op));
  }
  // groupBy was deferred from the original pass and added 2026-08-23. The real
  // call sites group ORDERS by buyer email and GROWTH POINT TRANSACTIONS by
  // action type, so an unscoped one is other people's customers and other
  // people's money, already summed — the worst-shaped leak of the four.
  assert("groupBy is no longer the unguarded fourth", GUARDED_READ_OPERATIONS.has("groupBy"));

  for (const op of ["update", "delete", "updateMany", "deleteMany"]) {
    assert(`${op} is guarded as a mutation`, GUARDED_MUTATION_OPERATIONS.has(op));
  }

  // DELIBERATELY NOT GUARDED, and asserted so that adding one becomes a
  // decision somebody makes rather than something that drifts in. findFirst and
  // findUnique are the confirmed-safe fetch-then-authorize pattern; create and
  // upsert were out of the approved scope.
  for (const op of ["findFirst", "findUnique", "create", "createMany", "upsert"]) {
    assert(`${op} is deliberately not guarded`,
      !GUARDED_READ_OPERATIONS.has(op) && !GUARDED_MUTATION_OPERATIONS.has(op));
  }
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

// ============ THE MAP AND THE SCHEMA MUST NOT DRIFT ======================
//
// This is a SWEEP, not a list, and the difference is the whole point of it.
//
// On 2026-08-27 the map and the schema had drifted by EIGHT models --
// conversation, task, promotion, checkoutDraft, proactiveDelivery,
// recordRelationship, supplierRequestEvent, businessPartnerTrialGrant -- every
// one added after the map was last widened. None of them leaked, because every
// call site happened to pass storeId. But the guard returns early for a model
// it does not know, so nothing would have objected if one had not.
//
// A maintained list would have needed the same person who forgot the map to
// remember the list. Reading the schema removes that: adding a storeId column
// fails this suite until the model is either guarded or deliberately excused.
//
// Same lesson, and the same fix, as scripts/lib/suiteLanes.ts's needsDatabase.
{
  console.log("\n=== The guard covers every store-scoped model in the schema ===\n");

  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const lower = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

  const withStoreId = [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)]
    .filter((m) => /\n\s+storeId\s/.test(m[2]))
    .map((m) => lower(m[1]));

  assert("the schema really does have store-scoped models", withStoreId.length > 20,
    `found ${withStoreId.length}`);

  const guarded = new Set(Object.keys(TENANT_SCOPED_MODEL_KEYS));

  // DELIBERATELY UNGUARDED, each with a reason. Empty today: every model that
  // carries a storeId is guarded. An entry here is a decision somebody made,
  // which is the only acceptable way for this list to be non-empty.
  const excused = new Map<string, string>([]);

  const unguarded = withStoreId.filter((m) => !guarded.has(m) && !excused.has(m));
  check("every model carrying storeId is guarded", unguarded, []);

  // AND THE REVERSE: a guarded model that no longer carries storeId is a rule
  // pointing at nothing, which reads as protection and is not.
  const schemaModels = new Set(
    [...schema.matchAll(/model\s+(\w+)\s*\{/g)].map((m) => lower(m[1])),
  );
  const stale = [...guarded].filter((m) => !schemaModels.has(m));
  check("and no guarded model has left the schema", stale, []);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
