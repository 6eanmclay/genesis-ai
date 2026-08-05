"use server";

import { redirect } from "next/navigation";
import { PERMISSIONS, requireStorePermission } from "@/lib/permissions";
import { createBillingPortalSession } from "@/lib/billing/portal";
import { createPlanSubscriptionCheckoutSession } from "@/lib/billing/checkout";

export async function manageBilling() {
  const { storeId } = await requireStorePermission(PERMISSIONS.BILLING_MANAGE);
  const url = await createBillingPortalSession(storeId);
  redirect(url);
}

export async function subscribeToPlan(planId: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.BILLING_MANAGE);
  const url = await createPlanSubscriptionCheckoutSession(storeId, planId);
  redirect(url);
}
