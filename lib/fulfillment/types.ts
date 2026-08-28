import type { IntegrationProvider } from "@prisma/client";
import type { PartnerParcel } from "./parcel";

// Onboarding v2 — the provider-agnostic fulfillment-strategy layer. See
// ONBOARDING_V2_DESIGN.md section 6: the owner never chooses between
// fulfillment providers by name — Genesis evaluates the registered
// connectors internally (lib/fulfillment/strategy.ts) and recommends a
// strategy explained in business terms. Deliberately a SEPARATE interface
// from lib/integrations/types.ts's IntegrationConnector: that interface's
// sync() pulls a store's own data out of a system it already owns and
// writes read-only into BusinessRecord; a fulfillment connector pulls a
// THIRD PARTY's catalog and writes into typed Product rows, plus creates
// draft orders — the structural opposite on every axis (see
// ONBOARDING_V2_DESIGN.md section 3(b)).
//
// Fulfillment is one execution strategy, not something the platform is
// permanently centered around (Sean's own words, ONBOARDING_V2_DESIGN.md
// section 11) — this module is the ecommerce path's own strategy
// implementation. The generic discovery-flow orchestrator
// (lib/onboarding/discoveryFlow.ts) invokes it only when business-model
// classification resolves to a product-selling revenue stream, and never
// imports its internals otherwise. A future services/bookings strategy
// gets its own sibling module, never routed through this one.

// A slug from lib/businessTaxonomy.ts's BRAND_POSITIONING_TYPES — kept as
// a plain string (not a literal union) for the same "small, open,
// additive" reason that taxonomy itself isn't a Prisma enum.
export type BrandPositioningSlug = string;

export interface FulfillmentPartnerProfile {
  provider: IntegrationProvider; // never shown to the owner — see the mental-model rule below
  displayName: string; // internal/support use only — same rule
  qualityTier: "standard" | "premium";
  costTier: "budget" | "mid" | "premium";
  // Which brand positionings this partner is a genuinely good fit for —
  // used by selectFulfillmentStrategy's scoring, not just descriptive.
  brandFit: BrandPositioningSlug[];
}

export interface FulfillmentVariant {
  externalVariantId: string;
  name: string; // e.g. a size/color combination
}

export interface FulfillmentCandidate {
  provider: IntegrationProvider; // which connector this came from — internal bookkeeping only, never rendered
  externalProductId: string;
  name: string;
  description: string;
  imageUrl: string | null;
  // v1 deliberately selects one representative variant per candidate — no
  // variant-selection UI, no variant model on Product (see
  // ONBOARDING_V2_IMPLEMENTATION.md section 3).
  variant: FulfillmentVariant;
}

export interface FulfillmentCostEstimate {
  costInCents: number; // the partner's own cost to us, not a retail price
  shippingInCents: number;
  totalCostInCents: number;
}

export interface FulfillmentOrderResult {
  externalOrderId: string;
  // Present only when the partner's own API computes it for us (confirmed
  // true for Printful's draft-order response) — never invented locally
  // when a connector doesn't provide it.
  costBreakdown: { totalCostInCents: number; retailInCents: number; profitInCents: number } | null;
}

export interface FulfillmentConnector {
  provider: IntegrationProvider;
  profile: FulfillmentPartnerProfile;

  /**
   * What this variant's PARCEL is — packaged weight and box size — so a
   * product created from this partner never needs them typed in.
   *
   * OPTIONAL, because most partners genuinely cannot answer. Printful's and
   * Printify's catalog APIs were both checked field by field on 2026-08-26 and
   * neither returns a weight or a box; the only dimensions either exposes are
   * print areas for artwork placement. A connector that cannot answer omits
   * this rather than returning a guess — see lib/fulfillment/parcel.ts, which
   * treats absence and failure identically and never throws.
   */
  getParcel?(params: {
    storeId: string | null;
    storeDraftId: string | null;
    externalProductId: string;
    externalVariantId: string | null;
  }): Promise<PartnerParcel | null>;

  browseCandidates(params: {
    storeId: string | null;
    storeDraftId: string | null;
    brandPositioning: BrandPositioningSlug;
    keywords?: string;
  }): Promise<FulfillmentCandidate[]>;

  getCost(params: {
    storeId: string | null;
    storeDraftId: string | null;
    candidate: FulfillmentCandidate;
  }): Promise<FulfillmentCostEstimate>;

  createProduct(params: {
    storeId: string | null;
    storeDraftId: string | null;
    candidate: FulfillmentCandidate;
    imageUrl: string;
    retailPriceInCents: number;
  }): Promise<{ externalProductId: string }>;

  /**
   * Create a product on an EXACT variant, with artwork on several placements.
   *
   * ============ WHY THIS IS NOT createProduct (2026-08-28) =============
   *
   * createProduct above takes a `candidate` — something discovery found — and a
   * single `imageUrl` with nothing saying where it prints. That is right for
   * the path it serves, where J4 chose the blank. It is wrong for the Creation
   * Station, where the owner chose the colour and the size themselves and put
   * artwork on named sides.
   *
   * Sean: "Create must take the saved/current design, create the product with
   * the connected print supplier using the exact variant/color/size and all
   * selected placements... If the owner puts artwork on front and back, Create
   * needs to create the actual two-sided product — not silently reduce it to
   * one placement."
   *
   * So the variant is passed rather than searched for, and files are a list
   * rather than one URL.
   *
   * ============ VERIFICATION IS PART OF THE RETURN ====================
   *
   * `placements` is what the SUPPLIER says it recorded, read back after the
   * write — not an echo of what was sent. A creation call that does not throw
   * is not evidence that a back print exists, and the whole reason this
   * interface exists is that the back must not be silently dropped. The caller
   * compares the two and treats a mismatch as a failure.
   *
   * OPTIONAL, because a partner may genuinely not support multi-placement
   * creation. Absent means the Creation Station cannot offer Create through
   * that partner, which is a true statement to make rather than a reduced
   * product to create.
   */
  createProductWithPlacements?(params: {
    storeId: string | null;
    storeDraftId: string | null;
    name: string;
    retailPriceInCents: number;
    /**
     * Every variant to create the product in — one colourway, all its sizes.
     *
     * A LIST, because the size someone designs against is not the only size
     * they sell. The reference variant is the first entry; the supplier is
     * asked for all of them so a customer can eventually choose.
     */
    externalVariantIds: string[];
    /** One print-ready file per placement, named as the supplier names them. */
    files: { placement: string; url: string }[];
  }): Promise<{
    externalProductId: string;
    /** Placements the supplier confirms it holds, read back after creating. */
    placements: string[];
  }>;

  // Deliberately a DRAFT order — never confirmed/published from this
  // interface. See lib/fulfillment/printful.ts for the specific mechanism
  // that keeps this safe (Printful's confirm: false / no separate confirm
  // call). Automatic order-to-supplier routing on a real customer purchase
  // is explicit non-goal, ONBOARDING_V2_DESIGN.md section 9.
  //
  // `imageUrl` is required, same as createProduct — a real finding from
  // live validation: a catalog candidate's own `imageUrl` (a mockup
  // preview) is NOT a valid print file (Printful rejects it, "file URL is
  // not a valid URL" — no recognized image extension). Callers pass a real
  // print-ready image the same way createProduct needs one; this is a cost
  // PREVIEW during discovery, so a placeholder is acceptable here in a way
  // it wouldn't be for createProduct's real, final product creation.
  createDraftOrder(params: {
    storeId: string | null;
    storeDraftId: string | null;
    candidate: FulfillmentCandidate;
    imageUrl: string;
    retailPriceInCents: number;
  }): Promise<FulfillmentOrderResult>;
}
