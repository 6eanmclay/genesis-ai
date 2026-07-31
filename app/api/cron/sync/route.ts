import { NextRequest, NextResponse } from "next/server";
import { runDueSyncs } from "@/lib/intelligence/scheduler";

// Phase 3 Milestone 3 — the actual trigger. Secured via Vercel's own
// documented convention for cron routes: Vercel automatically sends
// `Authorization: Bearer ${CRON_SECRET}` on requests it triggers itself;
// anything else (a public request that guessed this path) gets a 401
// before runDueSyncs — the scheduler's unattended-execution bypass in
// execute() — ever runs. See vercel.json for the actual schedule.
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summaries = await runDueSyncs(50);
  const synced = summaries.filter((s) => s.ok).length;
  const failed = summaries.length - synced;

  return NextResponse.json({ synced, failed, total: summaries.length });
}
