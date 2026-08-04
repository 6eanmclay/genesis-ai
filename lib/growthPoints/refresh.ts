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

export async function getDueGrowthPointRefreshes(limit: number) {
  const now = new Date();
  return prismaSystem.store.findMany({
    where: {
      planId: { not: null },
      OR: [{ growthPointNextRefreshAt: null }, { growthPointNextRefreshAt: { lte: now } }],
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
  }

  return summaries;
}
