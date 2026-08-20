import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/auth/cronAuth";
import { runDueSyncs } from "@/lib/intelligence/scheduler";
import { runDueIntelligenceCycles } from "@/lib/intelligence/cycle";
import { runDueGrowthPointRefreshes } from "@/lib/growthPoints/refresh";
import { pruneExpiredAttempts } from "@/lib/auth/attemptThrottle";

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
  await pruneExpiredAttempts().catch((error) => {
    console.error("[cron/sync] pruning auth attempts failed:", error);
  });

  // Stage isolation (2026-08-20). These three stages are independent — a
  // store needs no connected integration to be due growth points, and none to
  // have first-party intelligence to run. Awaited bare, one throwing 500'd the
  // whole route and silently skipped the two after it, with nothing recording
  // that they had been skipped rather than found empty.
  //
  // Each stage now reports its own outcome, and a stage that failed says so in
  // the response instead of being indistinguishable from one that had no work.
  const stageErrors: string[] = [];

  let summaries: Awaited<ReturnType<typeof runDueSyncs>> = [];
  try {
    summaries = await runDueSyncs(50);
  } catch (error) {
    console.error("[cron/sync] connector syncs failed:", error);
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
    console.error("[cron/sync] growth point refreshes failed:", error);
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
    console.error("[cron/sync] intelligence cycles failed:", error);
    stageErrors.push("intelligence");
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
    })),
  });
}
