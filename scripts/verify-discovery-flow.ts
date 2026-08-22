import {
  initialDiscoveryState,
  applyBusinessModelAnswer,
  applyBrandPositioningAnswer,
  applyCreativeApproachAnswer,
  applyCreativeDirectionsGenerated,
  applyCreativeDirectionSelected,
  applyArtworkUploaded,
  applyFulfillmentStrategyChosen,
  applySelfFulfillmentPriced,
  applyProductSourceAnswer,
  applyFulfillmentConnected,
  applyCandidateSelected,
  applyPricingConfirmed,
  type DiscoveryState,
  type CreativeDirectionOption,
} from "@/lib/onboarding/discoveryFlow";

// THE ONBOARDING STATE MACHINE — every path a new owner can take:
//
//   npx tsx scripts/verify-discovery-flow.ts
//
// The pure half of Onboarding v2. Every function here takes an
// already-classified answer and returns the next state; all the I/O — the real
// AI classification, the real fulfillment API calls — lives in
// app/onboarding/actions.ts, which calls these with the result. So the whole
// state machine is testable with no database, no provider and no AI.
//
// WHAT THIS PROTECTS. Onboarding is the one flow where a wrong turn is
// unrecoverable in practice: the owner is meeting Genesis for the first time,
// and a path that skips a step or lands somewhere impossible is a person who
// does not come back. Three branch points carry that risk:
//
//   the ecommerce fork      a non-ecommerce idea must NOT be walked down a
//                           product path it can never finish
//   creative approach       custom / upload / resell diverge and reconverge,
//                           and upload deliberately skips "review 3 options"
//   fulfillment strategy    resell has no self-fulfillment fallback, so a
//                           non-Printful answer there must stay put and say so
//                           rather than fabricate a path forward
//
// Also asserted throughout: every transition is PURE. It returns a new state
// and never mutates the one it was given — a state machine that mutated in
// place would make the back button lie.

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

// The real shape, not a cast past it — a fixture that does not typecheck
// against the interface is a fixture that stops matching it silently.
const direction: CreativeDirectionOption = {
  name: "Warm editorial",
  description: "Quiet, considered, a little bit hand-made.",
  brandVoice: "Plain and warm",
  photographyStyle: "Natural light, close crops",
  colors: {
    primary: "#2b2b2b", secondary: "#8a7a66", accent: "#c96f4a",
    background: "#faf7f2", surface: "#ffffff", text: "#1a1a1a", textSecondary: "#6b6b6b",
  },
  typography: { headingFont: "Fraunces", bodyFont: "Inter" },
  logoUrl: "https://blob.example.test/logo.png",
  productImageUrl: "https://blob.example.test/product.png",
};

const pricing = { costInCents: 1_000, recommendedPriceInCents: 2_500 } as never;
const candidate = { id: "cand-1", name: "A blank tee" } as never;

// ============================================================================
console.log("\n=== 1. Where everyone starts ===\n");
// ============================================================================
const start = initialDiscoveryState();
check("the first question is the business model", start.step, "business_model");
assert("and nothing is assumed about the business yet",
  Object.entries(start).every(([k, v]) => k === "step" || v === null || v === false),
  JSON.stringify(start));

// ============================================================================
console.log("\n=== 2. The ecommerce fork ===\n");
// ============================================================================
// Only two revenue-stream slugs get the product path. Everything else — a
// consultancy, a service business, "other" — must be told plainly rather than
// walked down a path it can never finish.
check("selling products is the ecommerce path",
  applyBusinessModelAnswer(start, "product_sales", "Candles").step, "brand_positioning");
check("so is selling digital products",
  applyBusinessModelAnswer(start, "digital_products", "Presets").step, "brand_positioning");
check("a service business is not",
  applyBusinessModelAnswer(start, "services", "Consulting").step, "not_ecommerce");
check("and neither is 'other'",
  applyBusinessModelAnswer(start, "other", "Something else").step, "not_ecommerce");
assert("but what they said is kept either way",
  applyBusinessModelAnswer(start, "services", "Consulting").ideaText === "Consulting",
  "the idea is not discarded just because the path diverges");

// ============================================================================
console.log("\n=== 3. Three creative approaches that reconverge ===\n");
// ============================================================================
const positioned = applyBrandPositioningAnswer(
  applyBusinessModelAnswer(start, "product_sales", "Candles"),
  "minimalist",
  "Clean and quiet"
);
check("positioning leads to the creative question", positioned.step, "creative_approach");

const custom = applyCreativeApproachAnswer(positioned, "custom");
check("custom generates directions first", custom.step, "creative_direction_generating");
const reviewing = applyCreativeDirectionsGenerated(custom, [direction]);
check("then reviews them", reviewing.step, "creative_direction_review");
const chosen = applyCreativeDirectionSelected(reviewing, direction);
check("choosing one moves to fulfillment", chosen.step, "fulfillment_strategy");
check("and the options are cleared once chosen", chosen.creativeDirectionOptions, null);
assert("while the choice itself is kept", chosen.creativeDirection?.name === "Warm editorial");

const upload = applyCreativeApproachAnswer(positioned, "upload");
check("upload goes straight to the owner's own artwork", upload.step, "artwork_upload");
const uploaded = applyArtworkUploaded(upload, direction);
check("and lands on the same fulfillment step", uploaded.step, "fulfillment_strategy");
assert("skipping 'review three options' entirely",
  uploaded.creativeDirectionOptions === null,
  "one real upload is one real direction — there is nothing to choose between");

const resell = applyCreativeApproachAnswer(positioned, "resell");
check("resell also reaches fulfillment", resell.step, "fulfillment_strategy");
check("and is marked as discovering products", resell.productSource, "discover");
check("with no creative direction of its own", resell.creativeDirection, null);

// ============================================================================
console.log("\n=== 4. Fulfillment, where resell has no fallback ===\n");
// ============================================================================
check("choosing Printful goes to connect",
  applyFulfillmentStrategyChosen(chosen, "printful").step, "fulfillment_connect");
// A custom/upload owner who is not using Printful prices their own product.
check("self-fulfilment prices it themselves",
  applyFulfillmentStrategyChosen(chosen, "self").step, "self_fulfillment_pricing");
check("as does 'other'", applyFulfillmentStrategyChosen(chosen, "other").step, "self_fulfillment_pricing");
check("and 'later'", applyFulfillmentStrategyChosen(chosen, "later").step, "self_fulfillment_pricing");

// THE HONEST REFUSAL. Resell means "browse an existing fulfillable catalog",
// and Printful's is the only one that exists — so a non-Printful answer here
// STAYS PUT rather than inventing a path that cannot be completed.
const resellSelf = applyFulfillmentStrategyChosen(resell, "self");
check("a reseller choosing self-fulfilment stays on the same step", resellSelf.step, "fulfillment_strategy");
check("but their answer is recorded", resellSelf.fulfillmentStrategy, "self");
assert(
  "so the UI can say what is missing rather than fabricating a way forward",
  resellSelf.step === "fulfillment_strategy",
  "there is no self-fulfillment catalog to browse"
);
check("while a reseller choosing Printful does proceed",
  applyFulfillmentStrategyChosen(resell, "printful").step, "fulfillment_connect");

// ============================================================================
console.log("\n=== 5. After connecting, the paths differ again ===\n");
// ============================================================================
const customConnected = applyFulfillmentConnected(applyFulfillmentStrategyChosen(chosen, "printful"));
check("custom builds a creative product", customConnected.step, "creative_product_building");
check("and is marked connected", customConnected.fulfillmentConnected, true);

const uploadConnected = applyFulfillmentConnected(applyFulfillmentStrategyChosen(uploaded, "printful"));
check("upload does the same", uploadConnected.step, "creative_product_building");

const resellConnected = applyFulfillmentConnected(applyFulfillmentStrategyChosen(resell, "printful"));
check("resell browses the catalog instead", resellConnected.step, "product_discovery");

// A draft created before this fork existed has creativeApproach null and must
// keep working — backward compatibility by construction, not by migration.
const legacy = applyFulfillmentConnected({ ...start, creativeApproach: null } as DiscoveryState);
check("an in-flight draft from before the fork still works", legacy.step, "product_discovery");

// ============================================================================
console.log("\n=== 6. Pricing, and where each path ends ===\n");
// ============================================================================
const picked = applyCandidateSelected(resellConnected, candidate, "It matches the brand");
check("picking a candidate goes to pricing", picked.step, "pricing");
assert("keeping the reasoning the owner was given", picked.candidateReasoning === "It matches the brand");

check("a reseller finishes ready to publish", applyPricingConfirmed(picked, pricing).step, "ready_to_publish");
check("a custom owner sees their storefront first",
  applyPricingConfirmed(customConnected, pricing).step, "storefront_reveal");
check("and so does an upload owner",
  applyPricingConfirmed(uploadConnected, pricing).step, "storefront_reveal");

// Self-fulfilment reaches the same destination without a candidate, because
// there is no catalog item to select.
const selfPriced = applySelfFulfillmentPriced(applyFulfillmentStrategyChosen(chosen, "self"), 800, pricing);
check("self-fulfilment ends at the storefront reveal too", selfPriced.step, "storefront_reveal");
check("recording the owner's own cost", selfPriced.selfSuppliedCostInCents, 800);
check("and never inventing a catalog item", selfPriced.selectedCandidate, null);

// ============================================================================
console.log("\n=== 7. The deferred branch is wired but unreached ===\n");
// ============================================================================
// applyProductSourceAnswer exists for the "I already have products" fork, which
// ONBOARDING_V2_DESIGN.md defers. It is asserted here so the deferral stays
// deliberate rather than becoming a quietly broken path if it is ever reached.
check("an owner who already has products goes straight to pricing",
  applyProductSourceAnswer(positioned, "existing").step, "pricing");
check("and one who does not goes to connect",
  applyProductSourceAnswer(positioned, "discover").step, "fulfillment_connect");

// ============================================================================
console.log("\n=== 8. Every transition is pure ===\n");
// ============================================================================
// A state machine that mutated in place would make the back button lie: the
// previous step would silently become the current one.
const before = initialDiscoveryState();
const snapshot = JSON.stringify(before);
applyBusinessModelAnswer(before, "product_sales", "Candles");
applyBrandPositioningAnswer(before, "minimalist", "Clean");
applyCreativeApproachAnswer(before, "custom");
applyFulfillmentConnected(before);
applyPricingConfirmed(before, pricing);
check("the state handed in is never modified", JSON.stringify(before), snapshot);

assert("and each call returns a genuinely different object",
  applyBusinessModelAnswer(before, "product_sales", "Candles") !== before);

// The same inputs always produce the same output — no clock, no randomness, so
// a resumed draft replays identically.
check("the same answer twice gives the same state",
  applyCreativeApproachAnswer(positioned, "custom"),
  applyCreativeApproachAnswer(positioned, "custom"));

console.log(`\n${failures === 0 ? "All discovery-flow assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
