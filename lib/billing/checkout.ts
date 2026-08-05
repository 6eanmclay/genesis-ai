import { prisma } from "@/lib/prisma";
import { platformStripe } from "./stripeClient";
import { getOrCreateStripeCustomer } from "./customer";
import { getBaseUrl } from "@/lib/integrations/util";
import { growthPointPackage } from "@/lib/growthPoints/purchaseCatalog";

// Chapter 5 (Payments) — mirrors app/store/[slug]/actions.ts's own
// createStripeCheckoutSession pattern (mode/line_items/success+cancel
// urls/metadata), just against the platform's own Stripe client instead of
// a per-merchant one. pointAmount is baked into metadata at creation time
// (not re-derived from the catalog on webhook fulfillment) so what gets
// credited always matches exactly what was actually paid for, even if the
// catalog changes between checkout and fulfillment.
export async function createGrowthPointCheckoutSession(
  storeId: string,
  packageKey: string,
  // opts.baseUrl lets a script outside a real Next.js request scope (where
  // getBaseUrl()'s own headers() call would throw) verify this function
  // directly — every real call site (a server action) omits it and gets
  // the real, request-derived base URL, unchanged.
  opts: { baseUrl?: string } = {}
): Promise<string> {
  const pkg = growthPointPackage(packageKey);
  if (!pkg) {
    throw new Error(`Growth Point package "${packageKey}" isn't available.`);
  }

  const [customerId, baseUrl] = await Promise.all([
    getOrCreateStripeCustomer(storeId),
    opts.baseUrl ? Promise.resolve(opts.baseUrl) : getBaseUrl(),
  ]);

  const session = await platformStripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{ price: pkg.stripePriceId, quantity: 1 }],
    success_url: `${baseUrl}/dashboard/growth-points?purchase=success`,
    cancel_url: `${baseUrl}/dashboard/growth-points?purchase=cancelled`,
    metadata: { storeId, packageKey, pointAmount: String(pkg.pointAmount) },
  });

  if (!session.url) {
    throw new Error("Failed to create checkout session");
  }
  return session.url;
}

// Chapter 5 (Payments) — same real pattern, mode: "subscription" instead
// of a one-time payment, against a real Plan's own stripePriceId. Plan
// ships with zero rows and a null stripePriceId until Sean creates a real
// one (see prisma/schema.prisma's own comment on Plan.stripePriceId) — an
// unpriced/nonexistent plan is a real, honest error here, never a
// fabricated checkout.
export async function createPlanSubscriptionCheckoutSession(
  storeId: string,
  planId: string,
  opts: { baseUrl?: string } = {}
): Promise<string> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan?.stripePriceId) {
    throw new Error(`Plan "${planId}" isn't available for subscription yet.`);
  }

  const [customerId, baseUrl] = await Promise.all([
    getOrCreateStripeCustomer(storeId),
    opts.baseUrl ? Promise.resolve(opts.baseUrl) : getBaseUrl(),
  ]);

  const session = await platformStripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: `${baseUrl}/dashboard/billing?subscribe=success`,
    cancel_url: `${baseUrl}/dashboard/billing?subscribe=cancelled`,
    metadata: { storeId, planId },
  });

  if (!session.url) {
    throw new Error("Failed to create checkout session");
  }
  return session.url;
}
