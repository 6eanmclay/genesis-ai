"use server";

import { redirect } from "next/navigation";
import { PERMISSIONS, requireBusinessOrActive } from "@/lib/permissions";
import { createBillingPortalSession } from "@/lib/billing/portal";
import { createPlanSubscriptionCheckoutSession } from "@/lib/billing/checkout";

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). `slug` is bound by the page under /b/[slug]; the legacy page passes
// nothing and resolves the account's active business exactly as before.
//
// These are the actions where operating on the wrong business costs real money:
// a subscription is charged against the business it is started from, and Growth
// Points are credited to that business's balance.
export async function manageBilling(slug?: string) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.BILLING_MANAGE, slug);
  const url = await createBillingPortalSession(storeId);
  redirect(url);
}

export async function subscribeToPlan(slug: string | undefined, planId: string) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.BILLING_MANAGE, slug);
  const url = await createPlanSubscriptionCheckoutSession(storeId, planId);
  redirect(url);
}
