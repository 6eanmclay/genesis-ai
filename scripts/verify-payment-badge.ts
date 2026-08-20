import { paymentBadgeFor, isBrokenConnection } from "@/lib/integrations/paymentBadge";

// The one question a payments badge answers: can this store take money?
// No database, no network:
//
//   npx tsx scripts/verify-payment-badge.ts
//
// Both cards used to answer it with "is the row not DISCONNECTED?", which said
// Connected for accounts that could not take a cent. Section 1 is that bug.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

// ---------------------------------------------------------------------------
console.log("\n1. The bug: only a verified connection may say Connected");
{
  // The old rule was `status !== "DISCONNECTED"`, which caught all three of
  // these. Each one is a store being told it can take money when it cannot.
  for (const broken of ["FAILED", "NEEDS_ATTENTION"] as const) {
    assert(`${broken} does NOT say Connected`, paymentBadgeFor(broken).kind !== "connected");
  }
  check("only CONNECTED does", paymentBadgeFor("CONNECTED"), { kind: "connected" });
}

// ---------------------------------------------------------------------------
console.log("\n2. A broken connection says so, in the owner's words");
{
  check("FAILED is blunt, because the situation is", paymentBadgeFor("FAILED"), {
    kind: "attention",
    label: "Not working",
  });
  check("NEEDS_ATTENTION keeps the provider's softer wording", paymentBadgeFor("NEEDS_ATTENTION"), {
    kind: "attention",
    label: "Needs attention",
  });
  // The specific contradiction PayPal used to render: a green Connected badge
  // AND a "Needs attention" chip, side by side, at the same time.
  const badge = paymentBadgeFor("NEEDS_ATTENTION");
  assert("and never both at once", badge.kind === "attention");
}

// ---------------------------------------------------------------------------
console.log("\n3. No connection is not the same as a broken one");
{
  check("DISCONNECTED", paymentBadgeFor("DISCONNECTED"), { kind: "none" });
  check("never connected at all", paymentBadgeFor(null), { kind: "none" });
  check("and an absent row", paymentBadgeFor(undefined), { kind: "none" });
  // An owner who never connected PayPal must not be told PayPal is broken.
  assert("a store that never connected is not 'broken'", !isBrokenConnection(null));
  assert("nor is a deliberately disconnected one", !isBrokenConnection("DISCONNECTED"));
  assert("but a failed one is", isBrokenConnection("FAILED"));
}

// ---------------------------------------------------------------------------
console.log("\n4. Every status has an answer");
{
  // A status with no case would fall through to whatever the JSX did last,
  // which is how the original dishonesty survived review.
  const all = ["CONNECTED", "NEEDS_ATTENTION", "FAILED", "DISCONNECTED"] as const;
  for (const status of all) {
    const badge = paymentBadgeFor(status);
    assert(`${status} maps to a real badge`, ["connected", "attention", "none"].includes(badge.kind));
  }
  check("exactly one status may claim Connected", all.filter((s) => paymentBadgeFor(s).kind === "connected"), [
    "CONNECTED",
  ]);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
