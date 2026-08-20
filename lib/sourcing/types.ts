import type { IntegrationProvider, ProductSourceKind } from "@prisma/client";

// Where products come from — the contract every supplier implements (P0.5).
//
// WHY THIS EXISTS ALONGSIDE lib/fulfillment/. That layer is real and stays: it
// answers "which partner should print this, and what will it cost", and its
// FulfillmentConnector interface is shaped around exactly that — browse a
// catalog of blanks, put the owner's artwork on one, get a cost back. Every
// method assumes an image being applied to a product that does not exist yet.
//
// A wholesale supplier is the structural opposite. There is no artwork, nothing
// is created, and the thing already exists with a price and a photograph; the
// owner is choosing whether to resell it. Passing that through an interface
// built around `createProduct(candidate, imageUrl, retailPrice)` would mean
// either lying about the image or bolting optional-everything onto a contract
// that is currently honest.
//
// So this is the wider contract: a source declares what it can actually do, and
// callers branch on capability rather than on the supplier's name. Printful is
// registered through an adapter over the fulfillment connector it already has —
// nothing about that code changed.
//
// THE RULE THIS FILE DEFENDS: a source that cannot do something says so, and is
// never asked. No capability is inferred from a provider name anywhere in this
// module, because that is how "Printful means customisable" quietly becomes
// "every source means customisable" the moment a second one is added.

export interface SourceCapabilities {
  /** Can the owner's own artwork genuinely be put on this? Print-on-demand only. */
  customization: boolean;
  /** Does the source create a new listing on its side, or is it resold as-is? */
  createsListings: boolean;
  /** Does the supplier ship to the customer, or does the owner? */
  shipsDirect: boolean;
  /** Will the source quote a unit cost before anything is created? */
  quotesCost: boolean;
}

/**
 * Why a source cannot be used right now — never a silent empty result.
 *
 * A discovery run that returns nothing because a credential is missing must be
 * distinguishable from one that returns nothing because the catalog genuinely
 * had no fit. They lead to completely different next actions, and only one of
 * them is the owner's to take.
 */
export type SourceUnavailable =
  | { reason: "not_connected"; detail: string }
  | { reason: "not_configured"; detail: string; missing: string[] }
  | { reason: "provider_error"; detail: string };

/** What a source knows about the business it is searching on behalf of. */
export interface SourcingIntent {
  storeId: string;
  /** Free text drawn from the business's own words — never a raw user query. */
  keywords: string;
  /** A slug from lib/businessTaxonomy.ts. */
  brandPositioning: string;
  /** How many candidates the caller can usefully show. */
  limit: number;
}

/**
 * One thing a source is offering. Not a Product — the store does not sell it.
 */
export interface SourcedCandidate {
  sourceKey: string;
  externalProductId: string;
  externalVariantId: string | null;
  kind: ProductSourceKind;
  name: string;
  description: string | null;
  imageUrl: string | null;
  /** Null means UNKNOWN, and must never be rendered or reasoned about as zero. */
  unitCostInCents: number | null;
  suggestedRetailInCents: number | null;
  currency: string;
  customizable: boolean;
  /** Copied from the source, and recorded on the candidate so adoption need not
   *  re-resolve a source that may since have been de-registered. */
  fulfillmentProvider: IntegrationProvider | null;
}

export type SourceSearchResult =
  | { ok: true; candidates: SourcedCandidate[] }
  | ({ ok: false } & SourceUnavailable);

export interface ProductSource {
  /** Stable, lowercase, and what Product.sourceKey / SourcedProduct.sourceKey hold. */
  key: string;
  displayName: string;
  /** What every candidate from this source is. A source sells one shape. */
  kind: ProductSourceKind;
  capabilities: SourceCapabilities;
  /**
   * Which integration will actually fulfil an order for this, if any.
   *
   * Declared by the source rather than derived from it. The first version of
   * adoption wrote `createsListings ? "PRINTFUL" : null`, which was correct
   * exactly until a second print-on-demand partner existed — at which point
   * every product from it would have been labelled Printful and handed to
   * Printful's order routing.
   */
  fulfillmentProvider: IntegrationProvider | null;
  /**
   * What this source still needs before it can be used at all, in the operator's
   * terms. Empty when it is genuinely ready. Declared rather than discovered, so
   * "why is this source not returning anything" has an answer that does not
   * require making a request to find out.
   */
  blockedOn: string[];

  search(intent: SourcingIntent): Promise<SourceSearchResult>;

  /**
   * What one candidate actually costs — present if and only if
   * `capabilities.quotesCost` is true.
   *
   * Separate from search() because it is expensive per candidate (two HTTP
   * round trips on Printful) and discovery surfaces eight at a time. A cost is
   * fetched when somebody is genuinely interested, and until then the candidate
   * records an honest null.
   *
   * The "if and only if" is not a comment. verify-product-sourcing.ts asserts it
   * over the whole registry, because a source declaring a capability it does not
   * implement is exactly the kind of thing that reads as working right up until
   * a caller believes it.
   */
  quote?(params: { storeId: string; candidate: SourcedCandidate }): Promise<SourceQuoteResult>;
}

export interface SourceQuote {
  /** What the supplier charges for one, before shipping. */
  unitCostInCents: number;
  /** What the supplier charges to ship one, when it will say. */
  shippingInCents: number;
}

export type SourceQuoteResult = ({ ok: true } & SourceQuote) | ({ ok: false } & SourceUnavailable);

/**
 * How "this source has no variants" is stored.
 *
 * SourcedProduct.externalVariantId is NOT NULL because the unique key that makes
 * discovery idempotent has to hold for variant-less candidates too, and Postgres
 * treats NULLs in a unique index as distinct. The sentinel exists at exactly two
 * boundaries — here on the way in, and lib/sourcing/adopt.ts on the way out —
 * and nowhere in between, so no other code has to know about it.
 */
export const NO_VARIANT = "";

export function toVariantKey(externalVariantId: string | null): string {
  return externalVariantId ?? NO_VARIANT;
}

export function fromVariantKey(key: string): string | null {
  return key === NO_VARIANT ? null : key;
}
