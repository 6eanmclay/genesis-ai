import { prisma } from "@/lib/prisma";

// Growth Points Economy (Chapter 2) — the owner-facing sibling of
// lib/admin/aiUsageQueries.ts: real, store-scoped aggregates over
// GrowthPointTransaction, for the one owner viewing their own economy —
// not the cross-tenant admin-only queries that file has.

export interface GrowthPointHistoryItem {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  actionType: string | null;
  description: string;
  createdAt: Date;
}

export async function getGrowthPointHistory(storeId: string, limit = 20): Promise<GrowthPointHistoryItem[]> {
  return prisma.growthPointTransaction.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, type: true, amount: true, balanceAfter: true, actionType: true, description: true, createdAt: true },
  });
}

export interface GrowthPointUsageByAction {
  actionType: string;
  count: number;
  totalSpent: number;
}

// "Usage analytics" — real spend grouped by actionType, the store-scoped
// sibling of admin's costByFeature. Only DEDUCTION rows count as spend;
// REFRESH/REFERRAL_REWARD/PURCHASE/ADJUSTMENT are credits, not usage.
export async function getGrowthPointUsageByAction(storeId: string): Promise<GrowthPointUsageByAction[]> {
  const grouped = await prisma.growthPointTransaction.groupBy({
    by: ["actionType"],
    where: { storeId, type: "DEDUCTION", actionType: { not: null } },
    _count: { _all: true },
    _sum: { amount: true },
  });
  return grouped
    .map((g) => ({
      actionType: g.actionType as string,
      count: g._count._all,
      totalSpent: Math.abs(g._sum.amount ?? 0),
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent);
}

export interface ReferralStatusItem {
  id: string;
  referredName: string | null;
  referredEmail: string;
  status: string;
  createdAt: Date;
  rewardedAt: Date | null;
}

export async function getReferralsSent(userId: string): Promise<ReferralStatusItem[]> {
  const referrals = await prisma.referral.findMany({
    where: { referrerUserId: userId },
    orderBy: { createdAt: "desc" },
    include: { referred: { select: { name: true, email: true } } },
  });
  return referrals.map((r) => ({
    id: r.id,
    referredName: r.referred.name,
    referredEmail: r.referred.email,
    status: r.status,
    createdAt: r.createdAt,
    rewardedAt: r.rewardedAt,
  }));
}
