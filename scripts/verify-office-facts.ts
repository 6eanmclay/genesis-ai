import { readFileSync } from "node:fs";
import { officeFacts, everyFactIsSourced, OFFICE_ARC } from "@/lib/j4/officeFacts";

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
const REAL = officeFacts(
  {
    activeProducts: 12,
    openTasks: 1,
    pendingDecisions: 0,
    opportunities: 53,
    needsYou: 34,
    understandingKnown: 7,
    understandingTotal: 11,
  },
  BASE,
);

console.log("\n=== every number is traceable ===\n");
check("every fact names its source", everyFactIsSourced(REAL));
const unsourced = REAL.filter((f) => f.source.trim().length === 0);
check("no fact has a blank source", unsourced.length === 0, unsourced.map((f) => f.label).join(", ") || "all sourced");
for (const f of REAL) console.log(`      ${String(f.value).padStart(4)}  ${f.label.padEnd(14)} ${f.source}`);

console.log("\n=== nothing is a score, a percentage, or a guess ===\n");
// A health score or a completion percentage is the exact shape of the invented
// metric. Neither can appear without failing here.
const banned = REAL.filter((f) => /health|score|%|percent/i.test(`${f.label} ${f.source}`));
check("no fact is a health score or a percentage", banned.length === 0, banned.map((f) => f.label).join(", ") || "none");
check("every value is a whole count", REAL.every((f) => Number.isInteger(f.value)));

console.log("\n=== a zero is shown as a zero ===\n");
// Hiding an empty count would overstate what J4 is holding. The empty state is
// information: "no decisions waiting" is a fact the owner wants.
const decisions = REAL.find((f) => f.label === "Decisions");
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
    const CATEGORIES = ["conversation", "tasks", "ideas", "decisions", "information", "understanding"];
    check(`${f.label} opens a real Office view`, CATEGORIES.includes(f.target.view), f.target.view);
  }
}

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
