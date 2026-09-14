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
    // REFUNDED MONEY IS NOT REVENUE (2026-08-20).
    //
    // This summed amountInCents across every order regardless of status, so a
    // refund left the dashboard still reporting the money as earned. The owner
    // was being shown income they had given back.
    //
    // The COUNT deliberately still includes refunded orders: one genuinely
    // happened, and hiding it would make a busy refund-heavy month look quiet.
    // Only the money is corrected — which is why these are separate queries
    // rather than one filtered aggregate.
    const earned = { status: { not: "refunded" } };
    const [windowed, windowedRevenue, allTime, allTimeRevenue] = await Promise.all([
      prisma.order.aggregate({ where: { storeId, createdAt: { gte: since } }, _count: true }),
      prisma.order.aggregate({
        where: { storeId, createdAt: { gte: since }, ...earned },
        _sum: { amountInCents: true },
      }),
      prisma.order.aggregate({ where: { storeId }, _count: true }),
      prisma.order.aggregate({ where: { storeId, ...earned }, _sum: { amountInCents: true } }),
    ]);
    return {
      orderCount: windowed._count,
      revenueInCents: windowedRevenue._sum.amountInCents ?? 0,
      allTimeOrderCount: allTime._count,
      allTimeRevenueInCents: allTimeRevenue._sum.amountInCents ?? 0,
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

// Owner-experience milestone — real profit, not just revenue. Only
// Product.costInCents-backed orders (products sourced through a
// fulfillment strategy, see lib/fulfillment/) have a known cost; a
// manually-entered product from the older AI-imagined flow has none.
// Honest about the gap rather than assuming zero cost for those — the
// caller shows "profit (tracked for N of M orders)" using both counts,
// never a silently-inflated total. Gated by REVENUE_VIEW, same tier as
// getOrderSummary's revenueInCents — profit is a dollar figure.
export async function getProfitSummary(storeId: string): Promise<{
  profitInCents: number;
  ordersWithKnownCost: number;
  ordersWithUnknownCost: number;
}> {
  // ============ REFUNDED MONEY IS NOT PROFIT EITHER (2026-09-14) ======
  //
  // The same correction getOrderSummary took on 2026-08-20, forty lines above
  // this one, and for the same reason in its words: "a refund left the
  // dashboard still reporting the money as earned. The owner was being shown
  // income they had given back."
  //
  // This still summed every Order row, so on one screen, at one moment, a
  // store with two paid sales and one refund of the same value rendered
  // $100.00 in revenue — correct, that fix working — beside $90.00 profit.
  // Arithmetically impossible with a $20 cost on a $50 sale, and closer to
  // revenue than the truthful $60.00.
  //
  // KNOWN AND DEFERRED UNTIL NOW, not newly discovered:
  // lib/businessModel/profitability.ts names it — "a refunded order's amount
  // still counts as revenue... inherited knowingly, stated plainly, and left
  // for whoever revisits refund handling as its own change". This is that
  // change, approved by Sean as a correction to an existing financial
  // invariant rather than a new Analytics decision.
  //
  // SAME STATUS SEMANTICS, NO NEW VOCABULARY. Order.status defaults to "paid"
  // and the only other value any payment path writes is "refunded", so this is
  // getOrderSummary's own `{ status: { not: "refunded" } }` and nothing more.
  //
  // AND IT LEAVES BOTH SIDES OF THE FRACTION. getOrderSummary deliberately
  // keeps refunded orders in its COUNT, because one genuinely happened and
  // hiding it would make a refund-heavy month look quiet. That reasoning does
  // not carry here: these counts are not "how many orders happened", they are
  // the denominator of "how much of your profit could be worked out", and an
  // order that earned nothing is not profit whose cost is unknown — it is not
  // profit at all.
  //
  // Downstream is untouched by construction. summarizeMarginCoverage (M5) and
  // planNetOfPostage (M7) consume the summary object returned below, not this
  // query, so their logic is unchanged and net = M5 profit − postage still
  // holds; both now rest on a correct figure instead of a known-wrong one.
  const orders = await prisma.order.findMany({
    where: { storeId, status: { not: "refunded" } },
    select: { amountInCents: true, product: { select: { costInCents: true } } },
  });

  let profitInCents = 0;
  let ordersWithKnownCost = 0;
  let ordersWithUnknownCost = 0;
  for (const order of orders) {
    const costInCents = order.product?.costInCents;
    if (costInCents === null || costInCents === undefined) {
      ordersWithUnknownCost++;
      continue;
    }
    profitInCents += order.amountInCents - costInCents;
    ordersWithKnownCost++;
  }
  return { profitInCents, ordersWithKnownCost, ordersWithUnknownCost };
}

// Owner-experience milestone — real fulfillment-status counts for the
// dashboard's "order status" figure. Not revenue-gated (a count, not a
// dollar amount) — same tier as getOrderSummary's orderCount.
export async function getFulfillmentBreakdown(
  storeId: string
): Promise<{ unfulfilledCount: number; fulfilledCount: number }> {
  const rows = await prisma.order.groupBy({
    by: ["fulfillmentStatus"],
    where: { storeId },
    _count: true,
  });
  const unfulfilledCount = rows.find((r) => r.fulfillmentStatus === "unfulfilled")?._count ?? 0;
  const fulfilledCount = rows.find((r) => r.fulfillmentStatus === "fulfilled")?._count ?? 0;
  return { unfulfilledCount, fulfilledCount };
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
    approvals.map((a) => [a.executionId, a.decisionMode as "human" | "chat_auto" | "autonomous"])
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
