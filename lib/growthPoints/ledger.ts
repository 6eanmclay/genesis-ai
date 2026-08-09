import { prisma } from "@/lib/prisma";
import type { GenesisActionType } from "@/lib/execution/genesisActions";
import { growthPointCostFor } from "./catalog";

export interface GrowthPointGate {
  ok: boolean;
  // null means the action has no catalog entry yet — free. Non-null is
  // the real cost this gate checked against (the catalog is real and
  // priced today — see catalog.ts's own comment; this is no longer the
  // "everything is unpriced" state it was before 2026-08-05).
  cost: number | null;
  // The store's real current balance at check time — carried back so a
  // caller can report an honest, specific shortfall ("you need 2 more")
  // instead of a bare rejection. Null exactly when cost is null (the gate
  // never needed to look up a balance at all).
  balance: number | null;
}

// Growth Points pricing (Chapter 5) — the Business Partner "unlimited
// 1-point actions" mechanic. A plan's unlimitedActionCostCeiling of null
// means no free tier (Builder, Growth); a real number means any action
// costing at or below it never touches the store's own balance. Kept as
// a pure function so both call sites below apply the identical rule.
function isUnlimitedViaPlan(ceiling: number | null | undefined, cost: number): boolean {
  return ceiling !== null && ceiling !== undefined && cost <= ceiling;
}

// Business Partner Preview — an active trial (Store.businessPartnerTrialEndsAt
// in the future) grants exactly the real Business Partner plan's own
// unlimitedActionCostCeiling, looked up live rather than duplicating "1" as
// a second source of truth, so the trial can never drift from Business
// Partner's real, current ceiling. Only queried when a trial is actually
// active, so the common non-trialing case pays no extra query.
async function isUnlimitedViaTrial(trialEndsAt: Date | null | undefined, cost: number): Promise<boolean> {
  if (!trialEndsAt || trialEndsAt.getTime() <= Date.now()) return false;
  const businessPartner = await prisma.plan.findUnique({
    where: { name: "Business Partner" },
    select: { unlimitedActionCostCeiling: true },
  });
  return isUnlimitedViaPlan(businessPartner?.unlimitedActionCostCeiling, cost);
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
  if (cost === null) return { ok: true, cost: null, balance: null };

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: {
      growthPointBalance: true,
      businessPartnerTrialEndsAt: true,
      plan: { select: { unlimitedActionCostCeiling: true } },
    },
  });
  const balance = store?.growthPointBalance ?? 0;
  if (isUnlimitedViaPlan(store?.plan?.unlimitedActionCostCeiling, cost)) {
    return { ok: true, cost, balance };
  }
  if (await isUnlimitedViaTrial(store?.businessPartnerTrialEndsAt, cost)) {
    return { ok: true, cost, balance };
  }
  return { ok: balance >= cost, cost, balance };
}

// Real fix (2026-08-09) for the "same activity repeated at the exact same
// timestamp" report — root cause traced to performApproveGenesisActionGroup
// (app/dashboard/ai-actions.ts) looping through every pending member of a
// group and letting each one independently hit checkGrowthPointBalance via
// execute(), each writing its own genuinely-distinct FAILED ExecutionLog row
// with byte-identical generic text — ActivityFeed doesn't surface per-item
// action context, so N real rows read as one duplicated one. This is the
// group-level counterpart to checkGrowthPointBalance: one query, one
// combined shortfall, checked BEFORE any member is executed, so an
// unaffordable group fails once with one clear reason instead of N.
export interface GroupGrowthPointGate {
  ok: boolean;
  totalCost: number;
  balance: number;
}

export async function checkGrowthPointBalanceForActions(
  storeId: string,
  actionTypes: readonly GenesisActionType[]
): Promise<GroupGrowthPointGate> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: {
      growthPointBalance: true,
      businessPartnerTrialEndsAt: true,
      plan: { select: { unlimitedActionCostCeiling: true } },
    },
  });
  const balance = store?.growthPointBalance ?? 0;

  let totalCost = 0;
  for (const actionType of actionTypes) {
    const cost = growthPointCostFor(actionType);
    if (cost === null) continue;
    if (isUnlimitedViaPlan(store?.plan?.unlimitedActionCostCeiling, cost)) continue;
    if (await isUnlimitedViaTrial(store?.businessPartnerTrialEndsAt, cost)) continue;
    totalCost += cost;
  }

  return { ok: balance >= totalCost, totalCost, balance };
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
      select: {
        growthPointBalance: true,
        businessPartnerTrialEndsAt: true,
        plan: { select: { unlimitedActionCostCeiling: true } },
      },
    });

    // Business Partner's unlimited-tier (real subscription or an active
    // Preview trial) — covered actions still write a real transaction (so
    // the owner's history stays honest about what happened) but never
    // decrement balance. The description names which mechanism actually
    // covered it rather than a generic merged label.
    const unlimitedSource = isUnlimitedViaPlan(current?.plan?.unlimitedActionCostCeiling, params.cost)
      ? "plan"
      : (await isUnlimitedViaTrial(current?.businessPartnerTrialEndsAt, params.cost))
        ? "trial"
        : null;

    if (unlimitedSource) {
      await tx.growthPointTransaction.create({
        data: {
          storeId: params.storeId,
          type: "DEDUCTION",
          amount: 0,
          balanceAfter: current?.growthPointBalance ?? 0,
          actionType: params.actionType,
          executionLogId: params.executionLogId,
          description:
            unlimitedSource === "plan" ? "Included with your plan" : "Included with your Business Partner Preview",
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

// Real, urgent gap closed (2026-08-09) — "do not let Growth Points become a
// blocker that makes the product impossible to test" (Sean, after hitting
// the insufficient-balance gate 4 times in one day on a store starting at
// balance 0). GrowthPointTransaction.type already documented "ADJUSTMENT"
// as a real, intended value (see the Prisma schema's own comment) — no
// code anywhere actually created one. This completes that, rather than
// inventing a new mechanism: a real, fully transparent, owner-only,
// audit-labeled balance adjustment, honestly named "Adjustment" in the
// exact same ledger/history UI every other transaction type already
// renders through (app/dashboard/growth-points/page.tsx's own
// TYPE_LABEL map already expected this to exist). Never disguised as a
// purchase or an earned reward — the description says exactly what it is
// and who did it.
export async function adjustGrowthPointBalance(params: {
  storeId: string;
  amount: number;
  adjustedByLabel: string; // e.g. the acting user's name/email — recorded in the description, not a separate column, matching every other transaction type's own plain-text description convention
}): Promise<{ balanceAfter: number }> {
  return prisma.$transaction(async (tx) => {
    const store = await tx.store.update({
      where: { id: params.storeId },
      data: { growthPointBalance: { increment: params.amount } },
      select: { growthPointBalance: true },
    });
    await tx.growthPointTransaction.create({
      data: {
        storeId: params.storeId,
        type: "ADJUSTMENT",
        amount: params.amount,
        balanceAfter: store.growthPointBalance,
        description: `Manual adjustment by ${params.adjustedByLabel} — development/testing`,
      },
    });
    return { balanceAfter: store.growthPointBalance };
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
