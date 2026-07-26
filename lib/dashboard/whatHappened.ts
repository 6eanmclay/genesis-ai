import { prisma } from "@/lib/prisma";
import type { ActivityItem, OrderSummary, RecentOrder } from "./types";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Two aggregates (windowed + all-time) rather than one — a brand-new store
// with a few lifetime orders shouldn't look empty just because none landed
// in the last 30 days. `includeRevenue: false` omits the dollar sum from
// the query itself, so the figure never reaches the component tree for a
// caller without REVENUE_VIEW — not just hidden in the UI.
export async function getOrderSummary(
  storeId: string,
  opts: { includeRevenue: boolean }
): Promise<OrderSummary> {
  const since = new Date(Date.now() - WINDOW_MS);

  // Two fully separate branches, not a shared conditional args object —
  // Prisma's return-type inference gets confused by a union-typed args
  // object (and separately, a present-but-undefined `_sum` key throws
  // "needs at least one truthy value," unlike an omitted key).
  if (opts.includeRevenue) {
    const [windowed, allTime] = await Promise.all([
      prisma.order.aggregate({
        where: { storeId, createdAt: { gte: since } },
        _count: true,
        _sum: { amountInCents: true },
      }),
      prisma.order.aggregate({
        where: { storeId },
        _count: true,
        _sum: { amountInCents: true },
      }),
    ]);
    return {
      orderCount: windowed._count,
      revenueInCents: windowed._sum.amountInCents ?? 0,
      allTimeOrderCount: allTime._count,
      allTimeRevenueInCents: allTime._sum.amountInCents ?? 0,
      windowLabel: "Last 30 days",
    };
  }

  const [windowed, allTime] = await Promise.all([
    prisma.order.aggregate({ where: { storeId, createdAt: { gte: since } }, _count: true }),
    prisma.order.aggregate({ where: { storeId }, _count: true }),
  ]);
  return {
    orderCount: windowed._count,
    revenueInCents: null,
    allTimeOrderCount: allTime._count,
    allTimeRevenueInCents: null,
    windowLabel: "Last 30 days",
  };
}

// Individual recent orders, not just the aggregate getOrderSummary() above —
// used for Home's positively-framed "recent orders" section. Same
// includeRevenue gating pattern as getOrderSummary/getCustomerSummaries:
// the dollar amount is never selected from the DB at all for a caller
// without REVENUE_VIEW, not just hidden in the UI.
export async function getRecentOrders(
  storeId: string,
  opts: { includeRevenue: boolean; limit?: number }
): Promise<RecentOrder[]> {
  const rows = await prisma.order.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 5,
    select: {
      id: true,
      productName: true,
      buyerEmail: true,
      createdAt: true,
      amountInCents: opts.includeRevenue,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    productName: row.productName,
    buyerEmail: row.buyerEmail,
    amountInCents: opts.includeRevenue ? (row.amountInCents as number) : null,
    createdAt: row.createdAt,
  }));
}

// Row-cap only, no date window — a quiet store (nothing in the last N days)
// should still show its real recent history rather than an empty feed.
// Spans every action type for the store, not just Stripe-related ones.
export async function getRecentActivity(
  storeId: string,
  limit = 20
): Promise<ActivityItem[]> {
  const rows = await prisma.executionLog.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: { select: { name: true, email: true } } },
  });

  // Phase 6 — executionId is a loose match (no FK, same convention as
  // recommendationId) against ApprovalRequest, only ever present for rows
  // that went through the Genesis approval/autonomy path. A second small
  // query rather than a join, so this stays a plain enrichment of the
  // existing append-only log rather than something that could ever mutate
  // ExecutionLog itself.
  const executionIds = rows.map((row) => row.executionId);
  const approvals = executionIds.length
    ? await prisma.approvalRequest.findMany({
        where: { executionId: { in: executionIds } },
        select: { executionId: true, decisionMode: true },
      })
    : [];
  const decisionModeByExecutionId = new Map(
    approvals.map((a) => [a.executionId, a.decisionMode as "human" | "autonomous"])
  );

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    status: row.status as ActivityItem["status"],
    message: row.message,
    actorType: row.actorType as ActivityItem["actorType"],
    actorName: row.actor ? (row.actor.name ?? row.actor.email) : null,
    createdAt: row.createdAt,
    metadata: row.metadata,
    decisionMode: decisionModeByExecutionId.get(row.executionId),
  }));
}
