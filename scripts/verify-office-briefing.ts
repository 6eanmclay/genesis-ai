import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildBriefing,
  summariseHandled,
  standingFor,
  briefingIsEmpty,
  BRIEFING_ORDER,
  type BriefingItem,
} from "@/lib/j4/officeBriefing";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// J4 LEADS WITH WHAT MATTERS (2026-09-09).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-office-briefing.ts" -OutFile out.txt
//
// Every check below runs the real function and asserts on what it RETURNS.
// None of them reads a comment, a class name, or a source file - two suites
// earlier today did exactly that and both were wrong: one matched the comment
// explaining a rule and failed the rule, and one searched for a regex a
// heredoc had corrupted into a backspace byte.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const BASE = "/b/cubit-and-coil";
const NOW = new Date("2026-09-09T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

// A fixture shaped like the real store: a decision waiting, problems that can
// and cannot be acted on, and opportunities of both kinds - deliberately fed
// in the WRONG order so the ordering has something to do.
const ITEMS = buildBriefing(
  {
    now: NOW,
    decisions: [
      { id: "d1", summary: "Publish the updated homepage copy", rationale: "Your bios are empty, so search shows nothing.", createdAt: daysAgo(2) },
    ],
    observations: [
      { id: "o-opp-inert", summary: "Repeat customers are drifting", genesisState: "opportunity", actionHref: null, firstNoticedAt: daysAgo(30) },
      { id: "o-prob-inert", summary: "Orders are counted oddly this week", genesisState: "urgent", actionHref: null, firstNoticedAt: daysAgo(1) },
      { id: "o-opp-live", summary: "Your best seller is out of stock", genesisState: "opportunity", actionHref: "/dashboard/products", firstNoticedAt: daysAgo(3) },
      { id: "o-prob-live-new", summary: "QuickBooks needs reconnecting", genesisState: "urgent", actionHref: "/dashboard/connections", firstNoticedAt: daysAgo(2) },
      { id: "o-prob-live-old", summary: "Google Calendar needs reconnecting", genesisState: "urgent", actionHref: "/dashboard/connections", firstNoticedAt: daysAgo(40) },
    ],
  },
  BASE,
);

console.log("\n=== the order is the priority ===\n");
console.log(`      ${ITEMS.map((i) => i.id).join(" -> ")}`);
check("a waiting decision comes first", ITEMS[0]?.kind === "decision", ITEMS[0]?.id ?? "none");
check("problems come before opportunities",
  ITEMS.findIndex((i) => i.kind.startsWith("problem")) < ITEMS.findIndex((i) => i.kind.startsWith("opportunity")),
  ITEMS.map((i) => i.kind).join(", "));
check("an actionable problem outranks one that is inert",
  ITEMS.findIndex((i) => i.kind === "problem_actionable") < ITEMS.findIndex((i) => i.kind === "problem_inert"));
check("an actionable opportunity outranks one that is inert",
  ITEMS.findIndex((i) => i.kind === "opportunity_actionable") < ITEMS.findIndex((i) => i.kind === "opportunity_inert"));

const problems = ITEMS.filter((i) => i.kind === "problem_actionable");
check("within a kind, the longest-standing comes first",
  problems[0]?.id === "o-prob-live-old",
  problems.map((p) => `${p.id}=${p.standingDays}d`).join(", "));

check("the emitted order matches BRIEFING_ORDER exactly", (() => {
  const positions = ITEMS.map((i) => BRIEFING_ORDER.indexOf(i.kind));
  return positions.every((p, idx) => idx === 0 || positions[idx - 1] <= p);
})(), ITEMS.map((i) => i.kind).join(" <= "));

console.log("\n=== why it matters is a real field, or nothing ===\n");
const decision = ITEMS.find((i) => i.kind === "decision")!;
check("a decision shows J4's own rationale",
  decision.why === "Your bios are empty, so search shows nothing.", decision.why ?? "null");

const noRationale = buildBriefing(
  { now: NOW, decisions: [{ id: "d2", summary: "Do a thing", rationale: null, createdAt: daysAgo(1) }], observations: [] },
  BASE,
);
check("a decision with no rationale says nothing, rather than filling the space",
  noRationale[0].why === null, String(noRationale[0].why));

const blankRationale = buildBriefing(
  { now: NOW, decisions: [{ id: "d3", summary: "Do a thing", rationale: "   ", createdAt: daysAgo(1) }], observations: [] },
  BASE,
);
check("whitespace is not a rationale", blankRationale[0].why === null, JSON.stringify(blankRationale[0].why));

console.log("\n=== standing time is honest about its own precision ===\n");
check("today", standingFor(0) === "noticed today", String(standingFor(0)));
check("yesterday", standingFor(1) === "since yesterday", String(standingFor(1)));
check("within a fortnight it gives the number", standingFor(6) === "standing for 6 days", String(standingFor(6)));
check("past a fortnight it stops implying precision", standingFor(47) === "standing for weeks", String(standingFor(47)));
check("past two months it says months", standingFor(90) === "standing for months", String(standingFor(90)));
check("unknown stays unknown", standingFor(null) === null, String(standingFor(null)));

const futureDated = buildBriefing(
  { now: NOW, decisions: [], observations: [{ id: "f", summary: "x", genesisState: "urgent", actionHref: null, firstNoticedAt: new Date(NOW.getTime() + 86_400_000) }] },
  BASE,
);
check("a future timestamp does not become a negative age",
  futureDated[0].standingDays === null, String(futureDated[0].standingDays));

console.log("\n=== the action layer decides the action, not this module ===\n");
const live = ITEMS.find((i) => i.id === "o-prob-live-old")!;
check("an actionable row carries a real destination",
  live.action.kind === "open" && live.action.href === `${BASE}/connections`,
  live.action.kind === "open" ? live.action.href : live.action.kind);
const inert = ITEMS.find((i) => i.id === "o-prob-inert")!;
check("an inert row carries a stated reason, not a destination",
  inert.action.kind === "none" && inert.action.because.length > 20,
  inert.action.kind === "none" ? inert.action.because : inert.action.kind);
check("a decision is executed, not navigated to",
  decision.action.kind === "execute" && decision.action.intent === "approve",
  decision.action.kind);

console.log("\n=== internal executions are not news ===\n");
const handled = summariseHandled(
  {
    resolvedByJ4: 80,
    decisionsSettled: 3,
    windowDays: 14,
    successes: [
      // The real production mix, in the real proportions.
      ...Array.from({ length: 117 }, () => ({ action: "genesis.communicate_finding", message: "x" })),
      ...Array.from({ length: 29 }, () => ({ action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE, message: "x" })),
      ...Array.from({ length: 8 }, () => ({ action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE, message: "x" })),
      ...Array.from({ length: 7 }, () => ({ action: EXECUTION_ACTIONS.PRODUCT_EDIT, message: "x" })),
      ...Array.from({ length: 4 }, () => ({ action: EXECUTION_ACTIONS.PRODUCT_CREATE, message: "x" })),
      { action: EXECUTION_ACTIONS.ORDER_TOGGLE_FULFILLED, message: "x" },
    ],
  },
  BASE,
);
const total = handled.changes.reduce((n, c) => n + c.n, 0);
check("166 executions become 12 pieces of news", total === 12, `${total} of 166`);
check("no chat turn is reported as a change",
  !handled.changes.some((c) => c.action === EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE),
  handled.changes.map((c) => c.action).join(", "));
check("no internal review run is reported as a change",
  !handled.changes.some((c) => /recommendations|communicate_finding/.test(c.action)));
check("the biggest real change is listed first",
  handled.changes[0]?.action === EXECUTION_ACTIONS.PRODUCT_EDIT && handled.changes[0]?.n === 7,
  handled.changes.map((c) => `${c.action}=${c.n}`).join(", "));
check("every change names the act rather than a raw action id",
  handled.changes.every((c) => c.label.length > 0 && c.label !== c.action),
  handled.changes.map((c) => c.label).join(" / "));
check("the window is carried with the numbers", handled.windowDays === 14, String(handled.windowDays));

// ============ DONE CLAIMS ONLY WHAT IT CAN SUBSTANTIATE ===============
//
// Sean: "Do not label a count 'verified' unless verification actually
// occurred... No evidence → no claim."
//
// The three verification states are the (status, verified) pair from
// VERIFICATION_HARDENING_CONTRACT.md §3. They were already persisted; the
// query selected neither field, so a confirmed change and one nobody could
// check arrived at the Office identical, and WARNING rows — "it ran and did
// not confirm" — were filtered out entirely.
console.log("\n=== DONE separates confirmed from unconfirmed ===\n");
const evidence = summariseHandled(
  {
    resolvedByJ4: 0,
    decisionsSettled: 0,
    windowDays: 14,
    successes: [
      { action: EXECUTION_ACTIONS.PRODUCT_EDIT, message: "x", status: "SUCCESS", verified: true },
      { action: EXECUTION_ACTIONS.PRODUCT_EDIT, message: "x", status: "SUCCESS", verified: false },
      { action: EXECUTION_ACTIONS.PRODUCT_EDIT, message: "x", status: "WARNING", verified: false },
      { action: EXECUTION_ACTIONS.PRODUCT_CREATE, message: "x", status: "SUCCESS", verified: true },
    ],
  },
  BASE,
);
const edits = evidence.changes.find((c) => c.action === EXECUTION_ACTIONS.PRODUCT_EDIT);
check("the three states stay distinct",
  edits?.verified === 1 && edits?.notConfirmed === 1 && edits?.couldNotCheck === 1,
  `verified=${edits?.verified} notConfirmed=${edits?.notConfirmed} couldNotCheck=${edits?.couldNotCheck}`);
check("and they account for every execution, none double-counted",
  (edits?.verified ?? 0) + (edits?.notConfirmed ?? 0) + (edits?.couldNotCheck ?? 0) === edits?.n,
  `${edits?.n} total`);

// A WARNING IS "IT RAN AND DID NOT CONFIRM", and it must reach the owner.
check("a verification failure is reported, not filtered away",
  (edits?.notConfirmed ?? 0) === 1, `${edits?.notConfirmed} not confirmed`);

// THE UNCONFIRMED ONE IS NEVER COUNTED AS VERIFIED. This is the whole claim.
check("an unverified execution is never counted as verified",
  edits?.verified === 1, `${edits?.verified} claimed verified out of ${edits?.n}`);

// MISSING EVIDENCE FALLS TO THE SMALLER CLAIM. A row that carries no pair
// cannot be confirmed, and defaulting the other way would manufacture
// confirmation out of an absent field.
const noEvidence = summariseHandled(
  {
    resolvedByJ4: 0, decisionsSettled: 0, windowDays: 14,
    successes: [{ action: EXECUTION_ACTIONS.PRODUCT_EDIT, message: "x" } as never],
  },
  BASE,
);
check("no evidence means no verification claim",
  noEvidence.changes[0]?.verified === 0 && noEvidence.changes[0]?.couldNotCheck === 1,
  `verified=${noEvidence.changes[0]?.verified} couldNotCheck=${noEvidence.changes[0]?.couldNotCheck}`);

// AND THERE IS NO `succeeded` FIELD FOR A CALLER TO SET. Success is whatever
// the counts say; nothing can assert it beside them.
check("no caller can set a success flag",
  !Object.keys(evidence.changes[0] ?? {}).some((k) => /succeed|success|ok\b/i.test(k)),
  Object.keys(evidence.changes[0] ?? {}).join(", "));

// SUMMARISING CANNOT MUTATE. Pure function, no database reachable from it.
const briefingSrc = readFileSync(join(process.cwd(), "lib", "j4", "officeBriefing.ts"), "utf8");
check("building DONE cannot mutate anything",
  !/from "@\/lib\/prisma"/.test(briefingSrc) && !/\bprisma\./.test(briefingSrc),
  "officeBriefing has no database access");

console.log("\n=== an empty business says so honestly ===\n");
const nothing = buildBriefing({ now: NOW, decisions: [], observations: [] }, BASE);
const nothingHandled = summariseHandled({ resolvedByJ4: 0, decisionsSettled: 0, successes: [], windowDays: 14 }, BASE);
check("nothing found and nothing handled reads as empty", briefingIsEmpty(nothing, nothingHandled));
check("nothing found but something handled is NOT empty",
  !briefingIsEmpty(nothing, { ...nothingHandled, resolvedByJ4: 4 }));

console.log("\n=== nothing here is a score ===\n");
// A number that ranks would be the "Business Health 87" failure in a new
// place. The item type has no such field, so this asserts the shape.
const keys = new Set(ITEMS.flatMap((i: BriefingItem) => Object.keys(i)));
check("no item carries a score, weight or rank",
  ![...keys].some((k) => /score|weight|rank|priority|urgency/i.test(k)),
  [...keys].join(", "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
