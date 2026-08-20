"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { PERMISSIONS, requireBusinessOrActive } from "@/lib/permissions";
import { createGrowthPointCheckoutSession } from "@/lib/billing/checkout";
import { adjustGrowthPointBalance } from "@/lib/growthPoints/ledger";
import { isPlatformAdmin } from "@/lib/platformAdmin";
import { prisma } from "@/lib/prisma";

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). `slug` is bound by the page under /b/[slug]; the legacy page passes
// nothing and resolves the account's active business exactly as before.
//
// These are the actions where operating on the wrong business costs real money:
// a subscription is charged against the business it is started from, and Growth
// Points are credited to that business's balance.
export async function purchaseGrowthPoints(slug: string | undefined, packageKey: string) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.BILLING_MANAGE, slug);
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

export async function addGrowthPointsForTesting(slug: string | undefined, formData: FormData) {
  const { storeId, userId } = await requireBusinessOrActive(PERMISSIONS.BILLING_MANAGE, slug);

  // PLATFORM ADMIN ONLY (2026-08-20). This was gated on BILLING_MANAGE, which
  // every store OWNER has on their own store — so any real customer could mint
  // themselves 500 Growth Points per submit, unlimited times, on a product that
  // is sold for money. It was added deliberately as a development unblock and
  // is correct as one; it simply must not be reachable by the people buying
  // points. The env-var allowlist keeps it working for Sean and nobody else.
  if (!(await isPlatformAdmin())) {
    throw new Error("Manual balance adjustment is a platform-operator tool.");
  }
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
