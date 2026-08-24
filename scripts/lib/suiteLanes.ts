import { readFileSync } from "fs";
import { join } from "path";

// WHICH LANE A VERIFICATION SUITE BELONGS IN.
//
// EXTRACTED FROM run-db-suites.ts, 2026-08-24, unchanged. It lived there while
// the runner was its only caller. verification-inventory.ts is now a second
// caller, and the runner self-executes on import — so the choice was to copy
// this decision or to move it.
//
// Copying it would have been the worse of the two by a distance. The inventory
// exists to be the authoritative answer to "what do we actually run", and an
// inventory that RE-DERIVES the runner's decision is wrong the moment somebody
// adds an exclusion to one file and not the other. It would then report
// confidently about suites nothing was running. One function, one answer, both
// callers.
//
// This is the same rule ARCHITECTURE.md already states for codeOnly: move it to
// scripts/lib the moment a second consumer needs it, rather than pasting it.

export const SCRIPTS_DIR = join(process.cwd(), "scripts");

export function needsDatabase(file: string): boolean {
  const source = readFileSync(join(SCRIPTS_DIR, file), "utf8");
  if (file === "run-db-suites.ts") return false;

  // A SUITE THAT BRINGS ITS OWN DATABASE IS NOT THIS RUNNER'S TO RUN, and this
  // is read from the source rather than from the list below (2026-08-22).
  //
  // Everything named in that list for this reason — the browser suites, the
  // live-Postgres ones — shares one detectable property: it imports
  // startTestServer or startRealPostgres. The list is hand-maintained, so
  // verify-mobile-reliability.ts was added without an entry and ran here for a
  // day, passing by luck against a harness DATABASE_URL it ignores, until it
  // failed on a browser assertion that passes perfectly well standalone. That
  // is a false failure reported against code with nothing wrong with it, which
  // is the most expensive kind.
  //
  // Detecting the property removes the whole category from the list rather than
  // adding one more line to it — the same list-versus-sweep lesson the currency
  // guard learned the hard way.
  if (/startTestServer|startRealPostgres/.test(source)) return false;
  // Suites that bring their own database must not be run twice here.
  if (file === "verify-db-integrity.ts" || file === "verify-ledger-live.ts") return false;
  // verify-order-webhook-live.ts brings a real Postgres AND a real Next server,
  // and PostgreSQL refuses to start under an administrator account. It has its
  // own entry point for that reason:
  //
  //   powershell -File scripts/run-unelevated.ps1   //     -Command "npx tsx scripts/verify-order-webhook-live.ts" -OutFile out.txt
  //
  // Running it from here would fail for a reason that has nothing to do with
  // the code under test.
  if (file === "verify-order-webhook-live.ts") return false;
  // ENVIRONMENTAL, and named rather than left failing (2026-08-21).
  //
  // verify-stripe-webhook-e2e POSTs to `${BASE_URL}/api/webhooks/stripe` over
  // HTTP. A database is not enough — it wants a running Next server, which this
  // runner deliberately does not start, so it fails with ECONNREFUSED for a
  // reason that has nothing to do with the code under test. Exactly the
  // situation verify-order-webhook-live.ts is excluded for, and excluded the
  // same way:
  //
  //   npm run dev
  //   npx tsx scripts/verify-stripe-webhook-e2e.ts
  //
  // NOT a passing result and not claimed as one. It is unrun.
  if (file === "verify-stripe-webhook-e2e.ts") return false;
  // Same: brings its own real Postgres and must run unelevated.
  if (file === "verify-confirmation-live.ts") return false;
  if (file === "verify-checkout-live.ts") return false;
  if (file === "verify-orders-live.ts") return false;
  if (file === "verify-paypal-live.ts") return false;
  if (file === "verify-paypal-refund.ts") return false;
  if (file === "verify-paypal-webhook-lifecycle.ts") return false;
  if (file === "verify-label-purchase-live.ts") return false;
  if (file === "verify-sourcing-live.ts") return false;
  if (file === "verify-business-context-live.ts") return false;
  if (file === "verify-business-browser.ts") return false;
  // Same category, and MISSED when it was added (found 2026-08-21): it brings
  // its own real Postgres AND a Next server via startTestServer, and its own
  // header names run-unelevated.ps1 as its entry point. It had been failing
  // here with "Execution of PostgreSQL by a user with administrative
  // permissions is not permitted" — an environment message about the shell,
  // with nothing to say about the catalog.
  if (file === "verify-catalog-browser.ts") return false;
  // Same again: its own Postgres, its own Next server, its own browser.
  if (file === "verify-office-browser.ts") return false;
  if (file === "verify-rooms-browser.ts") return false;
  if (file === "verify-commerce-lead-browser.ts") return false;
  if (file === "verify-progression-live.ts") return false;
  if (file === "verify-economics-live.ts") return false;
  if (file === "verify-economics-ingest.ts") return false;
  if (file === "verify-economics-answer.ts") return false;
  if (file === "verify-economics-chat.ts") return false;
  if (file === "verify-economics-producer.ts") return false;
  if (file === "verify-economics-production.ts") return false;
  if (file === "verify-catalog-live.ts") return false;
  if (file === "verify-sourcing-schedule.ts") return false;
  if (file === "verify-sourcing-budget.ts") return false;
  if (file === "verify-business-memory-live.ts") return false;
  if (file === "verify-bi-reads-live.ts") return false;
  if (file === "verify-commitments-live.ts") return false;
  if (file === "verify-hero-asset-live.ts") return false;
  if (file === "verify-owner-understanding-live.ts") return false;
  if (file === "verify-business-switcher-live.ts") return false;
  if (file === "verify-execute-binding-live.ts") return false;
  if (file === "verify-owner-edits-live.ts") return false;
  if (file === "verify-route-business-live.ts") return false;
  if (file === "verify-upload-understanding-live.ts") return false;
  if (file === "verify-proposals-live.ts") return false;
  if (file === "verify-audience-recall-live.ts") return false;
  if (file === "verify-readiness-lifecycle-live.ts") return false;
  if (file === "verify-growth-points-live.ts") return false;
  if (file === "verify-growth-point-refresh-live.ts") return false;
  if (file === "verify-trial-live.ts") return false;
  if (file === "verify-connected-summaries-live.ts") return false;
  if (file === "verify-next-best-action-live.ts") return false;
  if (file === "verify-trends-live.ts") return false;
  if (file === "verify-insights-live.ts") return false;
  if (file === "verify-notify-live.ts") return false;
  if (file === "verify-scheduler-live.ts") return false;
  if (file === "verify-autonomy-live.ts") return false;
  if (file === "verify-measurement-live.ts") return false;
  if (file === "verify-tasks-live.ts") return false;
  if (file === "verify-change-detection-live.ts") return false;
  if (file === "verify-ai-usage-live.ts") return false;
  if (file === "verify-briefing-grounding-live.ts") return false;
  return /from "@\/lib\/prisma"|prismaSystem|prisma\./.test(source);
}
