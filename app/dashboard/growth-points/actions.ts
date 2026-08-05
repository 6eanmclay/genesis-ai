"use server";

import { redirect } from "next/navigation";
import { PERMISSIONS, requireStorePermission } from "@/lib/permissions";
import { createGrowthPointCheckoutSession } from "@/lib/billing/checkout";

export async function purchaseGrowthPoints(packageKey: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.BILLING_MANAGE);
  const url = await createGrowthPointCheckoutSession(storeId, packageKey);
  redirect(url);
}
