import { prisma } from "@/lib/prisma";
import type { CustomerSummary, RecentOrder } from "./types";

// Derived from Order.buyerEmail — no Customer model exists (or is being
// invented here); a raw buyer email is the only identity signal that
// exists today. `includeRevenue: false` omits the dollar sum from the
// query itself, matching getOrderSummary's pattern.
export async function getCustomerSummaries(
  storeId: string,
  opts: { includeRevenue: boolean; limit?: number }
): Promise<CustomerSummary[]> {
  // Two fully separate branches, not a shared conditional args object —
  // Prisma's return-type inference gets confused by a union-typed args
  // object (and separately, a present-but-undefined `_sum` key throws
  // "needs at least one truthy value," unlike an omitted key).
  if (opts.includeRevenue) {
    const rows = await prisma.order.groupBy({
      by: ["buyerEmail"],
      where: { storeId },
      _count: { _all: true },
      _sum: { amountInCents: true },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: opts.limit ?? 20,
    });
    return rows.map((row) => ({
      buyerEmail: row.buyerEmail,
      orderCount: row._count._all,
      totalSpentInCents: row._sum.amountInCents ?? 0,
      lastOrderAt: row._max.createdAt!,
    }));
  }

  const rows = await prisma.order.groupBy({
    by: ["buyerEmail"],
    where: { storeId },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: opts.limit ?? 20,
  });
  return rows.map((row) => ({
    buyerEmail: row.buyerEmail,
    orderCount: row._count._all,
    totalSpentInCents: null,
    lastOrderAt: row._max.createdAt!,
  }));
}

// Owner-experience milestone — real per-customer purchase history for the
// Customers page. A store's real order volume at this stage is small (same
// assumption getRevenueTrend already makes), so fetching every order once
// and grouping in JS is simpler and just as correct as a per-customer
// query loop. Capped at `limit` total orders (not per-customer) — a
// generous cap for beta-stage volume, revisit only if that stops holding.
export async function getOrdersByEmail(
  storeId: string,
  opts: { includeRevenue: boolean; limit?: number }
): Promise<Map<string, RecentOrder[]>> {
  const rows = await prisma.order.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 300,
    select: {
      id: true,
      productName: true,
      buyerEmail: true,
      createdAt: true,
      amountInCents: opts.includeRevenue,
    },
  });

  const byEmail = new Map<string, RecentOrder[]>();
  for (const row of rows) {
    const order: RecentOrder = {
      id: row.id,
      productName: row.productName,
      buyerEmail: row.buyerEmail,
      amountInCents: opts.includeRevenue ? (row.amountInCents as number) : null,
      createdAt: row.createdAt,
    };
    const existing = byEmail.get(row.buyerEmail) ?? [];
    existing.push(order);
    byEmail.set(row.buyerEmail, existing);
  }
  return byEmail;
}

// Real first-time-buyer count for Live Intelligence's Business Pulse widget
// — a customer only counts as "new" if their true first-ever order (not
// just their first order *in the window*) falls inside the last `days`.
// Requires grouping across ALL of the store's orders (not a windowed
// where-clause) so a customer who bought long ago and again recently isn't
// miscounted as new. Gated by ORDERS_VIEW (a count, not a dollar figure),
// independent of REVENUE_VIEW — same tier as getOrderSummary's orderCount.
export async function getNewCustomerCount(storeId: string, days: number = 30): Promise<number> {
  return getNewCustomerCountSince(storeId, new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

// Daily Operating Rhythm — the same real "true first-ever order" logic
// above, parameterized by an arbitrary anchor date rather than a rolling
// day-count, for the briefing composer's "since you were last here" window
// (which isn't a round number of days).
export async function getNewCustomerCountSince(storeId: string, since: Date): Promise<number> {
  const rows = await prisma.order.groupBy({
    by: ["buyerEmail"],
    where: { storeId },
    _min: { createdAt: true },
  });
  return rows.filter((row) => row._min.createdAt && row._min.createdAt >= since).length;
}
