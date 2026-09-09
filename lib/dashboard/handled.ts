import { prisma } from "@/lib/prisma";

/**
 * WHAT J4 GOT ON WITH, AND WHAT ACTUALLY CHANGED.
 *
 * ============ WHY THIS READ EXISTS (2026-09-09) ========================
 *
 * Sean's arc ends with VERIFY and GROW - "what has already been handled" and
 * "what changed as a result". Measured on Cubit & Coil, all of that already
 * existed and nothing read it: over a fortnight, 80 observations J4 closed on
 * its own, 3 decisions settled, 238 successful executions.
 *
 * ============ IT RETURNS RAW ROWS ON PURPOSE ===========================
 *
 * The 238 successes are mostly not news: 117 `genesis.communicate_finding`,
 * 29 chat turns, 8 internal review runs. Deciding which of them an owner would
 * call a change is the action layer's job, not this one's - so this returns
 * what happened and lib/j4/officeBriefing.ts's summariseHandled applies
 * officeActionForExecution, the SAME rule the attention rows use.
 *
 * That split is deliberate. A reader that filtered as it fetched would be a
 * second opinion about what is owner-facing, and this repository has been bitten
 * repeatedly by two places holding the same rule: the allowlist reader, the nav
 * reserve, the connection-health definition. One rule, one module, two callers.
 */
export interface HandledSince {
  resolvedByJ4: number;
  decisionsSettled: number;
  successes: { action: string; message: string }[];
  windowDays: number;
}

export async function getHandledSince(storeId: string, windowDays: number): Promise<HandledSince> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [resolvedByJ4, decisionsSettled, successes] = await Promise.all([
    // Conditions that stopped being true without troubling the owner. The
    // resolve sweep sets this, so it is J4's own work rather than a guess.
    prisma.genesisObservation.count({
      where: { storeId, status: "RESOLVED", resolvedAt: { gte: since } },
    }),
    // decidedAt, not updatedAt - ApprovalRequest has no updatedAt, and asking
    // for one is how the first version of this read failed.
    prisma.approvalRequest.count({
      where: { storeId, decidedAt: { gte: since } },
    }),
    // BOUNDED. This runs on every Office visit, and an unbounded read of a
    // fortnight of execution logs on a busy store is a page-load cost nobody
    // asked for. 300 is comfortably above the 238 the busiest real store
    // produced in that window, so the summary is complete in practice and
    // cannot degrade into a slow query if that ever stops being true.
    prisma.executionLog.findMany({
      where: { storeId, status: "SUCCESS", createdAt: { gte: since } },
      select: { action: true, message: true },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
  ]);

  return { resolvedByJ4, decisionsSettled, successes, windowDays };
}
