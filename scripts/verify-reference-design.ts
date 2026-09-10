import {
  isUsableProposal,
  unusableProposals,
  uncitedProposals,
  refinementsFrom,
  explainReading,
  misattributedProposals,
  seenButNotActionable,
  type ReferenceReading,
} from "@/lib/design/referenceObservation";
import { REFINABLE_DIMENSIONS, REFINABLE_DIMENSION_KEYS } from "@/lib/storefront/dimensions";
import {
  ReferenceReadingSchema,
  validateReading,
  vocabularyForPrompt,
} from "@/lib/design/analyzeReference";
import { referentFor } from "@/lib/design/referenceUpload";
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
// STRONGER THAN SHOWING A PLACEHOLDER. An earlier version rendered "(an
// observation that is no longer present)" on the card, which is honest but
// still puts an unbacked change in front of the owner to approve. Once the
// citation became the execution gate, such a proposal cannot execute - so it
// must not be offered either. A card the owner can approve must describe a
// change that would actually happen.
assert("and it never reaches the approval card",
  explainReading(orphaned).length === 0, `${explainReading(orphaned).length} lines`);
assert("nor the execution path",
  refinementsFrom(orphaned).length === 0, JSON.stringify(refinementsFrom(orphaned)));

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

console.log("\n=== 5. Seen, but outside the vocabulary: said, never acted on ===\n");
// ============ THE HONEST ANSWER TO A REAL OBSERVATION ============
//
// A good reference contains more design than ten dimensions have words for.
// Sean: "I would rather J4 say 'I can see this, but I can't change it yet'
// than pretend it can control something it cannot... enforced structurally,
// not just through prompting."
const beyond: ReferenceReading = {
  inWords: "A staggered, asymmetric grid with the navigation pinned to the top.",
  observations: [
    { id: "b1", what: "The product grid is deliberately asymmetric, with staggered rows", bearsOn: null },
    { id: "b2", what: "The navigation stays pinned as the page scrolls", bearsOn: null },
    { id: "b3", what: "There is a lot of air between sections", bearsOn: "spacing" },
  ],
  proposals: [
    { dimension: "spacing", value: "spacious", becauseOf: "b3", soThat: "the store breathes the way theirs does" },
  ],
};
assert("an observation outside the vocabulary is still reported to the owner",
  seenButNotActionable(beyond).length === 2, seenButNotActionable(beyond).join(" | "));
assert("and it produces no executable proposal",
  refinementsFrom(beyond).length === 1 && refinementsFrom(beyond)[0].dimension === "spacing",
  JSON.stringify(refinementsFrom(beyond)));
assert("while the one it CAN act on still goes through",
  explainReading(beyond).length === 1, `${explainReading(beyond).length} explained`);

// THE "CLOSEST AVAILABLE DIMENSION" MOVE, which is how an observation about
// photography quietly becomes a change to card corners: a real change, made
// for a stated reason that was never true.
const mapped: ReferenceReading = {
  ...beyond,
  proposals: [
    { dimension: "cardStyle", value: "sharp", becauseOf: "b1", soThat: "it feels more like their grid" },
  ],
};
assert("mapping an unactionable observation onto the nearest dimension is refused",
  misattributedProposals(mapped).length === 1, misattributedProposals(mapped).join("; "));
assert("and that proposal cannot reach the execution path",
  refinementsFrom(mapped).length === 0, JSON.stringify(refinementsFrom(mapped)));
assert("nor appear on the approval card",
  explainReading(mapped).length === 0, `${explainReading(mapped).length} lines`);

// And the subtler one: a REAL dimension, a REAL value, cited from an
// observation about something else entirely.
const swapped: ReferenceReading = {
  ...beyond,
  proposals: [
    { dimension: "buttonStyle", value: "pill", becauseOf: "b3", soThat: "it looks softer" },
  ],
};
assert("citing a spacing observation for a button change is refused",
  misattributedProposals(swapped).length === 1, misattributedProposals(swapped).join("; "));
assert("and it too cannot execute", refinementsFrom(swapped).length === 0);

console.log("\n=== 6. The vocabulary is the existing one, not a copy of it ===\n");
// A second vocabulary would not fail loudly - it would drift. So this asserts
// the module reads the live one rather than a snapshot beside it.
assert("every dimension a reading may use is a REFINABLE_DIMENSION",
  REFINABLE_DIMENSION_KEYS.every((k) => isUsableProposal({ dimension: k, value: REFINABLE_DIMENSIONS[k].values[0] })),
  `${REFINABLE_DIMENSION_KEYS.length} dimensions`);
assert("and a dimension that is not one is refused",
  !isUsableProposal({ dimension: "vibes", value: "premium" }));

console.log("\n=== 7. Model output is untrusted input ===\n");
// ============ WHAT IS PROVEN HERE, AND WHAT IS NOT =================
//
// Everything below is OFFLINE. It exercises the schema and the validator with
// readings shaped exactly like a model's output, and proves the reading cannot
// reach the approval card or the store unless it passes the same gate section
// 5 established.
//
// It does NOT prove the model behaves. Whether a real vision call classifies
// photography as `null` rather than reaching for cardStyle is a question about
// a model, answerable only by spending money on a real call against a real
// image - and asserted nowhere in this file, because a test that mimics the
// model proves only that the mimicry was written to pass.

// The schema is the first gate, and it is closed at the boundary: a dimension
// that does not exist cannot even be parsed.
const invented = ReferenceReadingSchema.safeParse({
  inWords: "x",
  observations: [{ id: "o1", what: "The grid is asymmetric", bearsOn: "gridRhythm" }],
  proposals: [],
});
assert("an invented dimension is rejected by the schema itself",
  !invented.success, invented.success ? "it parsed" : "rejected at the boundary");

// null is a first-class answer, not an error case.
const honest = ReferenceReadingSchema.safeParse({
  inWords: "A large editorial photograph with a lot of negative space.",
  observations: [{ id: "o1", what: "A large editorial photograph with substantial negative space", bearsOn: null }],
  proposals: [],
});
assert("and bearsOn: null parses as a legitimate reading",
  honest.success, honest.success ? "accepted" : JSON.stringify(honest.error?.issues?.[0]));

// THE EXACT CASE SEAN NAMED. A model that saw photography and reached for the
// nearest lever must be refused by the validator, not trusted.
const reachedForTheNearestLever = validateReading({
  inWords: "A large editorial photograph with a lot of negative space.",
  observations: [
    { id: "o1", what: "The reference uses a large editorial photograph with substantial negative space", bearsOn: null },
  ],
  proposals: [
    { dimension: "cardStyle", value: "sharp", becauseOf: "o1", soThat: "it will feel more like theirs" },
  ],
});
assert("a photography observation mapped onto cardStyle is rejected by the validator",
  reachedForTheNearestLever.rejected.length === 1, reachedForTheNearestLever.rejected.join("; "));
assert("and nothing from it is offered to the owner",
  reachedForTheNearestLever.actionable.length === 0, `${reachedForTheNearestLever.actionable.length} actionable`);
assert("while what J4 saw is still reported",
  reachedForTheNearestLever.seenOnly.length === 1, reachedForTheNearestLever.seenOnly.join(" | "));

// A partly-bad reading keeps its good half and names its bad half, rather
// than being silently trimmed to look clean.
const partly = validateReading({
  inWords: "Big headings, an asymmetric grid.",
  observations: [
    { id: "o1", what: "The headings are far larger than the body text", bearsOn: "typeScale" },
    { id: "o2", what: "The product grid is deliberately asymmetric", bearsOn: null },
  ],
  proposals: [
    { dimension: "typeScale", value: "display", becauseOf: "o1", soThat: "your headings lead the page" },
    { dimension: "sectionLayout", value: "split", becauseOf: "o2", soThat: "it feels more like their grid" },
  ],
});
assert("the well-founded proposal survives", partly.actionable.length === 1, JSON.stringify(partly.actionable));
assert("the unfounded one is named rather than dropped",
  partly.rejected.length === 1, partly.rejected.join("; "));

// And the prompt must carry the real vocabulary, not a copy that can drift.
assert("the prompt is built from the live REFINABLE_DIMENSIONS",
  REFINABLE_DIMENSION_KEYS.every((k) => vocabularyForPrompt().includes(k)),
  `${REFINABLE_DIMENSION_KEYS.length} dimensions named in the prompt`);
assert("and it states every permitted value",
  REFINABLE_DIMENSIONS.spacing.values.every((v) => vocabularyForPrompt().includes(v)),
  "a model cannot choose a value it was never shown");

console.log("\n=== 8. Which picture did they mean ===\n");
// ============ NO SECOND UPLOAD MECHANISM =========================
//
// The screenshot arrives through the ordinary chat upload and is already a
// BusinessRecord. All this decides is WHICH row "I like this website" refers
// to - and it is resolved from the record's own timestamp rather than from
// anything the model says, because a model asked to name an id will
// eventually name one that does not exist, or one belonging to another upload.
const now = new Date("2026-09-10T20:00:00Z");
const at = (mins: number) => new Date(now.getTime() - mins * 60_000);
const img = (id: string, mins: number, fileType = "image") => ({
  id, storageUrl: `https://blob.example/${id}.png`, fileType,
  originalFilename: `${id}.png`, createdAt: at(mins),
});

const newestWins = referentFor([img("older", 30), img("newest", 2), img("oldest", 55)], now);
assert("the most recent image is the one they meant",
  newestWins.found && newestWins.image.id === "newest",
  newestWins.found ? newestWins.image.id : newestWins.because);

const noImages = referentFor([img("a-contract", 5, "document")], now);
assert("a document is not a design reference",
  !noImages.found, noImages.found ? "it was accepted" : noImages.because);
assert("and the refusal tells the owner what to do",
  !noImages.found && noImages.because.includes("Upload a picture"), "");

// NOT RESOLVED TO THE NEAREST CANDIDATE. An hour-old upload is not what "this"
// means, and reading the wrong picture would produce a confident analysis of
// something the owner was not talking about.
const stale = referentFor([img("yesterday", 24 * 60)], now);
assert("an old upload is not silently treated as 'this'",
  !stale.found, stale.found ? "it was accepted" : "refused");
assert("and J4 asks rather than guessing",
  !stale.found && stale.because.includes("not sure which one you mean"), "");

const nothing = referentFor([], now);
assert("no uploads at all is refused with a reason", !nothing.found && nothing.because.length > 0,
  nothing.found ? "" : nothing.because);

console.log(`\n${failures === 0 ? `ALL PASS` : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
