// Which store a Stripe checkout event belongs to (extracted 2026-08-20).
//
// This is the trust boundary for money arriving, so it is worth being able to
// attack directly rather than only through a database. The logic is unchanged —
// it is lifted verbatim out of app/api/webhooks/stripe/route.ts — but it is pure
// now, and scripts/verify-webhook-store.ts forges events against it.
//
// THE TRUST PROBLEM. Session metadata is set by our own createCheckoutSession.
// But a connected merchant holds an API-key-equivalent access token for their
// own Stripe account and can create sessions directly, with any metadata they
// like. So for a CONNECTED event, metadata alone cannot say which store the
// money belongs to — otherwise a merchant could mint a session claiming someone
// else's storeId and have the order land in that store.
//
// `event.account` is set by Stripe, not by the merchant, so for connected events
// it is the source of truth. Metadata is only allowed to DISAMBIGUATE between
// stores that genuinely share that account — never to reach a store the account
// is not connected to. Platform-key events (no event.account) are ours end to
// end, so metadata is trusted there.

export interface ClaimedIntegration {
  storeId: string;
  externalAccountId: string | null;
}

export type StoreResolution =
  | { storeId: string; via: "metadata_confirmed" | "account_lookup" | "platform_metadata" }
  | { storeId: null; via: "unresolved" };

/**
 * Resolve the owning store — pure.
 *
 * `claimed` is the integration row for whatever storeId the metadata named, or
 * null if it named none / none exists. `byAccount` is the integration found by
 * looking up `eventAccount` alone.
 */
export function resolveWebhookStore(params: {
  /** Stripe-controlled. Present only for connected-account events. */
  eventAccount: string | null | undefined;
  /** Merchant-influenced for connected events. */
  metadataStoreId: string | null | undefined;
  claimed: ClaimedIntegration | null;
  byAccount: { storeId: string } | null;
}): StoreResolution {
  // Platform-key event: ours end to end, so metadata is trustworthy.
  if (!params.eventAccount) {
    return params.metadataStoreId
      ? { storeId: params.metadataStoreId, via: "platform_metadata" }
      : { storeId: null, via: "unresolved" };
  }

  // Connected event. Metadata may only pick between stores that genuinely hold
  // this account — confirmed against that store's OWN stored externalAccountId,
  // never the merchant's say-so.
  if (params.metadataStoreId && params.claimed && params.claimed.externalAccountId === params.eventAccount) {
    return { storeId: params.claimed.storeId, via: "metadata_confirmed" };
  }

  // Otherwise fall back to the account itself, which the merchant cannot forge.
  if (params.byAccount) {
    return { storeId: params.byAccount.storeId, via: "account_lookup" };
  }

  return { storeId: null, via: "unresolved" };
}
