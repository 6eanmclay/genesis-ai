import { prismaSystem } from "@/lib/prisma";

// AI Cost & Usage Infrastructure, Milestone 5 — every function here is
// read-only and deliberately cross-tenant (every store/user/anonymous
// session on the platform, not one store's), so it uses prismaSystem, not
// the tenant-isolation-guarded `prisma` export — same reasoning and same
// real precedent as app/api/cron/status/route.ts (see that file's own
// comment, and lib/prisma.ts's comment on prismaSystem itself).
//
// The real authorization boundary is NOT in this file — every function
// here must only ever be called from a route already gated by
// isPlatformAdmin() (lib/platformAdmin.ts, Milestone 6), same convention
// as the cron route's own CRON_SECRET check happening before its
// prismaSystem read, not inside it.

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfMonthUtc(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function totalCostSince(from: Date): Promise<number> {
  const result = await prismaSystem.aiUsageEvent.aggregate({
    where: { occurredAt: { gte: from } },
    _sum: { costUsd: true },
  });
  return Number(result._sum.costUsd ?? 0);
}

export async function totalCostToday(): Promise<number> {
  return totalCostSince(startOfTodayUtc());
}

export async function totalCostThisMonth(): Promise<number> {
  return totalCostSince(startOfMonthUtc());
}

export interface FeatureCostRow {
  feature: string;
  totalCostUsd: number;
  callCount: number;
  avgCostUsd: number;
}

// Doubles as both "highest/lowest cost features" and "most/least
// frequently used features" — sort by whichever field the caller needs,
// rather than two near-duplicate queries.
export async function costByFeature(from: Date): Promise<FeatureCostRow[]> {
  const rows = await prismaSystem.aiUsageEvent.groupBy({
    by: ["feature"],
    where: { occurredAt: { gte: from }, feature: { not: null } },
    _sum: { costUsd: true },
    _count: { _all: true },
  });
  return rows
    .map((r) => {
      const totalCostUsd = Number(r._sum.costUsd ?? 0);
      const callCount = r._count._all;
      return {
        feature: r.feature!,
        totalCostUsd,
        callCount,
        avgCostUsd: callCount > 0 ? totalCostUsd / callCount : 0,
      };
    })
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

export interface BusinessIntentCostRow {
  businessIntent: string;
  totalCostUsd: number;
  callCount: number;
}

export async function costByBusinessIntent(from: Date): Promise<BusinessIntentCostRow[]> {
  const rows = await prismaSystem.aiUsageEvent.groupBy({
    by: ["businessIntent"],
    where: { occurredAt: { gte: from }, businessIntent: { not: null } },
    _sum: { costUsd: true },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({
      businessIntent: r.businessIntent!,
      totalCostUsd: Number(r._sum.costUsd ?? 0),
      callCount: r._count._all,
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

// Anonymous-scope only — every real visitor who touched the experience
// flow, whether or not they ever created a business. Distinct session
// count comes from groupBy's own distinct groups, not a second query.
export async function averageCostPerVisitor(from: Date): Promise<{ avgCostUsd: number; visitorCount: number }> {
  const rows = await prismaSystem.aiUsageEvent.groupBy({
    by: ["anonymousSessionToken"],
    where: { occurredAt: { gte: from }, anonymousSessionToken: { not: null } },
    _sum: { costUsd: true },
  });
  const visitorCount = rows.length;
  const totalCostUsd = rows.reduce((sum, r) => sum + Number(r._sum.costUsd ?? 0), 0);
  return { avgCostUsd: visitorCount > 0 ? totalCostUsd / visitorCount : 0, visitorCount };
}

// Real accounts (userId or storeId scope) — "paying customer" in the sense
// Sean asked for (an activated account), not an anonymous visitor.
export async function averageCostPerCustomer(from: Date): Promise<{ avgCostUsd: number; customerCount: number }> {
  const rows = await prismaSystem.aiUsageEvent.groupBy({
    by: ["storeId"],
    where: { occurredAt: { gte: from }, storeId: { not: null } },
    _sum: { costUsd: true },
  });
  const customerCount = rows.length;
  const totalCostUsd = rows.reduce((sum, r) => sum + Number(r._sum.costUsd ?? 0), 0);
  return { avgCostUsd: customerCount > 0 ? totalCostUsd / customerCount : 0, customerCount };
}

// The real conversion-weighted number Sean's own retrospective cost
// analysis (2026-08-04, this same day) computed by hand — now a real,
// repeatable query: among anonymous sessions that actually led to a kept
// business (outcome: "accepted"), what did that real business cost.
export async function averageCostPerCreatedBusiness(from: Date): Promise<{ avgCostUsd: number; businessCount: number }> {
  const rows = await prismaSystem.aiUsageEvent.groupBy({
    by: ["sessionId"],
    where: { occurredAt: { gte: from }, sessionId: { not: null }, outcome: "accepted" },
    _sum: { costUsd: true },
  });
  const businessCount = rows.length;
  const totalCostUsd = rows.reduce((sum, r) => sum + Number(r._sum.costUsd ?? 0), 0);
  return { avgCostUsd: businessCount > 0 ? totalCostUsd / businessCount : 0, businessCount };
}

export interface RevenueVsCost {
  totalRevenueUsd: number;
  totalCostUsd: number;
  // null, not 0, when there's no real revenue yet to divide by — an
  // honest "not meaningful yet," never a fabricated 0% or 100%.
  aiCostAsPercentOfRevenue: number | null;
  grossAiMarginUsd: number | null;
}

// Real Order revenue (status "paid") against real AI cost, same window.
// "Gross AI margin" here means revenue minus AI cost specifically — not a
// full P&L (fulfillment/payment-processor fees aren't AI costs and
// deliberately aren't netted out here).
export async function revenueVsAiCost(from: Date): Promise<RevenueVsCost> {
  const [orderSum, costSum] = await Promise.all([
    prismaSystem.order.aggregate({
      where: { createdAt: { gte: from }, status: "paid" },
      _sum: { amountInCents: true },
    }),
    prismaSystem.aiUsageEvent.aggregate({
      where: { occurredAt: { gte: from } },
      _sum: { costUsd: true },
    }),
  ]);
  const totalRevenueUsd = (orderSum._sum.amountInCents ?? 0) / 100;
  const totalCostUsd = Number(costSum._sum.costUsd ?? 0);
  return {
    totalRevenueUsd,
    totalCostUsd,
    aiCostAsPercentOfRevenue: totalRevenueUsd > 0 ? (totalCostUsd / totalRevenueUsd) * 100 : null,
    grossAiMarginUsd: totalRevenueUsd > 0 ? totalRevenueUsd - totalCostUsd : null,
  };
}
