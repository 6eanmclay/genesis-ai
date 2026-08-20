import { reportIssue } from "@/lib/observability/reportIssue";
import { prisma, prismaSystem } from "@/lib/prisma";

// Growth Points Economy (Chapter 2) — the monthly refresh sweep. Same
// "due timestamp stamped on the row" idiom as lib/intelligence/scheduler.ts's
// getDueSyncs/StoreIntegration.nextSyncDueAt, not a new cadence mechanism:
// deployment-agnostic (works whether the cron fires daily or more often),
// called from the same existing cron route.
//
// Deliberately cross-tenant for the discovery read — due refreshes across
// the whole platform, not one store's — mirroring getDueSyncs' own use of
// prismaSystem for exactly this reason; every subsequent per-store mutation
// uses the guarded `prisma` client.
function addOneCalendarMonth(date: Date): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + 1);
  return next;
}

// Chapter 5 (Payments) correctness closeout — a real gap once planId means
// "has a real Stripe subscription" (it didn't before Chapter 5; every
// planId was previously assigned by hand, with no lifecycle behind it at
// all). Without this, a canceled/past-due subscription would keep
// receiving free monthly grants forever, since nothing else in this sweep
// ever stops. subscriptionStatus: null still qualifies — a store whose
// plan was assigned without going through real Stripe billing (comped,
// hand-assigned) is a legitimate case, not a lapsed one; only a real,
// unhealthy Stripe status (canceled/past_due/unpaid/incomplete/paused)
// excludes a store.
const HEALTHY_SUBSCRIPTION_STATUSES = ["active", "trialing"];

export async function getDueGrowthPointRefreshes(limit: number) {
  const now = new Date();
  return prismaSystem.store.findMany({
    where: {
      planId: { not: null },
      AND: [
        {
          OR: [
            { subscriptionStatus: null },
            { subscriptionStatus: { in: HEALTHY_SUBSCRIPTION_STATUSES } },
          ],
        },
        { OR: [{ growthPointNextRefreshAt: null }, { growthPointNextRefreshAt: { lte: now } }] },
      ],
    },
    orderBy: { growthPointNextRefreshAt: "asc" },
    take: limit,
    include: { plan: true },
  });
}

export interface GrowthPointRefreshSummary {
  storeId: string;
  planId: string;
  granted: number;
}

// A store with no planId (everyone, today — no real Plan rows exist yet)
// never appears in getDueGrowthPointRefreshes' query at all, so this
// function is a genuine no-op in production until Sean assigns real plans.
// A store ON a plan whose monthlyGrowthPointAllowance isn't set yet still
// gets its due date advanced (so it isn't re-checked every cycle forever)
// but grants nothing — the same "wired but inert until real values exist"
// shape as lib/growthPoints/catalog.ts.
export async function runDueGrowthPointRefreshes(limit = 50): Promise<GrowthPointRefreshSummary[]> {
  const due = await getDueGrowthPointRefreshes(limit);
  const summaries: GrowthPointRefreshSummary[] = [];

  for (const store of due) {
    // Per-store isolation (2026-08-20), same reasoning as the sync scheduler:
    // this loop is cross-tenant, so one store's failed transaction used to
    // abandon every store after it and silently deny them a month's points.
    try {
      const nextRefreshAt = addOneCalendarMonth(store.growthPointNextRefreshAt ?? new Date());
      const allowance = store.plan?.monthlyGrowthPointAllowance;

      if (allowance === null || allowance === undefined || !store.planId) {
        await prisma.store.update({
          where: { id: store.id },
          data: { growthPointNextRefreshAt: nextRefreshAt },
        });
        continue;
      }

      await prisma.$transaction(async (tx) => {
        const updated = await tx.store.update({
          where: { id: store.id },
          data: {
            growthPointBalance: { increment: allowance },
            growthPointNextRefreshAt: nextRefreshAt,
          },
          select: { growthPointBalance: true },
        });
        await tx.growthPointTransaction.create({
          data: {
            storeId: store.id,
            type: "REFRESH",
            amount: allowance,
            balanceAfter: updated.growthPointBalance,
            description: `Monthly refresh (${store.plan!.name})`,
          },
        });
      });

      summaries.push({ storeId: store.id, planId: store.planId, granted: allowance });
    } catch (error) {
      reportIssue("monthly Growth Point refresh failed", error, {
        subsystem: "billing",
        stage: "growthPoints.refresh",
        storeId: store.id,
      });
    }
  }

  return summaries;
}
