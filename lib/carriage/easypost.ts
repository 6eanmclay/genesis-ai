import { buyLabelViaEasyPost } from "@/lib/shipping/labelPurchase";
import { mapTrackerToShipment, type TrackerLike } from "@/lib/integrations/easypost";
import type { CarriageProvider } from "./types";

// EASYPOST, AS A CARRIAGE PROVIDER.
//
// WRAPS, NEVER REBUILDS. Both real behaviours already existed and both are
// already covered: buyLabelViaEasyPost is the concrete LabelBuyer the purchase
// path has always used, and mapTrackerToShipment is a pure tracker-to-Shipment
// mapper with its own suite (verify-easypost-shipments.ts). Reimplementing
// either behind this interface would have meant two versions of a money path
// and two versions of a delivery vocabulary, with the drifted one being
// whichever nobody was reading.
//
// So this file is thin on purpose. It is the place a SECOND provider becomes
// possible, not a rewrite of the first.
//
// EasyPost is itself a multi-carrier broker — USPS, UPS, FedEx and others — so
// "which carrier" is a property of the rate it returns, never of this module.
// Nothing here mentions a carrier by name.

export const easypostCarriageProvider: CarriageProvider = {
  id: "EASYPOST",
  internalName: "EasyPost",
  capabilities: {
    quotesRates: true,
    buysLabels: true,
    // TRUE, AND THE INGESTION FOR IT IS BUILT — see app/api/webhooks/easypost.
    // Whether real events arrive is a question about an account, not about
    // this capability: the handler exists and is verified against real payload
    // shapes.
    pushesTrackingUpdates: true,
    // S4, approved: voiding is out of v1. Declared false rather than left
    // unimplemented-and-unmentioned, so a caller can tell "we chose not to"
    // from "this provider cannot".
    voidsLabels: false,
  },

  buyLabel: buyLabelViaEasyPost,

  toShipment(payload: unknown, orderId: string | null) {
    // The payload is whatever arrived on the wire. mapTrackerToShipment already
    // treats every field as optional and refuses to invent anything — a parcel
    // with no scans gets null timestamps rather than the order date standing in
    // — so the cast is narrowing to the shape it already tolerates, not a claim
    // that the payload is well-formed.
    return mapTrackerToShipment(payload as TrackerLike, orderId);
  },
};
