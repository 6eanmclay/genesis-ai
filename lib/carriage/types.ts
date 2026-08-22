import type { IntegrationProvider } from "@prisma/client";
import type { Shipment } from "@/lib/businessModel/entities";
import type { LabelRequest, PurchasedLabel } from "@/lib/shipping/labelPurchase";

// WHO MOVES THE PARCEL (Shipping & Fulfilment, S1 and S2 approved 2026-08-22).
//
// CARRIAGE, NOT FULFILMENT, and the distinction is why this directory exists
// rather than living in lib/fulfillment/. That module is the SUPPLIER layer —
// Printful, print-on-demand, who MAKES the product and ships it on the store's
// behalf. This is about who CARRIES a parcel the owner is sending themselves.
// Two different things sharing one word in one codebase is how somebody later
// wires the wrong one, so S2 kept them apart by name.
//
// A PROVIDER IS NOT A CARRIER. S1, approved: the abstraction is over the
// broker — EasyPost today, Shippo or a direct account later — not over USPS
// versus UPS. EasyPost is itself the multi-carrier layer, and the rate path
// already passes whatever carrier it quotes straight through, so abstracting
// carriers would have been renaming rather than architecture.
//
// GENERALITY IS UNPROVEN AND SAID SO PLAINLY (S6). One implementation exists.
// An interface with a single implementation is a hypothesis about the second
// one, and this file does not pretend otherwise — the capability map below is
// the honest half of that hypothesis, because the thing a second provider is
// most likely to differ on is what it cannot do.

/**
 * What a provider can actually do.
 *
 * Declared rather than assumed, because "call it and see" fails at the counter
 * with somebody's money involved. Some brokers cannot void a label once
 * bought; some have no tracking webhook at all and must be polled. A caller
 * asks before offering the owner a button.
 */
export interface CarriageCapabilities {
  /** Live rate quotes for a real destination. */
  quotesRates: boolean;
  /** Buying a real label, which spends real postage. */
  buysLabels: boolean;
  /** Pushes tracking updates to us, rather than needing to be polled. */
  pushesTrackingUpdates: boolean;
  /** Cancelling a bought label and reclaiming the postage. Out of v1 (S4). */
  voidsLabels: boolean;
}

/**
 * One shipping provider.
 *
 * Every method is optional except `capabilities` and `id`: a provider that
 * cannot buy labels simply does not implement `buyLabel`, and the capability
 * map says so before anyone calls it. That is deliberately more honest than a
 * method that exists and throws.
 */
export interface CarriageProvider {
  /** The integration this provider's credentials live under. */
  id: IntegrationProvider;
  /** Never shown to an owner — Genesis talks about "shipping", not brand names. */
  internalName: string;
  capabilities: CarriageCapabilities;

  // NO quoteRates, DELIBERATELY, and this is the smallest-correct-change line
  // of this whole milestone. Quoting already runs through ONE carrier-agnostic
  // path — quoteShippingForProduct resolves the store, the product and the
  // origin itself and passes whatever carrier the broker returns straight
  // through. Wrapping that in a provider method would mean re-plumbing
  // checkout, which this milestone's contract explicitly protects, to gain a
  // seam nothing is asking for yet. `quotesRates` in the capability map above
  // still records whether a provider CAN, so a second one that cannot is
  // describable before any of this is refactored.

  /** Buy one label. Spends real money, and is never called automatically. */
  buyLabel?(apiKey: string, request: LabelRequest): Promise<PurchasedLabel>;

  /**
   * Turn this provider's own tracking payload into the canonical Shipment.
   *
   * Pure and synchronous on purpose: it is the half of delivery tracking that
   * can be proved without an account, and it already existed for EasyPost
   * (mapTrackerToShipment) with its own suite. Reused rather than rebuilt.
   */
  toShipment?(payload: unknown, orderId: string | null): Shipment;
}
