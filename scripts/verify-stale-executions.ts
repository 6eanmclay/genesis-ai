import { isAwaitingHumanDecision } from "@/lib/dashboard/needsAttention";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// The PENDING/stale collision fix (2026-08-19). No database, no environment:
//
//   npx tsx scripts/verify-stale-executions.ts
//
// The distinction this defends, in Sean's words: an execution legitimately
// waiting for owner approval is not an execution that started and never
// completed. Before the fix, Cubit & Coil carried 47 urgent badges quoting J4's
// own chat replies back at the owner, while a customer waiting 31 days for a
// package had no signal at all.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
console.log("\n1. Waiting on a human is not a failure");
{
  check(
    "a chat turn that produced a proposal is awaiting the owner",
    isAwaitingHumanDecision(EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE),
    true
  );
  check(
    "the review's own concurrency claim is not an owner-facing failure",
    isAwaitingHumanDecision(EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE),
    true
  );
}

// ---------------------------------------------------------------------------
console.log("\n2. Real abandoned work is still surfaced");
{
  // The original intent of this reader, preserved verbatim: an OAuth handoff
  // nobody finished is a real, actionable stale execution.
  for (const action of [
    EXECUTION_ACTIONS.INTEGRATION_STRIPE_CONNECT,
    EXECUTION_ACTIONS.INTEGRATION_PAYPAL_CONNECT,
    EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_CONNECT,
    EXECUTION_ACTIONS.INTEGRATION_GOOGLE_CALENDAR_CONNECT,
  ]) {
    check(`${action} still counts as stale when abandoned`, isAwaitingHumanDecision(action), false);
  }
}

// ---------------------------------------------------------------------------
console.log("\n3. Ordinary business actions are unaffected");
{
  for (const action of [
    EXECUTION_ACTIONS.PRODUCT_CREATE,
    EXECUTION_ACTIONS.PRODUCT_EDIT,
    EXECUTION_ACTIONS.ORDER_TOGGLE_FULFILLED,
    EXECUTION_ACTIONS.ORDER_PURCHASE_SHIPPING_LABEL,
    EXECUTION_ACTIONS.STORE_UPDATE_HERO,
    EXECUTION_ACTIONS.STORE_PUBLISH,
  ]) {
    check(`${action} is not exempted`, isAwaitingHumanDecision(action), false);
  }
}

// ---------------------------------------------------------------------------
console.log("\n4. The exemption is narrow");
{
  const exempt = Object.values(EXECUTION_ACTIONS).filter((a) => isAwaitingHumanDecision(a));
  check("exactly two actions are exempt", exempt.length, 2);
  check(
    "and they are the two identified in production",
    exempt.sort(),
    ["genesis.recommendations.generate", "genesis.store.message"]
  );
  // An unknown/future action defaults to being treated as a real failure —
  // never silently exempted.
  check("an unrecognised action is never exempt by default", isAwaitingHumanDecision("some.future.action"), false);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
