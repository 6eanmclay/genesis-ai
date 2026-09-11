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
import { readFileSync } from "fs";
import { approveSelection, reportFor } from "@/lib/design/referenceExecution";
import {
  presentReading,
  selectedRefinements,
} from "@/lib/design/referencePresentation";
import {
  verdictFor,
  ReferenceEligibilitySchema,
  type ReferenceKind,
} from "@/lib/design/referenceEligibility";
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

console.log("\n=== 9. Is it a design reference at all ===\n");
// ============ THE BOUNDARY THE FIRST LIVE RUN PROVED WE NEEDED ======
//
// A mascot logo produced four structurally perfect proposals - every gate
// green, zero rejected - including a button style read off the logo's own
// label. The reading was internally honest and about the wrong KIND of
// picture, which no amount of internal consistency can catch.
//
// So this is a separate question asked before the reading, and its own schema
// has no dimension field, no value field and no proposals: it cannot produce a
// design instruction even if something downstream tried to use it.
const kinds: { looksLike: ReferenceKind; expected: boolean }[] = [
  { looksLike: "website_or_app_screenshot", expected: true },
  { looksLike: "product_photo", expected: false },
  { looksLike: "logo_or_mascot", expected: false },
  { looksLike: "document_or_text", expected: false },
  { looksLike: "person_or_place", expected: false },
  { looksLike: "other", expected: false },
];
for (const k of kinds) {
  const verdict = verdictFor({ what: "a picture", looksLike: k.looksLike, confidence: "clear" });
  assert(`${k.looksLike} is ${k.expected ? "accepted" : "refused"}`,
    verdict.eligible === k.expected,
    verdict.eligible ? "eligible" : verdict.because.slice(0, 60));
}

// UNSURE IS A REFUSAL, and the asymmetry is deliberate: a wrongly refused
// screenshot costs one more upload; a wrongly accepted product photo costs a
// storefront changed on the strength of something that was never a design
// decision.
const hedged = verdictFor({ what: "a picture", looksLike: "website_or_app_screenshot", confidence: "unsure" });
assert("an unsure screenshot is refused rather than analysed",
  !hedged.eligible, hedged.eligible ? "accepted" : "refused");
assert("and the refusal says it would rather ask than guess",
  !hedged.eligible && hedged.because.includes("rather ask"), "");

// Every refusal must tell the owner what to do instead - a dead end is not an
// answer, it is a shrug.
for (const k of kinds.filter((x) => !x.expected)) {
  const verdict = verdictFor({ what: "a picture", looksLike: k.looksLike, confidence: "clear" });
  assert(`the ${k.looksLike} refusal tells them what to send instead`,
    !verdict.eligible && /screenshot/i.test(verdict.because), "");
}

// AND IT CANNOT CARRY A DESIGN INSTRUCTION. The data-shape argument, asserted
// rather than described: the schema refuses anything shaped like a proposal.
const smuggledThroughEligibility = ReferenceEligibilitySchema.safeParse({
  what: "a screenshot",
  looksLike: "website_or_app_screenshot",
  confidence: "clear",
  proposals: [{ dimension: "cardStyle", value: "sharp" }],
});
assert("the eligibility schema strips anything shaped like a proposal",
  smuggledThroughEligibility.success &&
    !("proposals" in (smuggledThroughEligibility.data as Record<string, unknown>)),
  "eligibility must not be able to produce executable values");
const inventedKind = ReferenceEligibilitySchema.safeParse({
  what: "a screenshot", looksLike: "website_but_also_a_logo", confidence: "clear",
});
assert("and a kind outside the closed list is rejected", !inventedKind.success, "");

console.log("\n=== 10. Show/Choose: what J4 saw, and what it wants to change ===\n");
// ============ THE TWO MUST NOT LOOK LIKE ONE ======================
//
// Sean: "prove that J4 can show the owner exactly what it saw and what it
// wants to change, without pretending those two things are the same."

// (1) A normal reference with actionable proposals.
const shown = presentReading(GOOD);
assert("every actionable proposal becomes a choice", shown.choices.length === 3, `${shown.choices.length}`);
assert("and each choice carries the OBSERVATION verbatim",
  shown.choices[0].saw === "The headings are much larger than the body text", shown.choices[0].saw);
assert("and the change in the store's own vocabulary",
  shown.choices[0].label === "Type scale" && shown.choices[0].value === "display",
  `${shown.choices[0].label} / ${shown.choices[0].value}`);
assert("and why the two are connected", shown.choices[0].why.length > 0, shown.choices[0].why);
// (6) Citation visible alongside: saw and change are separate fields on the
// same choice, so a card cannot render one without the other.
assert("saw and change are separate fields, not one sentence",
  shown.choices.every((c) => c.saw.length > 0 && c.value.length > 0 && c.saw !== c.value), "");

// (2) Actionable and non-actionable together.
const mixed = presentReading(beyond);
assert("an actionable observation becomes a choice", mixed.choices.length === 1, `${mixed.choices.length}`);
assert("and the unactionable ones are shown, not dropped",
  mixed.seenButUnchangeable.length === 2, mixed.seenButUnchangeable.join(" | "));
// (5) bearsOn: null is never selectable - and structurally so. They are
// strings with no index into anything, not disabled choices.
assert("an unactionable observation carries no index into the proposals",
  mixed.seenButUnchangeable.every((s) => typeof s === "string"), "");
assert("and none of them appears among the choices",
  mixed.choices.every((c) => !mixed.seenButUnchangeable.includes(c.saw)), "");

// (3) Zero actionable proposals.
const emptyReading = presentReading({
  inWords: "A staggered asymmetric grid with pinned navigation.",
  observations: [
    { id: "n1", what: "The grid is deliberately asymmetric", bearsOn: null },
    { id: "n2", what: "The navigation stays pinned while scrolling", bearsOn: null },
  ],
  proposals: [],
});
assert("a reference with nothing actionable says so", emptyReading.nothingActionable, "");
assert("offers no choices at all", emptyReading.choices.length === 0, `${emptyReading.choices.length}`);
assert("but still shows what J4 saw", emptyReading.seenButUnchangeable.length === 2, "");

// (4) Invalid proposals cannot reach the approval surface.
const invalidOnCard = presentReading({
  ...GOOD,
  proposals: [
    { dimension: "cardStyle", value: "#0A0A0A", becauseOf: "o1", soThat: "x" },
    { dimension: "buttonStyle", value: "pill", becauseOf: "o-missing", soThat: "x" },
    { dimension: "spacing", value: "spacious", becauseOf: "o1", soThat: "x" },
  ] as never,
});
assert("an invented value never becomes a choice",
  invalidOnCard.choices.every((c) => c.value !== "#0A0A0A"), JSON.stringify(invalidOnCard.choices));
assert("a proposal citing a missing observation never becomes a choice",
  invalidOnCard.choices.every((c) => c.label !== "Button style"), "");
assert("and one cited from the wrong observation never becomes a choice",
  invalidOnCard.choices.length === 0,
  `spacing cited o1, which bears on typeScale — ${invalidOnCard.choices.length} choices`);

// THE CARD AND THE EXECUTION PATH READ THE SAME LIST. The index is the link,
// so a tick resolves to the proposal the gate approved rather than to a
// parallel UI structure that could drift from it.
const everything = selectedRefinements(GOOD, shown.choices.map((c) => c.index));
assert("selecting every choice yields exactly the gate's refinements",
  JSON.stringify(everything) === JSON.stringify(refinementsFrom(GOOD)),
  JSON.stringify(everything));
const someOnly = selectedRefinements(GOOD, [0, 2]);
assert("and selecting some yields only those",
  someOnly.length === 2 && someOnly[0].dimension === "typeScale" && someOnly[1].dimension === "imageTreatment",
  JSON.stringify(someOnly));
assert("an index nobody could have been shown resolves to nothing",
  selectedRefinements(GOOD, [99, -1]).length === 0, "never to a neighbour");
assert("and the same choice ticked twice is still one refinement",
  selectedRefinements(GOOD, [1, 1]).length === 1, "");

// (7) Approving at this stage produces no mutation - a property of the code.
// These modules import nothing that can write: no prisma, no server action,
// no executable. A test that merely observed "nothing changed" would prove
// only that this run did not; this proves it cannot.
const presentationSource = readFileSync("lib/design/referencePresentation.ts", "utf8");
const cardSource = readFileSync("app/j4/ReferenceProposalCard.tsx", "utf8");
for (const [name, source] of [["referencePresentation", presentationSource], ["ReferenceProposalCard", cardSource]] as const) {
  assert(`${name} imports nothing that can write to a store`,
    !/from "@\/lib\/prisma"|prismaSystem|refineStorefront|executeExecutable|"use server"/.test(source),
    "Show/Choose must be non-mutating by construction, not by current wiring");
}
// THE CARD NOW HAS EXACTLY ONE MUTATION PATH, and this pins it there. Before
// the Execute phase it had none and this asserted an inert button; that is no
// longer the truth, so the assertion states the new boundary rather than the
// old one: one server action, reached only from the apply handler, and the
// presentation module still pure (asserted above).
assert("the card's only mutation is the explicit apply action",
  (cardSource.match(/applyReferenceDesign/g) ?? []).length === 2 &&
    !/refineStorefront|prisma/.test(cardSource),
  "approval must be one named call, not a path through the component");
assert("and it cannot name a dimension or a value",
  !/typeScale|spacious|cardStyle|dimension:/.test(cardSource),
  "the client sends indexes; the server resolves them against the gate");

console.log("\n=== 11. Approval: only what the owner ticked, resolved server-side ===\n");
// ============ THE CLIENT SENDS INDEXES, NOT CHANGES ===============
//
// A tampered request can only ever pick a different subset of what J4 actually
// proposed - it cannot introduce a dimension, a value, a bearsOn: null
// observation or an unbacked proposal, because none of those are in
// actionableProposals to be indexed at all.

const one = approveSelection(GOOD, [1]);
assert("approving one proposal executes exactly that one",
  one.approved && one.execution.refinements.length === 1 &&
    one.execution.refinements[0].dimension === "spacing",
  one.approved ? JSON.stringify(one.execution.refinements) : one.because);

const two = approveSelection(GOOD, [0, 2]);
assert("approving two executes exactly those two, once each",
  two.approved && two.execution.refinements.length === 2 &&
    two.execution.refinements[0].dimension === "typeScale" &&
    two.execution.refinements[1].dimension === "imageTreatment",
  two.approved ? JSON.stringify(two.execution.refinements) : two.because);
assert("and a deselected proposal is absent from the payload",
  two.approved && !two.execution.refinements.some((r) => r.dimension === "spacing"), "");
assert("the same index twice is still one refinement",
  (() => { const r = approveSelection(GOOD, [0, 0, 0]); return r.approved && r.execution.refinements.length === 1; })(), "");

// NOTHING IS APPROVED BY DEFAULT. An empty selection is the owner choosing
// nothing, which is a real answer - never "apply everything".
const none = approveSelection(GOOD, []);
assert("an empty selection executes nothing", !none.approved, none.approved ? "IT EXECUTED" : "refused");
assert("and says so rather than applying everything",
  !none.approved && none.because.includes("Nothing was selected"), "");

// BYPASS ATTEMPTS. Each is a real shape a tampered request could take.
const outOfRange = approveSelection(GOOD, [99]);
assert("an index outside the offered choices executes nothing",
  !outOfRange.approved, outOfRange.approved ? "IT EXECUTED" : "refused");
assert("a negative index executes nothing", !approveSelection(GOOD, [-1]).approved, "");
const mixedValid = approveSelection(GOOD, [0, 99]);
assert("a valid index alongside an invalid one applies only the valid",
  mixedValid.approved && mixedValid.execution.refinements.length === 1 &&
    mixedValid.execution.ignored.length === 1,
  mixedValid.approved ? `ignored ${JSON.stringify(mixedValid.execution.ignored)}` : mixedValid.because);

// bearsOn: null AND INVALID PROPOSALS CANNOT BE INDEXED AT ALL. `beyond` has
// two unactionable observations and one usable proposal; every index the
// client could send resolves within actionableProposals or nowhere.
const beyondApproval = approveSelection(beyond, [0, 1, 2]);
assert("bearsOn: null cannot be reached by any index",
  beyondApproval.approved && beyondApproval.execution.refinements.length === 1 &&
    beyondApproval.execution.refinements[0].dimension === "spacing",
  beyondApproval.approved ? JSON.stringify(beyondApproval.execution.refinements) : beyondApproval.because);
const invalidApproval = approveSelection({
  ...GOOD,
  proposals: [
    { dimension: "cardStyle", value: "#0A0A0A", becauseOf: "o1", soThat: "x" },
    { dimension: "spacing", value: "spacious", becauseOf: "o1", soThat: "x" },
  ] as never,
}, [0, 1]);
assert("an invented value and a mismatched citation cannot execute",
  !invalidApproval.approved, invalidApproval.approved ? "THEY EXECUTED" : "refused");

console.log("\n=== 12. The report keeps four facts apart ===\n");
// Sean: "what was requested, what was actually executed, what verification
// observed, and whether the change succeeded" - and a failure must never be
// described as a completed change. On 2026-09-05 eight executions failed and
// J4 reported "a more characterful headline font". The request became the
// report; these four fields are why it cannot again.
const failed = reportFor({ requested: ["Spacing → spacious"], executed: [], rendered: null, failure: "the value was refused" });
assert("a failed execution is not reported as done",
  !failed.succeeded && failed.executed.length === 0, JSON.stringify(failed.executed));
assert("and says so in the owner's words",
  /could not make/.test(failed.sentence) && /Nothing on your storefront has moved/.test(failed.sentence),
  failed.sentence);
assert("while still naming what was requested", failed.requested.length === 1, "");

const unseen = reportFor({ requested: ["Spacing → spacious"], executed: ["Spacing → spacious"], rendered: null });
assert("a change nobody could verify is not called verified",
  unseen.observed === null && /could not check the live page/.test(unseen.sentence), unseen.sentence);
assert("but it IS reported as executed", unseen.succeeded && unseen.executed.length === 1, "");

const notRendered = reportFor({ requested: ["Spacing → spacious"], executed: ["Spacing → spacious"], rendered: false });
assert("a change the page does not show is NOT a success",
  !notRendered.succeeded, "storage moved, the page did not");
assert("and the sentence says exactly that",
  /still not showing it/.test(notRendered.sentence), notRendered.sentence);

const verified = reportFor({ requested: ["Spacing → spacious"], executed: ["Spacing → spacious"], rendered: true });
assert("only a rendered-confirmed change claims the live page",
  verified.succeeded && verified.observed === "the rendered page shows the change" &&
    /I can see it on your live page/.test(verified.sentence),
  verified.sentence);

console.log(`\n${failures === 0 ? `ALL PASS` : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
