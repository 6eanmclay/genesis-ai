import {
  BUSINESS_CATEGORIES,
  BUSINESS_SUBCATEGORY_SLUGS,
  filterKnownBusinessCategories,
  businessCategoryLabel,

  REVENUE_STREAM_SLUGS,
  filterKnownRevenueStreams,
  revenueStreamLabel,
} from "@/lib/businessTaxonomy";
import { deriveActivityState } from "@/lib/dashboard/genesisActivity";

// THE CLASSIFICATION TAXONOMIES — and what a model may not add to them:
//
//   npx tsx scripts/verify-taxonomy.ts
//
// Two small open vocabularies used to validate AI classification at
// store-generation time, plus the tiny pure derivation behind Genesis's own
// activity state. All pure, none covered.
//
// THE PROPERTY THAT MATTERS is the same one factCapture holds one layer up: a
// model proposes, and code decides what is real. These filters exist because a
// generation call returns category slugs, and a slug nobody defined must not
// become a stored fact about somebody's business. The design's own note is that
// dropping is deliberate — "a misclassification is low-stakes content, never
// worth failing an entire generation over" — so the filter must silently drop
// rather than throw, and it must drop EVERYTHING unknown rather than most of it.
//
// The labels are the other half: an unknown slug that somehow reaches display
// renders as itself rather than crashing or as an empty string, so a gap shows
// up as an odd word rather than a blank space nobody can explain.

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

// ============================================================================
console.log("\n=== 1. The taxonomies are real and internally consistent ===\n");
// ============================================================================
assert("there are real business categories", BUSINESS_CATEGORIES.length > 0);
assert("with real subcategories", BUSINESS_SUBCATEGORY_SLUGS.length > 0);
check("every subcategory slug is unique",
  BUSINESS_SUBCATEGORY_SLUGS.length, new Set(BUSINESS_SUBCATEGORY_SLUGS).size);
assert("and every one has a label that is not its own slug",
  BUSINESS_SUBCATEGORY_SLUGS.every((s) => businessCategoryLabel(s) !== s),
  "a slug rendering as itself means a label is missing");

check("every revenue stream slug is unique",
  REVENUE_STREAM_SLUGS.length, new Set(REVENUE_STREAM_SLUGS).size);
assert("and every one has a real label",
  REVENUE_STREAM_SLUGS.every((s) => revenueStreamLabel(s) !== s));
assert("the two taxonomies are genuinely different axes",
  REVENUE_STREAM_SLUGS.some((s) => !BUSINESS_SUBCATEGORY_SLUGS.includes(s)),
  "what a business sells is not how it makes money");

// The onboarding fork depends on these two slugs existing by these exact names
// — discoveryFlow's ECOMMERCE_SLUGS is a hardcoded set, so a rename here would
// silently send every product business down the non-ecommerce path.
assert("product_sales is a real revenue stream", REVENUE_STREAM_SLUGS.includes("product_sales"),
  "onboarding's ecommerce fork is keyed on this exact slug");
assert("and so is digital_products", REVENUE_STREAM_SLUGS.includes("digital_products"));

// ============================================================================
console.log("\n=== 2. A model cannot invent a category ===\n");
// ============================================================================
const real = BUSINESS_SUBCATEGORY_SLUGS[0];
const alsoReal = BUSINESS_SUBCATEGORY_SLUGS[1];

check("a real slug survives", filterKnownBusinessCategories([real]), [real]);
check("an invented one is dropped", filterKnownBusinessCategories(["artisanal_wormholes"]), []);
check("and dropping is silent, not a throw",
  filterKnownBusinessCategories(["artisanal_wormholes", "another_invention"]), []);

// The mixed case is the one that matters: a real generation returns several
// slugs and gets some of them wrong. Every unknown must go, not most.
check("the real ones survive and the invented ones do not",
  filterKnownBusinessCategories([real, "artisanal_wormholes", alsoReal, "more_nonsense"]),
  [real, alsoReal]);

// Near-misses are the realistic failure mode — a model returning a plausible
// variant of a real slug.
check("a plausible near-miss is still not a category",
  filterKnownBusinessCategories([`${real}_premium`, `${real} `, real.toUpperCase()]), []);
check("an empty list stays empty", filterKnownBusinessCategories([]), []);
check("and an empty string is not a category", filterKnownBusinessCategories([""]), []);

// ============================================================================
console.log("\n=== 3. Nor a revenue stream ===\n");
// ============================================================================
check("a real stream survives", filterKnownRevenueStreams(["product_sales"]), ["product_sales"]);
check("an invented one is dropped", filterKnownRevenueStreams(["vibes_based_income"]), []);
check("mixed input keeps only the real",
  filterKnownRevenueStreams(["product_sales", "vibes_based_income", "digital_products"]),
  ["product_sales", "digital_products"]);
// The two vocabularies are separate: a business CATEGORY is not a revenue
// stream, and passing one to the other's filter must drop it.
check("a business category is not a revenue stream", filterKnownRevenueStreams([real]), []);

// ============================================================================
console.log("\n=== 4. An unknown slug still renders as something ===\n");
// ============================================================================
// A label lookup is display-time. If a slug ever reaches it that the filter
// did not catch, the owner should see an odd word rather than a blank space or
// a crash.
check("an unknown category renders as itself", businessCategoryLabel("artisanal_wormholes"), "artisanal_wormholes");
check("an unknown stream renders as itself", revenueStreamLabel("vibes_based_income"), "vibes_based_income");
check("and an empty slug renders as empty rather than throwing", businessCategoryLabel(""), "");
assert("a real slug renders as its real label",
  businessCategoryLabel(real) === BUSINESS_CATEGORIES.flatMap((g) => g.subcategories).find((s) => s.slug === real)!.label);

// ============================================================================
console.log("\n=== 5. What Genesis looks like it is doing ===\n");
// ============================================================================
// Deliberate precedence, per Sean's own priority: a real request in flight is a
// stronger signal than the owner still having focus in the textarea.
check("a request in flight is thinking",
  deriveActivityState({ isWorking: true, isComposing: false }), "thinking");
check("typing with nothing in flight is listening",
  deriveActivityState({ isWorking: false, isComposing: true }), "listening");
check("neither is idle",
  deriveActivityState({ isWorking: false, isComposing: false }), "idle");
check("and working outranks composing",
  deriveActivityState({ isWorking: true, isComposing: true }), "thinking");
assert(
  "so Genesis never reads as merely listening while it is actually working",
  deriveActivityState({ isWorking: true, isComposing: true }) === "thinking"
);

console.log(`\n${failures === 0 ? "All taxonomy assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
