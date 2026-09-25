"use server";

import { clearBagOnConfirmedPurchase } from "@/lib/bag/purchaseCompletion";

/**
 * Empty the bag after a purchase that provably completed.
 *
 * THE CLIENT IS NOT TRUSTED. This is a public Server Function: anything can
 * call it with any slug and any id. It therefore re-resolves the purchase
 * server-side rather than believing the caller — the success page only decides
 * whether to bother asking, never whether the answer is yes.
 *
 * The scoping that makes that safe is inside resolvePurchase: a session id is
 * checked against Stripe, and an order id is looked up scoped to the store the
 * slug resolves to, so a stranger's order id finds nothing and clears nothing.
 *
 * Returns nothing. A caller learning whether somebody else's order was paid
 * would be a disclosure this has no reason to make.
 */
export async function clearBagAfterConfirmedPurchase(
  slug: string,
  sessionId: string | null,
  orderId: string | null
): Promise<void> {
  await clearBagOnConfirmedPurchase({ slug, sessionId, orderId });
}
