import { officeActionForObservation } from "@/lib/j4/officeActions";
import { sectionFor } from "@/lib/j4/officeSections";

// WHERE THE FIVE REAL PRODUCTION OBSERVATIONS LAND IN THE OFFICE.
//
// No database. These are the exact rows read out of production on 2026-09-14
// (see check-commerce-observations-production.ts), pushed through the real
// officeActionForObservation -> sectionFor path the Office itself uses, so the
// placement below is the one an owner actually gets rather than one I inferred.

// The section blurbs, verbatim from app/j4/OfficeBriefing.tsx.
const BLURB: Record<string, string> = {
  needs_you: "(needs_you) — What only the owner can provide",
  ready_to_go: "I can do these now, with what I actually have.",
  decide: "Your call. Nothing happens until you say so.",
  noticed: "I have seen these and cannot act on them yet.",
};

const PRODUCTION_ROWS = [
  {
    store: "cubit-coil",
    dedupeKey: "commerce:orders_shipped_untracked",
    genesisState: "urgent",
    actionHref: "/dashboard/orders",
    summary: "1 order is marked shipped with no tracking number, so the buyer has no way to follow it.",
  },
  {
    store: "cubit-coil",
    dedupeKey: "commerce:receipts_unsent",
    genesisState: "urgent",
    actionHref: "/dashboard/connections",
    summary:
      "11 buyers have not been sent an order confirmation — the earliest ordered 56 days ago. I cannot send them: no email provider is connected yet.",
  },
  {
    store: "beta-test-bags",
    dedupeKey: "commerce:orders_shipped_untracked",
    genesisState: "urgent",
    actionHref: "/dashboard/orders",
    summary: "1 order is marked shipped with no tracking number, so the buyer has no way to follow it.",
  },
  {
    store: "beta-test-bags",
    dedupeKey: "commerce:payment_connection_broken",
    genesisState: "urgent",
    actionHref: "/dashboard/payments",
    summary: "Your Stripe connection is not working, so this store cannot reliably take payments.",
  },
  {
    store: "beta-test-bags",
    dedupeKey: "commerce:receipts_unsent",
    genesisState: "urgent",
    actionHref: "/dashboard/connections",
    summary:
      "1 buyer has not been sent an order confirmation — the earliest ordered 42 days ago. I cannot send them: no email provider is connected yet.",
  },
];

for (const row of PRODUCTION_ROWS) {
  const action = officeActionForObservation(row, "/b/demo");
  const section = sectionFor(action);
  console.log(`\n  ${row.store} · ${row.dedupeKey.replace("commerce:", "")}`);
  console.log(`      action.kind   ${action.kind}${"label" in action ? ` ("${action.label}")` : ""}`);
  console.log(`      section       ${section}`);
  console.log(`      owner reads   "${BLURB[section ?? "?"] ?? "(none)"}"`);
}

const sections = PRODUCTION_ROWS.map((r) => sectionFor(officeActionForObservation(r, "/b/demo")));
console.log(`\n  sections used: ${[...new Set(sections)].join(", ")}`);
console.log(`  any in needs_you: ${sections.includes("needs_you")}`);
console.log(`  any in ready_to_go: ${sections.includes("ready_to_go")}`);
