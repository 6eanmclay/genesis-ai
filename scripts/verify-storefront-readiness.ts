import {
  planStorefrontReadinessInsight,
  governanceFor,
  STOREFRONT_READINESS_INSIGHT_TYPE,
  STOREFRONT_READINESS_DEDUPE_KEY,
} from "@/lib/intelligence/storefrontReadiness";
import type { StorefrontEvaluation, StorefrontFinding } from "@/lib/storefront/evaluate";
import type { StorefrontSuggestionDecision } from "@/lib/dashboard/storefrontSuggestionGate";

// Business Intelligence Engine M4 — the acceptance suite.
//
//   npx tsx scripts/verify-storefront-readiness.ts
//
// Runs with no database and no environment, against the real planner the
// detector calls.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const ALLOWED: StorefrontSuggestionDecision = { allowed: true };

function finding(key: string, observed: string): StorefrontFinding {
  return { key, observed, wouldDo: "…" };
}

function evaluation(findings: StorefrontFinding[], over: Partial<StorefrontEvaluation> = {}): StorefrontEvaluation {
  return {
    productCount: 5,
    productsWithImages: 2,
    editorialImageCount: 0,
    hasLogo: false,
    hasHeroGraphic: false,
    hasFeatureGraphic: false,
    categories: [],
    findings,
    ...over,
  };
}

const MISSING_PHOTOS = finding(
  "products_missing_photos",
  "3 of your 5 products have no photo, so they render as blank cards next to the ones that do."
);
const NO_HERO = finding("no_hero_composition", "You have 4 products with real photography and nothing composed at the top of the store.");

// ---------------------------------------------------------------------------
console.log("\nT1. A storefront with real gaps produces exactly one insight");
{
  const plan = planStorefrontReadinessInsight({
    evaluation: evaluation([MISSING_PHOTOS]),
    gate: ALLOWED,
    observationIsActive: false,
  });
  assert("an insight is planned", plan !== null);
  check("of the one canonical type", plan?.insight.type, STOREFRONT_READINESS_INSIGHT_TYPE);
  check("as an opportunity, never urgent", plan?.insight.severity, "opportunity");
  check("quoting J4's own reading verbatim", plan?.insight.summary, MISSING_PHOTOS.observed);
  check("and it is a first raise", plan?.stampCooldown, true);
}

// ---------------------------------------------------------------------------
console.log("\nT2. A healthy storefront produces none");
{
  check(
    "no findings, no insight",
    planStorefrontReadinessInsight({ evaluation: evaluation([]), gate: ALLOWED, observationIsActive: false }),
    null
  );
  check(
    "and silence holds even with an observation standing",
    planStorefrontReadinessInsight({ evaluation: evaluation([]), gate: ALLOWED, observationIsActive: true }),
    null
  );
}

// ---------------------------------------------------------------------------
console.log("\nT3. The existing gate governs it");
for (const reason of ["cooldown", "previously_rejected", "owner_preference"] as const) {
  check(
    `${reason} suppresses a new raise`,
    planStorefrontReadinessInsight({
      evaluation: evaluation([MISSING_PHOTOS]),
      gate: { allowed: false, reason, detail: "…" },
      observationIsActive: false,
    }),
    null
  );
}
assert(
  "and the gate is consulted with a real action type and canonical topic key",
  JSON.stringify(governanceFor("no_hero_composition")) === JSON.stringify({ actionType: "update_hero", topicKey: "storefront_hero" })
);
assert(
  "product-level findings are not forced under a redesign cooldown",
  governanceFor("products_missing_photos")?.actionType === "update_product_image",
  "the gate deliberately excludes this action type from governing"
);

// ---------------------------------------------------------------------------
console.log("\nT4. A finding the owner already rejected never returns");
{
  check(
    "previously_rejected keeps it unsaid",
    planStorefrontReadinessInsight({
      evaluation: evaluation([NO_HERO]),
      gate: { allowed: false, reason: "previously_rejected", detail: "Owner rejected this same topicKey on 2026-07-02." },
      observationIsActive: false,
    }),
    null
  );
  // The learned-preference path is the durable version of the same memory,
  // surviving after the individual ApprovalRequest rows are gone.
  check(
    "and a learned preference keeps it unsaid too",
    planStorefrontReadinessInsight({
      evaluation: evaluation([NO_HERO]),
      gate: { allowed: false, reason: "owner_preference", detail: "Learned preference (confidence 0.60)…" },
      observationIsActive: false,
    }),
    null
  );
}

// ---------------------------------------------------------------------------
console.log("\nT5. An already-active observation keeps a true thing said");
{
  // The failure this prevents: the cooldown starts the moment J4 raises the
  // insight, so on the very next cycle the gate says no. If that silenced the
  // insight, notifyFromInsights' resolve sweep would mark the observation
  // RESOLVED — retracting something still true, seven days before J4 is
  // allowed to say it again.
  const plan = planStorefrontReadinessInsight({
    evaluation: evaluation([MISSING_PHOTOS]),
    gate: { allowed: false, reason: "cooldown", detail: "6d of cooldown remain." },
    observationIsActive: true,
  });
  assert("the insight survives its own cooldown while standing", plan !== null);
  check("without stamping the cooldown again", plan?.stampCooldown, false);
  check("still saying the same true thing", plan?.insight.summary, MISSING_PHOTOS.observed);
}

// ---------------------------------------------------------------------------
console.log("\nT6. Nothing is claimed about sales");
{
  const plan = planStorefrontReadinessInsight({
    // A pre-revenue store: real products, no orders anywhere in the inputs.
    evaluation: evaluation([MISSING_PHOTOS, NO_HERO]),
    gate: ALLOWED,
    observationIsActive: false,
  });
  const text = `${plan?.insight.summary} ${JSON.stringify(plan?.insight.metrics)}`.toLowerCase();
  const forbidden = ["revenue", "sales", "sold", "orders", "conversion", "customers", "buyers", "traffic"];
  const found = forbidden.filter((word) => text.includes(word));
  check("no sales language anywhere in the insight", found, []);
  check(
    "metrics are counted facts only",
    Object.keys(plan?.insight.metrics ?? {}).sort(),
    ["editorialImageCount", "findingCount", "findingKeys", "hasLogo", "leadingFinding", "productCount", "productsWithImages"]
  );
  assert("and it works with no sales data at all", plan !== null);
}

// ---------------------------------------------------------------------------
console.log("\nT7. Priority is deterministic when several findings are true");
{
  const all = [
    finding("products_could_be_grouped", "grouping"),
    finding("no_hero_composition", "hero"),
    finding("no_logo", "logo"),
    MISSING_PHOTOS,
    finding("editorial_imagery_unused", "editorial"),
  ];
  check(
    "a blank product card outranks an uncomposed hero",
    planStorefrontReadinessInsight({ evaluation: evaluation(all), gate: ALLOWED, observationIsActive: false })?.insight
      .metrics.leadingFinding,
    "products_missing_photos"
  );
  check(
    "shuffling the input does not change the answer",
    planStorefrontReadinessInsight({ evaluation: evaluation([...all].reverse()), gate: ALLOWED, observationIsActive: false })
      ?.insight.metrics.leadingFinding,
    "products_missing_photos"
  );
  check(
    "identity outranks enhancement",
    planStorefrontReadinessInsight({
      evaluation: evaluation([finding("editorial_imagery_unused", "editorial"), finding("no_logo", "logo")]),
      gate: ALLOWED,
      observationIsActive: false,
    })?.insight.metrics.leadingFinding,
    "no_logo"
  );
  // An unranked finding still gets a voice rather than vanishing.
  check(
    "a future finding key is still surfaced",
    planStorefrontReadinessInsight({
      evaluation: evaluation([finding("something_new", "a new observation")]),
      gate: ALLOWED,
      observationIsActive: false,
    })?.insight.summary,
    "a new observation"
  );
}

// ---------------------------------------------------------------------------
console.log("\nT8. No second notification system");
{
  // The insight becomes an observation through notify.ts's own existing
  // prefix — the same dedupe namespace every other insight uses.
  check("it lands under the existing insight: prefix", STOREFRONT_READINESS_DEDUPE_KEY, `insight:${STOREFRONT_READINESS_INSIGHT_TYPE}`);
  assert(
    "and the observation key is exactly what notify.ts builds",
    STOREFRONT_READINESS_DEDUPE_KEY === `insight:${STOREFRONT_READINESS_INSIGHT_TYPE}`
  );
}

// ---------------------------------------------------------------------------
console.log("\nT9. The cooldown is stamped only on a genuine raise");
{
  check(
    "a suppressed attempt never stamps",
    planStorefrontReadinessInsight({
      evaluation: evaluation([MISSING_PHOTOS]),
      gate: { allowed: false, reason: "cooldown", detail: "…" },
      observationIsActive: false,
    }),
    null
  );
  check(
    "a standing observation never re-stamps",
    planStorefrontReadinessInsight({ evaluation: evaluation([MISSING_PHOTOS]), gate: ALLOWED, observationIsActive: true })
      ?.stampCooldown,
    false
  );
  check(
    "only a first raise stamps",
    planStorefrontReadinessInsight({ evaluation: evaluation([MISSING_PHOTOS]), gate: ALLOWED, observationIsActive: false })
      ?.stampCooldown,
    true
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
