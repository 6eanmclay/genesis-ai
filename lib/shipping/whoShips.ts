import type { ProductSourceKind } from "@prisma/client";

// WHO PUTS THIS IN A BOX.
//
// ProductSourceKind has said this since 2026-08-20, in its own schema comments:
// PRINT_ON_DEMAND is "printed or customised per order by a partner, WHO SHIPS
// IT"; WHOLESALE_DROPSHIP is one the "owner never touches and never buys a
// label for"; DIGITAL is "nothing ships. No parcel, no label, no address."
//
// Nothing read any of it. So every product, however it was sourced, was asked
// for a packaged weight and packaged dimensions the owner could not possibly
// know — a Printful t-shirt's parcel is packed in Printful's warehouse — and
// would have been offered a Buy Label button for a box that is not in the
// building.
//
// PURE, and derived from a fact the product already carries. No new column, no
// new concept, and nothing inferred from the connector's name: `sourceKind` is
// an enum precisely so that "every value here changes what other code must do,
// and a value nobody handles should fail to compile rather than fall through".

export type ShippedBy =
  /** The owner packs it and buys the label. Cubit & Coil's tensor rings. */
  | "OWNER"
  /** A partner prints/holds and ships it. The owner never sees the parcel. */
  | "PARTNER"
  /** Nothing ships at all. */
  | "NOBODY";

/**
 * Who ships a product of this kind.
 *
 * EXHAUSTIVE BY CONSTRUCTION — the switch has no default, so adding a source
 * kind without deciding who ships it fails to compile rather than silently
 * defaulting to "the owner does", which would put a weight field and a Buy
 * Label button in front of somebody who cannot use either.
 */
export function shippedBy(sourceKind: ProductSourceKind | null): ShippedBy {
  // Null is every product that predates sourcing, and every manually created
  // one. Those genuinely are owner-shipped — the default records what is
  // already true rather than guessing.
  if (sourceKind === null) return "OWNER";

  switch (sourceKind) {
    case "OWNER_MADE":
    case "WHOLESALE_STOCKED":
    case "PRIVATE_LABEL":
    case "CONTRACT_MANUFACTURED":
      return "OWNER";
    case "PRINT_ON_DEMAND":
    case "WHOLESALE_DROPSHIP":
      return "PARTNER";
    case "DIGITAL":
      return "NOBODY";
  }
}

/**
 * Is the owner the one who packs this, and therefore the one who has to say
 * what it weighs?
 *
 * The single question the product form, the checkout shipping gate and the
 * label button all actually want answered.
 */
export function ownerPacksThis(sourceKind: ProductSourceKind | null): boolean {
  return shippedBy(sourceKind) === "OWNER";
}

/**
 * Why this product has no packaging details, said to the owner in their terms.
 *
 * Returns null when the owner DOES pack it, because then there is nothing to
 * explain and the fields belong on screen.
 */
export function packagingHandledBy(
  sourceKind: ProductSourceKind | null,
  partnerName: string | null
): string | null {
  switch (shippedBy(sourceKind)) {
    case "OWNER":
      return null;
    case "PARTNER":
      return `${partnerName ?? "Your fulfilment partner"} packs and ships this, so its weight and box size are theirs, not yours.`;
    case "NOBODY":
      return "Nothing ships for this product, so it has no packaging.";
  }
}
