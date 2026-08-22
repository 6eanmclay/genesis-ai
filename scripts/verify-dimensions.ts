import {
  REFINABLE_DIMENSIONS,
  REFINABLE_DIMENSION_KEYS,
  MAX_MUTATIONS_PER_IMPROVEMENT,
  isRefinableDimension,
  isValidDimensionValue,
  dimensionGroup,
  describeDimension,
  type RefinableDimensionKey,
} from "@/lib/storefront/dimensions";
import {
  DEFAULT_THEME,
  cardRadiusClass,
  buttonRadiusClass,
  shadowClass,
  sectionPaddingClass,
  contentGapClass,
  headingScaleClass,
  imageFrameClass,
  type Theme,
} from "@/lib/theme";

// THE VOCABULARY refine_storefront MAY MOVE — and that all of it renders:
//
//   npx tsx scripts/verify-dimensions.ts
//
// dimensions.ts is the closed vocabulary a storefront refinement is allowed to
// pick from, and its own stated rule is the reason a generated storefront cannot
// render broken: "the model never emits CSS. It picks from variants that are
// hand-built and tested."
//
// THAT RULE HAS A SEAM, and it is the same shape as the one found in
// targets.ts. This file is a hand-maintained literal that "mirrors Presentation
// and Composition in lib/theme.ts exactly", kept literal on purpose because
// TypeScript types are erased at runtime and this has to validate real model
// output. Nothing checks the mirror. A value listed here but dropped from
// theme.ts would still be offered to the model, chosen, approved by an owner,
// and then rendered as undefined CSS.
//
// So every declared value is fed through theme.ts's own accessors and asserted
// to produce something real. That is the check the mirror comment implies and
// the compiler cannot make.

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

const themeWith = (over: Record<string, unknown>): Theme => ({
  ...DEFAULT_THEME,
  presentation: { ...DEFAULT_THEME.presentation, ...over } as Theme["presentation"],
  composition: { ...DEFAULT_THEME.composition, ...over } as Theme["composition"],
});

// ============================================================================
console.log("\n=== 1. Every value the model may pick actually renders ===\n");
// ============================================================================
// Presentation dimensions resolve to real class strings. An unlisted value
// would produce undefined, which is how a storefront renders broken.
const PRESENTATION_RENDERERS: Record<string, (t: Theme) => string> = {
  cardStyle: cardRadiusClass,
  buttonStyle: buttonRadiusClass,
  shadowStyle: shadowClass,
};

for (const [dimension, render] of Object.entries(PRESENTATION_RENDERERS)) {
  for (const value of REFINABLE_DIMENSIONS[dimension as RefinableDimensionKey].values) {
    const rendered = render(themeWith({ [dimension]: value }));
    assert(`${dimension} "${value}" renders`, typeof rendered === "string",
      `got ${JSON.stringify(rendered)}`);
  }
}

// Spacing feeds two different renderers, and both must know every value.
for (const value of REFINABLE_DIMENSIONS.spacing.values) {
  const theme = themeWith({ spacing: value });
  assert(`spacing "${value}" has section padding`, typeof sectionPaddingClass(theme) === "string");
  assert(`spacing "${value}" has a content gap`, typeof contentGapClass(theme) === "string");
}

// Composition dimensions with a real lookup behind them.
for (const value of REFINABLE_DIMENSIONS.typeScale.values) {
  const theme = themeWith({ typeScale: value });
  assert(`typeScale "${value}" renders a heading scale`,
    typeof headingScaleClass(theme, "h1") === "string" && typeof headingScaleClass(theme, "h2") === "string");
}
for (const value of REFINABLE_DIMENSIONS.imageTreatment.values) {
  assert(`imageTreatment "${value}" renders an image frame`,
    typeof imageFrameClass(themeWith({ imageTreatment: value }), "rounded-md") === "string");
}

// And every rendered value is DISTINCT within its dimension — two variants that
// render identically are a vocabulary offering a choice that does nothing.
const cardRadii = REFINABLE_DIMENSIONS.cardStyle.values.map((v) => cardRadiusClass(themeWith({ cardStyle: v })));
check("each card style renders differently", new Set(cardRadii).size, cardRadii.length);
const shadows = REFINABLE_DIMENSIONS.shadowStyle.values.map((v) => shadowClass(themeWith({ shadowStyle: v })));
check("each shadow style renders differently", new Set(shadows).size, shadows.length);
const paddings = REFINABLE_DIMENSIONS.spacing.values.map((v) => sectionPaddingClass(themeWith({ spacing: v })));
check("each spacing renders differently", new Set(paddings).size, paddings.length);

// ============================================================================
console.log("\n=== 2. The vocabulary is closed ===\n");
// ============================================================================
assert("there are real dimensions", REFINABLE_DIMENSION_KEYS.length > 0);
// The tuple types make an empty list a compile error, so TypeScript rejects
// `=== 0` here as provably false. Checked at runtime anyway through a widened
// view: the literal is what ships, and a future refactor to a computed value
// would lose the type guarantee without losing this.
const valueCounts = REFINABLE_DIMENSION_KEYS.map(
  (k) => (REFINABLE_DIMENSIONS[k].values as readonly string[]).length
);
check("no dimension offers an empty choice", valueCounts.filter((n) => n === 0), []);
assert("and every one offers a real choice rather than a single option",
  valueCounts.every((n) => n >= 2),
  "a dimension with one value is not something the model can refine");
const unlabelled = REFINABLE_DIMENSION_KEYS.filter((k) => !describeDimension(k));
check("every dimension has an owner-facing name", unlabelled, []);

assert("a real dimension is recognised", isRefinableDimension("cardStyle"));
assert("an invented one is not", !isRefinableDimension("borderRadiusPx"));
assert("nor a near-miss", !isRefinableDimension("cardstyle"));
assert("nor a non-string", !isRefinableDimension(3) && !isRefinableDimension(null));
// The hasOwnProperty discipline, same as targets and scopes.
assert("nor an inherited Object property",
  !isRefinableDimension("constructor") && !isRefinableDimension("toString") &&
    !isRefinableDimension("__proto__"),
  "hasOwnProperty rather than `in`");

// ============================================================================
console.log("\n=== 3. A value belongs to its own dimension only ===\n");
// ============================================================================
assert("a real value is accepted", isValidDimensionValue("cardStyle", "rounded"));
assert("an invented one is refused", isValidDimensionValue("cardStyle", "extra-rounded") === false);
assert("and raw CSS is refused", isValidDimensionValue("cardStyle", "border-radius: 12px") === false,
  "the model never emits CSS — that is the whole rule");
assert("a non-string is refused", !isValidDimensionValue("cardStyle", 12));

// "pill" is a real value — for buttons, not cards. Cross-dimension values are
// the realistic model error, and accepting one would render nothing.
assert("a value from another dimension is refused",
  !isValidDimensionValue("cardStyle", "pill"),
  "pill is real, but it is a button style");
assert("and the reverse", !isValidDimensionValue("buttonStyle", "fullBleed"));
assert("while each is valid where it belongs",
  isValidDimensionValue("buttonStyle", "pill") && isValidDimensionValue("heroLayout", "fullBleed"));

// ============================================================================
console.log("\n=== 4. Groups, and the cap on one improvement ===\n");
// ============================================================================
check("card style is presentation", dimensionGroup("cardStyle"), "presentation");
check("hero layout is composition", dimensionGroup("heroLayout"), "composition");
const groups = new Set(REFINABLE_DIMENSION_KEYS.map(dimensionGroup));
check("every dimension is in one of the two groups",
  [...groups].sort(), ["composition", "presentation"]);

// Sean's cap: four mutations are the implementation detail of ONE idea, and the
// allowance must not be used to disguise a broader redesign.
check("one improvement may move at most four things", MAX_MUTATIONS_PER_IMPROVEMENT, 4);
assert("which is fewer than the vocabulary offers",
  MAX_MUTATIONS_PER_IMPROVEMENT < REFINABLE_DIMENSION_KEYS.length,
  "a cap equal to the vocabulary would not be a cap");

console.log(`\n${failures === 0 ? "All dimension assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
