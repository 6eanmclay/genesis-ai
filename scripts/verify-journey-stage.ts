import { deriveJourneyStage, type JourneyStageInput, type JourneyStage } from "@/lib/dashboard/journeyStage";
import { isPaymentConnected } from "@/lib/dashboard/needsAttention";

// WHERE GENESIS THINKS THIS BUSINESS HAS GOT TO:
//
//   npx tsx scripts/verify-journey-stage.ts
//
// deriveJourneyStage is the single definition of "what stage is this business
// at", and it was written to BE single: extracted out of BusinessJourney.tsx
// specifically so the instrumentation could detect a real transition "using the
// exact same logic the component renders from — never a second, competing
// definition." Both the owner-facing journey and the durable
// journey.stage_reached event resolve through this one function, and nothing
// covered it.
//
// WHY THE ORDERING IS THE WHOLE THING. The function is a cascade, and every
// early return is a claim about a real business:
//
//   * An order outranks setup. A business that has sold something is past
//     "getting ready" whether or not its checklist is complete — telling an
//     owner with a sale in hand that they are still getting ready would be
//     Genesis contradicting something they watched happen.
//   * ready-for-first-sale requires ALL THREE of published, a live product and
//     a payment rail. Two of three is still getting-ready, because a storefront
//     that cannot take money is not ready for a sale no matter how finished it
//     looks.
//   * first-sale is exactly one order, and it is a moment rather than a range.
//
// It is also deliberately state-based rather than order-count-tiered above
// one — see BusinessJourney.tsx's own comment. Two orders is
// "up-and-running", and so is two hundred; Genesis does not grade a business
// by volume.

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

const CONNECTED = { status: "CONNECTED" };

/** A business with nothing done yet. */
const nothing: JourneyStageInput = {
  published: false,
  hasActiveProducts: false,
  stripeIntegration: null,
  paypalIntegration: null,
  allTimeOrderCount: 0,
};

/** Everything set up, nothing sold. */
const readyToSell: JourneyStageInput = {
  published: true,
  hasActiveProducts: true,
  stripeIntegration: CONNECTED,
  paypalIntegration: null,
  allTimeOrderCount: 0,
};

const at = (over: Partial<JourneyStageInput>): JourneyStage =>
  deriveJourneyStage({ ...nothing, ...over });

// ============================================================================
console.log("\n=== 1. A real sale outranks a checklist ===\n");
// ============================================================================
// The most important ordering in the function. An owner who has sold something
// must never be told they are still getting ready.
check("one order is the first sale, however unfinished the setup",
  at({ allTimeOrderCount: 1 }), "first-sale");
check("two orders is up and running", at({ allTimeOrderCount: 2 }), "up-and-running");
assert(
  "even with nothing published, no product and no payment rail",
  at({ allTimeOrderCount: 2, published: false, hasActiveProducts: false }) === "up-and-running",
  "Genesis must not contradict something the owner watched happen"
);

// Volume is not a grade. Two orders and two hundred are the same stage.
check("two hundred orders is still up and running",
  at({ allTimeOrderCount: 200 }), "up-and-running");
assert("so the journey never becomes a scoreboard",
  at({ allTimeOrderCount: 2 }) === at({ allTimeOrderCount: 200 }),
  "state-based, deliberately, not order-count-tiered");

// ============================================================================
console.log("\n=== 2. Ready means all three, not two ===\n");
// ============================================================================
check("published, selling something, and able to take money", deriveJourneyStage(readyToSell), "ready-for-first-sale");

check("no payment rail is not ready",
  at({ published: true, hasActiveProducts: true }), "getting-ready");
check("nothing to sell is not ready",
  at({ published: true, stripeIntegration: CONNECTED }), "getting-ready");
check("unpublished is not ready",
  at({ hasActiveProducts: true, stripeIntegration: CONNECTED }), "getting-ready");
assert(
  "so a storefront that cannot take money is never called ready",
  at({ published: true, hasActiveProducts: true }) === "getting-ready",
  "however finished it looks"
);

check("and nothing done at all is getting ready", deriveJourneyStage(nothing), "getting-ready");

// ============================================================================
console.log("\n=== 3. Either rail counts, and only a connected one ===\n");
// ============================================================================
check("PayPal alone is a payment rail",
  at({ published: true, hasActiveProducts: true, paypalIntegration: CONNECTED }),
  "ready-for-first-sale");
check("Stripe alone is too",
  at({ published: true, hasActiveProducts: true, stripeIntegration: CONNECTED }),
  "ready-for-first-sale");
check("both is still just ready",
  at({ published: true, hasActiveProducts: true, stripeIntegration: CONNECTED, paypalIntegration: CONNECTED }),
  "ready-for-first-sale");

// A row that exists is not a rail that works. An integration part-way through
// OAuth has a row and cannot take a payment.
for (const status of ["PENDING", "DISCONNECTED", "ERROR", "REVOKED", "connected"]) {
  check(`a "${status}" integration cannot take money`,
    at({ published: true, hasActiveProducts: true, stripeIntegration: { status } }),
    "getting-ready");
}
assert("including a lowercase near-miss",
  !isPaymentConnected({ stripeIntegration: { status: "connected" }, paypalIntegration: null }),
  "the status vocabulary is uppercase; a case-insensitive match would accept a value nothing writes");

// ============================================================================
console.log("\n=== 4. The stage is a total function ===\n");
// ============================================================================
// Every combination resolves to one of the four stages. A business can never
// fall between them, because the owner is always somewhere.
const STAGES: JourneyStage[] = ["getting-ready", "ready-for-first-sale", "first-sale", "up-and-running"];
const seen = new Set<JourneyStage>();
let total = 0;
for (const published of [true, false]) {
  for (const hasActiveProducts of [true, false]) {
    for (const stripe of [CONNECTED, { status: "PENDING" }, null]) {
      for (const paypal of [CONNECTED, null]) {
        for (const orders of [0, 1, 2, 50]) {
          const stage = deriveJourneyStage({
            published,
            hasActiveProducts,
            stripeIntegration: stripe,
            paypalIntegration: paypal,
            allTimeOrderCount: orders,
          });
          total++;
          if (!STAGES.includes(stage)) failures++;
          seen.add(stage);
        }
      }
    }
  }
}
assert(`every one of ${total} combinations resolves to a real stage`, true);
check("and all four stages are genuinely reachable", [...seen].sort(), [...STAGES].sort());

// A negative order count is not a real input, but it must not silently become
// "first sale" — the comparison is `=== 1`, and this pins that it stays exact.
check("a negative order count is not a first sale",
  at({ allTimeOrderCount: -1, published: true, hasActiveProducts: true, stripeIntegration: CONNECTED }),
  "ready-for-first-sale");

// ============================================================================
console.log("\n=== 5. The same input always gives the same stage ===\n");
// ============================================================================
// Both the rendered journey and the durable journey.stage_reached event call
// this, and the event exists to record a REAL transition. A function that
// disagreed with itself would log a stage change nobody made.
const twice = [deriveJourneyStage(readyToSell), deriveJourneyStage(readyToSell)];
check("derivation is stable", twice[0], twice[1]);
assert("so a stage event is only ever written for a change that happened",
  twice[0] === twice[1],
  "logJourneyStageIfChanged compares against the last logged stage and returns early when equal");

console.log(`\n${failures === 0 ? "All journey-stage assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
