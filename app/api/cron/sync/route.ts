import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/auth/cronAuth";
import { withCorrelation } from "@/lib/observability/correlation";
import { runDueTasks } from "@/lib/scheduler/run";

// THE DAILY TRIGGER. It decides nothing.
//
// ============ WHAT THIS ROUTE USED TO BE (2026-08-30) ==================
//
// Three hundred lines and eleven responsibilities awaited in sequence, each
// with its own try/catch, its own reportIssue call, and its cadence expressed
// as an if-statement in the middle of its own body. The schedule was the route,
// so nothing could state what Genesis runs on a schedule without reading all of
// it, and nothing could change when something ran without editing it.
//
// The work has not moved — every task is the same function it always was. What
// moved is the DECIDING: what exists, how often it should run, whether it is
// switched on, and what a delay costs now live in lib/scheduler/registry.ts,
// and whether a thing is due now lives in lib/scheduler/run.ts, computed from
// the database rather than from which trigger fired.
//
// That leaves this file as what a trigger should be: check the caller, name
// itself, hand over, report. When real schedules exist, a second entry pointing
// somewhere else with different lanes needs nothing here to change.
//
// ============ THE CADENCE IS NOT IN THIS FILE =========================
//
// Deliberately. This entry runs daily today because vercel.json says so on a
// plan that allows one cron. Every task still states the interval it actually
// needs, and the gap between the two is visible on /admin/operations rather
// than buried in an expression. Nothing here needs to change when that gap
// closes.

export async function GET(request: NextRequest) {
  // Fails CLOSED when CRON_SECRET is unset — see lib/auth/cronAuth.ts. The
  // inline comparison this replaced compared against the literal string
  // "Bearer undefined" in that case, which anyone could send.
  if (!isAuthorizedCronRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ONE CORRELATION ID FOR THE WHOLE INVOCATION, and each task then opens its
  // own nested one — withCorrelation reuses the outer id, so every row any task
  // writes is joinable back to the tick that caused it.
  const result = await withCorrelation({ origin: "cron", surface: "cron.daily" }, () =>
    runDueTasks({
      trigger: "cron.daily",
      // EVERY LANE, because this is the only trigger that exists. When a
      // frequent one is added it takes ["queue", "timely"] and this keeps the
      // rest — a one-line change in a file that decides nothing else.
      budgetMs: 4 * 60_000,
    }),
  );

  // A task that FAILED is reported as failed, never as one that found nothing
  // to do. Those look identical in a count, and telling them apart is the whole
  // reason this shape exists — the same reasoning the eleven-stage version
  // arrived at, kept.
  return NextResponse.json({
    trigger: result.trigger,
    correlationId: result.correlationId,
    ran: result.outcomes.filter((o) => o.status === "ran").map((o) => ({ key: o.key, ms: o.durationMs })),
    failed: result.outcomes.filter((o) => o.status === "failed").map((o) => ({ key: o.key, error: o.reason })),
    skipped: result.outcomes.filter((o) => o.status === "skipped").map((o) => ({ key: o.key, why: o.reason })),
    // Due, enabled, and not started because the invocation ran out of budget.
    // Previously this was indistinguishable from "found nothing to do", which
    // is the worst pair in a scheduler to confuse.
    deferred: result.deferred,
  });
}
