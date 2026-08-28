import {
  chooseCreationSupplier,
  isCreationSupplier,
  CREATION_SUPPLIER_ORDER,
  type SupplierCandidate,
} from "@/lib/creation/supplierChoice";

// WHICH SUPPLIER A DESIGN GOES THROUGH, AND HOW THAT IS DECIDED:
//
//   npx tsx scripts/verify-creation-supplier.ts
//
// ============ WHAT THIS IS FOR (2026-08-28) =============================
//
// Sean: "keep the architecture clean and reusable for additional suppliers."
//
// lib/creation/provider.ts used to carry a comment saying "one provider today,
// and not hard-coded" directly above a query for `provider: "PRINTFUL"`. Only
// the first half was true, and a comment is exactly the wrong place to keep a
// guarantee — it cannot fail.
//
// ============ WHY THIS SUITE IS PURE ===================================
//
// The obvious place to test this was creationAccessFor(), and it cannot be
// imported: provider.ts is `server-only`, which resolves through Next's bundler
// and throws under plain Node. Dropping that marker to make the code reachable
// would trade a real protection — credentials cannot be imported into a client
// bundle — for a test, which is the wrong way round.
//
// So the decision moved to a pure module and the credentials stayed behind it.
// What is left in provider.ts is one query and a call to the function tested
// here.
//
// The control that matters is section 4: a store with a healthy, fully
// credentialled integration for a provider that does not MAKE anything must
// not be able to design. That is what fails if the resolution ever goes back to
// taking whatever integration it finds first.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const row = (over: Partial<SupplierCandidate> = {}): SupplierCandidate => ({
  provider: "PRINTFUL",
  status: "CONNECTED",
  hasCredentials: true,
  ...over,
});

function main(): void {
  // ======================================================================
  console.log("\n=== 1. The list is data, and membership is read from it ===\n");
  // ======================================================================

  assert("at least one supplier can host a design", CREATION_SUPPLIER_ORDER.length >= 1);
  eq("Printful is the one built today", CREATION_SUPPLIER_ORDER, ["PRINTFUL"]);

  assert("a registered provider makes things", isCreationSupplier("PRINTFUL"));
  assert("CONTROL: a payment processor does not", !isCreationSupplier("STRIPE"));
  assert("CONTROL: nor does a shop that sells them", !isCreationSupplier("SQUARE"));
  assert("CONTROL: and neither does nothing at all", !isCreationSupplier(null));

  // ======================================================================
  console.log("\n=== 2. Nothing connected is a real answer, not a failure ===\n");
  // ======================================================================

  eq("no integrations at all means no supplier",
    chooseCreationSupplier([]), { supplier: null, status: null });

  // ======================================================================
  console.log("\n=== 3. Credentials decide; the status travels beside ===\n");
  // ======================================================================

  eq("credentials choose the supplier",
    chooseCreationSupplier([row()]), { supplier: "PRINTFUL", status: "CONNECTED" });

  // THE CONNECTED-BUT-TOLD-TO-CONNECT RULE, from 2026-08-27. A stale status is
  // a fact about the last verification, not about whether the next call works.
  eq("a supplier NEEDING ATTENTION still hosts designs",
    chooseCreationSupplier([row({ status: "NEEDS_ATTENTION" })]),
    { supplier: "PRINTFUL", status: "NEEDS_ATTENTION" });
  eq("so does one whose last check FAILED",
    chooseCreationSupplier([row({ status: "FAILED" })]),
    { supplier: "PRINTFUL", status: "FAILED" });

  // DISCONNECTED needs no special case — disconnecting clears the credentials.
  eq("cleared credentials host nothing, and the row still explains itself",
    chooseCreationSupplier([row({ status: "DISCONNECTED", hasCredentials: false })]),
    { supplier: null, status: "DISCONNECTED" });
  assert("CONTROL: which is distinguishable from never having connected",
    chooseCreationSupplier([row({ status: "DISCONNECTED", hasCredentials: false })]).status !==
      chooseCreationSupplier([]).status,
    "'you disconnected this' and 'you have no supplier' must not read the same");

  // ======================================================================
  console.log("\n=== 4. CONTROL: only a supplier that MAKES things is chosen ===\n");
  // ======================================================================

  const shopAndBank: SupplierCandidate[] = [
    { provider: "SQUARE", status: "CONNECTED", hasCredentials: true },
    { provider: "STRIPE", status: "CONNECTED", hasCredentials: true },
  ];
  eq("healthy integrations that make nothing host nothing",
    chooseCreationSupplier(shopAndBank), { supplier: null, status: null });
  assert("CONTROL: and their status is not reported as a print supplier's",
    chooseCreationSupplier(shopAndBank).status === null,
    "a payment processor's health shown as the reason a hoodie cannot be designed");

  eq("a real supplier is still found alongside them",
    chooseCreationSupplier([...shopAndBank, row()]),
    { supplier: "PRINTFUL", status: "CONNECTED" });

  // ======================================================================
  console.log("\n=== 5. Order is a tie-break, and it is followed ===\n");
  // ======================================================================
  //
  // With one supplier registered this cannot be exercised against a second real
  // one, so it is asserted as the property it is: the chosen supplier is always
  // the earliest entry in CREATION_SUPPLIER_ORDER that has credentials. The day
  // a second is added, this is already here.

  const first = CREATION_SUPPLIER_ORDER[0];
  const candidates = CREATION_SUPPLIER_ORDER.map((provider) => row({ provider }));
  eq("every registered supplier connected picks the first in order",
    chooseCreationSupplier(candidates).supplier, first);

  const allButFirst = candidates.filter((c) => c.provider !== first);
  eq("and skipping the first falls through to the next that has credentials",
    chooseCreationSupplier(allButFirst).supplier,
    allButFirst[0]?.provider ?? null);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
