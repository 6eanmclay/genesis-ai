import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { officeQuickActions, everyActionIsReasoned, type QuickAction } from "@/lib/j4/officeQuickActions";
import { officeFacts } from "@/lib/j4/officeFacts";

// WHAT THE OFFICE OFFERS, IT CAN ACTUALLY DO (2026-09-12):
//
//   npx tsx scripts/verify-office-quick-actions.ts
//
// ============ WHY THIS SUITE EXISTS ==================================
//
// The reference shows a row of five buttons — Analyze, Create a product, Plan
// my marketing, Review my orders, More actions. Four of those name real
// capabilities and one is an overflow that exists to balance a row. Copying
// the row would have produced a screen where some buttons work, one leads to
// an empty ledger, one cannot finish what it starts, and one means nothing.
//
// So every action is gated on a real permission AND real business state, and
// this file proves the gates rather than the labels. The two assertions that
// matter most are the last two: that every destination is somewhere that
// exists, and that this row never becomes a second copy of the fact strip.

let failures = 0;
let total = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  total++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(label: string, ok: boolean, detail = ""): void {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const root = process.cwd();
const BASE = "/b/iron-gym";
const keys = (a: QuickAction[]) => a.map((x) => x.key);

/** An owner of a real shop: products, orders, no email platform. */
const OWNER = {
  basePath: BASE,
  canManageStore: true,
  canViewOrders: true,
  activeProducts: 12,
  allTimeOrderCount: 6,
  hasCampaignSource: false,
};

// ============================================================================
console.log("\n=== 1. A permission the owner does not hold removes the action ===\n");
// ============================================================================
const noManage = officeQuickActions({ ...OWNER, canManageStore: false });
assert("without store:manage there is no Create a product", !keys(noManage).includes("create-product"), keys(noManage).join(" "));
assert("  nor Plan my marketing", !keys(noManage).includes("plan-marketing"));
assert("  but Review orders survives, because it is a different permission",
  keys(noManage).includes("review-orders"));

const noOrders = officeQuickActions({ ...OWNER, canViewOrders: false });
assert("without orders:view there is no Review orders", !keys(noOrders).includes("review-orders"), keys(noOrders).join(" "));
assert("  and the rest are untouched", keys(noOrders).includes("create-product") && keys(noOrders).includes("plan-marketing"));

// ============================================================================
console.log("\n=== 2. State the business is not in removes the action ===\n");
// ============================================================================
//
// These are the two that would otherwise be shortcuts to nothing: an order
// list with no orders in it, and a marketing plan for a shop with nothing to
// sell. Absent rather than disabled — a greyed button still claims the
// capability is nearly there.
const noSales = officeQuickActions({ ...OWNER, allTimeOrderCount: 0 });
assert("a shop that has never sold anything is not sent to its order list",
  !keys(noSales).includes("review-orders"), keys(noSales).join(" "));

const empty = officeQuickActions({ ...OWNER, activeProducts: 0 });
assert("a shop with nothing to sell is not asked to market it",
  !keys(empty).includes("plan-marketing"), keys(empty).join(" "));
assert("  and Create a product leads instead", keys(empty)[0] === "create-product", keys(empty).join(" "));
check("  saying why, from the real count", empty.find((a) => a.key === "create-product")?.because,
  "there is nothing in your catalogue yet");

// THE ORDER IS STATE, NOT A FIXED LIST.
const selling = officeQuickActions(OWNER);
assert("with orders on the books, reviewing them leads",
  keys(selling)[0] === "review-orders", keys(selling).join(" "));
check("  and the count in the reason is the real one",
  selling.find((a) => a.key === "review-orders")?.because, "6 orders have come in");
check("  one order reads as one order",
  officeQuickActions({ ...OWNER, allTimeOrderCount: 1 }).find((a) => a.key === "review-orders")?.because,
  "1 order has come in");

// ============================================================================
console.log("\n=== 3. A capability that cannot finish says so ===\n");
// ============================================================================
//
// Marketing is the one case that is offered WITH a caveat rather than hidden:
// the room genuinely works — SEO, social bios, the subscriber list — it simply
// cannot send or measure a campaign with no email platform connected. Sean's
// rule for exactly this shape: communicate the real limitation rather than
// pretending it can.
const marketing = selling.find((a) => a.key === "plan-marketing");
assert("marketing is offered", !!marketing);
assert("  and states what it cannot do yet",
  /email platform/.test(marketing?.limitation ?? ""), marketing?.limitation ?? "no limitation");
const connected = officeQuickActions({ ...OWNER, hasCampaignSource: true });
check("  and the caveat disappears once something can produce campaigns",
  connected.find((a) => a.key === "plan-marketing")?.limitation, undefined);

// ============================================================================
console.log("\n=== 4. Nothing decorative, nothing unexplained ===\n");
// ============================================================================
assert("every action says why it is on offer", everyActionIsReasoned(selling));
assert("  there is no More actions overflow",
  !selling.some((a) => /more/i.test(a.label)),
  selling.map((a) => a.label).join(" | "));
// AN OWNER WITH NOTHING AND NO PERMISSIONS still gets the one thing that is
// always true: J4 can say what it knows.
const bare = officeQuickActions({
  basePath: BASE, canManageStore: false, canViewOrders: false,
  activeProducts: 0, allTimeOrderCount: 0, hasCampaignSource: false,
});
check("the floor is J4's own account of the business", keys(bare), ["analyze-business"]);

// ============================================================================
console.log("\n=== 5. Every destination is somewhere that exists ===\n");
// ============================================================================
//
// The assertion that separates a real entry point from a label. A route is
// checked against the filesystem and a view against the Office's own union of
// categories — both read from the code rather than restated here, so a
// renamed view or a deleted route fails this rather than shipping a dead
// button.
const ALL = [...selling, ...bare, ...empty, ...noManage, ...noOrders];
const routes = [...new Set(ALL.filter((a) => a.target.kind === "route").map((a) => (a.target as { href: string }).href))];
assert("there are routes to check", routes.length > 0, routes.join(" "));
for (const href of routes) {
  const rel = href.replace(`${BASE}/`, "");
  const page = join(root, "app", "b", "[slug]", ...rel.split("/"), "page.tsx");
  assert(`  ${href} is a real route`, existsSync(page), page.replace(root, ""));
}

const workspace = readFileSync(join(root, "app", "j4", "J4Workspace.tsx"), "utf8");
const categoryLine = /type Category =([^;]+);/.exec(workspace)?.[1] ?? "";
const CATEGORIES = [...categoryLine.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
assert("the Office's real view list was found", CATEGORIES.length >= 5, CATEGORIES.join(" "));
const views = [...new Set(ALL.filter((a) => a.target.kind === "view").map((a) => (a.target as { view: string }).view))];
for (const view of views) {
  assert(`  the "${view}" view is one the Office actually has`, CATEGORIES.includes(view), CATEGORIES.join(" "));
}

// ============================================================================
console.log("\n=== 6. It never becomes a second copy of the strip ===\n");
// ============================================================================
//
// The strip is what J4 is holding — nouns, counts, evidence. These are verbs.
// If a quick action ever points where a fact already points, the Office has
// grown a second representation of the same thing, which is precisely what
// the work-list migration exists to end. Cheaper to forbid than to untangle.
const FACTS = officeFacts({ activeProducts: 12 }, BASE);
const factTargets = new Set(
  FACTS.map((f) => (f.target.kind === "route" ? `route:${f.target.href}` : `view:${f.target.view}`)),
);
const actionTargets = ALL.map((a) =>
  a.target.kind === "route" ? `route:${a.target.href}` : `view:${a.target.view}`,
);
const overlap = [...new Set(actionTargets.filter((t) => factTargets.has(t)))];
check("no quick action leads where a fact already leads", overlap, []);

// ============================================================================
console.log("\n=== 7. A shortcut never executes anything ===\n");
// ============================================================================
//
// A quick action navigates or changes the view. Running a mutation from one
// would step around the decision layer — the authority model, the approval
// record, the warrant — that four slices of work exist to keep honest.
const src = readFileSync(join(root, "lib", "j4", "officeQuickActions.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
assert("the module imports no execution machinery",
  !/from "@\/lib\/execution/.test(src) && !/execute\(/.test(src),
  "a quick action is a door, not a hand on the lever");
assert("  and no target kind exists beyond route and view",
  !/kind: "(?!route|view)/.test(src));

console.log(`\n${failures === 0 ? `ALL PASS (${total})` : `${failures} of ${total} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
