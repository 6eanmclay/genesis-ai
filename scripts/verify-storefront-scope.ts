import {
  STOREFRONT_TARGET_KEYS,
  isStorefrontTarget,
  actionsForTarget,
  actionCanChangeTarget,
  describeTarget,
  type StorefrontTarget,
} from "@/lib/storefront/targets";
import {
  PROPOSAL_SCOPE_KEYS,
  isProposalScope,
  resolveProposalScope,
  proposalPresentation,
} from "@/lib/storefront/proposalScope";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import { SECTION_KEYS } from "@/lib/storefrontSections";

// WHAT A PROPOSAL MAY CLAIM IT CHANGES:
//
//   npx tsx scripts/verify-storefront-scope.ts
//
// Two closed registries that together decide what J4 is allowed to point at and
// how much of the storefront the owner is shown when judging it. Both pure,
// neither covered.
//
// THE INVARIANT targets.ts EXISTS FOR, in its own words: "a target with no
// action behind it must be unaddressable. The failure worth designing against is
// not 'J4 cannot address enough of the page' — it is J4 highlighting something,
// sounding certain, and then having no verb to change it with."
//
// The file says the compiler enforces that. It enforces half of it: the TYPE of
// every value is GenesisActionType, and the tuple type forbids an empty list. It
// cannot check that each of those action names is a live key in the runtime
// GENESIS_ACTIONS registry — a retired action would still typecheck as a string
// literal in a union. That cross-registry check is the most important assertion
// here, because a target pointing at an action nobody can execute is precisely
// "sounding certain with no verb behind it".
//
// The scope rule is the other half: a proposal's size is DERIVED from what it
// touches rather than declared by the model, "so it cannot disagree with it".
// Its bias is deliberately one-directional, and that direction is asserted.

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
console.log("\n=== 1. Every target has a real verb behind it ===\n");
// ============================================================================
assert("there are real targets", STOREFRONT_TARGET_KEYS.length > 0);

const emptyTargets = STOREFRONT_TARGET_KEYS.filter((t) => actionsForTarget(t).length === 0);
check("no target has an empty action list", emptyTargets, []);

// THE CROSS-REGISTRY CHECK. A target may only name actions that genuinely
// exist, or J4 can highlight something and have nothing to change it with.
const registryKeys = new Set(Object.keys(GENESIS_ACTIONS));
const danglingActions = STOREFRONT_TARGET_KEYS.flatMap((t) =>
  actionsForTarget(t)
    .filter((a) => !registryKeys.has(a))
    .map((a) => `${t} -> ${a}`)
);
check("every action a target names is a real registered action", danglingActions, []);
assert(
  "so J4 can never point at something it has no verb for",
  danglingActions.length === 0,
  "a retired action would still typecheck as a string literal"
);

// And each of those actions has a real executable behind it, not just a row.
const actionsWithoutExecutable = STOREFRONT_TARGET_KEYS.flatMap((t) =>
  actionsForTarget(t)
    .filter((a) => !GENESIS_ACTIONS[a]?.executable)
    .map((a) => `${t} -> ${a}`)
);
check("and each of those actions has a real executable", actionsWithoutExecutable, []);

// ============================================================================
console.log("\n=== 2. Sections cannot drift from the section registry ===\n");
// ============================================================================
// SECTION_TARGETS is derived from SECTION_KEYS rather than restated, which is
// the only way the two can never disagree.
const missingSections = SECTION_KEYS.filter((k) => !isStorefrontTarget(k));
check("every real section is addressable", missingSections, []);
assert("and each is changed by homepage content",
  SECTION_KEYS.every((k) => actionCanChangeTarget(k as StorefrontTarget, "update_homepage_content")),
  "section content lives in blueprint.homepageContent");

// ============================================================================
console.log("\n=== 3. Only a real target is a target ===\n");
// ============================================================================
assert("a real target is recognised", isStorefrontTarget("hero"));
assert("an invented one is not", !isStorefrontTarget("hero.background.gradient.angle"));
assert("nor is a near-miss", !isStorefrontTarget("Hero"));
assert("nor an empty string", !isStorefrontTarget(""));
assert("nor a non-string", !isStorefrontTarget(42) && !isStorefrontTarget(null) && !isStorefrontTarget(undefined));

// The own-property check is deliberate: `in` would let inherited Object
// properties resolve to a target, and "constructor" is a string a model could
// plausibly emit.
assert("an inherited Object property is not a target",
  !isStorefrontTarget("constructor") && !isStorefrontTarget("toString") &&
    !isStorefrontTarget("__proto__") && !isStorefrontTarget("hasOwnProperty"),
  "own-property check, not `in`");

// ============================================================================
console.log("\n=== 4. An action may only change what it actually changes ===\n");
// ============================================================================
assert("update_hero can change the hero", actionCanChangeTarget("hero", "update_hero"));
assert("and the hero headline", actionCanChangeTarget("hero.headline", "update_hero"));
assert("but not the search listing", !actionCanChangeTarget("seo", "update_hero"));
assert("and not the colour palette", !actionCanChangeTarget("palette", "update_hero"));
assert("update_seo changes the search listing", actionCanChangeTarget("seo", "update_seo"));
assert("and nothing else it was not listed for", !actionCanChangeTarget("hero", "update_seo"));

// An action that exists but is not listed for a target must be refused — this
// is the check that stops a proposal claiming reach it does not have.
assert("a real action not listed for a target cannot change it",
  !actionCanChangeTarget("seo", "update_theme"),
  "authorisation is by listing, never by the action merely existing");

// ============================================================================
console.log("\n=== 5. Every target has an owner-facing name ===\n");
// ============================================================================
const unnamed = STOREFRONT_TARGET_KEYS.filter((t) => !describeTarget(t) || describeTarget(t).length === 0);
check("no target renders as nothing", unnamed, []);
assert("a known target has a human name",
  describeTarget("seo") === "Search listing", describeTarget("seo"));
// The fallback is cosmetic-gap-tolerant by design: an unlabelled target is
// never a reason to fail a real proposal.
check("an unlabelled target falls back to its key rather than throwing",
  describeTarget("not_a_target" as StorefrontTarget), "not_a_target");

// ============================================================================
console.log("\n=== 6. Scope is derived, and biased toward showing more ===\n");
// ============================================================================
check("every scope has a presentation",
  PROPOSAL_SCOPE_KEYS.filter((s) => !proposalPresentation(s)?.previewHeightClass), []);
const heightOf = (scope: (typeof PROPOSAL_SCOPE_KEYS)[number]) =>
  Number(proposalPresentation(scope).previewHeightClass.match(/\d+/)?.[0] ?? 0);
assert("and a bigger scope is never shown smaller",
  (["element", "section", "page", "site"] as const).every((scope, i, arr) =>
    i === 0 || heightOf(scope) >= heightOf(arr[i - 1])),
  `element ${heightOf("element")} <= section ${heightOf("section")} <= page ${heightOf("page")} <= site ${heightOf("site")}`);

// One element, one change.
check("a dotted target with one change is an element",
  resolveProposalScope({ target: "hero.headline", mutationCount: 1 }), "element");
// The same element changed several ways is the section around it.
check("but several changes to it widen to the section",
  resolveProposalScope({ target: "hero.headline", mutationCount: 3 }), "section");
check("a section target with one change is a section",
  resolveProposalScope({ target: "hero", mutationCount: 1 }), "section");
check("and with several becomes the page",
  resolveProposalScope({ target: "hero", mutationCount: 3 }), "page");

// Whole-page concerns are the whole site regardless of count.
check("presentation is a site-level concern",
  resolveProposalScope({ target: "presentation", mutationCount: 1 }), "site");
check("and stays so however few the changes",
  resolveProposalScope({ target: "theme", mutationCount: 0 }), "site");

// No target is a claim about the whole storefront by omission.
check("no target with one change is the page",
  resolveProposalScope({ target: null, mutationCount: 1 }), "page");
check("no target with several is the whole site",
  resolveProposalScope({ target: null, mutationCount: 3 }), "site");
check("and an empty target string is treated the same as none",
  resolveProposalScope({ target: "", mutationCount: 1 }), "page");
check("as is undefined", resolveProposalScope({ target: undefined, mutationCount: 1 }), "page");

// THE ONE-DIRECTIONAL BIAS. An unrecognised target is shown as a page, never
// as an element: showing more costs screen, showing less costs the owner the
// ability to judge at all.
check("an unrecognised target is shown as a page",
  resolveProposalScope({ target: "some_future_target", mutationCount: 1 }), "page");
assert(
  "never as an element, which would hide a change the owner must judge",
  resolveProposalScope({ target: "some_future_target", mutationCount: 1 }) !== "element"
);

// ============================================================================
console.log("\n=== 7. Only a real scope is a scope ===\n");
// ============================================================================
assert("a real scope is recognised", isProposalScope("section"));
assert("an invented one is not", isProposalScope("gigantic") === false);
assert("nor an inherited property",
  !isProposalScope("constructor") && !isProposalScope("toString"),
  "same own-property discipline as isStorefrontTarget");
assert("nor a non-string", !isProposalScope(1) && !isProposalScope(null));
assert("and every derived scope is itself a valid scope",
  [
    resolveProposalScope({ target: null, mutationCount: 0 }),
    resolveProposalScope({ target: "hero", mutationCount: 9 }),
    resolveProposalScope({ target: "hero.headline", mutationCount: 0 }),
    resolveProposalScope({ target: "nonsense", mutationCount: 4 }),
  ].every(isProposalScope),
  "the resolver can never produce something the presentation lookup cannot render");

console.log(`\n${failures === 0 ? "All storefront-scope assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
