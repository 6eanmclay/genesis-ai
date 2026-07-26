import { prisma } from "@/lib/prisma";
import type { CustomerSummary } from "./types";

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
