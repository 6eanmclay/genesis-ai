import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  officeWork,
  needsFor,
  sectionFor,
  itemsIn,
  type OfficeSection,
  type WorkingState,
} from "@/lib/j4/officeWork";
import { ASSET_ROLES } from "@/lib/businessModel/assets";
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

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
