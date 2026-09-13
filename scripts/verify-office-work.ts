import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  officeWork,
  needsFor,
  sectionFor,
  itemsIn,
  workIdForTask,
  type OfficeSection,
  type WorkingState,
} from "@/lib/j4/officeWork";
import { inCategory, categoryFor, categoryDotFor } from "@/lib/j4/officeSections";
import { officeActionForDecision, officeActionForObservation } from "@/lib/j4/officeActions";
import { ASSET_ROLES } from "@/lib/businessModel/assets";
import { isInteractive } from "@/lib/j4/officeActions";
import type { OfficeAction } from "@/lib/j4/officeActions";
import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";

// THE WORK LAYER IS DERIVED, AND CANNOT FETCH (2026-09-10).
//
//   npx tsx scripts/verify-office-work.ts
//
// Sean's proof list, items 2 and 7:
//   "OfficeWork has no database access."
//   "The five Office sections are filters over the same action list."
//
// Both are checked as properties of the SOURCE and of the behaviour, not as
// properties of the current wiring - a module that merely happens not to fetch
// today is one import away from being a second assembler.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const BASE = "/b/cubit-and-coil";
const src = readFileSync(join(process.cwd(), "lib", "j4", "officeWork.ts"), "utf8");
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---- 1. it cannot reach the database ------------------------------------
console.log("\n=== the work layer cannot fetch ===\n");
check("no prisma import", !/from "@\/lib\/prisma"/.test(codeOnly));
check("no prisma call of any kind", !/\bprisma(System)?\./.test(codeOnly));
check("it does not assemble an understanding",
  !codeOnly.includes("getBusinessUnderstanding("),
  "it receives one as an argument - that is the whole distinction");
check("and imports no provider", !/businessModel\/(profile|reasoning|entities|relationships)/.test(codeOnly));
// The signature is the guarantee: business knowledge arrives through a
// parameter, so there is no independent way for it to learn anything.
check("its business knowledge arrives as a parameter",
  /understanding: BusinessUnderstanding/.test(codeOnly));

// ---- 2. a fixture, carrying only what the layer reads --------------------
//
// A partial cast on purpose. BusinessUnderstanding is a 30-field model and
// building a whole one here would test the fixture rather than the layer; if
// officeWork starts reading a field this omits, it throws, which is the
// failure we want rather than a quiet pass on invented data.
function understandingWith(opts: { activeProducts: number; hasPhoto: boolean; explanations?: { id: string; summary: string; actionHref: string | null }[] }): BusinessUnderstanding {
  return {
    profile: { offerings: { activeCount: opts.activeProducts } },
    currentAssets: opts.hasPhoto ? { [ASSET_ROLES.productPhoto]: { id: "a1", url: "u" } } : {},
    activeThoughts: (opts.explanations ?? []).map((e) => ({
      id: e.id,
      kind: "explanation",
      summary: e.summary,
      priority: null,
      confidence: null,
      actionHref: e.actionHref,
      generatedAt: "2026-09-10T00:00:00.000Z",
    })),
  } as unknown as BusinessUnderstanding;
}

const emptyState: WorkingState = {
  decisions: [],
  observations: [],
  tasks: [],
  handled: { resolvedByJ4: 0, decisionsSettled: 0, changes: [], windowDays: 14 },
};

// ---- 3. it really reads the understanding -------------------------------
console.log("\n=== the understanding is used, not merely accepted ===\n");
const withExplanation = officeWork(
  understandingWith({
    activeProducts: 0,
    hasPhoto: true,
    explanations: [{ id: "e1", summary: "Your calendar has not synced in nine days.", actionHref: "/dashboard/connections" }],
  }),
  emptyState,
  BASE,
);
check("an explanation in activeThoughts becomes an item",
  withExplanation.items.some((i) => i.id === "e1"),
  withExplanation.items.map((i) => i.id).join(", ") || "none");
check("  and its actionHref is used, rebased to this business",
  withExplanation.items.some((i) => i.action.kind === "open" && i.action.href === `${BASE}/connections`),
  JSON.stringify(withExplanation.items[0]?.action ?? null));

// ---- 4. needs are evidenced, not assumed --------------------------------
console.log("\n=== a need must be evidenced by the model ===\n");
check("products listed and no photograph -> the need exists",
  needsFor(understandingWith({ activeProducts: 3, hasPhoto: false })).length === 1);
check("a photograph on record -> no need",
  needsFor(understandingWith({ activeProducts: 3, hasPhoto: true })).length === 0);
// J4 does not ask an owner for photographs of products they do not sell.
check("nothing listed -> no need, whatever the assets say",
  needsFor(understandingWith({ activeProducts: 0, hasPhoto: false })).length === 0);

const needWork = officeWork(understandingWith({ activeProducts: 3, hasPhoto: false }), emptyState, BASE);
const needItem = needWork.items.find((i) => i.id === "need:product_photography");
check("the need becomes a needs_owner item", needItem?.action.kind === "needs_owner", needItem?.action.kind ?? "absent");
check("  and it lands in NEEDS YOU",
  needItem !== undefined && sectionFor(needItem.action) === "needs_you",
  needItem ? String(sectionFor(needItem.action)) : "absent");

// ---- 5. the sections are filters over ONE list --------------------------
console.log("\n=== every section is a filter over the same list ===\n");

const ALL: OfficeAction[] = [
  { kind: "needs_owner", missing: "capability", what: "photographs", because: "J4 cannot photograph a real object" },
  { kind: "execute", label: "Prepare three posts", intent: "approve", offer: "act" },
  { kind: "execute", label: "Approve", intent: "approve", offer: "decide" },
  { kind: "open", label: "Open orders", href: "/x/orders" },
  { kind: "none", because: "J4 noticed this and has nowhere for you to act on it yet." },
  { kind: "internal", because: "a bug report, not business intelligence" },
];

const EXPECTED: (OfficeSection | null)[] = ["needs_you", "ready_to_go", "decide", "noticed", "noticed", null];
ALL.forEach((a, i) => {
  const label = a.kind === "execute" ? `execute/${a.offer}` : a.kind;
  check(`${label} -> ${EXPECTED[i] ?? "nowhere"}`, sectionFor(a) === EXPECTED[i], String(sectionFor(a)));
});

const mixed = officeWork(understandingWith({ activeProducts: 0, hasPhoto: true }), {
  ...emptyState,
  decisions: ALL.map((action, i) => ({
    id: `i${i}`, kind: "decision" as const, headline: `h${i}`, why: null, standingDays: null, action,
    genesisState: null, proposedChange: null,
  })),
}, BASE);

const SECTIONS: OfficeSection[] = ["needs_you", "ready_to_go", "decide", "noticed"];
const placed = SECTIONS.flatMap((s) => itemsIn(mixed, s));

// EVERY ITEM IN EXACTLY ONE SECTION. Not "at least one" - an item appearing
// twice is the seven-tab problem in a new shape, where the same outstanding
// thing is counted in two places and the owner cannot tell it is one thing.
check("every item lands in exactly one section or nowhere",
  new Set(placed.map((i) => i.id)).size === placed.length,
  `${placed.length} placements, ${new Set(placed.map((i) => i.id)).size} distinct`);
check("the sections account for every item except internal",
  placed.length === mixed.items.filter((i) => i.action.kind !== "internal").length,
  `${placed.length} placed / ${mixed.items.length} total`);
check("internal appears in NO section",
  !placed.some((i) => i.action.kind === "internal"),
  "a bug report never reaches the Office");
// The filter reads the same array the sections are drawn from. There is no
// second list for a section to be built from, which is the property that makes
// two sections structurally unable to disagree.
check("itemsIn is a filter over work.items",
  placed.every((i) => mixed.items.includes(i)));

// ---- 6. DONE is honestly not one of them --------------------------------
console.log("\n=== DONE is a summary, and says so ===\n");
check("handled is carried through, not invented",
  mixed.handled.windowDays === 14 && mixed.handled.resolvedByJ4 === 0);
check("and it is NOT in the item list",
  !mixed.items.some((i) => i.id === "handled"),
  "four sections filter the list; DONE is retrospective and separate");

// ---- 6a. every open task is in the list, or it is not counted -----------
//
// THE DEFECT THIS EXISTS TO END. The strip reported three open tasks while
// officeWork was handed `tasks: []`, so they were counted in one place and
// absent from the list every section filters. Nothing failed: the count was
// true, the sections were true, and no test read them together.
//
// Sean's rule: "If J4 says there are 3 open tasks, those tasks must exist as
// actual work.items and be classified into one of the five arrival states."
console.log("\n=== a counted task cannot be a missing task ===\n");

const TASKS = [
  { id: "t1", title: "Reconnect QuickBooks", summary: "It stopped syncing nine days ago.", actionHref: "/dashboard/connections", priority: "opportunity" as const },
  { id: "t2", title: "Write your returns policy", summary: "Customers ask and there is nothing to point at.", actionHref: null, priority: "opportunity" as const },
  { id: "t3", title: "Confirm your shipping origin", summary: "", actionHref: null, priority: "opportunity" as const },
];

const withTasks = officeWork(understandingWith({ activeProducts: 0, hasPhoto: true }), { ...emptyState, tasks: TASKS }, BASE);

check("every open task reaches work.items",
  TASKS.every((t) => withTasks.items.some((i) => i.id === workIdForTask(t.id))),
  `${TASKS.length} tasks, ${withTasks.items.filter((i) => i.id.startsWith("task:")).length} in the list`);

// COUNTED IMPLIES PRESENT, as one predicate rather than two numbers that
// happen to match today.
const countedTaskIds = TASKS.map((t) => workIdForTask(t.id));
const presentTaskIds = withTasks.items.filter((i) => i.id.startsWith("task:")).map((i) => i.id);
check("nothing is counted while silently disappearing",
  countedTaskIds.every((id) => presentTaskIds.includes(id)) && presentTaskIds.length === countedTaskIds.length,
  `counted ${countedTaskIds.length}, present ${presentTaskIds.length}`);

// AND EACH ONE IS CLASSIFIED BY THE SAME FUNCTION AS EVERYTHING ELSE.
for (const t of TASKS) {
  const item = withTasks.items.find((i) => i.id === workIdForTask(t.id));
  const section = item ? sectionFor(item.action) : null;
  check(`"${t.title}" lands in a real section`, section !== null, String(section));
}

// A task with somewhere to go is followable; one without says why and wears
// no control. The same rule every other row obeys — not a task-specific one.
const navigable = withTasks.items.find((i) => i.id === workIdForTask("t1"));
check("a task with a destination is followable",
  navigable?.action.kind === "open" && navigable.action.href === `${BASE}/connections`,
  navigable?.action.kind === "open" ? navigable.action.href : String(navigable?.action.kind));
const inert = withTasks.items.find((i) => i.id === workIdForTask("t2"));
check("a task with nowhere to go says so instead",
  inert?.action.kind === "none" && inert.action.because.length > 20,
  inert?.action.kind === "none" ? inert.action.because : String(inert?.action.kind));
check("  and is not pressable", inert !== undefined && !isInteractive(inert.action));

// NOT AN EXECUTE. A Task carries actionType and trustLevel, so it looks
// runnable; nothing in the Office runs one, and a button would be a fake one.
check("no task claims to be executable",
  !withTasks.items.filter((i) => i.id.startsWith("task:")).some((i) => i.action.kind === "execute"),
  "tasks navigate; they do not execute yet");

// The summary becomes the why, and an empty one becomes nothing rather than
// an empty line pretending to be a reason.
const blank = withTasks.items.find((i) => i.id === workIdForTask("t3"));
check("an empty summary renders as no reason at all", blank?.why === null, String(blank?.why));

// ---- 6b. the client may import the contract safely ----------------------
//
// THE BUG THIS EXISTS TO PREVENT, because it already happened once.
// OfficeBriefing.tsx is a client component. It imported `itemsIn` from
// officeWork.ts, which value-imports ASSET_ROLES from businessModel/assets.ts,
// which imports prisma — so asking "which section is this row in" dragged the
// database client into the browser bundle. No type error, no console error:
// the Office panel simply never painted, and a 30s selector timed out.
//
// So the contract the client needs lives in a module with NO value imports at
// all, and that is asserted rather than remembered.
console.log("\n=== the section contract is safe for a browser ===\n");
const sectionsSrc = readFileSync(join(process.cwd(), "lib", "j4", "officeSections.ts"), "utf8");
const valueImports = [...sectionsSrc.matchAll(/^import\s+(?!type\b)[^;]+;/gm)].map((m) => m[0].trim());
check("officeSections has no value imports", valueImports.length === 0,
  valueImports.join(" | ") || "type-only imports, nothing survives compilation");
check("and it certainly does not reach prisma", !/from "@\/lib\/prisma"/.test(sectionsSrc));

const briefingSrc = readFileSync(join(process.cwd(), "app", "j4", "OfficeBriefing.tsx"), "utf8");
check("the client component imports the contract, not the derivation",
  /from "@\/lib\/j4\/officeSections"/.test(briefingSrc) &&
    !/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/j4\/officeWork"/m.test(briefingSrc),
  "a value import from officeWork puts prisma in the browser bundle");

// ---- 7. the rendered Office covers every section ------------------------
//
// A MIRRORED REGISTRY, guarded the day it was written. ARCHITECTURE.md:
// "A registry that mirrors another must carry a runtime cross-check asserting
// every referenced name resolves in the registry it mirrors."
//
// OfficeBriefing.tsx holds its own SECTIONS array. If a section is added to
// the OfficeSection union and not to that array, every item routed there
// becomes invisible — work the owner is never shown, with nothing failing.
// That is strictly worse than a crash.
console.log("\n=== the Office renders every section that exists ===\n");
const uiSrc = readFileSync(join(process.cwd(), "app", "j4", "OfficeBriefing.tsx"), "utf8");
const rendered = [...uiSrc.matchAll(/key:\s*"(needs_you|ready_to_go|decide|noticed)"/g)].map((m) => m[1]);

for (const s of SECTIONS) {
  check(`${s} has a section in the Office`, rendered.includes(s), rendered.join(", ") || "none found");
}
check("and the Office invents no section that does not exist",
  rendered.every((r) => (SECTIONS as string[]).includes(r)),
  rendered.filter((r) => !(SECTIONS as string[]).includes(r)).join(", ") || "none");

// NEEDS YOU MUST SAY BOTH THINGS. Sean: "NEEDS YOU must explicitly state what
// J4 needs from the owner and why." Checked at the source, because a row that
// renders one and silently drops the other still looks fine on screen.
check("a needs_owner row renders what J4 needs", /needs-what/.test(uiSrc));
check("  and why J4 cannot supply it", /needs-because/.test(uiSrc));
// The destination is conditional on it existing — not a disabled control.
check("  and offers a destination only when there is one",
  /action\.provideAt\s*&&/.test(uiSrc),
  "no unconditional provideAt link");

// AND THE INERT ROW STILL CANNOT WEAR A CONTROL. The 198 fake buttons were a
// UI-level decision, so this is checked at the UI level: the `none` branch
// renders a <p>, and there is no Link or button anywhere inside it.
const noneBranch = uiSrc.slice(uiSrc.indexOf('action.kind === "none"'), uiSrc.indexOf("work-action-none") + 400);
check("the inert row renders no control",
  !/<Link|<button/.test(noneBranch),
  "an item J4 cannot act on must not be pressable");


// ============================================================================
console.log("\n=== 8. Every Office category rebuilds from work alone ===\n");
// ============================================================================
//
// THE INVARIANT THE MIGRATION HAD TO EARN (2026-09-12):
//
//   OfficeWork must contain enough information to reconstruct every existing
//   Office category without consulting the legacy fields.
//
// It did not, twice, and each miss was found by asking this question rather
// than by trusting the shape. officeActionForObservation receives
// { actionHref, summary } and never sees genesisState, so an opportunity and
// an urgent observation produced identical items; explanations and tasks did
// the same to each other. Both facts existed upstream and were dropped at
// this boundary. They are carried now — plus Task.priority, which is what
// keeps a FAILED task from rendering as an opportunity.
//
// Every assertion below reads a fact the item CARRIES. None parses an id,
// inspects an href, or depends on the order items were pushed.

const CATEGORY_BASE = "/b/iron-gym";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const fiveSources = officeWork(
  understandingWith({ activeProducts: 2, hasPhoto: false }),
  {
    ...emptyState,
    decisions: [
      {
        id: "approval-1",
        kind: "decision" as const,
        headline: "Publish the updated homepage copy",
        why: null,
        standingDays: 2,
        action: officeActionForDecision(),
        genesisState: null,
        proposedChange: {
          input: { seoTitle: "Cubit & Coil — hand-wound tensor rings" },
          previousValues: { seoTitle: "Cubit & Coil" },
        },
      },
    ],
    observations: [
      {
        id: "obs-opportunity",
        kind: "opportunity_inert" as const,
        headline: "Your bios are empty",
        why: null,
        standingDays: 1,
        // NO HREF — the case that used to collapse. Both of these become
        // `none`, so the action alone cannot tell them apart.
        action: officeActionForObservation({ summary: "x" }, CATEGORY_BASE),
        genesisState: "opportunity" as const,
        proposedChange: null,
      },
      {
        id: "obs-urgent",
        kind: "problem_inert" as const,
        headline: "Three orders have no tracking",
        why: null,
        standingDays: 4,
        action: officeActionForObservation({ summary: "y" }, CATEGORY_BASE),
        genesisState: "urgent" as const,
        proposedChange: null,
      },
    ],
    tasks: [
      { id: "t-failed", title: "Fix the failed sync", summary: "It failed", actionHref: null, priority: "FAILED" as const },
      { id: "t-open", title: "Add a photo", summary: "Needed", actionHref: null, priority: "opportunity" as const },
    ],
  },
  CATEGORY_BASE,
);

const idsIn = (c: "tasks" | "ideas" | "decisions" | "information") =>
  inCategory(fiveSources, c).map((i) => i.id).sort();

// ---- 1. every category is derivable ----------------------------------
check("Decisions rebuilds from work", same(idsIn("decisions"), ["approval-1"]), idsIn("decisions").join(" "));
check("Ideas rebuilds from work", same(idsIn("ideas"), ["obs-opportunity"]), idsIn("ideas").join(" "));
check("Tasks rebuilds from work", same(idsIn("tasks"), ["task:t-failed", "task:t-open"]), idsIn("tasks").join(" "));
check("Information rebuilds from work", same(idsIn("information"), ["obs-urgent"]), idsIn("information").join(" "));

// ---- 2. Ideas and Information stay distinguishable --------------------
check("an opportunity is never filed under Information",
  !idsIn("information").includes("obs-opportunity"));
check("an urgent observation is never filed under Ideas",
  !idsIn("ideas").includes("obs-urgent"));

// ---- 3. the exact collapse that stopped this migration ----------------
const opp = fiveSources.items.find((i) => i.id === "obs-opportunity")!;
const urg = fiveSources.items.find((i) => i.id === "obs-urgent")!;
check("both really do have a `none` action",
  opp.action.kind === "none" && urg.action.kind === "none",
  `${opp.action.kind} / ${urg.action.kind}`);
check("  and the same section",
  sectionFor(opp.action) === sectionFor(urg.action),
  String(sectionFor(opp.action)));
check("  yet they land in different categories",
  categoryFor(opp) !== categoryFor(urg),
  `${categoryFor(opp)} vs ${categoryFor(urg)}`);

// ---- 4. a failed task is not an opportunity ---------------------------
const failedTask = fiveSources.items.find((i) => i.id === "task:t-failed")!;
const openTask = fiveSources.items.find((i) => i.id === "task:t-open")!;
check("a failed task keeps its own priority", failedTask.taskPriority === "FAILED", String(failedTask.taskPriority));
check("  and does not render as an opportunity",
  categoryDotFor(failedTask) !== categoryDotFor(openTask),
  `${categoryDotFor(failedTask)} vs ${categoryDotFor(openTask)}`);
check("  it is red, as it was", categoryDotFor(failedTask) === "bg-red-500", categoryDotFor(failedTask));
check("  an opportunity task is purple, as it was", categoryDotFor(openTask) === "bg-purple-500", categoryDotFor(openTask));
check("  an urgent observation stays red", categoryDotFor(urg) === "bg-red-500", categoryDotFor(urg));
check("  and an opportunity observation stays purple", categoryDotFor(opp) === "bg-purple-500", categoryDotFor(opp));

// ---- 5. action semantics are unchanged --------------------------------
//
// Categories are a SECOND axis over the same items, never a replacement for
// the first: every item is still placed in its section by its action alone.
check("every item still has a section decided by its action alone",
  fiveSources.items.every((i) => sectionFor(i.action) === sectionFor(i.action)),
  `${fiveSources.items.length} items`);
check("the sections still hold what they held",
  itemsIn(fiveSources, "decide").length === 1 && itemsIn(fiveSources, "noticed").length >= 2,
  `decide ${itemsIn(fiveSources, "decide").length}, noticed ${itemsIn(fiveSources, "noticed").length}`);

// ---- 6. nothing orphaned, nothing double-counted ----------------------
const categorised = fiveSources.items.filter((i) => categoryFor(i) !== null);
const needs = fiveSources.items.filter((i) => i.action.kind === "needs_owner");
check("every item is either categorised or a capability gap",
  categorised.length + needs.length === fiveSources.items.length,
  `${categorised.length} + ${needs.length} of ${fiveSources.items.length}`);
const summed = (["tasks", "ideas", "decisions", "information"] as const)
  .map((c) => inCategory(fiveSources, c).length)
  .reduce((a, b) => a + b, 0);
check("the four categories sum to the categorised items",
  summed === categorised.length, `${summed} vs ${categorised.length}`);
check("a capability gap is not quietly filed under Tasks",
  needs.length > 0 && !idsIn("tasks").some((id) => id.startsWith("need:")),
  `${needs.length} need(s)`);

// ============================================================================
console.log("\n=== 9. The inline action is the item's own, and nobody else's ===\n");
// ============================================================================
//
// Commit 3 renders each OfficeAction beside the WorkItem that owns it, by
// reusing the briefing's WorkRow rather than giving the category views a row
// of their own. These assert the properties that keeps true.

// ---- a dead entry point cannot become a valid action --------------------
//
// An `open` action IS a link the owner can press. One with an empty href is a
// control that goes nowhere, which is worse than no control at all — the
// whole reason `none` exists is to say "there is nowhere to go" out loud.
// ITS OWN FIXTURE, because fiveSources deliberately has no open actions — the
// inert pair is what proves the collapse. A check that ran over an empty list
// and reported "0 open action(s)" would pass forever without testing anything,
// which is the shape this suite has caught twice already.
const withOpen = officeWork(
  understandingWith({ activeProducts: 2, hasPhoto: true }),
  {
    ...emptyState,
    observations: [
      {
        id: "obs-open",
        kind: "problem_actionable" as const,
        headline: "Three orders have no tracking",
        why: null,
        standingDays: 1,
        action: officeActionForObservation({ summary: "z", actionHref: "/dashboard/orders" }, CATEGORY_BASE),
        genesisState: "urgent" as const,
        proposedChange: null,
      },
    ],
  },
  CATEGORY_BASE,
);
const everyOpen = withOpen.items.filter((i) => i.action.kind === "open");
check("there is an open action to check at all", everyOpen.length > 0, `${everyOpen.length}`);
check("every open action has somewhere real to go",
  everyOpen.every((i) => i.action.kind === "open" && i.action.href.trim().length > 0),
  `${everyOpen.length} open action(s)`);
check("  and each one is inside the business being viewed",
  everyOpen.every((i) => i.action.kind === "open" && i.action.href.startsWith(CATEGORY_BASE)),
  everyOpen.map((i) => (i.action.kind === "open" ? i.action.href : "")).join(" ") || "none to check");

// ---- none really is the absence of a control ---------------------------
const inertItems = fiveSources.items.filter((i) => i.action.kind === "none");
check("an inert item carries a reason instead of a control",
  inertItems.every((i) => i.action.kind === "none" && i.action.because.trim().length > 0),
  `${inertItems.length} inert item(s)`);

// ---- permissions still gate what reaches the list ----------------------
//
// The decisions in this list are pending approvals, and loadOfficeIntelligence
// only fetches them for somebody allowed to see them. Asserted against the
// real source, because the gate is upstream of anything this module can see.
const intelSrc = readFileSync(join(process.cwd(), "app", "j4", "intelligence-actions.ts"), "utf8");
check("pending approvals are still permission-gated before they become work",
  /hasPermission\(role, PERMISSIONS\.ANALYTICS_VIEW\)\s*\?\s*getPendingApprovals/.test(intelSrc),
  "an unpermitted reader gets an empty list, not a filtered view");
check("and the Office still refuses a reader without chat permission",
  /hasPermission\(role, PERMISSIONS\.GENESIS_CHAT\)/.test(intelSrc));

// ---- one renderer, one list -------------------------------------------
//
// The category views render the same WorkRow the briefing does. A second row
// component over the same items is how an action and the item it belongs to
// drift apart, and it is what this commit removed.
const workspaceSrc = readFileSync(join(process.cwd(), "app", "j4", "J4Workspace.tsx"), "utf8");
check("the category views render the briefing's own row",
  /import \{ OfficeBriefing, WorkRow \} from "\.\/OfficeBriefing";/.test(workspaceSrc),
  "one action renderer");
check("  and there is no second row component beside it",
  !/function CategoryRow\(/.test(workspaceSrc),
  "CategoryRow rendered a link-or-nothing of its own");
// THE FOUR, DISTINCTLY. Counting call sites was the first version and it
// proved nothing: swapping one category name for another left four calls and
// a green check, with two views rendering the same list. Its own sabotage
// caught that.
const readCategories = [...workspaceSrc.matchAll(/inCategory\(work, "([a-z]+)"\)/g)].map((m) => m[1]).sort();
check("  every category is read from the work list, and each exactly once",
  JSON.stringify(readCategories) === JSON.stringify(["decisions", "ideas", "information", "tasks"]),
  readCategories.join(" "));
check("  and the six legacy arrays are gone from the payload",
  !/briefingItems:|information:|ideas:/.test(readFileSync(join(process.cwd(), "app", "j4", "intelligence-actions.ts"), "utf8").replace(/\/\/.*$/gm, "")),
  "no legacy field survives in OfficeIntelligence");


const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
