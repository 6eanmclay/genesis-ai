"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { PERMISSIONS, requireStorePermission } from "@/lib/permissions";
import { createGrowthPointCheckoutSession } from "@/lib/billing/checkout";
import { adjustGrowthPointBalance } from "@/lib/growthPoints/ledger";
import { prisma } from "@/lib/prisma";

export async function purchaseGrowthPoints(packageKey: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.BILLING_MANAGE);
  const url = await createGrowthPointCheckoutSession(storeId, packageKey);
  redirect(url);
}

// Real, urgent unblock (2026-08-09) — see adjustGrowthPointBalance's own
// comment. Owner-only (same gate purchaseGrowthPoints already uses), a
// sane upper bound per submission (not a security boundary — the owner
// already has full access to their own store's balance — just a guard
// against a fat-fingered "50000" silently corrupting real usage history),
// and every adjustment is fully visible afterward in the exact same real
// ledger/history the rest of this page already renders.
const MAX_ADJUSTMENT_PER_SUBMIT = 500;

export async function addGrowthPointsForTesting(formData: FormData) {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.BILLING_MANAGE);
  const raw = Number(formData.get("amount"));
  const amount = Math.floor(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_ADJUSTMENT_PER_SUBMIT) {
    throw new Error(`Enter a whole number between 1 and ${MAX_ADJUSTMENT_PER_SUBMIT}.`);
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });

  await adjustGrowthPointBalance({
    storeId,
    amount,
    adjustedByLabel: user?.name ?? user?.email ?? userId,
  });

  revalidatePath("/dashboard/growth-points");
  redirect("/dashboard/growth-points");
}
