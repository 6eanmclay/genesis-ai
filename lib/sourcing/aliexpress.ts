import type { ProductSource, SourceSearchResult } from "./types";

// AliExpress, as a wholesale/dropship source.
//
// DECLARED, AND DELIBERATELY NOT IMPLEMENTED AGAINST A FAKE CATALOG. Sean's own
// instruction for P0.5 was to build the model so additional suppliers can be
// added cleanly, and not to stop at a mock catalog. A mock catalog would be the
// worse of the two failures available here: it would make the system look
// finished while every product in it was invented, and the first real
// integration would have to unpick a set of behaviours nobody had ever
// validated. lib/integrations/catalog.ts already carries the same rule for
// connectors that are named but not built.
//
// What this entry IS for: it is the second SHAPE. Printful creates a listing
// with the owner's artwork on it; a wholesale supplier creates nothing and
// customises nothing — the item already exists, with a price and a photograph,
// and the owner is deciding whether to resell it. Declaring that shape now is
// what proves the contract in ./types.ts holds more than print-on-demand, and
// what the discovery and adoption paths are written against.
//
// It returns not_configured with the credentials it actually needs. It never
// returns an empty success, because "no results" and "I was never able to look"
// are different answers with different next actions, and only one of them is
// the owner's.
export const ALIEXPRESS_REQUIRED_CREDENTIALS = ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"];

export const aliexpressSource: ProductSource = {
  key: "aliexpress",
  displayName: "AliExpress",
  kind: "WHOLESALE_DROPSHIP",
  capabilities: {
    // The line that matters. Nothing about a wholesale listing is customisable,
    // and offering "add your logo" on one would be a promise to a customer that
    // the supplier has no idea was made.
    customization: false,
    createsListings: false,
    shipsDirect: true,
    quotesCost: true,
  },
  // Nobody fulfils on Genesis's behalf here — the supplier ships to the
  // customer directly and no connector routes anything to them.
  fulfillmentProvider: null,
  blockedOn: ALIEXPRESS_REQUIRED_CREDENTIALS,

  async search(): Promise<SourceSearchResult> {
    return {
      ok: false,
      reason: "not_configured",
      detail:
        "AliExpress sourcing needs an AliExpress Open Platform app before its catalog can be searched. Nothing is being shown from it rather than showing invented products.",
      missing: ALIEXPRESS_REQUIRED_CREDENTIALS,
    };
  },
};
