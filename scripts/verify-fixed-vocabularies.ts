import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { BUSINESS_INTENT_CATEGORIES, businessIntentFor } from "@/lib/businessIntent";
import { AI_FEATURES, type AiFeature } from "@/lib/aiFeatures";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";

// THE SMALL FIXED VOCABULARIES NOTHING ELSE CHECKS:
//
//   npx tsx scripts/verify-fixed-vocabularies.ts
//
// Three sets of constants that each carry a real decision, and whose types check
// the shape while leaving the decision itself unguarded.
//
// 88px IS ON THE UNTOUCHABLE LIST. GENESIS_SURFACES.md names "the orb, Talk
// Mode, the voice architecture, useJ4Talk.ts, and 88px" as what the room work
// may not touch — and 88px is the only one of the five that is a number in a
// file rather than a component. It was reached by real-device iteration and then
// walked back to: "tried at 88px (thick, visible)... back to 88px, the size it
// originally was." A frozen number with a history of being changed and reverted
// is exactly the kind that drifts.
//
// BUSINESS_INTENT_CATEGORIES is "fixed to Sean's own 9 categories —
// deliberately not open/additive... a small, stable set to aggregate and compare
// against over time; add a 10th only with real evidence it's needed." The
// Record<AiFeature, ...> type makes a MISSING FEATURE a compile error. What it
// cannot catch is the other direction: a category no feature maps to, which
// compiles perfectly and shows up as a permanently empty column in every
// comparison the set exists to make.

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

/** The number in a Tailwind size class, whichever notation it uses. */
function sizeIn(value: string, axis: "h" | "w"): string | null {
  for (const token of value.split(/\s+/)) {
    if (!token.startsWith(`${axis}-`)) continue;
    const digits = /^\d+$/.exec(token.slice(2).replace("[", "").replace("px]", "").replace("]", ""));
    if (digits) return digits[0];
  }
  return null;
}

// ============================================================================
console.log("\n=== 1. 88px, which is on the untouchable list ===\n");
// ============================================================================
assert("the summon orb is 88px", GENESIS_AVATAR_SIZE.summon.includes("h-[88px]"), GENESIS_AVATAR_SIZE.summon);
assert("and so is the presence orb", GENESIS_AVATAR_SIZE.presenceOrb.includes("h-[88px]"),
  GENESIS_AVATAR_SIZE.presenceOrb);
assert(
  "both, because they are the same orb in two places",
  GENESIS_AVATAR_SIZE.summon === GENESIS_AVATAR_SIZE.presenceOrb,
  "one of them drifting is how the orb starts looking like two different objects"
);

// EVERY SIZE IS SQUARE, by one of two legitimate idioms — and that is a
// correction to this test rather than to the code. The first version demanded
// `h-N w-N` plus shrink-0 everywhere and failed eight of nine: the responsive
// sizes use `aspect-square w-[min(...)]`, which is square by RATIO rather than
// by a matching pair, and shrink-0 only matters where a fixed size sits in a
// flex row. Asserting one idiom would have been asserting my own assumption.
//
// A non-square avatar is a squashed face, however it is expressed.
for (const [name, value] of Object.entries(GENESIS_AVATAR_SIZE)) {
  const height = sizeIn(value, "h");
  const width = sizeIn(value, "w");
  const byRatio = value.includes("aspect-square");
  const byPair = Boolean(height && width && height === width);
  assert(`${name} is square`, byRatio || byPair, value);
  assert(`${name} declares a size at all`, value.split(/\s+/).some((t) => t.startsWith("w-")), value);
}

// shrink-0 where a FIXED size sits in a flex row. Without it the orb is the
// thing that gives when the tab bar is tight, and it is the one element that
// must not move.
for (const name of ["summon", "presenceOrb", "toolbar", "header", "inline"] as const) {
  const value = GENESIS_AVATAR_SIZE[name];
  assert(`${name} keeps its size in a flex row`, value.includes("shrink-0"), value);
}

// ============================================================================
console.log("\n=== 2. Nine categories, every one of them real ===\n");
// ============================================================================
check("there are exactly nine", BUSINESS_INTENT_CATEGORIES.length, 9);
check("and no duplicates", new Set(BUSINESS_INTENT_CATEGORIES).size, BUSINESS_INTENT_CATEGORIES.length);

// THE DIRECTION THE TYPE CANNOT CHECK — and it found one, which turned out to
// be a reservation rather than drift.
//
// `financial_insight` is one of the nine and no feature maps to it. That is
// deliberate: the map's own comment says analyze_business "already covers for
// orders/revenue/customers", so today's financial work is folded there, and
// financial_insight is reserved for a dedicated capability that does not exist
// yet. The same "architect for, don't build" discipline as ArrivalMode's
// "switching", which is real code nothing currently triggers.
//
// Named here rather than skipped, because an exception nobody wrote down is
// indistinguishable from drift — and because a SECOND empty category must
// still fail. A permanently empty bucket is a column that always reads zero in
// every comparison this set exists to make.
const RESERVED_FOR_A_CAPABILITY_NOT_BUILT_YET = new Set(["financial_insight"]);

const used = new Set(AI_FEATURES.map((f) => businessIntentFor(f as AiFeature)));
const unused = BUSINESS_INTENT_CATEGORIES.filter((c) => !used.has(c));
check("only the reserved category is unused",
  unused.filter((c) => !RESERVED_FOR_A_CAPABILITY_NOT_BUILT_YET.has(c)), []);
assert(
  "so a second empty bucket would fail here rather than pass unnoticed",
  unused.every((c) => RESERVED_FOR_A_CAPABILITY_NOT_BUILT_YET.has(c)),
  `unused: ${JSON.stringify(unused)}`
);
assert("and the reservation is still a reservation, not a majority of the set",
  unused.length < BUSINESS_INTENT_CATEGORIES.length / 2,
  `${unused.length} of ${BUSINESS_INTENT_CATEGORIES.length} categories have no feature`);

// And nothing maps outside the nine — the type says so, but the map is
// hand-written and this is the runtime half of the same claim.
const strays = AI_FEATURES
  .map((f) => businessIntentFor(f as AiFeature))
  .filter((c) => !(BUSINESS_INTENT_CATEGORIES as readonly string[]).includes(c));
check("and no feature maps outside them", [...new Set(strays)], []);

const unmapped = AI_FEATURES.filter((f) => !businessIntentFor(f as AiFeature));
check("every AI feature has an intent", unmapped, []);
assert(`all ${AI_FEATURES.length} features are classified`, unmapped.length === 0);

// The categories are the owner's vocabulary rather than the machine's — each
// reads as a business activity, not a call site or a provider.
for (const category of BUSINESS_INTENT_CATEGORIES) {
  assert(`"${category}" names an activity`, category.includes("_") || category.length > 6, category);
  assert(`"${category}" is not a model or provider name`,
    !/claude|anthropic|openai|gpt|model|api/i.test(category), category);
}

// ============================================================================
console.log("\n=== 3. Genesis's own environment is not the app's theme ===\n");
// ============================================================================
// GENESIS_ATMOSPHERE is fixed "regardless of the owner's light/dark toggle
// (this is Genesis's own identity, not the app's dark mode)". verify-rooms
// asserts no ROOM may reach for blue; this is the other half — the atmosphere is
// where the blue legitimately lives, and it must not become theme-dependent.
const entries = Object.entries(GENESIS_ATMOSPHERE).filter(([, v]) => typeof v === "string") as [string, string][];
assert("the atmosphere defines real values", entries.length > 0, JSON.stringify(GENESIS_ATMOSPHERE));
for (const [name, value] of entries) {
  assert(`${name} is a real value`, value.trim().length > 0, value);
}
const themed = entries.filter(([, v]) => v.includes("dark:")).map(([k]) => k);
check("and none of it follows the app's dark mode", themed, []);
assert(
  "so Genesis looks like Genesis whichever theme the owner picked",
  themed.length === 0,
  "this is Genesis's own identity, not the app's dark mode"
);

console.log(`\n${failures === 0 ? "All fixed-vocabulary assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
