import { checkoutProblemNotice, parseCheckoutProblem } from "@/lib/orders/checkoutOutcome";

// What a buyer is told when checkout does not finish. No database, no network:
//
//   npx tsx scripts/verify-checkout-outcome.ts
//
// The PayPal return route had four exits that redirected to the shop's front
// page with no message at all. Two of them happen AFTER PayPal has taken the
// money. Silence there is the worst kind of false state: not a wrong claim, but
// no claim, leaving a buyer to assume whichever answer is more comfortable.
//
// The single most important assertion in this file is that someone who has
// already paid is never invited to pay again.

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
console.log("\n1. Someone who has already paid is never told to try again");
{
  const paid = checkoutProblemNotice("payment_taken_unconfirmed");
  // If this ever flips, a buyer pays twice for one order.
  check("retrying is not safe", paid.safeToRetry, false);
  assert("and they are told so in words, not just by a missing button",
    paid.detail.toLowerCase().includes("don't pay again"), paid.detail);
  assert("the message says the payment DID go through",
    paid.headline.toLowerCase().includes("went through"), paid.headline);
  assert("and never says they were not charged",
    !paid.detail.toLowerCase().includes("haven't been charged"));
  assert("it points them at the store, since only a human can fix this",
    paid.detail.toLowerCase().includes("contact the store"));
}

// ---------------------------------------------------------------------------
console.log("\n2. Someone who was NOT charged is told that plainly");
{
  const notPaid = checkoutProblemNotice("payment_not_completed");
  check("retrying is safe", notPaid.safeToRetry, true);
  assert("they are told they weren't charged",
    notPaid.detail.toLowerCase().includes("haven't been charged"), notPaid.detail);
  assert("and that trying again is fine", notPaid.detail.toLowerCase().includes("try again"));
  // A buyer who was not charged must not be frightened into thinking they were.
  assert("it never claims a payment went through",
    !notPaid.headline.toLowerCase().includes("went through"));
}

// ---------------------------------------------------------------------------
console.log("\n3. The two cases are never confusable");
{
  const paid = checkoutProblemNotice("payment_taken_unconfirmed");
  const notPaid = checkoutProblemNotice("payment_not_completed");
  assert("different headlines", paid.headline !== notPaid.headline);
  assert("different guidance", paid.detail !== notPaid.detail);
  assert("opposite retry advice", paid.safeToRetry !== notPaid.safeToRetry);
  // Both must actually say something. An empty string renders as silence,
  // which is the bug this whole file exists to prevent.
  for (const notice of [paid, notPaid]) {
    assert("the headline is non-empty", notice.headline.trim().length > 0);
    assert("the detail is non-empty", notice.detail.trim().length > 0);
  }
}

// ---------------------------------------------------------------------------
console.log("\n4. Only the two known problems are recognised");
{
  check("a taken-unconfirmed payment", parseCheckoutProblem("payment_taken_unconfirmed"), "payment_taken_unconfirmed");
  check("an incomplete payment", parseCheckoutProblem("payment_not_completed"), "payment_not_completed");
  // The value arrives in a URL anyone can edit. Anything unrecognised renders
  // no banner at all rather than a broken or attacker-chosen one.
  check("an unknown value", parseCheckoutProblem("please_send_money_here"), null);
  check("an empty value", parseCheckoutProblem(""), null);
  check("a missing value", parseCheckoutProblem(null), null);
  check("an undefined value", parseCheckoutProblem(undefined), null);
  check("and a near-miss", parseCheckoutProblem("payment_taken"), null);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
