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
  /**
   * Executions that ran, with the evidence of whether they were confirmed.
   *
   * `status` and `verified` are REQUIRED here rather than optional. The query
   * selects them, and a type that merely permitted them would let a future
   * caller drop the pair while still compiling — at which case every change
   * would silently count as "could not check", which reads as honest and is
   * actually just missing data.
   */
  successes: { action: string; message: string; status: string; verified: boolean }[];
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
    // SUCCESS *AND* WARNING, with the verification evidence attached.
    //
    // This read used to be `status: "SUCCESS"` selecting `action, message`,
    // and both halves of that were losing evidence the database already had:
    //
    //   - `verified` was never selected, so a change confirmed by a real
    //     read-back and one nobody could check arrived identical.
    //   - WARNING rows were excluded entirely, and WARNING is precisely
    //     "the write ran and verification did not confirm it" — the one
    //     outcome an owner most needs to see. It was being filed as nothing.
    //
    // VERIFICATION_HARDENING_CONTRACT.md §3: the (status, verified) pair IS
    // the three-state verification result. Selecting one without the other
    // cannot express it.
    prisma.executionLog.findMany({
      where: { storeId, status: { in: ["SUCCESS", "WARNING"] }, createdAt: { gte: since } },
      select: { action: true, message: true, status: true, verified: true },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
  ]);

  return { resolvedByJ4, decisionsSettled, successes, windowDays };
}
