import { readFileSync } from "node:fs";
import { join } from "node:path";
import { officeFacts, everyFactIsSourced, OFFICE_ARC } from "@/lib/j4/officeFacts";
import { itemsIn } from "@/lib/j4/officeSections";
import type { OfficeAction } from "@/lib/j4/officeActions";

// NO NUMBER IN THE OFFICE CAME FROM NOWHERE (2026-09-09).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-office-facts.ts" -OutFile out.txt
//
// The Office references show "Business Health 87", "Customers 2,340",
// "Financials $117.63" and a "J4 is analyzing your business... 68%" bar. Sean
// had already ruled on that class of thing: "Remove invented metrics such as
// 'Business Health 87' unless there is an actual underlying calculation and
// source." This is that ruling, held to by the compiler and by these checks
// rather than by my memory of it.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const BASE = "/b/cubit-and-coil";

/**
 * The work list the strip and the sections both read.
 *
 * Two needs_owner items and one decision, so the two derived counts are
 * non-trivial and a mismatch would show.
 */
const WORK = {
  items: [
    { id: "n1", headline: "photographs", why: null, standingDays: null,
      action: { kind: "needs_owner", missing: "capability", what: "photographs", because: "J4 cannot photograph a real object" } as OfficeAction },
    { id: "n2", headline: "positioning", why: null, standingDays: null,
      action: { kind: "needs_owner", missing: "decision", what: "how you want to be positioned", because: "yours to settle" } as OfficeAction },
    { id: "d1", headline: "publish copy", why: null, standingDays: null,
      action: { kind: "execute", label: "Approve", intent: "approve", offer: "decide" } as OfficeAction },
    { id: "o1", headline: "reconnect", why: null, standingDays: null,
      action: { kind: "open", label: "Open", href: "/x" } as OfficeAction },
    { id: "i1", headline: "internal", why: null, standingDays: null,
      action: { kind: "internal", because: "a bug report" } as OfficeAction },
  ],
};

const REAL = officeFacts({ activeProducts: 12 }, BASE);

console.log("\n=== every number is traceable ===\n");
check("every fact names its source", everyFactIsSourced(REAL));
const unsourced = REAL.filter((f) => f.source.trim().length === 0);
check("no fact has a blank source", unsourced.length === 0, unsourced.map((f) => f.label).join(", ") || "all sourced");


for (const f of REAL) console.log(`      ${String(f.value).padStart(4)}  ${f.label.padEnd(14)} ${f.source}`);

// ============ THE STRIP CANNOT COUNT WHAT A DESTINATION OWNS ==========
//
// THE RULE, AND NOT A LIST OF BANNED WORDS (2026-09-13).
//
// Sean: "If a fact is already owned and counted by an Office destination
// directly below, the summary strip does not count it again."
//
// The previous version of this section asserted that the strip's NEEDS YOU
// equalled `itemsIn(WORK, "needs_you").length`. That was a true property and
// it fixed the original defect — a strip reading "2 NEEDS YOU" above a section
// reading "Nothing is waiting on you right now" — by making both derive from
// one list. What it could not see is that agreeing is not the same as being
// worth saying twice. The count is gone, so the agreement is not a property
// of anything any more; the rule that replaced it is below.
//
// An Office destination is a `view` target. Everything else is a `route` to
// another room. So the rule has an exact, checkable shape.
console.log("\n=== the strip does not count what a destination owns ===\n");
const viewFacts = REAL.filter((f) => f.target.kind === "view");
check("no strip fact points at an Office view",
  viewFacts.length === 0,
  viewFacts.map((f) => `${f.label} -> ${f.target.kind === "view" ? f.target.view : ""}`).join(", ") || "every fact leads out of the Office");
check("  which is what stops it counting a section's population",
  !REAL.some((f) => /needs you|opportunit|idea|decision|task/i.test(f.label)),
  REAL.map((f) => f.label).join(" | "));
// AND THE WORK LIST IS NO LONGER REACHABLE FROM HERE AT ALL. officeFacts took
// the work list only to derive that count; with it gone the module has no
// imports left. A future fact that needed the work list would be a fact a
// destination already owns, which is the rule above stated as a dependency.
const factsModule = readFileSync(join(process.cwd(), "lib", "j4", "officeFacts.ts"), "utf8");
check("officeFacts imports nothing from the work layer",
  !/^import\s/m.test(factsModule),
  "the strip is business facts; the work list is the work list");

// ============================================================================
console.log("\n=== the strip no longer counts what a tab owns (2026-09-12) ===\n");
// ============================================================================
//
// Sean, after the vocabulary investigation: the strip should stop duplicating
// counts that already belong to the Office views. Three of its five facts —
// Opportunities, Decisions, Tasks — were destinations with their own counts
// forty pixels below, and the same population was called "Opportunities"
// above and "Ideas" below.
//
// AND THEN NEEDS YOU WENT TOO (2026-09-13). It was the survivor of that pass
// and the clearest case of the lot: "Needs you 0" directly above a section
// headed NEEDS YOU saying nothing was waiting. Deriving both from one list
// made them agree; agreeing is not a reason to say it twice.
//
// What is left is the one fact no Office destination owns. The strip does not
// need five slots, or two, and nothing was invented to keep them.
check("the strip is exactly the one fact no destination owns",
  JSON.stringify(REAL.map((f) => f.label)) === JSON.stringify(["Products"]),
  REAL.map((f) => f.label).join(" | "));
check("  no fact counts a population a destination owns",
  !REAL.some((f) => /needs you|opportunit|idea|decision|task/i.test(f.label)),
  REAL.map((f) => f.label).join(" | "));
// CODE, NOT THE PROSE ABOUT IT — the mistake this file records two sections
// below and then made anyway. This scanned the raw source for "Opportunit",
// and the history note explaining WHY Opportunities was removed put the word
// back in the file, so the explanation of the rule failed the rule. Comments
// stripped first, like every other source scan here.
const factsProseFree = readFileSync(join(process.cwd(), "lib", "j4", "officeFacts.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
check("  and the owner-facing word for that category is never Opportunities",
  !/Opportunit/.test(factsProseFree),
  "Opportunity belongs to CognitiveOutput's own label on the activity feed");

// THE PARALLEL POPULATION IS GONE, not merely unused. The count came from
// `observations.filter(o => o.genesisState === "opportunity")` — the raw rows,
// before officeWork — while the Ideas tab counted work.items. One predicate,
// two paths, agreeing by coincidence.
const intelSource = readFileSync(join(process.cwd(), "app", "j4", "intelligence-actions.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
check("no second population is computed for a category count",
  !/observations\.filter\(/.test(intelSource),
  "the strip's opportunities count was the last raw-observation read");
// CODE, NOT THE COMMENTS ABOUT IT. officeFacts' own header still explains what
// the strip used to carry, and it should — the history is why the field is
// gone. The assertion is about the type.
const factsCode = readFileSync(join(process.cwd(), "lib", "j4", "officeFacts.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
check("  and officeFacts cannot be handed one",
  !/opportunities|openTasks/.test(factsCode),
  "OfficeFactInput no longer has a field to pass a parallel count through");

// THE SECTION STILL OWNS ITS OWN COUNT, and that is why the strip can stop
// saying it. Read from the same `itemsIn` the section renders with — the
// population did not move, only the place it is counted.
check("NEEDS YOU is still a real, countable population",
  itemsIn(WORK, "needs_you").length === 2,
  `${itemsIn(WORK, "needs_you").length} needs_owner items in the fixture`);
check("  and no strip fact is counting it",
  !REAL.some((f) => f.value === itemsIn(WORK, "needs_you").length && /needs/i.test(f.label)),
  REAL.map((f) => `${f.label}=${f.value}`).join(" | "));

// ZERO IS STILL SHOWN AS ZERO, on the fact that remains.
const emptyFacts = officeFacts({ activeProducts: 0 }, BASE);
const emptyProducts = emptyFacts.find((f) => f.label === "Products");
check("a catalogue with nothing in it gives a zero count",
  emptyProducts?.value === 0, `value=${emptyProducts?.value}`);
check("and that zero is shown, marked quiet", emptyProducts?.quiet === true, `quiet=${emptyProducts?.quiet}`);

console.log("\n=== nothing is a score, a percentage, or a guess ===\n");
// A health score or a completion percentage is the exact shape of the invented
// metric. Neither can appear without failing here.
const banned = REAL.filter((f) => /health|score|%|percent/i.test(`${f.label} ${f.source}`));
check("no fact is a health score or a percentage", banned.length === 0, banned.map((f) => f.label).join(", ") || "none");
check("every value is a whole count", REAL.every((f) => Number.isInteger(f.value)));

console.log("\n=== a zero is shown as a zero ===\n");
// Hiding an empty count would overstate what J4 is holding. The empty state is
// information: "no decisions waiting" is a fact the owner wants.
// THE ZERO MOVED TWICE, AND THE RULE DID NOT (2026-09-13). Tasks was the zero
// in this fixture, then Needs you; both are now owned by their destinations.
// It is proven on the one fact that remains, which is the only one that can
// still be zero. The rule is unchanged: a zero renders, marked quiet, rather
// than hiding, because "nothing in your catalogue" is information.
check("a zero count still renders, marked quiet",
  emptyProducts?.value === 0 && emptyProducts?.quiet === true,
  `value=${emptyProducts?.value} quiet=${emptyProducts?.quiet}`);
const products = REAL.find((f) => f.label === "Products");
check("a non-zero count is not quiet", products?.quiet === false, `quiet=${products?.quiet}`);

console.log("\n=== every fact leads somewhere real ===\n");
for (const f of REAL) {
  if (f.target.kind === "route") {
    check(`${f.label} routes inside this business`, f.target.href.startsWith(BASE), f.target.href);
  } else {
    // A view must be a category this surface actually has, or the click does
    // nothing — the dead-row problem in a new place.
    const CATEGORIES = ["briefing", "conversation", "tasks", "ideas", "decisions", "information", "understanding"];
    check(`${f.label} opens a real Office view`, CATEGORIES.includes(f.target.view), f.target.view);
  }
}

// "KNOWN" IS GONE FROM THE STRIP, on purpose (2026-09-09). Its number came
// from getBusinessUnderstanding - 921ms measured against production - so
// rendering it here meant paying the Office's most expensive read for one
// figure. It moved into the Understanding view, which loads on demand. This
// asserts the move rather than trusting it: an edit that put it back would
// silently restore 921ms to the critical path.
check("no fact requires the 921ms understanding read",
  !REAL.some((f) => /known/i.test(f.label)),
  REAL.map((f) => f.label).join(", "));

console.log("\n=== the Office band matches the locked decisions ===\n");
// COMMENTS STRIPPED FIRST, and the reason is a bug this suite already had.
//
// The first version scanned the raw file, and OfficeBand's own doc comment
// EXPLAINS that it deliberately excludes "Business Health 87" and "Search
// anything in your business" — so the explanation of the rule failed the rule.
// That is the same mistake as verify-j4-artwork matching a comment naming the
// retired face file: a test that reads prose measures my writing, not the
// product. Only code can render, so only code is scanned.
const bandSource = readFileSync("app/j4/OfficeBand.tsx", "utf8");
const band = bandSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// These three were named by Sean and then reappeared in the reference artwork.
// Asserted against the component so the reference cannot quietly win later.
check("the Office has no invented health score", !/Business Health|\b87\b/.test(band));
check("the Office claims no search it does not have", !/Search anything/i.test(band));
check("the Office builds no sixteen-item rail", !/Overview|Strategy|Upgrade/.test(band));
check("stripping comments left real code to scan", band.includes("office-facts"), `${band.length} chars of code`);
check("the arc is the one from the direction", OFFICE_ARC.join(" ") === "Plan Create Execute Grow", OFFICE_ARC.join(" › "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
