import {
  methodProfile,
  allMethodProfiles,
  zeroCapitalMethods,
  methodsAboveRung,
} from "@/lib/sourcing/methodProfile";
import { currentPolicy, rungPolicy } from "@/lib/sourcing/progressionPolicy";
import { earnedRungs, spendableCents, type CapitalPosture, type ProductEvidence } from "@/lib/sourcing/progression";
import { assessFeasibility, decide, FIRM, type Feasibility } from "@/lib/sourcing/feasibility";
import { materialChange, type ProgressionConditions } from "@/lib/sourcing/graduation";
import { framingFor } from "@/lib/sourcing/framing";
import type { Recommendation } from "@/lib/sourcing/recommend";
import { NO_TERMS, type SupplierTerms } from "@/lib/sourcing/economics";

// The progression model's rules. No database, no network:
//
//   npx tsx scripts/verify-progression.ts
//
// P0.5 units 1, 3, 6 and 7. Everything here is pure, which is the point: the
// judgements that decide whether Genesis tells somebody to spend money should be
// checkable without a database, a server, or a supplier.

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

const POLICY = currentPolicy();

function evidence(over: Partial<ProductEvidence> = {}): ProductEvidence {
  return {
    productId: "p1",
    currency: "USD",
    unitsSold: 0,
    refundedUnits: 0,
    orderCount: 0,
    firstSoldAt: null,
    windowDays: 0,
    unitsPerWeek: 0,
    netRevenueCents: 0,
    netMarginCents: null,
    marginPerUnitCents: null,
    returnRate: 0,
    ...over,
  };
}

const UNSTATED: CapitalPosture = { state: "unstated", currency: "USD", capabilities: [] };
const stated = (cents: number, capabilities: CapitalPosture["capabilities"] = []): CapitalPosture => ({
  state: "stated",
  currency: "USD",
  investableCents: cents,
  statedAt: new Date("2026-08-01"),
  capabilities,
});

const fits = (reasons = ["It matches how you describe your business."]): Recommendation => ({
  verdict: "fits",
  score: 10,
  reasons,
  concerns: [],
  basedOn: ["own_words"],
});

/**
 * Supplier terms for a case that only cares about the two figures.
 *
 * Spreads NO_TERMS so everything else — shipping, lead time, provenance,
 * freshness, per-product capabilities — is explicitly unknown rather than
 * accidentally absent. A test that quietly stopped compiling when those fields
 * arrived would have been a test asserting on a shape nobody uses.
 */
function terms(
  minimumOrderUnits: number | null,
  bulkUnitCostInCents: number | null,
  rest: Partial<SupplierTerms> = {}
): SupplierTerms {
  return { ...NO_TERMS, minimumOrderUnits, bulkUnitCostInCents, ...rest };
}

// ---------------------------------------------------------------------------
console.log("\n1. Every sourcing method declares what it would cost");
{
  for (const profile of allMethodProfiles()) {
    assert(`${profile.kind}: rung is in range`, profile.rung >= 0 && profile.rung <= 3, String(profile.rung));
    assert(`${profile.kind}: capabilities are real`, Array.isArray(profile.requiresCapabilities));
  }

  // THE ZERO-CAPITAL ENTRY, stated as a test rather than a hope. A person with
  // no money must have real methods available, and print-on-demand and dropship
  // are the two that make a business possible with nothing.
  const free = zeroCapitalMethods().map((p) => p.kind).sort();
  assert("print-on-demand costs nothing up front", free.includes("PRINT_ON_DEMAND"), free.join(", "));
  assert("dropshipping costs nothing up front", free.includes("WHOLESALE_DROPSHIP"), free.join(", "));
  for (const profile of zeroCapitalMethods()) {
    check(`${profile.kind}: nothing is lost if it does not sell`, profile.unsoldRisk, "none");
    check(`${profile.kind}: sits at the entry rung`, profile.rung, 0);
  }

  // And the ladder is ordered by commitment, not by preference.
  check("stocked wholesale is a step up", methodProfile("WHOLESALE_STOCKED").rung, 1);
  check("private label is above it", methodProfile("PRIVATE_LABEL").rung, 2);
  check("own production is the top", methodProfile("CONTRACT_MANUFACTURED").rung, 3);
  assert("branded stock is riskier than generic stock",
    methodProfile("PRIVATE_LABEL").unsoldRisk === "branded_stock" &&
      methodProfile("WHOLESALE_STOCKED").unsoldRisk === "held_stock");

  // Only methods that genuinely carry the owner's branding say they do.
  for (const profile of allMethodProfiles()) {
    if (profile.carriesOwnBranding) {
      check(`${profile.kind}: framing agrees it is customisable`, framingFor(profile.kind).customizable, true);
    }
  }

  const above = methodsAboveRung(0).map((p) => p.rung);
  assert("steps up are offered in order", above.every((r, i) => i === 0 || r >= above[i - 1]), above.join(","));
}

// ---------------------------------------------------------------------------
console.log("\n2. Capital has three states and they never collapse");
{
  // Unstated and explicitly-zero behave IDENTICALLY...
  check("unstated can spend nothing", spendableCents(UNSTATED), 0);
  check("an explicit zero can spend nothing", spendableCents(stated(0)), 0);
  // ...and are NOT the same fact. This is the distinction that decides whether
  // J4 asks, and losing it is how a partner starts sounding like a form.
  assert("but they remain distinguishable", UNSTATED.state !== stated(0).state);
  check("a stated amount is spendable", spendableCents(stated(50_000)), 50_000);
}

// ---------------------------------------------------------------------------
console.log("\n3. Policy reads evidence; evidence knows no thresholds");
{
  const rung1 = rungPolicy(POLICY, 1)!;
  const justEnough = evidence({
    unitsSold: rung1.minUnitsSold,
    windowDays: rung1.minWindowDays,
    netMarginCents: 5_000,
    marginPerUnitCents: 250,
    returnRate: 0,
  });
  check("meeting every threshold earns the first rung", earnedRungs(justEnough, POLICY), [1]);

  // Volume without time is a spike, not a pattern — and buying a case on a
  // spike is the mistake this whole model exists to prevent.
  check("volume in too short a window earns nothing",
    earnedRungs({ ...justEnough, windowDays: 3 }, POLICY), []);
  check("time without volume earns nothing",
    earnedRungs({ ...justEnough, unitsSold: 2 }, POLICY), []);
  check("too many returns earns nothing",
    earnedRungs({ ...justEnough, returnRate: 0.5 }, POLICY), []);

  // UNKNOWN MARGIN NEVER SATISFIES A THRESHOLD. A product nobody recorded a cost
  // for cannot be shown to be profitable, and "probably fine" is not a basis for
  // telling somebody to spend money.
  check("unknown margin earns nothing",
    earnedRungs({ ...justEnough, netMarginCents: null }, POLICY), []);
  check("a losing product earns nothing",
    earnedRungs({ ...justEnough, netMarginCents: -100 }, POLICY), []);

  // Rungs are cumulative: no factory without first a case.
  const rung2 = rungPolicy(POLICY, 2)!;
  const strong = evidence({
    unitsSold: rung2.minUnitsSold,
    windowDays: rung2.minWindowDays,
    netMarginCents: 50_000,
    marginPerUnitCents: 300,
  });
  check("strong evidence earns both lower rungs", earnedRungs(strong, POLICY), [1, 2]);

  // TUNING IS A POLICY EDIT AND NOTHING ELSE. The same evidence under a
  // different policy gives a different answer, and the evidence is untouched.
  const strict = { ...POLICY, rungs: POLICY.rungs.map((r) => ({ ...r, minUnitsSold: r.minUnitsSold * 100 })) };
  check("the same evidence under a stricter policy earns nothing", earnedRungs(strong, strict), []);
  check("and the evidence itself is unchanged", strong.unitsSold, rung2.minUnitsSold);
}

// ---------------------------------------------------------------------------
console.log("\n4. Starting with nothing is always possible");
{
  // THE INVARIANT THE WHOLE PRODUCT RESTS ON. An owner who has said nothing
  // about money can still be recommended real products to sell.
  for (const profile of zeroCapitalMethods()) {
    const capable: CapitalPosture = { ...UNSTATED, capabilities: profile.requiresCapabilities };
    check(`${profile.kind} is affordable with no money at all`,
      assessFeasibility({ profile, posture: capable, supplier: terms(null, null), evidence: null, currency: "USD" }).kind,
      "affordable");
  }

  // And notably: it is affordable even though every supplier number is unknown,
  // because at rung 0 there is no number to know.
  check("no supplier minimum is needed to start",
    assessFeasibility({
      profile: methodProfile("WHOLESALE_DROPSHIP"),
      posture: UNSTATED,
      supplier: terms(null, null),
      evidence: null,
      currency: "USD",
    }).kind,
    "affordable");
}

// ---------------------------------------------------------------------------
console.log("\n5. An unknown supplier fact blocks rather than becoming a zero");
{
  const stocked = methodProfile("WHOLESALE_STOCKED");
  const posture = stated(500_00, ["hold_stock"]);

  const noMinimum = assessFeasibility({
    profile: stocked, posture,
    supplier: terms(null, 400),
    evidence: null, currency: "USD",
  });
  check("an unknown minimum cannot be assessed", noMinimum.kind, "cannot_assess");
  assert("and says which fact is missing",
    noMinimum.kind === "cannot_assess" && noMinimum.missing.includes("minimum_order"), JSON.stringify(noMinimum));

  const noPrice = assessFeasibility({
    profile: stocked, posture,
    supplier: terms(100, null),
    evidence: null, currency: "USD",
  });
  check("an unknown bulk price cannot be assessed", noPrice.kind, "cannot_assess");
  // The failure this prevents: an unknown becoming free.
  assert("it never reports as affordable", noPrice.kind !== "affordable");
}

// ---------------------------------------------------------------------------
console.log("\n6. Fits, and cannot be done yet");
{
  const stocked = methodProfile("WHOLESALE_STOCKED");
  const selling = evidence({
    unitsSold: 40, windowDays: 56, unitsPerWeek: 5,
    netRevenueCents: 40 * 1_800, netMarginCents: 40 * 900, marginPerUnitCents: 900,
  });
  const supplier = terms(100, 410);

  const broke = assessFeasibility({
    profile: stocked, posture: { ...UNSTATED, capabilities: ["hold_stock"] },
    supplier, evidence: selling, currency: "USD",
  });
  check("it is not yet", broke.kind, "not_yet");
  if (broke.kind === "not_yet") {
    check("the upfront cost is the real one", broke.upfrontCents, 41_000);
    check("and the whole of it is short", broke.shortfallCents, 41_000);
    // THE DISTINCTION THAT DECIDES WHETHER J4 ASKS.
    check("it knows capital was assumed, not stated", broke.capitalBasis, "assumed_because_unstated");
    assert("payback is computed from real sales", broke.paybackWeeks !== null, String(broke.paybackWeeks));
  }

  const asked = assessFeasibility({
    profile: stocked, posture: stated(30_000, ["hold_stock"]), supplier, evidence: selling, currency: "USD",
  });
  if (asked.kind === "not_yet") {
    check("a stated posture is reported as stated", asked.capitalBasis, "stated");
    check("and only the gap is short", asked.shortfallCents, 11_000);
  }

  const funded = assessFeasibility({
    profile: stocked, posture: stated(50_000, ["hold_stock"]), supplier, evidence: selling, currency: "USD",
  });
  check("with enough money and the capability, it is affordable", funded.kind, "affordable");

  // A capability the owner has not confirmed blocks it even when funded —
  // somewhere to put 100 units is a fact about their life, not their bank.
  const noSpace = assessFeasibility({
    profile: stocked, posture: stated(50_000), supplier, evidence: selling, currency: "USD",
  });
  check("without somewhere to keep it, it is not yet", noSpace.kind, "not_yet");
  assert("naming the capability", noSpace.kind === "not_yet" && noSpace.missingCapabilities.includes("hold_stock"));

  // No margin known means no payback figure. NEVER an estimate.
  const unpriced = assessFeasibility({
    profile: stocked, posture: UNSTATED, supplier,
    evidence: { ...selling, netMarginCents: null, marginPerUnitCents: null },
    currency: "USD",
  });
  assert("an unknown cost yields no payback figure",
    unpriced.kind === "not_yet" && unpriced.paybackWeeks === null, JSON.stringify(unpriced));
}

// ---------------------------------------------------------------------------
console.log("\n7. Fit is decided before feasibility, always");
{
  const affordable: Feasibility = { kind: "affordable", confidence: FIRM };
  const notYet: Feasibility = {
    kind: "not_yet", currency: "USD", upfrontCents: 41_000, shortfallCents: 41_000,
    capitalBasis: "assumed_because_unstated", missingCapabilities: [],
    paybackWeeks: 5, unitsToGo: 60, costBasis: "complete", confidence: FIRM,
  };

  const wrong: Recommendation = {
    verdict: "does_not_fit", score: 0, reasons: [],
    concerns: ["It doesn't fit the brand you've described."], basedOn: ["no_relevance"],
  };
  // AFFORDABLE AND WRONG IS STILL WRONG. Telling an owner they can afford the
  // wrong thing is worse than saying nothing.
  check("a bad fit is not a fit, however affordable", decide(wrong, affordable).kind, "not_a_fit");

  const unknownFit: Recommendation = { verdict: "unknown", score: 0, reasons: [], concerns: [], basedOn: [] };
  check("an unknown business cannot be judged", decide(unknownFit, affordable).kind, "cannot_assess");

  check("a good fit that is affordable is recommended", decide(fits(), affordable).kind, "recommended_now");

  const deferred = decide(fits(), notYet);
  check("a good fit that is unaffordable is not_yet", deferred.kind, "not_yet");
  if (deferred.kind === "not_yet") {
    // SHOWN, not hidden — with why it fits AND what is in the way.
    assert("it keeps the reasons it fits", deferred.reasons.length > 0);
    assert("names what is in the way", deferred.blockers.length > 0, deferred.blockers.join(" | "));
    assert("and carries a real plan", deferred.plan.includes("60") && deferred.plan.includes("5"), deferred.plan);
    assert("phrased as an assumption, since nothing was stated",
      deferred.blockers.some((b) => b.includes("assumption")), deferred.blockers.join(" | "));
    check("the basis survives to the outcome", deferred.capitalBasis, "assumed_because_unstated");
  }

  const stateded = decide(fits(), { ...notYet, capitalBasis: "stated", shortfallCents: 11_000 });
  assert("a stated posture is spoken to differently",
    stateded.kind === "not_yet" && stateded.blockers.some((b) => b.includes("you told me")),
    stateded.kind === "not_yet" ? stateded.blockers.join(" | ") : "");

  // No payback figure means say so, rather than invent a timeline — which is
  // the one number an owner would actually act on.
  const noPlan = decide(fits(), { ...notYet, paybackWeeks: null, unitsToGo: null });
  assert("an unknown payback is admitted",
    noPlan.kind === "not_yet" && noPlan.plan.includes("can't work out"), noPlan.kind === "not_yet" ? noPlan.plan : "");

  const blocked = decide(fits(), { kind: "cannot_assess", missing: ["minimum_order"] });
  check("missing supplier facts are their own outcome", blocked.kind, "cannot_assess");
}

// ---------------------------------------------------------------------------
console.log("\n8. Reconsideration is a material change, never a counter");
{
  const base: ProgressionConditions = {
    capitalState: "unstated", spendableCents: 0, ownerCapabilities: [],
    minimumOrderUnits: 200, bulkUnitCostInCents: 700,
    unitsSold: 40, unitsPerWeek: 5, netMarginCents: 36_000,
    paybackWeeks: 9, sourceAvailable: true, currency: "USD",
    policyVersion: POLICY.version,
  };

  check("nothing changed is not a reason", materialChange(base, { ...base }, POLICY), null);
  // Time is NOT a reason. Re-asking on a timer is how a partner becomes a nag.
  check("more of the same is not a reason",
    materialChange(base, { ...base, unitsSold: 60, unitsPerWeek: 6, paybackWeeks: 9 }, POLICY), null);

  // The changes that genuinely turn no into yes.
  check("the supplier halving its minimum is",
    materialChange(base, { ...base, minimumOrderUnits: 50 }, POLICY), "minimum_order_lowered");
  check("a price drop is",
    materialChange(base, { ...base, bulkUnitCostInCents: 410 }, POLICY), "supplier_price_dropped");
  check("stating capital for the first time is",
    materialChange(base, { ...base, capitalState: "stated", spendableCents: 0 }, POLICY), "capital_first_stated");
  check("gaining a capability is",
    materialChange(base, { ...base, ownerCapabilities: ["hold_stock"] }, POLICY), "capability_gained");
  check("learning the margin is",
    materialChange({ ...base, netMarginCents: null }, base, POLICY), "margin_became_known");

  // DEMAND EXPRESSED AS PAYBACK, not as units. "Sold 50% more" is a fact about
  // a number; "pays for itself in four weeks instead of nine" is a fact about
  // the decision they declined.
  check("payback improving by a week is",
    materialChange(base, { ...base, paybackWeeks: 8 }, POLICY), "demand_grew");
  check("payback barely moving is not",
    materialChange(base, { ...base, paybackWeeks: 9 }, POLICY), null);
  check("payback getting worse is not",
    materialChange(base, { ...base, paybackWeeks: 12 }, POLICY), null);

  check("a policy change is", materialChange(base, { ...base, policyVersion: "9999" }, POLICY), "policy_changed");

  // And an unknown becoming known counts as much as an improvement, because the
  // unknown is what blocked it.
  check("a minimum becoming known is",
    materialChange({ ...base, minimumOrderUnits: null }, base, POLICY), "minimum_order_lowered");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
