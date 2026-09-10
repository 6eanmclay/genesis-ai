import {
  isUsableProposal,
  unusableProposals,
  uncitedProposals,
  refinementsFrom,
  explainReading,
  type ReferenceReading,
} from "@/lib/design/referenceObservation";
import { REFINABLE_DIMENSIONS, REFINABLE_DIMENSION_KEYS } from "@/lib/storefront/dimensions";
import { applyRefinementsToTheme } from "@/lib/execution/executables/refineStorefront";
import { DEFAULT_THEME } from "@/lib/theme";

// WHAT J4 SAW, AND WHAT J4 DECIDED, ARE DIFFERENT CLAIMS:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-reference-design.ts" -OutFile out.txt
//
// Reference Design Mode, first slice. The owner uploads a screenshot of a site
// they like; J4 reads it, says what it saw, proposes what to change, and only
// then - with approval - travels the ordinary refinement path.
//
// This suite covers the half that can be proven without a model: that the
// reading's SHAPE cannot carry a lie. The rendered half is already proven by
// verify-design-properties, which watches all eleven properties move on a real
// page; the point of reusing REFINABLE_DIMENSIONS is that an approved reading
// arrives there rather than anywhere new.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** A reading of the sort the analysis step is meant to produce. */
const GOOD: ReferenceReading = {
  inWords:
    "Restrained and editorial: very large headings against a lot of empty space, " +
    "with the product images running full width and the buttons kept quiet.",
  observations: [
    { id: "o1", what: "The headings are much larger than the body text", bearsOn: "typeScale" },
    { id: "o2", what: "There is a great deal of empty space between sections", bearsOn: "spacing" },
    { id: "o3", what: "Product images run edge to edge with no frame", bearsOn: "imageTreatment" },
  ],
  proposals: [
    { dimension: "typeScale", value: "display", becauseOf: "o1", soThat: "your headings carry the page the way theirs do" },
    { dimension: "spacing", value: "spacious", becauseOf: "o2", soThat: "the store feels unhurried rather than packed" },
    { dimension: "imageTreatment", value: "fullBleed", becauseOf: "o3", soThat: "your photography gets the room it needs" },
  ],
};

console.log("\n=== 1. A well-formed reading survives, and reaches the real path ===\n");

assert("every proposal names a real dimension and a real value",
  unusableProposals(GOOD).length === 0, unusableProposals(GOOD).join("; "));
assert("and every proposal cites an observation that exists",
  uncitedProposals(GOOD).length === 0, uncitedProposals(GOOD).join(", "));

const refinements = refinementsFrom(GOOD);
assert("it produces refinements in the shape refine_storefront already takes",
  refinements.length === 3 && refinements.every((r) => typeof r.dimension === "string" && typeof r.value === "string"),
  JSON.stringify(refinements));

// THE POINT OF REUSING THE VOCABULARY, asserted rather than asserted-about:
// the refinements go through the SAME pure transform an approved refinement
// uses, and the theme actually moves. If this ever needed its own applier,
// that would be the second design system Sean ruled out.
const before = DEFAULT_THEME;
const after = applyRefinementsToTheme(before, refinements);
assert("and applying them through the existing transform changes the theme",
  JSON.stringify(after.composition) !== JSON.stringify(before.composition) ||
    JSON.stringify(after.presentation) !== JSON.stringify(before.presentation),
  `typeScale ${after.composition?.typeScale}, spacing ${after.presentation?.spacing}, imageTreatment ${after.composition?.imageTreatment}`);
assert("specifically, each proposed value is the one now in the theme",
  after.composition?.typeScale === "display" &&
    after.presentation?.spacing === "spacious" &&
    after.composition?.imageTreatment === "fullBleed",
  `${after.composition?.typeScale} / ${after.presentation?.spacing} / ${after.composition?.imageTreatment}`);

console.log("\n=== 2. Principles out, never assets ===\n");
// ============ THE GUARDRAIL, AS A DATA SHAPE ======================
//
// J4_DESIGN_INSPIRATION.md: "The schema itself should have no field capable of
// carrying a literal asset forward; this is a data-shape decision, not an
// instruction to be careful."
//
// So the test is not "the model was told not to" - it is that a model which
// TRIED could not. Each of these is a real thing a vision model might lift off
// a screenshot, and each must be refused because it is not a member of any
// dimension's values.
const smuggled = [
  { dimension: "backgroundTreatment", value: "#0A0A0A" },
  { dimension: "typeScale", value: "Helvetica Neue" },
  { dimension: "imageTreatment", value: "https://example.com/their-hero.jpg" },
  { dimension: "heroLayout", value: "Shop the new collection" },
  { dimension: "brandColour", value: "muted earth tones" },
];
for (const attempt of smuggled) {
  assert(`a proposal of "${attempt.value.slice(0, 28)}" is refused`,
    !isUsableProposal(attempt), `${attempt.dimension} must not accept it`);
}
assert("and none of them can reach the refinements",
  refinementsFrom({ ...GOOD, proposals: smuggled.map((s) => ({ ...s, becauseOf: "o1", soThat: "x" })) as never }).length === 0,
  "an invented value must not travel the execution path");

console.log("\n=== 3. A proposal with no observation behind it is caught ===\n");
// The citation IS the owner's ability to disagree with half of a suggestion.
// An id pointing at nothing removes that without looking like it has.
const orphaned: ReferenceReading = {
  ...GOOD,
  proposals: [{ dimension: "ctaEmphasis", value: "banner", becauseOf: "o-nonexistent", soThat: "it stands out" }],
};
assert("a proposal citing an observation that does not exist is reported",
  uncitedProposals(orphaned).length === 1, uncitedProposals(orphaned).join(", "));
assert("and the explanation says so rather than inventing one",
  explainReading(orphaned)[0].saw.includes("no longer present"),
  explainReading(orphaned)[0].saw);

console.log("\n=== 4. The owner is shown saw -> recommends -> why ===\n");
const explained = explainReading(GOOD);
assert("one line per usable proposal", explained.length === 3, `${explained.length}`);
assert("each names what was SEEN, in the reference's terms",
  explained[0].saw === "The headings are much larger than the body text", explained[0].saw);
assert("and what is RECOMMENDED, in this store's terms",
  explained[0].recommends === "Type scale: display", explained[0].recommends);
assert("and why it is worth doing",
  explained[0].soThat.length > 0, explained[0].soThat);
// The chain must describe the change that will actually happen. Derived from
// the same reading the refinements come from, so it cannot drift from them.
assert("and every explained line corresponds to a real refinement",
  explained.length === refinements.length, `${explained.length} explained, ${refinements.length} applied`);

console.log("\n=== 5. The vocabulary is the existing one, not a copy of it ===\n");
// A second vocabulary would not fail loudly - it would drift. So this asserts
// the module reads the live one rather than a snapshot beside it.
assert("every dimension a reading may use is a REFINABLE_DIMENSION",
  REFINABLE_DIMENSION_KEYS.every((k) => isUsableProposal({ dimension: k, value: REFINABLE_DIMENSIONS[k].values[0] })),
  `${REFINABLE_DIMENSION_KEYS.length} dimensions`);
assert("and a dimension that is not one is refused",
  !isUsableProposal({ dimension: "vibes", value: "premium" }));

console.log(`\n${failures === 0 ? `ALL PASS` : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
