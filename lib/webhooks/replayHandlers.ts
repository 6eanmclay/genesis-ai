import { getConnectorByName } from "@/lib/integrations/registry";

// WHICH PROVIDERS CAN ACTUALLY BE REPLAYED.
//
// ============ FEWER THAN YOU WOULD EXPECT (2026-08-30) ================
//
// Replay runs a handler against a body that was verified when it arrived. That
// requires a handler which takes a BODY — and only one of the three live
// providers has one.
//
//   EasyPost   its handler lives on the connector as IntegrationWebhooks.handle
//              and takes (storeId, rawBody). Replayable.
//   Stripe     handleStripeWebhook takes (body, headers) and calls
//              stripe.webhooks.constructEvent itself. It cannot run without a
//              live signature, and a stored one is time-expired by definition.
//   PayPal     the same shape, verifying against a per-store webhook id.
//
// So the two that move money are the two that cannot be replayed, which is the
// opposite of convenient and is stated here rather than discovered later. What
// closes it is the same work Item 5 deliberately did not do: extracting their
// handlers from their verification, which is a money-path refactor and needs
// its own approval.
//
// ============ THIS IS NOT A REGISTRY OF PROVIDERS =====================
//
// It is a registry of REPLAYABLE ones, and the difference is the point. A
// provider missing here is refused by name — `no handler supplied for STRIPE` —
// rather than silently doing nothing, so an operator learns why the button did
// not work instead of wondering whether it did.

export type ReplayHandler = (storeId: string, rawBody: string) => Promise<void>;

/**
 * The handlers replay may use.
 *
 * Built per call rather than held as a constant: a connector reads its own
 * configuration at verify time, and a module-level snapshot would capture
 * whatever was set when the lambda cold-started.
 */
export function replayHandlers(): Record<string, ReplayHandler> {
  const handlers: Record<string, ReplayHandler> = {};

  const easypost = getConnectorByName("EASYPOST");
  if (easypost.webhooks) {
    // The one provider whose contract lives on its connector — which is
    // precisely what Item 5 built, and this is the first thing to benefit.
    handlers.EASYPOST = (storeId, rawBody) => easypost.webhooks!.handle(storeId, rawBody);
  }

  return handlers;
}

/** Providers a delivery can be replayed for, for an operator surface to show. */
export function replayableProviders(): string[] {
  return Object.keys(replayHandlers()).sort();
}
