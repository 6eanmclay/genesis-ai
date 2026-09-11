import { readFileSync } from "node:fs";
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

const REAL = officeFacts(
  {
    activeProducts: 12,
    openTasks: 0,
    opportunities: 53,
  },
  BASE,
  WORK,
);

console.log("\n=== every number is traceable ===\n");
check("every fact names its source", everyFactIsSourced(REAL));
const unsourced = REAL.filter((f) => f.source.trim().length === 0);
check("no fact has a blank source", unsourced.length === 0, unsourced.map((f) => f.label).join(", ") || "all sourced");
for (const f of REAL) console.log(`      ${String(f.value).padStart(4)}  ${f.label.padEnd(14)} ${f.source}`);

// ============ THE STRIP AND THE SECTION COUNT THE SAME THINGS =========
//
// The defect this exists to prevent, seen on a screenshot and invisible to
// every suite: the strip read "2 NEEDS YOU" directly above a section reading
// "Nothing is waiting on you right now". Both were right about their own
// meaning — the strip counted urgent observations, the section counted
// needs_owner items — and nothing forced them together.
//
// Now both derive from one list through one function, so these assertions are
// checking a property rather than a coincidence.
console.log("\n=== the strip cannot disagree with the section ===\n");
const needsYou = REAL.find((f) => f.label === "Needs you");
const decides = REAL.find((f) => f.label === "Decisions");
check("NEEDS YOU counts exactly the needs_you items",
  needsYou?.value === itemsIn(WORK, "needs_you").length,
  `strip ${needsYou?.value} vs section ${itemsIn(WORK, "needs_you").length}`);
check("DECIDE counts exactly the decide items",
  decides?.value === itemsIn(WORK, "decide").length,
  `strip ${decides?.value} vs section ${itemsIn(WORK, "decide").length}`);

// A NON-ZERO COUNT CANNOT COEXIST WITH THE EMPTY STATE. The section renders its
// empty copy when the filter is empty, so the two are the same predicate: a
// count above zero and an empty section is the contradiction itself.
check("a non-zero count means the section is NOT empty",
  (needsYou?.value ?? 0) > 0 && itemsIn(WORK, "needs_you").length > 0);
check("and it is not marked quiet", needsYou?.quiet === false, `quiet=${needsYou?.quiet}`);

// ZERO ITEMS PRODUCES THE EMPTY STATE, from the same source.
const EMPTY = { items: [{ id: "x", headline: "h", why: null, standingDays: null,
  action: { kind: "internal", because: "not owner-facing" } as OfficeAction }] };
const emptyFacts = officeFacts({ activeProducts: 0, openTasks: 0, opportunities: 0 }, BASE, EMPTY);
const emptyNeeds = emptyFacts.find((f) => f.label === "Needs you");
check("zero needs_owner items gives a zero count",
  emptyNeeds?.value === 0 && itemsIn(EMPTY, "needs_you").length === 0, `value=${emptyNeeds?.value}`);
check("and that zero is shown, marked quiet", emptyNeeds?.quiet === true, `quiet=${emptyNeeds?.quiet}`);

// AND THE COUNT LEADS WHERE THE ITEMS ARE. It pointed at the Information view,
// which cannot contain a needs_owner item — so following a non-zero count
// landed on a screen that could not show what was counted.
check("NEEDS YOU points at the surface that holds them",
  needsYou?.target.kind === "view" && needsYou.target.view === "briefing",
  needsYou?.target.kind === "view" ? needsYou.target.view : String(needsYou?.target.kind));

console.log("\n=== nothing is a score, a percentage, or a guess ===\n");
// A health score or a completion percentage is the exact shape of the invented
// metric. Neither can appear without failing here.
const banned = REAL.filter((f) => /health|score|%|percent/i.test(`${f.label} ${f.source}`));
check("no fact is a health score or a percentage", banned.length === 0, banned.map((f) => f.label).join(", ") || "none");
check("every value is a whole count", REAL.every((f) => Number.isInteger(f.value)));

console.log("\n=== a zero is shown as a zero ===\n");
// Hiding an empty count would overstate what J4 is holding. The empty state is
// information: "no decisions waiting" is a fact the owner wants.
// Tasks is the zero in this fixture now that Decisions is derived from WORK.
// The rule is unchanged: a zero renders, marked quiet, rather than hiding.
const decisions = REAL.find((f) => f.label === "Tasks");
check("a zero count still renders, marked quiet", decisions?.value === 0 && decisions?.quiet === true, `value=${decisions?.value} quiet=${decisions?.quiet}`);
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
