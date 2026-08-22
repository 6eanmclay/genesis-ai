import { buildPageAttentionCards, buildAttentionCards } from "@/lib/dashboard/attentionCards";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { LEGACY_BUSINESS_BASE, businessBasePath } from "@/lib/dashboard/navConfig";
import type { PendingApproval } from "@/lib/dashboard/pendingApprovals";

// A REVIEW LINK MUST NOT CHANGE WHICH BUSINESS YOU ARE EDITING:
//
//   npx tsx scripts/verify-review-links.ts
//
// ACTION_SECTIONS stores the legacy "/dashboard/..." spelling of every section,
// which was the only spelling there was for as long as an account held one
// business. Business-in-the-URL (2026-08-20) made it one of two, and every
// consumer of that map kept handing the raw value straight to a <Link>.
//
// WHAT THAT ACTUALLY DOES, which is worse than a cosmetic inconsistency:
// /b/<slug>/... carries the business in the request, deliberately, so "two tabs
// can hold two businesses and nothing an account does in one tab moves the
// other". /dashboard/... does the opposite — it resolves the account's ACTIVE
// business, which is per-account state shared across every tab. So an owner
// working in business A, with B active, who clicked "Review" on a proposal
// belonging to A, landed on B's version of that screen. Same layout, same
// controls, different business, and nothing anywhere saying so.
//
// Visiting /b/<slug> does not set the active business — that is the whole point
// of the route — so this could not self-correct.
//
// The fix is sectionHref, the transformation that already existed for the nav,
// applied at the three places a section href becomes a link. This suite asserts
// the property at the boundary rather than trusting each call site.

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

const BASE = businessBasePath("copper-and-coil");

const approval = (actionType: string, id = "ap_1"): PendingApproval =>
  ({
    id,
    summary: `A proposal for ${actionType}`,
    actionType,
    input: {},
    previousValues: {},
    createdAt: new Date("2026-08-20T10:00:00Z"),
    groupId: null,
    topicKey: null,
    status: "PENDING_APPROVAL",
    failureMessage: null,
  }) as unknown as PendingApproval;

const reviewHrefFor = (actionType: string, basePath: string): string | null => {
  const [card] = buildPageAttentionCards({
    basePath,
    approvals: [approval(actionType)],
    observations: [],
  });
  return (card as { reviewHref: string | null }).reviewHref;
};

// ============================================================================
console.log("\n=== 1. A review link stays inside the owner's business ===\n");
// ============================================================================
check("a storefront proposal is reviewed in THIS business",
  reviewHrefFor("update_hero", BASE), `${BASE}/website`);
check("a product proposal too", reviewHrefFor("update_product", BASE), `${BASE}/products`);
check("and an SEO one", reviewHrefFor("update_seo", BASE), `${BASE}/marketing`);

assert(
  "so a Review click can never move the owner to another business",
  !(reviewHrefFor("update_hero", BASE) ?? "").startsWith(LEGACY_BUSINESS_BASE),
  "/dashboard/... resolves the ACTIVE business, which may not be this one"
);

// Every registered action, not a sample. One missed entry is one screen where
// the link silently changes business.
const leaking = Object.keys(ACTION_SECTIONS)
  .map((a) => [a, reviewHrefFor(a, BASE)] as const)
  .filter(([, href]) => href !== null && !href.startsWith(BASE))
  .map(([a, href]) => `${a} -> ${href}`);
check("no action's review link escapes the business", leaking, []);

// ============================================================================
console.log("\n=== 2. The legacy route is unchanged ===\n");
// ============================================================================
// An account on /dashboard has exactly one business in play — its active one —
// and rebasing onto the legacy base must be the identity, or this fix would
// have moved every existing link.
for (const action of Object.keys(ACTION_SECTIONS)) {
  const href = reviewHrefFor(action, LEGACY_BUSINESS_BASE);
  check(`${action} still points where it always did`, href, ACTION_SECTIONS[action].href);
}

// ============================================================================
console.log("\n=== 3. Two businesses, two links, from identical input ===\n");
// ============================================================================
// The property the whole route migration exists for, at this one boundary.
const gym = businessBasePath("iron-gym");
const coil = businessBasePath("copper-and-coil");
const inGym = reviewHrefFor("update_hero", gym);
const inCoil = reviewHrefFor("update_hero", coil);
assert("the same proposal reviews in whichever business asked", inGym !== inCoil,
  `${inGym} vs ${inCoil}`);
check("each in its own", [inGym, inCoil], [`${gym}/website`, `${coil}/website`]);

// ============================================================================
console.log("\n=== 4. An action with no section still has no link ===\n");
// ============================================================================
// A card for an unmapped action must render without a Review link rather than
// with one pointing at the business root — an honest absence, not a guess.
check("an unknown action has no review link", reviewHrefFor("not_a_real_action", BASE), null);
assert("rather than a link to nowhere in particular",
  reviewHrefFor("not_a_real_action", BASE) !== BASE,
  "a Review button that lands on the home screen is worse than no button");

// ============================================================================
console.log("\n=== 5. The home feed's cards carry the same property ===\n");
// ============================================================================
// buildAttentionCards is a different entry point with its own call site, and it
// was the one most likely to be missed: Home is where an owner reviews things
// without having navigated into the room first.
const home = buildAttentionCards({
  basePath: BASE,
  issues: [],
  pendingApprovals: [approval("update_theme", "ap_home")],
  nextRecommendation: null,
  discoveryItems: [],
  tasks: [],
});
const homeCard = home.cards.find((c) => c.kind === "proposal") as { reviewHref: string | null } | undefined;
check("a proposal on Home reviews in this business", homeCard?.reviewHref, `${BASE}/website`);
assert("both entry points agree",
  homeCard?.reviewHref === reviewHrefFor("update_theme", BASE),
  "two builders producing two different links would be the drift this closes");

console.log(`\n${failures === 0 ? "All review-link assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
