import { LEGACY_BUSINESS_BASE, businessBasePath } from "@/lib/dashboard/navConfig";

// WHERE STRIPE SENDS THE OWNER BACK.
//
// ============ THE BUSINESS THEY WERE PAYING FOR (2026-09-13) ===========
//
// Every Stripe redirect in this directory was a literal `/dashboard/billing`
// or `/dashboard/growth-points`. Those are the LEGACY routes, and the legacy
// route resolves the account's ACTIVE business — while visiting /b/[slug]
// deliberately does not set the active business ("that write happens only at
// /choose-business", app/dashboard/ai-actions.ts). So an owner who subscribed
// from /b/second-shop/billing was returned to whichever business they had last
// chosen, looking at its plan, right after paying for a different one.
//
// The charge was always correct — the session's metadata carries the real
// storeId and the webhook credits that store. What was wrong is the only part
// the owner can see. And the moment it is wrong is the worst possible one: a
// payment has just been taken, and the page they land on says the business
// they are looking at isn't on a plan.
//
// EXACTLY THE DEFECT dismissAttentionCard already carried and had fixed:
// "every business-route path fell through to '/dashboard', so the page the
// owner was actually on was never revalidated". These URLs simply predate
// BUSINESS_CONTEXT.md Phase C and were not migrated with the screens.
//
// Pure, and in its own module on purpose: lib/billing/stripeClient.ts
// constructs a Stripe client at import time and throws without an API key, so
// anything living in checkout.ts cannot be exercised by a code-lane suite.
// Here it can be, and verify-billing-return-path.ts does.

/** The two surfaces Stripe returns an owner to. */
export type BillingReturnPage = "billing" | "growth-points";

/**
 * Build the absolute URL Stripe should return to.
 *
 * `slug` is the business the owner was actually operating on — undefined on
 * the legacy /dashboard route, which is the one case where resolving the
 * active business is the correct behaviour rather than a bug, because that is
 * the business that route is about.
 */
export function billingReturnUrl(params: {
  baseUrl: string;
  slug: string | undefined;
  page: BillingReturnPage;
  /** e.g. "subscribe=success". Omitted for the portal, which has no outcome. */
  query?: string;
}): string {
  const base = params.slug ? businessBasePath(params.slug) : LEGACY_BUSINESS_BASE;
  const suffix = params.query ? `?${params.query}` : "";
  return `${params.baseUrl}${base}/${params.page}${suffix}`;
}
