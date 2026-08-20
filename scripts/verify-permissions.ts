import { PERMISSIONS, hasPermission } from "@/lib/permissions";

// The role/permission matrix. No database, no network:
//
//   npx tsx scripts/verify-permissions.ts
//
// There are exactly two roles. OWNER is derived from Store.userId — never a
// StoreMember row — so it cannot be granted by writing to a membership table.
// EMPLOYEE comes from StoreMember.
//
// The permissions EMPLOYEE must NEVER hold are asserted by name below rather
// than by counting, because the realistic way this breaks is someone adding one
// line to the EMPLOYEE array while wiring up a feature. Every entry here is a
// decision someone made deliberately, and this file is where it stops being
// possible to undo one by accident.

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

// ---------------------------------------------------------------------------
console.log("\n1. What an employee must never be able to do");
{
  // Money, identity, and Genesis's own autonomy. Each of these is owner-only
  // for a stated reason in lib/permissions.ts; this is where that survives
  // someone wiring up a feature in a hurry.
  const OWNER_ONLY = [
    ["change the store itself", PERMISSIONS.STORE_MANAGE],
    ["see revenue", PERMISSIONS.REVENUE_VIEW],
    ["connect or change payment providers", PERMISSIONS.PAYMENTS_MANAGE],
    ["add or remove employees", PERMISSIONS.EMPLOYEES_MANAGE],
    ["change what Genesis may do unsupervised", PERMISSIONS.AUTHORITY_MANAGE],
    ["connect third-party business software", PERMISSIONS.CONNECTIONS_MANAGE],
    ["spend the owner's money with Genesis", PERMISSIONS.BILLING_MANAGE],
    ["see analytics", PERMISSIONS.ANALYTICS_VIEW],
  ] as const;

  for (const [what, permission] of OWNER_ONLY) {
    assert(`an employee cannot ${what}`, !hasPermission("EMPLOYEE", permission), permission);
    // And the owner genuinely can, or the permission is just decoration.
    assert(`but the owner can`, hasPermission("OWNER", permission));
  }

  // BILLING_MANAGE is the one that mints Growth Points, which are sold for
  // money. Called out separately because it is the highest-value single line
  // in the whole matrix.
  assert("BILLING_MANAGE is owner-only", !hasPermission("EMPLOYEE", PERMISSIONS.BILLING_MANAGE));
}

// ---------------------------------------------------------------------------
console.log("\n2. What an employee legitimately can do");
{
  // An employee who cannot do their job is a broken product, not a secure one.
  const EMPLOYEE_GRANTED = [
    PERMISSIONS.PRODUCTS_MANAGE,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.ORDERS_MANAGE,
    PERMISSIONS.GENESIS_CHAT,
  ] as const;

  for (const permission of EMPLOYEE_GRANTED) {
    assert(`an employee can ${permission}`, hasPermission("EMPLOYEE", permission));
  }
  // Marking an order fulfilled is deliberately operational, not financial —
  // an employee ships orders without ever seeing what the store earned.
  assert("fulfilment without revenue",
    hasPermission("EMPLOYEE", PERMISSIONS.ORDERS_MANAGE) && !hasPermission("EMPLOYEE", PERMISSIONS.REVENUE_VIEW));
}

// ---------------------------------------------------------------------------
console.log("\n3. The owner holds everything, and the sets do not drift");
{
  const all = Object.values(PERMISSIONS);
  assert("the owner holds every permission", all.every((p) => hasPermission("OWNER", p)), `${all.length} total`);

  // An employee holding everything would mean the two roles had silently
  // collapsed into one.
  const employeeHolds = all.filter((p) => hasPermission("EMPLOYEE", p));
  assert("an employee holds strictly fewer", employeeHolds.length < all.length,
    `${employeeHolds.length} of ${all.length}`);
  check("and exactly the four intended", employeeHolds.sort(), [
    PERMISSIONS.GENESIS_CHAT,
    PERMISSIONS.ORDERS_MANAGE,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.PRODUCTS_MANAGE,
  ].sort());
}

// ---------------------------------------------------------------------------
console.log("\n4. Unknown permissions are never granted");
{
  // hasPermission does an array lookup, so a typo'd or removed permission must
  // read as denied rather than throwing or accidentally matching.
  const madeUp = "store:take_everything" as never;
  assert("an invented permission is denied to an employee", !hasPermission("EMPLOYEE", madeUp));
  assert("and to an owner", !hasPermission("OWNER", madeUp));
  // Every declared permission is a non-empty, namespaced string — a blank one
  // would match nothing and silently deny a real feature forever.
  assert("every permission is namespaced",
    Object.values(PERMISSIONS).every((p) => typeof p === "string" && p.includes(":") && p.length > 3));
  // No duplicates: two names for one permission means changing one leaves the
  // other granting access nobody remembers.
  check("no duplicate permission values",
    new Set(Object.values(PERMISSIONS)).size, Object.values(PERMISSIONS).length);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
