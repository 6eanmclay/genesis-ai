import { platformStripe } from "./stripeClient";
import { getOrCreateStripeCustomer } from "./customer";
import { getBaseUrl } from "@/lib/integrations/util";

// Chapter 5 (Payments) — "billing and account management" answered by
// leaning on Stripe's own hosted Billing Portal rather than building
// custom payment-method/invoice UI: a status summary plus one redirect
// button covers real account management (update card, view invoices,
// cancel) with a real Stripe surface, not a maintained clone of it.
export async function createBillingPortalSession(
  storeId: string,
  opts: { baseUrl?: string } = {}
): Promise<string> {
  const [customerId, baseUrl] = await Promise.all([
    getOrCreateStripeCustomer(storeId),
    opts.baseUrl ? Promise.resolve(opts.baseUrl) : getBaseUrl(),
  ]);

  const session = await platformStripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/dashboard/billing`,
  });

  return session.url;
}
