import { readFileSync } from "node:fs";
import { billingReturnNotice } from "@/lib/billing/returnNotice";

// WHAT AN OWNER IS TOLD WHEN STRIPE SENDS THEM BACK:
//
//   part of the code-only sweep — npx tsx scripts/run-code-suites.ts billing-return-notice
//
// ============ THE ONE RULE THIS EXISTS TO ENFORCE (2026-09-13) =========
//
// Sean: "success must never be rendered as 'subscription active', 'Pro
// activated', or any equivalent claim unless the actual persisted billing
// state confirms it. The webhook remains the authority."
//
// A success redirect means the browser came back from a completed Checkout
// Session. It does not mean the subscription is live — the webhook writes
// that, asynchronously, and can land after the owner returns. So the whole
// suite turns on one comparison: the SAME success parameter, once with the
// persisted state confirming and once without, must produce two different
// messages, and only one of them may say they are subscribed.
//
// AND A URL MUST NOT BE ABLE TO PUT WORDS ON THE PAGE. Anything that is not
// one of the four real values renders nothing at all, so a typed or forged
// query string cannot manufacture a confirmation.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Every word this project would consider a claim that the plan is live. */
const ACTIVE_CLAIM = /\bactive\b|\bactivated\b|\bsubscribed\b|\bpro\b|\bupgraded\b|\bconfirmed\b/i;

function main(): void {
  // ====================================================================
  console.log("\n1. each of the four states is represented\n");
  // ====================================================================
  {
    const subSuccess = billingReturnNotice({ subscribe: "success", subscriptionConfirmed: false });
    eq("subscribe=success is a pending return, not an outcome", subSuccess?.tone, "pending");
    eq("  and says the checkout completed", subSuccess?.title, "Checkout completed");

    const subCancelled = billingReturnNotice({ subscribe: "cancelled", subscriptionConfirmed: false });
    eq("subscribe=cancelled is neutral", subCancelled?.tone, "neutral");
    eq("  and says no subscription was started", subCancelled?.detail, "No subscription was started.");

    const buySuccess = billingReturnNotice({ purchase: "success", subscriptionConfirmed: false });
    eq("purchase=success is a pending return too", buySuccess?.tone, "pending");
    assert("  and never claims the points arrived",
      /will appear once/.test(buySuccess?.detail ?? ""), buySuccess?.detail ?? "");

    const buyCancelled = billingReturnNotice({ purchase: "cancelled", subscriptionConfirmed: false });
    eq("purchase=cancelled is neutral", buyCancelled?.tone, "neutral");
    eq("  and says nothing was bought", buyCancelled?.detail, "No Growth Points were bought.");
  }

  // ====================================================================
  console.log("\n2. success cannot claim an active subscription\n");
  // ====================================================================
  {
    const unconfirmed = billingReturnNotice({ subscribe: "success", subscriptionConfirmed: false });
    // THE ASSERTION THE WHOLE SLICE EXISTS FOR. The redirect is identical to
    // the confirmed case below; only the persisted state differs.
    assert("an unconfirmed success says nothing that reads as subscribed",
      !ACTIVE_CLAIM.test(`${unconfirmed?.title} ${unconfirmed?.detail}`),
      `${unconfirmed?.title} — ${unconfirmed?.detail}`);
    assert("  and names the webhook's confirmation as still outstanding",
      /still confirming/.test(unconfirmed?.detail ?? ""), unconfirmed?.detail ?? "");

    // A purchase has no persisted fact that could confirm it, so the flag must
    // not be able to promote it either.
    const buyWithFlag = billingReturnNotice({ purchase: "success", subscriptionConfirmed: true });
    eq("a purchase stays pending even when a subscription is confirmed", buyWithFlag?.tone, "pending");
  }

  // ====================================================================
  console.log("\n3. no parameter is the normal Billing experience\n");
  // ====================================================================
  {
    eq("no parameters at all render no notice",
      billingReturnNotice({ subscriptionConfirmed: false }), null);
    eq("  and still none when a subscription IS confirmed",
      billingReturnNotice({ subscriptionConfirmed: true }), null);
    // A FORGED OR MISTYPED URL MUST SAY NOTHING. Anything that is not one of
    // the four real values is not a return from Stripe.
    for (const value of ["", "yes", "Success", "true", "1", "succeeded"]) {
      eq(`  subscribe=${JSON.stringify(value)} renders nothing`,
        billingReturnNotice({ subscribe: value, subscriptionConfirmed: true }), null);
    }
    eq("  purchase=\"paid\" renders nothing",
      billingReturnNotice({ purchase: "paid", subscriptionConfirmed: false }), null);
  }

  // ====================================================================
  console.log("\n4. the persisted state wins over the redirect\n");
  // ====================================================================
  {
    const confirmed = billingReturnNotice({ subscribe: "success", subscriptionConfirmed: true });
    const pending = billingReturnNotice({ subscribe: "success", subscriptionConfirmed: false });

    eq("the same redirect confirms only when the row does", confirmed?.tone, "confirmed");
    eq("  and stays pending when it does not", pending?.tone, "pending");
    assert("  so the two are genuinely different messages",
      confirmed?.title !== pending?.title && confirmed?.detail !== pending?.detail,
      "one parameter producing one message would make the flag decorative");
    assert("the confirmed one defers to the plan block rather than restating it",
      /shown above/.test(confirmed?.detail ?? ""), confirmed?.detail ?? "");

    // AND CANCELLED IGNORES THE ROW ENTIRELY. A store that is already on a
    // plan and cancels a second checkout must not be told anything about the
    // plan it already has.
    const cancelledWhileSubscribed = billingReturnNotice({
      subscribe: "cancelled", subscriptionConfirmed: true,
    });
    eq("a cancellation is neutral even for a subscribed store",
      cancelledWhileSubscribed?.tone, "neutral");
  }

  // ====================================================================
  console.log("\n5. the pages read the parameters they are actually sent\n");
  // ====================================================================
  {
    // THE HELPER BEING CORRECT IS HALF OF IT. The four states were written and
    // consumed nowhere for weeks precisely because nothing read them, so the
    // screens are checked for actually taking searchParams and calling this.
    const billing = readFileSync("app/dashboard/billing/page.tsx", "utf8");
    const growth = readFileSync("app/dashboard/growth-points/page.tsx", "utf8");

    assert("Billing reads its return parameter", /await searchParams/.test(billing), "");
    assert("  and asks this helper about it", /billingReturnNotice\(/.test(billing), "");
    assert("  and computes confirmation from the persisted row, not the URL",
      /subscriptionStatus === "active"/.test(billing),
      "the only honest source of a confirmation");
    assert("Growth Points reads its return parameter", /await searchParams/.test(growth), "");
    assert("  and asks the same helper", /billingReturnNotice\(/.test(growth), "");
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main();
