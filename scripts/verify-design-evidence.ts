import {
  DESIGN_PROPERTIES, statusIsSelfConsistent, observeStatus, claimViolations,
  NO_ELEMENT, NO_VALUE, propertiesInState, type PropertyStatus,
} from "@/lib/design/designProperties";
import { designChange, designOutcome } from "@/lib/design/designChange";

// FIVE THINGS THAT MUST NOT BE POSSIBLE (2026-09-10).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-design-evidence.ts" -OutFile out.txt
//
// verify-design-properties proves the eleven properties move on a real page.
// It cannot prove the opposite: that a property which does NOT move is unable
// to be reported as if it did. Every property currently passes, so every
// failure branch in the evidence model is unexercised - and an unexercised
// branch is the one that quietly stops working.
//
// So this suite sabotages the judgement directly. `observeStatus` and
// `claimViolations` are the two functions that decide whether a design change
// is real; they live in lib/ precisely so these cases can be handed to them
// without a browser, a fixture and a payments row standing in the way.
//
// Sean named the five. Each section below is one of them, stated as the lie it
// refuses:
//
//   1. proven with no browser evidence behind it
//   2. a value that did not move, called proven
//   3. a selector pointed at the wrong thing, called proven
//   4. an element that was never there, called proven
//   5. storage changing while the render does not, called success
//
// The fifth is the original defect. The other four are the ways a verifier
// could be written that would have missed it.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** A registry entry claiming proof, with whatever evidence the caller invents. */
function claimsProven(before: string, after: string): PropertyStatus {
  return { state: "proven", before, after };
}

// ---- 1. PROVEN WITH NO BROWSER EVIDENCE --------------------------------
//
// The shape of the original bug: a claim written down by someone confident,
// with nothing behind it. Two defences, and both have to hold - the type must
// refuse a proof with no values in it, and the judge must refuse a proof the
// browser did not witness.
console.log("\n=== 1. a claim of proof with nothing behind it ===\n");

check("a proven status with empty values is not self-consistent",
  !statusIsSelfConsistent({ state: "proven", before: "", after: "" }),
  "this is exactly what the proven:boolean -> PropertyStatus conversion produced, unnoticed");

check("a proven status whose two values are equal is not self-consistent",
  !statusIsSelfConsistent(claimsProven("16px", "16px")),
  "proof of a change requires two different values");

// The browser saw nothing at all. A claim of proof over that is a claim about
// a page nobody looked at.
const sawNothing = observeStatus(NO_ELEMENT, NO_ELEMENT, false);
check("a proven claim over an unobserved page is a violation",
  claimViolations(claimsProven("Oswald", "Playfair Display"), sawNothing).length > 0,
  claimViolations(claimsProven("Oswald", "Playfair Display"), sawNothing).join("; "));

// And the subtler one: the browser DID see a change, but not the one recorded.
// The state matches; the evidence does not. A verifier comparing only states
// would pass this, which is how a stale proof outlives the thing it proved.
const sawSomethingElse = observeStatus("Oswald, sans-serif", "Lora, sans-serif", true);
check("a proven claim whose recorded values are not what rendered is a violation",
  claimViolations(claimsProven("Oswald, sans-serif", `"Playfair Display", sans-serif`), sawSomethingElse).length > 0,
  "same state, different evidence — the case a state-only comparison misses");

// ---- 2. A VALUE THAT DID NOT MOVE, CALLED PROVEN -----------------------
//
// The product ran, the measurement worked, and the page rendered the same
// thing twice. That is a defect, and it has to be reported as one - not as a
// gap, and not as a pass.
console.log("\n=== 2. a value that did not move ===\n");

const didNotMove = observeStatus("rgb(250, 250, 250)", "rgb(250, 250, 250)", false);
check("an unchanged rendered value is observed as failed, not unproven",
  didNotMove.state === "failed", didNotMove.state);
check("and never as proven",
  didNotMove.state !== "proven", "a page that rendered the same thing twice proves nothing");
check("claiming proven over it is a violation",
  claimViolations(claimsProven("rgb(250, 250, 250)", "rgb(26, 13, 46)"), didNotMove).length > 0,
  claimViolations(claimsProven("rgb(250, 250, 250)", "rgb(26, 13, 46)"), didNotMove).join("; "));

// The direction Sean named explicitly: a failure must not be downgraded into a
// gap. "unproven" reads as housekeeping; "failed" reads as the bug it is.
check("calling a failure `unproven` is itself a violation",
  claimViolations({ state: "unproven", because: "no rendered evidence yet" }, didNotMove).length > 0,
  "never silently convert failures into unproven");

// ---- 3. A SELECTOR POINTED AT THE WRONG THING --------------------------
//
// This is not hypothetical: `background` was measured on `body`, which returned
// a real, plausible colour that never moved, and the first report blamed the
// FEATURE. A wrong selector produces one of two readings, and neither may ever
// be proof.
console.log("\n=== 3. a selector pointed at the wrong element ===\n");

// (a) It resolves, and returns a real value that cannot move. Indistinguishable
//     from a defect by measurement alone - so it lands in `failed`, which is
//     the honest answer: something is wrong, and a human has to say which.
const wrongButResolving = observeStatus("rgb(250, 250, 248)", "rgb(250, 250, 248)", false);
check("a wrong-but-resolving selector cannot produce proof",
  wrongButResolving.state !== "proven", wrongButResolving.state);

// (b) The trap that nearly shipped. `.design-section` exists only on the
//     `split` layout, so a mutation TO split makes the element appear - and an
//     appearance looks exactly like a change. It is not one: there is no
//     before to compare against.
const appearedFromNowhere = observeStatus(NO_ELEMENT, "221.328px 442.672px", true);
check("an element that only appears after the mutation is not a proven change",
  appearedFromNowhere.state === "unproven", appearedFromNowhere.state);
check("and the reverse — an element that vanishes — is not one either",
  observeStatus("221.328px 442.672px", NO_ELEMENT, true).state === "unproven",
  "a disappearing element is a measurement that stopped working, not a proof");

// (c) The selector resolves but the property is not one that element carries,
//     so the read comes back empty. Empty is not a value and cannot differ.
check("an empty read is unproven even when the two reads differ",
  observeStatus(NO_VALUE, "6px", true).state === "unproven",
  "getPropertyValue('fontFamily') returned exactly this for eleven properties once");

// ---- 4. AN ELEMENT THAT WAS NEVER THERE --------------------------------
//
// Three properties read NO ELEMENT for two full runs because the fixture had
// no payments row and no hero image. Nothing was known about them either way,
// and the one thing that must never happen is that silence being read as
// either a pass or a defect.
console.log("\n=== 4. an element that was never there ===\n");

const neverThere = observeStatus(NO_ELEMENT, NO_ELEMENT, false);
check("a missing element is observed as unproven", neverThere.state === "unproven", neverThere.state);
check("never as proven", neverThere.state !== "proven", "silence is not evidence");
check("and never as failed either",
  neverThere.state !== "failed",
  "a fixture too bare to show a property says nothing about the product");
check("claiming proven over a missing element is a violation",
  claimViolations(claimsProven("rgb(24, 24, 27)", "rgb(255, 107, 53)"), neverThere).length > 0,
  claimViolations(claimsProven("rgb(24, 24, 27)", "rgb(255, 107, 53)"), neverThere).join("; "));

// `incapable` is the one claim a page cannot be asked to reproduce - but it can
// still be contradicted, by the property moving.
const moved = observeStatus("16px", "6px", true);
check("a property claimed incapable that visibly moves is a violation",
  claimViolations({ state: "incapable", because: "no executable can mutate this" }, moved).length > 0,
  claimViolations({ state: "incapable", because: "no executable can mutate this" }, moved).join("; "));
check("but incapable over a page that did not move is not a violation",
  claimViolations({ state: "incapable", because: "no executable can mutate this" }, neverThere).length === 0,
  "incapable is a statement about the executables, not a prediction about pixels");

// ---- 5. STORAGE CHANGED, THE RENDER DID NOT ----------------------------
//
// The original defect, and still the most dangerous case: update_theme wrote
// the font, read it back, found it correct, and reported success for months
// while the rendered page never changed. Reading back what was written proves
// persistence, not effect.
console.log("\n=== 5. storage changed and the page did not ===\n");

const storedChange = designChange({ group: "typography", field: "headingFont" }, "Oswald", "Playfair Display");
check("the stored value really did change (so this is not a trivial pass)",
  storedChange.changed, `${storedChange.before} -> ${storedChange.after}`);

const withNoRender = designOutcome({ executed: true, change: storedChange, rendered: false });
check("a successful write with a page that did not move is NOT verified",
  withNoRender.state !== "verified", withNoRender.state);
check("it is reported as failed",
  withNoRender.state === "failed", withNoRender.state);
check("and the owner is told the page is not showing it",
  /not showing it/.test(withNoRender.report), withNoRender.report.slice(0, 90));

// The honest middle: no render check could run. That is not proof either, and
// it must not be quietly promoted to one.
const unchecked = designOutcome({ executed: true, change: storedChange, rendered: null });
check("an unchecked render is not verified either",
  unchecked.state === "changed_but_unverified", unchecked.state);

// And the same rule stated in the registry's own vocabulary: a write that
// round-trips perfectly, over a page whose rendered value is identical, is a
// failed verification.
check("in the registry's terms, the same case is failed",
  observeStatus("Oswald, sans-serif", "Oswald, sans-serif", false).state === "failed",
  "persistence proved, effect disproved");

// ---- THE REGISTRY AS IT STANDS -----------------------------------------
//
// Not a sabotage - a statement of where the eleven properties actually are, so
// this suite fails if someone adds a property and never measures it.
console.log("\n=== where the registry stands ===\n");
for (const state of ["proven", "failed", "measured", "unproven", "incapable"] as const) {
  const keys = propertiesInState(state);
  if (keys.length > 0) console.log(`  ${state.padEnd(10)} ${keys.join(", ")}`);
}
check("every registered property carries a self-consistent status",
  Object.values(DESIGN_PROPERTIES).every((r) => statusIsSelfConsistent(r.status)),
  `${Object.keys(DESIGN_PROPERTIES).length} properties`);
check("no property is left in a state that carries no evidence at all",
  propertiesInState("measured").length === 0,
  "`measured` means a value was read but no before/after was ever run");

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
