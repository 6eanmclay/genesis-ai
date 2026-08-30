import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/auth/cronAuth";
import { withCorrelation } from "@/lib/observability/correlation";
import { runDueTasks } from "@/lib/scheduler/run";
import type { Lane } from "@/lib/scheduler/registry";

// THE FREQUENT TRIGGER — BUILT, TESTED, AND NOT SCHEDULED.
//
// ============ WHY IT EXISTS BEFORE IT IS TURNED ON (2026-08-30) ========
//
// The durable queue this platform depends on has exactly one runner, and that
// runner is a daily cron. So a job enqueued at 06:05 — a customer's receipt,
// say — waits nearly twenty-four hours. The queue is durable; its trigger is
// not adequate. That is the whole of Rank 3.
//
// The fix needs a Vercel plan that allows more than one cron entry, which is a
// paid-infrastructure requirement and NOT something to fake locally. So the
// application half is built and proven now, and the schedule stays off:
//
//   vercel.json, when the plan allows it:
//     { "path": "/api/cron/tick", "schedule": "*/2 * * * *" }
//
// Adding that line is the entire change. Nothing in lib/scheduler, no task, and
// no handler is touched — which is the requirement this was designed against.
//
// ============ WHY IT IS SAFE TO ADD LATER =============================
//
// Two properties, both proven by scripts/verify-scheduler-db.ts:
//
//   Due-ness comes from the database, so a task with a daily interval offered a
//   chance every two minutes still runs once a day. A frequent trigger changes
//   the latency of due work and no task's cadence.
//
//   The queue drain claims each job before running it, so two triggers
//   overlapping cannot run one job twice. That was already true and is why this
//   is a schedule change rather than a design change.
//
// LANES, NOT TASKS. This trigger names the two lanes whose delay is felt by
// somebody — draining durable work, and finding notices nobody has sent. It
// deliberately does not take "recompute" or "outbound": a supplier search does
// not want to be offered a chance every two minutes, and its own interval
// already says so.

const FREQUENT_LANES: Lane[] = ["queue", "timely"];

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await withCorrelation({ origin: "cron", surface: "cron.tick" }, () =>
    runDueTasks({
      trigger: "cron.tick",
      lanes: FREQUENT_LANES,
      // Short on purpose. A frequent trigger that can run for four minutes can
      // overlap itself; one bounded well inside its own interval cannot.
      budgetMs: 90_000,
    }),
  );

  return NextResponse.json({
    trigger: result.trigger,
    correlationId: result.correlationId,
    ran: result.outcomes.filter((o) => o.status === "ran").map((o) => ({ key: o.key, ms: o.durationMs })),
    failed: result.outcomes.filter((o) => o.status === "failed").map((o) => ({ key: o.key, error: o.reason })),
    deferred: result.deferred,
  });
}
