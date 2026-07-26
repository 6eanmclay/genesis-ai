import { prisma } from "@/lib/prisma";

// Fixed, not owner-configurable — Phase 5 deliberately has no measurement-
// window setting or any other new control surface (see the Phase 5 plan,
// memory: project_architecture_pivot_audit.md).
const MEASUREMENT_WINDOW_DAYS = 14;
const MEASUREMENT_WINDOW_MS = MEASUREMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// A safety cap on how many due measurements one opportunistic trigger will
// compute inline — real stores should never approach this, but a store
// catching up after being dormant a long time shouldn't do unbounded work
// inside one request's after() callback.
const MAX_MEASUREMENTS_PER_SWEEP = 20;

function buildSummary(params: {
  orderCountBefore: number;
  orderCountAfter: number;
  concurrentActionTypes: string[];
}): string {
  const base = `During the ${MEASUREMENT_WINDOW_DAYS} days after this change, the store received ${params.orderCountAfter} order${
    params.orderCountAfter === 1 ? "" : "s"
  } (vs. ${params.orderCountBefore} in the ${MEASUREMENT_WINDOW_DAYS} days before).`;

  if (params.concurrentActionTypes.length === 0) return base;

  return `${base} ${params.concurrentActionTypes.length} other Genesis-executed change${
    params.concurrentActionTypes.length === 1 ? "" : "s"
  } (${params.concurrentActionTypes.join(", ")}) occurred during this same window, so this change alone may not explain the difference.`;
}

// Deterministic, zero-AI-cost — a plain before/after Order aggregate, never
// an inference about causation. Meant to be invoked via next/server's
// after(), the same opportunistic pattern as Phase 4's observation sweep —
// no scheduler/queue/worker. See the Phase 5 plan for why this is
// deliberately NOT an "impact"/attribution calculation: concurrentActionTypes
// exists only to flag how confounded a given window is, never to weight or
// net out anyone's contribution.
export async function measureDueMeasurements(storeId: string): Promise<void> {
  const dueBefore = new Date(Date.now() - MEASUREMENT_WINDOW_MS);

  const dueApprovals = await prisma.approvalRequest.findMany({
    where: {
      storeId,
      status: "EXECUTED",
      decidedAt: { lte: dueBefore },
      postExecutionMeasurement: null,
    },
    take: MAX_MEASUREMENTS_PER_SWEEP,
  });
  if (dueApprovals.length === 0) return;

  for (const approval of dueApprovals) {
    const decidedAt = approval.decidedAt!;
    const beforeStart = new Date(decidedAt.getTime() - MEASUREMENT_WINDOW_MS);
    // Always fully in the past: dueApprovals already guarantees
    // decidedAt <= now - MEASUREMENT_WINDOW_MS, so afterEnd <= now.
    const afterEnd = new Date(decidedAt.getTime() + MEASUREMENT_WINDOW_MS);

    // Only update_product_image is scoped to one product today — everything
    // else is a store-wide change with no single product to isolate.
    const productId =
      approval.actionType === "update_product_image"
        ? ((approval.input as { productId?: string }).productId ?? null)
        : null;
    const scope = productId ? "product" : "store";

    const orderWhere = (from: Date, to: Date) => ({
      storeId,
      createdAt: { gte: from, lt: to },
      ...(productId ? { productId } : {}),
    });

    const [before, after, concurrent] = await Promise.all([
      prisma.order.aggregate({
        where: orderWhere(beforeStart, decidedAt),
        _count: true,
        _sum: { amountInCents: true },
      }),
      prisma.order.aggregate({
        where: orderWhere(decidedAt, afterEnd),
        _count: true,
        _sum: { amountInCents: true },
      }),
      prisma.approvalRequest.findMany({
        where: {
          storeId,
          status: "EXECUTED",
          id: { not: approval.id },
          decidedAt: { gte: beforeStart, lt: afterEnd },
        },
        select: { actionType: true },
      }),
    ]);

    const concurrentActionTypes = [...new Set(concurrent.map((c) => c.actionType))];

    await prisma.postExecutionMeasurement.create({
      data: {
        approvalRequestId: approval.id,
        storeId,
        actionType: approval.actionType,
        topicKey: approval.topicKey,
        scope,
        productId,
        windowDays: MEASUREMENT_WINDOW_DAYS,
        orderCountBefore: before._count,
        orderCountAfter: after._count,
        revenueBeforeCents: before._sum.amountInCents ?? 0,
        revenueAfterCents: after._sum.amountInCents ?? 0,
        concurrentActionTypes,
        summary: buildSummary({
          orderCountBefore: before._count,
          orderCountAfter: after._count,
          concurrentActionTypes,
        }),
      },
    });
  }
}
