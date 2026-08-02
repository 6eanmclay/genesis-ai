import { prisma } from "@/lib/prisma";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
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

// Real daily revenue over the same 30-day window getOrderSummary already
// uses — for Live Intelligence's Business Pulse sparkline. Prisma has no
// day-truncated groupBy without raw SQL, so this fetches the real (small-
// volume, already-indexed-by-storeId) order rows in the window and buckets
// them in plain JS — still genuine Order data, just aggregated differently.
// Same REVENUE_VIEW gating as getOrderSummary's revenueInCents — this is a
// revenue metric, so callers must check that permission before calling
// this at all (see layout.tsx).
export async function getRevenueTrend(storeId: string, days: number = 30): Promise<number[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const orders = await prisma.order.findMany({
    where: { storeId, createdAt: { gte: since } },
    select: { createdAt: true, amountInCents: true },
  });

  const buckets = new Array(days).fill(0) as number[];
  const now = Date.now();
  for (const order of orders) {
    const daysAgo = Math.floor((now - order.createdAt.getTime()) / (24 * 60 * 60 * 1000));
    const index = days - 1 - daysAgo;
    if (index >= 0 && index < days) buckets[index] += order.amountInCents;
  }
  return buckets;
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
        where: { storeId, executionId: { in: executionIds } },
        select: { executionId: true, decisionMode: true },
      })
    : [];
  const decisionModeByExecutionId = new Map(
    approvals.map((a) => [a.executionId, a.decisionMode as "human" | "autonomous"])
  );

  // Genesis Experience Principles, "Spoken, not logged" — a
  // genesis.communicate_finding row's own ExecutionLog.message is a raw,
  // mechanical audit-log wrapper (see communicateFinding.ts's run()), never
  // meant for an owner to read. The real sentence Genesis wrote lives on the
  // CognitiveOutput row it created — reliably findable via the
  // cognitiveOutputId this executable's own run() always returns as
  // metadata (see engine.ts/log.ts — persisted onto ExecutionLog.metadata
  // for every successful run, no schema change needed). A small second
  // query enriching the existing append-only log, same shape as the
  // decisionModeByExecutionId lookup just above — never a rewrite of what's
  // actually stored.
  const findingRowIds = rows
    .filter((row) => row.action === EXECUTION_ACTIONS.GENESIS_COMMUNICATE_FINDING)
    .map((row) => {
      const metadata = row.metadata as { cognitiveOutputId?: string } | null;
      return metadata?.cognitiveOutputId;
    })
    .filter((id): id is string => typeof id === "string");
  const cognitiveOutputs = findingRowIds.length
    ? await prisma.cognitiveOutput.findMany({
        where: { storeId, id: { in: findingRowIds } },
        select: { id: true, summary: true, kind: true },
      })
    : [];
  const cognitiveOutputById = new Map(cognitiveOutputs.map((c) => [c.id, c]));

  return rows.map((row) => {
    const metadata = row.metadata as { cognitiveOutputId?: string } | null;
    const cognitiveOutput =
      row.action === EXECUTION_ACTIONS.GENESIS_COMMUNICATE_FINDING && metadata?.cognitiveOutputId
        ? cognitiveOutputById.get(metadata.cognitiveOutputId)
        : undefined;
    return {
      id: row.id,
      action: row.action,
      status: row.status as ActivityItem["status"],
      message: cognitiveOutput ? cognitiveOutput.summary : row.message,
      actorType: row.actorType as ActivityItem["actorType"],
      actorName: row.actor ? (row.actor.name ?? row.actor.email) : null,
      createdAt: row.createdAt,
      metadata: row.metadata,
      decisionMode: decisionModeByExecutionId.get(row.executionId),
      cognitiveOutputKind: cognitiveOutput?.kind,
    };
  });
}
