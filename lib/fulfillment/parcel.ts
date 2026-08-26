import type { IntegrationProvider } from "@prisma/client";
import { getFulfillmentConnector } from "./registry";

// PACKAGING FROM THE PARTNER, WHENEVER THE PARTNER ACTUALLY KNOWS IT.
//
// The requirement is that a product created or imported from a print-on-demand
// partner should never need its weight and box size typed in by hand.
//
// ============================ WHAT THE PARTNERS RETURN =====================
//
// Checked against both providers' own documentation on 2026-08-26, field by
// field, rather than assumed:
//
//   Printful, v1 GET /products/{id} — variants carry id, product_id, name,
//   size, color, color_code, color_code2, image, price, in_stock,
//   availability_regions, availability_status, material. The product level
//   carries id, main_category_id, type, type_name, title, brand, model, image,
//   variant_count, currency, files, options, is_discontinued,
//   avg_fulfillment_time, description, techniques, origin_country.
//   NO weight. NO package dimensions.
//
//   Printful, v2 catalog — the only dimensions are `placement_dimensions`,
//   which are PRINT AREAS for artwork placement, not a box.
//
//   Printify, v1 catalog variants — id, title, options, placeholders,
//   decoration_methods. `placeholders` carries height and width IN PIXELS, for
//   the printable area. Again not a box.
//
// So neither partner exposes a parcel today. That is a fact about their APIs,
// not a gap in this file, and the honest response to it is to return null.
// Writing a print area into lengthIn would be exactly the invented number that
// lib/shipping/packagedWeight.ts exists to remove — and an invented parcel
// becomes real postage on a real customer's order.
//
// ============================ WHY THIS EXISTS ANYWAY =======================
//
// Two reasons. It is the seam: a connector that CAN answer only has to
// implement getParcel, and every creation path below already writes what it
// returns — no call site changes when a partner adds the field or a partner
// that has it is added.
//
// And it makes the absence legible. Before this, "Printful products have no
// weight" was indistinguishable from "nobody wired weight up yet".

export interface PartnerParcel {
  /** Packaged weight in ounces, or null if the partner does not say. */
  weightOz: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
}

/** Nothing usable came back. Distinct from a parcel of zeroes. */
export const NO_PARTNER_PARCEL: PartnerParcel = {
  weightOz: null,
  lengthIn: null,
  widthIn: null,
  heightIn: null,
};

/** True when at least one measurement is present and usable. */
export function hasAnyMeasurement(parcel: PartnerParcel): boolean {
  return [parcel.weightOz, parcel.lengthIn, parcel.widthIn, parcel.heightIn].some(
    (value) => typeof value === "number" && value > 0
  );
}

/**
 * Only the measurements that are genuinely present, as Prisma data.
 *
 * A partner that knows a weight but not a box contributes the weight and
 * leaves the dimensions alone, rather than writing three nulls over anything.
 * All three dimensions or none, for the reason parsePackagedDimensions gives:
 * two of three leaves the rating code substituting a default for the third.
 */
export function parcelToProductData(parcel: PartnerParcel): {
  weightOz?: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
} {
  const data: { weightOz?: number; lengthIn?: number; widthIn?: number; heightIn?: number } = {};
  if (typeof parcel.weightOz === "number" && parcel.weightOz > 0) data.weightOz = parcel.weightOz;

  const { lengthIn, widthIn, heightIn } = parcel;
  const complete = [lengthIn, widthIn, heightIn].every((v) => typeof v === "number" && v > 0);
  if (complete) {
    data.lengthIn = lengthIn as number;
    data.widthIn = widthIn as number;
    data.heightIn = heightIn as number;
  }
  return data;
}

/**
 * Ask the partner what this variant's parcel is.
 *
 * NEVER THROWS. A partner outage, a retired variant or a connector with no
 * opinion all mean the same thing here — no packaging was learned — and none of
 * them may stop a product being created. The owner can always type it in.
 */
export async function partnerParcelFor(params: {
  provider: IntegrationProvider | null;
  storeId: string | null;
  storeDraftId: string | null;
  externalProductId: string | null;
  externalVariantId: string | null;
}): Promise<PartnerParcel> {
  if (!params.provider || !params.externalProductId) return NO_PARTNER_PARCEL;

  const connector = getFulfillmentConnector(params.provider);
  if (!connector?.getParcel) return NO_PARTNER_PARCEL;

  try {
    return (
      (await connector.getParcel({
        storeId: params.storeId,
        storeDraftId: params.storeDraftId,
        externalProductId: params.externalProductId,
        externalVariantId: params.externalVariantId,
      })) ?? NO_PARTNER_PARCEL
    );
  } catch {
    return NO_PARTNER_PARCEL;
  }
}
