import { prisma } from "@/lib/prisma";
import type { GenesisActionType } from "@/lib/execution/genesisActions";
import { growthPointCostFor } from "./catalog";

export interface GrowthPointGate {
  ok: boolean;
  // null means the action has no catalog entry yet — free, the real
  // production state today (every action is unpriced until Sean assigns
  // real values). Non-null is the real cost this gate checked against.
  cost: number | null;
}

// Growth Points pricing (Chapter 5) — the Business Partner "unlimited
// 1-point actions" mechanic. A plan's unlimitedActionCostCeiling of null
// means no free tier (Builder, Growth); a real number means any action
// costing at or below it never touches the store's own balance. Kept as
// a pure function so both call sites below apply the identical rule.
function isUnlimitedViaPlan(ceiling: number | null | undefined, cost: number): boolean {
  return ceiling !== null && ceiling !== undefined && cost <= ceiling;
}

// A read-only pre-check, run by lib/execution/engine.ts before an
// executable's run() — rejects up front rather than letting Genesis
// attempt real work the store can't afford. Deliberately separate from the
// actual debit (deductGrowthPoints below): the debit only happens once the
// action has genuinely succeeded, so a failed execution never costs the
// owner real points for nothing.
export async function checkGrowthPointBalance(
  storeId: string,
  actionType: GenesisActionType
): Promise<GrowthPointGate> {
  const cost = growthPointCostFor(actionType);
  if (cost === null) return { ok: true, cost: null };

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { growthPointBalance: true, plan: { select: { unlimitedActionCostCeiling: true } } },
  });
  if (isUnlimitedViaPlan(store?.plan?.unlimitedActionCostCeiling, cost)) {
    return { ok: true, cost };
  }
  return { ok: (store?.growthPointBalance ?? 0) >= cost, cost };
}

// Debits the store's real balance and writes exactly one GrowthPointTransaction
// row, atomically — called only from lib/execution/engine.ts, only after an
// action has genuinely succeeded (never on a FAILED execution). Mirrors
// ExecutionLog's own append-only convention: this only ever creates a row,
// never updates one.
export async function deductGrowthPoints(params: {
  storeId: string;
  actionType: GenesisActionType;
  cost: number;
  executionLogId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.store.findUnique({
      where: { id: params.storeId },
      select: { growthPointBalance: true, plan: { select: { unlimitedActionCostCeiling: true } } },
    });

    // Business Partner's unlimited-tier — covered actions still write a
    // real transaction (so the owner's history stays honest about what
    // happened) but never decrement balance.
    if (isUnlimitedViaPlan(current?.plan?.unlimitedActionCostCeiling, params.cost)) {
      await tx.growthPointTransaction.create({
        data: {
          storeId: params.storeId,
          type: "DEDUCTION",
          amount: 0,
          balanceAfter: current?.growthPointBalance ?? 0,
          actionType: params.actionType,
          executionLogId: params.executionLogId,
          description: "Included with your plan",
        },
      });
      return;
    }

    const store = await tx.store.update({
      where: { id: params.storeId },
      data: { growthPointBalance: { decrement: params.cost } },
      select: { growthPointBalance: true },
    });
    await tx.growthPointTransaction.create({
      data: {
        storeId: params.storeId,
        type: "DEDUCTION",
        amount: -params.cost,
        balanceAfter: store.growthPointBalance,
        actionType: params.actionType,
        executionLogId: params.executionLogId,
        description: `Invested in "${params.actionType}"`,
      },
    });
  });
}

// Chapter 5 (Payments) — the credit-side counterpart to deductGrowthPoints,
// called only from the platform billing webhook once a real Stripe payment
// has genuinely completed. externalRef (the originating Checkout Session
// id) is the idempotency guard: Stripe can redeliver the same event more
// than once, and a pre-check inside the same transaction as the write means
// a retry that finds an existing row is a genuine no-op — same "existence
// check, not upsert-return inference" discipline as the merchant order
// webhook (app/api/webhooks/stripe/route.ts) already uses.
export async function creditGrowthPointsFromPurchase(params: {
  storeId: string;
  amount: number;
  externalRef: string;
  description: string;
}): Promise<{ credited: boolean }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.growthPointTransaction.findUnique({
      where: { externalRef: params.externalRef },
    });
    if (existing) return { credited: false };

    const store = await tx.store.update({
      where: { id: params.storeId },
      data: { growthPointBalance: { increment: params.amount } },
      select: { growthPointBalance: true },
    });
    await tx.growthPointTransaction.create({
      data: {
        storeId: params.storeId,
        type: "PURCHASE",
        amount: params.amount,
        balanceAfter: store.growthPointBalance,
        externalRef: params.externalRef,
        description: params.description,
      },
    });
    return { credited: true };
  });
}
