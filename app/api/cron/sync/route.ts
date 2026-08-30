import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/auth/cronAuth";
import { reportIssue } from "@/lib/observability/reportIssue";
import { runDueSyncs } from "@/lib/intelligence/scheduler";
import { runDueIntelligenceCycles } from "@/lib/intelligence/cycle";
import { runDueGrowthPointRefreshes } from "@/lib/growthPoints/refresh";
import { runDueSourcing } from "@/lib/sourcing/sourcingSchedule";
import { pruneExpiredAttempts } from "@/lib/auth/attemptThrottle";
import { runDueOrderNotifications } from "@/lib/orders/notificationSweep";
import { sweepAbandonedTemporaries } from "@/lib/storage/temporaryAssets";
import {
  attributionSweepEnabled,
  nightlyEnabled,
  runAttributionSweep,
  runNightlyReconciliation,
} from "@/lib/storage/reconcile";

// Phase 3 Milestone 3 — the actual trigger. Secured via Vercel's own
// documented convention for cron routes: Vercel automatically sends
// `Authorization: Bearer ${CRON_SECRET}` on requests it triggers itself;
// anything else (a public request that guessed this path) gets a 401
// before runDueSyncs — the scheduler's unattended-execution bypass in
// execute() — ever runs. See vercel.json for the actual schedule.
export async function GET(request: NextRequest) {
  // Fails CLOSED when CRON_SECRET is unset — see lib/auth/cronAuth.ts. The
  // inline comparison this replaced compared against the literal string
  // "Bearer undefined" in that case, which anyone could send.
  if (!isAuthorizedCronRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Auth-throttle rows outlive their usefulness after WINDOW_MS. Swept here
  // rather than on every login, because the count query is already bounded by
  // occurredAt — stale rows are a storage concern, not a correctness one.
  // ============ WHAT A CRASH LEFT BEHIND (2026-08-29) ================
  //
  // Creating a product uploads print files and mockups before it calls the
  // supplier. A caught failure discards them inline; this is for the failure
  // that was never caught — a process killed between two uploads, a deploy
  // mid-creation, a timeout that took the function with it.
  //
  // STORAGE.md section 5 requires exactly this: "a temporary asset must be
  // recoverable by a sweep even when the code that created it never got to run
  // its own cleanup, because the case that leaks is the one that did not reach
  // the finally."
  //
  // Its own stage and its own catch, like every other stage here.
  await sweepAbandonedTemporaries().catch((error) => {
    reportIssue("the abandoned temporary-asset sweep failed", error, {
      subsystem: "storage",
      stage: "cron.temporaryAssets",
    });
  });

  // ============ STORAGE RECONCILIATION — ORCHESTRATION ONLY ==========
  //
  // Every decision lives in lib/storage/reconcile.ts. This calls it, catches
  // its own failure like every other stage, and knows nothing about presence,
  // sizes, orphans or attribution.
  //
  // BOTH ARE DARK. Sean, 2026-08-30: "do not schedule or enable the cron until
  // the ledger write paths and reconciliation code are actually deployed.
  // Production is currently on 605faed; reconciliation must not be activated
  // against that code gap." Production has no ledger writes, so every blob it
  // writes lands unclaimed — a first run would report the deploy gap as a pile
  // of orphans, and a monitor whose opening report is all false alarms is one
  // nobody reads again.
  //
  // The nightly pass is cheap: one provider listing, one ledger read, a few
  // indexed queries. The weekly sweep reads 279 text and JSON columns with
  // regexp_matches, which is why it is not here every night.
  if (nightlyEnabled()) {
    await runNightlyReconciliation({
      listObjects: async () => {
        const { vercelBlobStorage } = await import("@/lib/storage/vercelBlob");
        const listing = await vercelBlobStorage.list();
        return {
          objects: listing.objects.map((o) => ({ pathname: o.pathname, url: o.url, size: o.size })),
          truncated: listing.truncated,
        };
      },
      apply: true,
    }).catch((error) => {
      reportIssue("nightly storage reconciliation failed", error, {
        subsystem: "storage",
        stage: "cron.reconcile",
      });
    });
  }

  // Weekly, and gated on the day as well as the flag — the cron itself runs
  // daily, so the cadence lives here rather than in a second Vercel schedule
  // nobody would remember exists beside the first.
  if (attributionSweepEnabled() && new Date().getUTCDay() === 0) {
    await (async () => {
      const { vercelBlobStorage } = await import("@/lib/storage/vercelBlob");
      const listing = await vercelBlobStorage.list();
      const hosts = [...new Set(listing.objects.map((o) => new URL(o.url).host))];
      return runAttributionSweep({ hosts, apply: true });
    })().catch((error) => {
      reportIssue("the weekly attribution sweep failed", error, {
        subsystem: "storage",
        stage: "cron.attributionSweep",
      });
    });
  }

  // ============ THE NOTIFICATIONS NOBODY REDELIVERED (2026-08-29) =====
  //
  // A receipt is the one thing a customer has, and the PayPal path is a browser
  // redirect nobody retries. This sweeps for orders that are paid with no
  // confirmation, delivered with no notice, or refunded with no notice — and
  // sends what is missing.
  //
  // Its own stage, caught on its own, for the reason the rest of this route is
  // built that way: one failing stage must not take the others down.
  await runDueOrderNotifications().catch((error) => {
    reportIssue("the order notification sweep failed", error, {
      subsystem: "email",
      stage: "cron.orderNotifications",
    });
  });

  await pruneExpiredAttempts().catch((error) => {
    // Reported too, though it is the one stage here whose own comment calls it
    // a storage concern rather than a correctness one. Four stages reporting
    // and one not is how a rule stops being true for the case nobody looked at
    // — and a sweep that has been silently failing for months is still worth
    // knowing about.
    reportIssue("pruning auth attempts failed", error, {
      subsystem: "scheduler",
      stage: "cron.pruneAuthAttempts",
    });
  });

  // Stage isolation (2026-08-20). These three stages are independent — a
  // store needs no connected integration to be due growth points, and none to
  // have first-party intelligence to run. Awaited bare, one throwing 500'd the
  // whole route and silently skipped the two after it, with nothing recording
  // that they had been skipped rather than found empty.
  //
  // Each stage now reports its own outcome, and a stage that failed says so in
  // the response instead of being indistinguishable from one that had no work.
  // A FAILED STAGE REACHES A PERSON (2026-08-24).
  //
  // Each of these already isolated itself from the others, and each already
  // reported "this stage failed" in the response body. What none of them did
  // was tell anybody. On Vercel a console line is short-retention runtime log,
  // found only by somebody who already suspects a problem — which is the exact
  // reasoning lib/observability/reportIssue.ts's own header gives for existing.
  // reportIssue keeps the console line and adds the operator.
  const stageErrors: string[] = [];

  let summaries: Awaited<ReturnType<typeof runDueSyncs>> = [];
  try {
    summaries = await runDueSyncs(50);
  } catch (error) {
    reportIssue("connector syncs failed", error, {
      subsystem: "scheduler",
      stage: "cron.syncs",
    });
    stageErrors.push("syncs");
  }
  const synced = summaries.filter((s) => s.ok).length;
  const failed = summaries.length - synced;

  // Growth Points Economy (Chapter 2) — an independent concern from
  // integration syncs (a store needs no connected integration at all to be
  // due a monthly refresh), sharing the same daily trigger rather than a
  // second cron route.
  let growthPointRefreshes: Awaited<ReturnType<typeof runDueGrowthPointRefreshes>> = [];
  try {
    growthPointRefreshes = await runDueGrowthPointRefreshes(50);
  } catch (error) {
    reportIssue("growth point refreshes failed", error, {
      subsystem: "scheduler",
      stage: "cron.growthPoints",
    });
    stageErrors.push("growthPoints");
  }

  // Business Intelligence Engine M1 — the first-party path. Until now the
  // engine only ever ran for a store that had just completed a connector sync,
  // which meant a store built entirely on Genesis's own commerce never ran it
  // at all (BI_ENGINE.md, Defect 1). A store is due here because real activity
  // happened in it, which needs no integration.
  //
  // Stores whose cycle already ran above are skipped rather than run twice in
  // one invocation. A store with nothing new is never selected at all.
  //
  // Only SUCCESSFUL syncs are skipped, deliberately. runDueSyncs adds a store to
  // its cycle loop only when its sync succeeded, so a store whose connector
  // failed never ran the engine — skipping it here too would let one broken
  // connector silently suppress the store's own first-party intelligence until
  // the connector was fixed.
  let intelligenceCycles: Awaited<ReturnType<typeof runDueIntelligenceCycles>> = [];
  try {
    intelligenceCycles = await runDueIntelligenceCycles(50, {
      skipStoreIds: summaries.filter((s) => s.ok).map((s) => s.storeId),
    });
  } catch (error) {
    reportIssue("intelligence cycles failed", error, {
      subsystem: "scheduler",
      stage: "cron.intelligence",
    });
    stageErrors.push("intelligence");
  }

  // P0.5 sourcing, unattended (2026-08-21). A fifth independent stage, in the
  // same shape as the four above: its own limit, its own try/catch, its own
  // reported outcome. Until now discovery and the supplier-economics refresh ran
  // only on a Home load, so a business whose owner never opened Home was never
  // searched and never refreshed.
  //
  // Deliberately LAST. It is the only stage that makes outbound calls to third
  // parties on its own initiative, and a cron invocation that runs out of time
  // should lose this before it loses a connector sync or a Growth Point refresh.
  //
  // Its own limit, lower than the others' 50: each store here can mean several
  // supplier HTTP round trips, where a Growth Point refresh is one write.
  let sourcing: Awaited<ReturnType<typeof runDueSourcing>> | null = null;
  try {
    sourcing = await runDueSourcing();
  } catch (error) {
    reportIssue("sourcing pass failed", error, {
      subsystem: "scheduler",
      stage: "cron.sourcing",
    });
    stageErrors.push("sourcing");
  }

  return NextResponse.json({
    // A stage that FAILED is reported as failed, not as a stage that found
    // nothing to do. Those look identical in the counts below, and telling
    // them apart is the whole reason this field exists.
    stageErrors,
    synced,
    failed,
    total: summaries.length,
    // Per-connector detail — without this, a bare count can't say which
    // provider actually ran, the first thing worth knowing when diagnosing
    // a sync.
    results: summaries.map((s) => ({
      provider: s.provider,
      ok: s.ok,
      written: s.written,
      errors: s.errors,
    })),
    growthPointRefreshes: growthPointRefreshes.length,
    // Per-store detail for the same reason the sync results carry it: a bare
    // count can't say which store actually ran, the first thing worth knowing.
    intelligenceCycles: intelligenceCycles.map((c) => ({
      storeId: c.storeId,
      ok: c.ok,
      insights: c.insights,
      spoken: c.spoken,
      // WHICH stage, not merely that the pass did not complete. A cycle that
      // failed only at ai_review still ran Learn, still spoke, and needs a
      // provider — not an engineer. One that failed at insights is a different
      // problem entirely, and a bare `ok: false` cannot tell them apart.
      failedStages: c.failedStages,
    })),
    // Per-store detail, same reasoning as the two above. A store that was
    // considered and correctly did nothing reads differently from one that was
    // never reached, and only one of those is worth investigating.
    // WHY IT STOPPED, not only what it did. A pass that ran out of budget and
    // one that found nothing to do look identical in a count, and only one of
    // them means businesses are still waiting.
    sourcing: sourcing
      ? {
          runId: sourcing.runId,
          stoppedBecause: sourcing.stoppedBecause,
          policyVersion: sourcing.policyVersion,
          spent: sourcing.spent,
          stores: sourcing.stores.map((r) => ({
            storeId: r.storeId,
            discovery: r.discovery.ran ? `found ${r.discovery.suggested}` : r.discovery.reason,
            economicsRefreshed: r.economics?.ran ?? [],
            error: r.error,
          })),
        }
      : null,
  });
}
