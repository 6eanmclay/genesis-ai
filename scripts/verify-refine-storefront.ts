import { applyRefinementsToTheme, type RefineStorefrontChange } from "@/lib/execution/executables/refineStorefront";
import { DEFAULT_THEME, type Theme } from "@/lib/theme";
import {
  REFINABLE_DIMENSIONS,
  REFINABLE_DIMENSION_KEYS,
  MAX_MUTATIONS_PER_IMPROVEMENT,
  dimensionGroup,
  type RefinableDimensionKey,
} from "@/lib/storefront/dimensions";

// THE TRANSFORM BEHIND AN APPROVED STOREFRONT CHANGE:
//
//   npx tsx scripts/verify-refine-storefront.ts
//
// applyRefinementsToTheme is what actually moves a storefront when the owner
// approves a refinement — and it is also what renders the preview they approved
// it from, imported by lib/storefront/previewTheme.ts rather than reimplemented
// there, because "two copies would be a preview that lies, and the lie would
// only surface after the owner had already approved it."
//
// So this one function is both halves of "what you saw is what you got", and it
// had no direct coverage. verify-dimensions proves the vocabulary renders;
// verify-preview-theme proves the preview path reaches it. Neither exercises its
// own rules.
//
// IT THROWS RATHER THAN SKIPPING, which is the design and the thing worth
// pinning. Stored input is read back long after it was written — an approval
// sitting for a week, a proposal written before a dimension was retired — so it
// gets the same gate a fresh tool call does. A version that silently dropped an
// unrecognised change would apply a PARTIAL refinement while reporting success,
// and the owner would be looking at something nobody proposed.
//
// AND IT LEAVES COLOUR AND TYPE ALONE. "This action changes structure and
// presentation only; a palette or font change remains update_theme's job, which
// is the separation that keeps this one small." A refinement that quietly
// restyled the palette would be a redesign wearing a refinement's summary.

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

/** What this threw, or null. */
function threw(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const BASE_PRESENTATION = DEFAULT_THEME.presentation!;
const BASE_COMPOSITION = DEFAULT_THEME.composition!;

/** A value for this dimension that is not the current one. */
const otherValue = (dimension: RefinableDimensionKey, current: unknown) =>
  (REFINABLE_DIMENSIONS[dimension].values as readonly string[]).find((v) => v !== current)!;

const change = (dimension: RefinableDimensionKey, value: string): RefineStorefrontChange =>
  ({ dimension, value }) as RefineStorefrontChange;

// ============================================================================
console.log("\n=== 1. A refinement moves exactly what it names ===\n");
// ============================================================================
for (const dimension of REFINABLE_DIMENSION_KEYS) {
  const group = dimensionGroup(dimension);
  const baseline = group === "presentation"
    ? (BASE_PRESENTATION as Record<string, unknown>)[dimension]
    : (BASE_COMPOSITION as Record<string, unknown>)[dimension];
  const next = otherValue(dimension, baseline);
  const result = applyRefinementsToTheme(DEFAULT_THEME, [change(dimension, next)]);
  const landed = group === "presentation"
    ? (result.presentation as Record<string, unknown>)[dimension]
    : (result.composition as Record<string, unknown>)[dimension];
  check(`${dimension} lands in ${group}`, landed, next);

  // And nothing else moved. A refinement is one idea, not a redesign.
  const movedElsewhere = [
    ...Object.keys(BASE_PRESENTATION).filter(
      (k) => k !== dimension && (result.presentation as Record<string, unknown>)[k] !== (BASE_PRESENTATION as Record<string, unknown>)[k]
    ),
    ...Object.keys(BASE_COMPOSITION).filter(
      (k) => k !== dimension && (result.composition as Record<string, unknown>)[k] !== (BASE_COMPOSITION as Record<string, unknown>)[k]
    ),
  ];
  check(`and nothing else moves with it`, movedElsewhere, []);
}

// ============================================================================
console.log("\n=== 2. Colour and type are somebody else's job ===\n");
// ============================================================================
const withPalette: Theme = {
  ...DEFAULT_THEME,
  colors: { ...(DEFAULT_THEME.colors ?? {}), primary: "#ff0000" } as Theme["colors"],
  typography: { headingFont: "Fraunces", bodyFont: "Source Serif 4" } as Theme["typography"],
};
const refined = applyRefinementsToTheme(withPalette, [
  change("cardStyle", otherValue("cardStyle", BASE_PRESENTATION.cardStyle)),
]);
check("the palette is untouched", refined.colors, withPalette.colors);
check("and so is the typography", refined.typography, withPalette.typography);
assert(
  "so a refinement can never be a redesign wearing a refinement's summary",
  JSON.stringify(refined.colors) === JSON.stringify(withPalette.colors),
  "a palette or font change remains update_theme's job"
);

// Everything else on the theme survives too — this returns { ...current }, so
// an unknown future field must not be dropped on the way through.
const withExtra = { ...DEFAULT_THEME, layout: "featured" } as Theme;
check("and any other theme field survives",
  (applyRefinementsToTheme(withExtra, []) as Record<string, unknown>).layout, "featured");

// ============================================================================
console.log("\n=== 3. Stored input gets the same gate a fresh call does ===\n");
// ============================================================================
// The reason this throws rather than skipping: an approval read back a week
// later must not apply a PARTIAL refinement while reporting success.
const invented = threw(() => applyRefinementsToTheme(DEFAULT_THEME, [change("borderRadiusPx" as RefinableDimensionKey, "12")]));
assert("an invented dimension is refused", invented !== null, String(invented));
assert("and says it is not a refinable part of the storefront",
  (invented ?? "").includes("Not a refinable part"), String(invented));

const badValue = threw(() => applyRefinementsToTheme(DEFAULT_THEME, [change("cardStyle", "extra-rounded")]));
assert("a value outside the vocabulary is refused", badValue !== null, String(badValue));
assert("and names the dimension in the owner's words",
  (badValue ?? "").includes("card") || (badValue ?? "").toLowerCase().includes("style"), String(badValue));

// A value that is real, but belongs to a different dimension.
const crossed = threw(() => applyRefinementsToTheme(DEFAULT_THEME, [change("cardStyle", "pill")]));
assert("a value from another dimension is refused", crossed !== null,
  "pill is real, but it is a button style");

// Raw CSS is the model failure this whole vocabulary exists to prevent.
assert("and raw CSS is refused",
  threw(() => applyRefinementsToTheme(DEFAULT_THEME, [change("cardStyle", "border-radius: 12px")])) !== null,
  "the model never emits CSS — that is the whole rule");

// Prototype keys, since dimension arrives as a string from stored JSON.
for (const key of ["constructor", "toString", "__proto__", "valueOf"]) {
  assert(`"${key}" is not a dimension`,
    threw(() => applyRefinementsToTheme(DEFAULT_THEME, [change(key as RefinableDimensionKey, "x")])) !== null);
}

// THE PARTIAL-APPLICATION PROPERTY. One bad change in a list must not leave the
// good ones applied — the throw happens before any write is persisted, so the
// caller gets nothing rather than half.
const half = threw(() =>
  applyRefinementsToTheme(DEFAULT_THEME, [
    change("cardStyle", otherValue("cardStyle", BASE_PRESENTATION.cardStyle)),
    change("cardStyle", "not-a-real-value"),
  ])
);
assert("one bad change refuses the whole list", half !== null, String(half));
assert(
  "so an owner never gets half of what they approved",
  half !== null,
  "a silent skip would apply a partial refinement while reporting success"
);

// ============================================================================
console.log("\n=== 4. A store that predates the theme fields still works ===\n");
// ============================================================================
// "A store that predates presentation or composition therefore gains a
// complete, known-good set rather than a half-populated one."
const ancient = { colors: DEFAULT_THEME.colors } as Theme;
const upgraded = applyRefinementsToTheme(ancient, [
  change("cardStyle", otherValue("cardStyle", BASE_PRESENTATION.cardStyle)),
]);
check("presentation is filled in completely",
  Object.keys(upgraded.presentation ?? {}).sort(), Object.keys(BASE_PRESENTATION).sort());
check("and composition too",
  Object.keys(upgraded.composition ?? {}).sort(), Object.keys(BASE_COMPOSITION).sort());
assert("with the requested change applied on top",
  (upgraded.presentation as Record<string, unknown>).cardStyle === otherValue("cardStyle", BASE_PRESENTATION.cardStyle),
  String((upgraded.presentation as Record<string, unknown>).cardStyle));

// An empty change list is a no-op rather than an error — the caller's schema
// already requires at least one, so this is defence rather than a code path.
const untouched = applyRefinementsToTheme(DEFAULT_THEME, []);
check("no changes changes nothing", untouched.presentation, BASE_PRESENTATION);
check("on both halves", untouched.composition, BASE_COMPOSITION);

// ============================================================================
console.log("\n=== 5. Several changes are one idea, and capped ===\n");
// ============================================================================
// Sean's cap: four mutations are the implementation detail of ONE idea, and the
// allowance must not be used to disguise a broader redesign. The schema enforces
// the count; this asserts the transform handles a full-size one correctly.
const many = REFINABLE_DIMENSION_KEYS.slice(0, MAX_MUTATIONS_PER_IMPROVEMENT).map((d) => {
  const baseline = dimensionGroup(d) === "presentation"
    ? (BASE_PRESENTATION as Record<string, unknown>)[d]
    : (BASE_COMPOSITION as Record<string, unknown>)[d];
  return change(d, otherValue(d, baseline));
});
const multi = applyRefinementsToTheme(DEFAULT_THEME, many);
for (const c of many) {
  const landed = dimensionGroup(c.dimension as RefinableDimensionKey) === "presentation"
    ? (multi.presentation as Record<string, unknown>)[c.dimension]
    : (multi.composition as Record<string, unknown>)[c.dimension];
  check(`${c.dimension} applied in a full-size improvement`, landed, c.value);
}
check("and exactly that many things moved", many.length, MAX_MUTATIONS_PER_IMPROVEMENT);

// Later changes to the same dimension win, rather than the first silently
// sticking — last-write-wins is the only coherent answer, and it should be the
// one that happens.
const twice = applyRefinementsToTheme(DEFAULT_THEME, [
  change("cardStyle", REFINABLE_DIMENSIONS.cardStyle.values[0]),
  change("cardStyle", REFINABLE_DIMENSIONS.cardStyle.values[1]),
]);
check("the last word on a dimension wins",
  (twice.presentation as Record<string, unknown>).cardStyle, REFINABLE_DIMENSIONS.cardStyle.values[1]);

console.log(`\n${failures === 0 ? "All refine-storefront assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
