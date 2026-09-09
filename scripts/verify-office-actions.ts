import { existsSync } from "node:fs";
import {
  officeActionForExecution,
  officeActionForExplanation,
  officeActionForObservation,
  officeActionForDecision,
  ownerFacingDestinations,
  internalActions,
  isInteractive,
  rowInteractionClass,
  offersHover,
  type OfficeAction,
} from "@/lib/j4/officeActions";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// NOTHING THE OWNER CAN SEE PRETENDS TO BE PRESSABLE (2026-09-09).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-office-actions.ts" -OutFile out.txt
//
// Sean: "Do not make fake buttons just to make the UI look interactive. Every
// actionable item needs a real destination or real execution path. If an item
// genuinely cannot be acted upon yet, make that state explicit rather than
// pretending it is interactive."
//
// This is a code-only suite on purpose. The decision it checks used to be
// reachable only by loading the Office in a browser and tapping rows, which is
// how 198 dead rows survived in production unnoticed. Moved into lib/, the
// real production sequence is three lines.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const BASE = "/b/cubit-and-coil";

// ---- 1. every destination is a route that actually exists ---------------
//
// The one rule needsAttention.ts already states in prose — "inventing a link
// to a screen that does not exist would be worse than an imperfect one" — held
// to by the filesystem rather than by care.
console.log("\n=== every destination is a real route ===\n");
for (const d of ownerFacingDestinations()) {
  const segment = d.section.replace(/^\/dashboard/, "");
  const routeFile = `app/b/[slug]${segment}/page.tsx`;
  check(`${d.action} -> ${d.section}`, existsSync(routeFile), existsSync(routeFile) ? "route exists" : `MISSING ${routeFile}`);
}

// ---- 2. every destination tells the owner what they are about to do -----
console.log("\n=== every destination names the act ===\n");
const vague = ownerFacingDestinations().filter((d) => /^(view|click|go|here|more)$/i.test(d.label.trim()));
check("no label is a bare 'View'/'Click here'", vague.length === 0, vague.map((v) => v.label).join(", ") || "all labels name an act");

// ---- 3. the internal rows never reach the owner -------------------------
//
// These are the exact actions behind the dead rows measured in production.
console.log("\n=== internal execution rows are not business intelligence ===\n");
const MUST_BE_INTERNAL: [string, string][] = [
  [EXECUTION_ACTIONS.STORE_REFINE_STOREFRONT, '"warm cream base with copper-toned section bands" is not a real option for Background treatment.'],
  [EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE, "Starting opportunistic business review"],
  [EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE, "I've drafted that for you."],
];
for (const [action, message] of MUST_BE_INTERNAL) {
  const a = officeActionForExecution({ action, message }, BASE);
  check(`${action} is internal`, a.kind === "internal", a.kind === "internal" ? a.because.slice(0, 62) : `LEAKED as ${a.kind}`);
}

const rawProviderError = officeActionForExecution(
  { action: "provider.unknown.error", message: 'Provider error (billing): 400 {"type":"error","error":{"type":"invalid_request_error"}}' },
  BASE,
);
check("an unmapped action defaults to internal, not to the owner",
  rawProviderError.kind === "internal",
  rawProviderError.kind === "internal" ? "raw provider JSON stays out of the Office" : `LEAKED as ${rawProviderError.kind}`);

// ---- 4. the real ones get a real destination ----------------------------
console.log("\n=== the genuinely owner-facing rows lead somewhere ===\n");
const REAL: [string, string][] = [
  [EXECUTION_ACTIONS.INTEGRATION_GOOGLE_CALENDAR_SYNC, `${BASE}/connections`],
  [EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_SYNC, `${BASE}/connections`],
  [EXECUTION_ACTIONS.CHECKOUT_PAYPAL_CAPTURE, `${BASE}/orders`],
  [EXECUTION_ACTIONS.INTEGRATION_STRIPE_VERIFY, `${BASE}/payments`],
];
for (const [action, expected] of REAL) {
  const a = officeActionForExecution({ action, message: "x" }, BASE);
  check(`${action} -> ${expected}`, a.kind === "open" && a.href === expected, a.kind === "open" ? a.href : a.kind);
}

// ---- 5. the destination follows the business being looked at ------------
//
// The legacy "/dashboard/..." spelling resolves the ACCOUNT'S ACTIVE business,
// so a row followed without rebasing could move the owner into a DIFFERENT
// business than the Office they are standing in. J4Surface documents this
// hazard for Decisions; it applies to every row.
console.log("\n=== a row cannot move the owner to another business ===\n");
const other = officeActionForExecution({ action: EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_SYNC, message: "x" }, "/b/iron-gym");
check("the same row rebases per business",
  other.kind === "open" && other.href === "/b/iron-gym/connections",
  other.kind === "open" ? other.href : other.kind);
const legacy = officeActionForExecution({ action: EXECUTION_ACTIONS.INTEGRATION_QUICKBOOKS_SYNC, message: "x" }, "/dashboard");
check("the legacy base is left alone",
  legacy.kind === "open" && legacy.href === "/dashboard/connections",
  legacy.kind === "open" ? legacy.href : legacy.kind);

// ---- 6. an inert row states its reason ----------------------------------
console.log("\n=== nothing is inert AND silent ===\n");
const explained = officeActionForExplanation({ actionHref: null }, BASE);
check("an explanation with no destination says why",
  explained.kind === "none" && explained.because.length > 20,
  explained.kind === "none" ? explained.because : explained.kind);

const explainedWithHref = officeActionForExplanation({ actionHref: "/dashboard/finances" }, BASE);
check("an explanation that HAS a destination uses it",
  explainedWithHref.kind === "open" && explainedWithHref.href === `${BASE}/finances`,
  explainedWithHref.kind === "open" ? explainedWithHref.href : explainedWithHref.kind);

const observed = officeActionForObservation({ actionHref: null, summary: "s" }, BASE);
check("an observation with no destination says why",
  observed.kind === "none" && observed.because.length > 20,
  observed.kind === "none" ? observed.because : observed.kind);

const everyReasonIsWritten = ([] as OfficeAction[])
  .concat(explained, observed, ...MUST_BE_INTERNAL.map(([a, m]) => officeActionForExecution({ action: a, message: m }, BASE)))
  .every((a) => (a.kind === "none" || a.kind === "internal" ? a.because.trim().length > 0 : true));
check("no reason is blank", everyReasonIsWritten);

// ---- 7. a decision is decided, not navigated to -------------------------
console.log("\n=== a decision carries a real execution ===\n");
const decision = officeActionForDecision();
check("a decision offers approve and reject",
  decision.length === 2 && decision.every((d) => d.kind === "execute"),
  decision.map((d) => (d.kind === "execute" ? `${d.label}/${d.intent}` : d.kind)).join(", "));

// ---- 8. the type itself forbids the fake button -------------------------
console.log("\n=== only a real action is interactive ===\n");
check("open is interactive", isInteractive({ kind: "open", label: "x", href: "/y" }));
check("execute is interactive", isInteractive({ kind: "execute", label: "x", intent: "approve" }));
check("none is NOT interactive", !isInteractive({ kind: "none", because: "x" }));
check("internal is NOT interactive", !isInteractive({ kind: "internal", because: "x" }));

// ---- 9. the fake button is now unrepresentable --------------------------
//
// The actual regression, guarded at the point the decision is made. 198 rows
// wore `hover:bg-white/[.04]` with nothing behind them because the class was
// written once and used on both branches of CategoryRow.
console.log("\n=== an inert row cannot wear a hover ===\n");
const INERT: OfficeAction[] = [
  { kind: "none", because: "nothing yet" },
  { kind: "internal", because: "not owner-facing" },
];
for (const a of INERT) {
  const cls = rowInteractionClass(a);
  check(`${a.kind} gets no hover affordance`, !offersHover(cls), cls);
}
const liveClass = rowInteractionClass({ kind: "open", label: "Reconnect", href: "/x" });
check("a followable row DOES get one", offersHover(liveClass), liveClass);
check("execute gets one too", offersHover(rowInteractionClass({ kind: "execute", label: "Approve", intent: "approve" })));

// ---- 10. the two lists cannot both claim an action ----------------------
const overlap = ownerFacingDestinations().filter((d) => internalActions().includes(d.action));
check("no action is both owner-facing and internal", overlap.length === 0, overlap.map((o) => o.action).join(", ") || "disjoint");

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
