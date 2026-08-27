import type { Garment, GarmentVariant, CreationProvider } from "./garment";
import { brandFromTitle } from "./garment";
import type { PrintArea } from "./design";

// PRINTFUL, AS A PLACE TO DESIGN ON.
//
// Verified against Printful's own v2 documentation on 2026-08-27. Every field
// mapped below is one their API actually returns; nothing here is a shape that
// seemed likely.
//
//   GET /v2/catalog-products/{id}
//     → placements: [{ placement, technique, layers }]
//
//   GET /v2/catalog-products/{id}/catalog-variants
//     → id, size, color, color_code (hex), image, and placement_dimensions
//
// ============ V2, WHILE FULFILMENT STAYS ON V1 ===========================
//
// lib/fulfillment/printful.ts talks to v1 and keeps doing so. That is not
// indecision: v1 is what has been taking real money through createProduct and
// createDraftOrder, and moving a working payment path onto a beta API to gain
// print areas it does not need would be trading a certainty for a convenience.
//
// v2 is used HERE because it is the only version that answers the question
// Creation Station asks — v1 exposes no placement dimensions at all. The two
// versions share credentials and the same request boundary, so this is a second
// endpoint rather than a second integration.
//
// ============ WHAT IS PROVIDER-DEPENDENT, SAID PLAINLY ===================
//
// Nothing in this file can be exercised without a connected Printful account.
// The mapping functions below are exported separately from the fetching for
// exactly that reason: what a response MEANS is provable from a recorded shape,
// and only the fetch itself needs credentials.


// ============ THE SHAPES PRINTFUL SENDS ==================================

interface PrintfulV2Placement {
  placement?: string;
  technique?: string;
}

interface PrintfulV2Product {
  id?: number;
  name?: string;
  type?: string;
  description?: string;
  image?: string;
  placements?: PrintfulV2Placement[];
}

interface PrintfulV2PlacementDimension {
  placement?: string;
  width?: number;
  height?: number;
}

interface PrintfulV2Variant {
  id?: number;
  size?: string;
  color?: string;
  color_code?: string;
  image?: string;
  /** A decimal string in the catalogue's currency, where quoted. */
  price?: string;
  placement_dimensions?: PrintfulV2PlacementDimension[];
}

// ============ MAPPING, WHICH NEEDS NO ACCOUNT ============================

/** Cents from Printful's decimal price string, or null where unreadable. */
export function priceToCents(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function toVariant(raw: PrintfulV2Variant): GarmentVariant | null {
  if (raw.id === undefined || !raw.color || !raw.size) return null;
  return {
    externalVariantId: String(raw.id),
    color: raw.color,
    // A HEX OR NULL, never a colour name pretending to be one. Printful sends
    // "#14191e"; a swatch painted from an unparseable value would be a lie
    // about what the garment looks like.
    colorHex: /^#[0-9a-f]{3,8}$/i.test(raw.color_code ?? "") ? raw.color_code! : null,
    size: raw.size,
    imageUrl: raw.image ?? null,
    costInCents: priceToCents(raw.price),
  };
}

/**
 * The print areas of a garment, from its variants.
 *
 * ============ WHY THIS READS VARIANTS AND NOT THE PRODUCT ================
 *
 * The product tells you WHICH placements exist; only a variant carries their
 * DIMENSIONS. And they genuinely differ by size — a 15" wide front on a 3XL is
 * not the 15" front of an XS — so there is no single answer for a garment.
 *
 * This takes the dimensions from the FIRST variant that states them and says so
 * here rather than implying a garment has one print area. It is right for the
 * common case and it is an approximation; the honest fix, when sizes need to
 * differ, is to re-read areas when the size changes rather than to average them
 * into a number belonging to no garment anyone can buy.
 */
export function toPrintAreas(variants: PrintfulV2Variant[]): PrintArea[] {
  for (const variant of variants) {
    const dims = variant.placement_dimensions ?? [];
    const areas = dims
      .filter((d) => d.placement && typeof d.width === "number" && typeof d.height === "number")
      .map((d) => ({
        placement: d.placement!,
        width: d.width!,
        height: d.height!,
        // Printful states these in inches for DTG. Carried, never converted —
        // the design model is normalised, so the unit only ever travels back
        // out to the same supplier that named it.
        unit: "in",
      }));
    if (areas.length > 0) return areas;
  }
  return [];
}

export function toGarment(
  product: PrintfulV2Product,
  variants: PrintfulV2Variant[],
): Garment | null {
  if (product.id === undefined || !product.name) return null;
  const mapped = variants.map(toVariant).filter((v): v is GarmentVariant => v !== null);
  const areas = toPrintAreas(variants);

  // A blank with no variants cannot be bought and a blank with no print areas
  // cannot be designed on. Either one makes it useless HERE, whatever else it
  // is — and offering it anyway would be a garment that dead-ends.
  if (mapped.length === 0 || areas.length === 0) return null;

  return {
    provider: "PRINTFUL",
    externalProductId: String(product.id),
    name: product.name,
    type: product.type ?? null,
    brand: brandFromTitle(product.name),
    description: product.description ?? null,
    imageUrl: product.image ?? null,
    variants: mapped,
    printAreas: areas,
  };
}

// ============ THE PART THAT NEEDS A CONNECTED ACCOUNT ====================

/**
 * The Printful creation provider.
 *
 * Takes its fetcher as an argument rather than importing one, so the mapping
 * above can be proven against recorded responses and this file needs no test
 * double of its own.
 */
export function printfulCreationProvider(
  fetchJson: (storeId: string, operation: string, path: string) => Promise<unknown>,
): CreationProvider {
  return {
    provider: "PRINTFUL",

    async listGarments({ storeId, keywords }) {
      const body = (await fetchJson(storeId, "creation.catalog", "/catalog-products?limit=100")) as {
        data?: PrintfulV2Product[];
      } | null;
      const products = body?.data ?? [];

      // Filtered to what can actually be designed on, and by the owner's words
      // where they gave any. Matching is deliberately shallow — Printful's
      // catalogue has no semantic search, and pretending otherwise is the same
      // overclaim lib/fulfillment/printful.ts already names in its own header.
      const wanted = keywords?.toLowerCase().trim();
      const matching = wanted
        ? products.filter((p) => `${p.name ?? ""} ${p.type ?? ""}`.toLowerCase().includes(wanted))
        : products;

      const garments: Garment[] = [];
      for (const product of matching.slice(0, 24)) {
        const garment = await this.getGarment({ storeId, externalProductId: String(product.id) });
        if (garment) garments.push(garment);
      }
      return garments;
    },

    async getGarment({ storeId, externalProductId }) {
      const [productBody, variantBody] = await Promise.all([
        fetchJson(storeId, "creation.product", `/catalog-products/${externalProductId}`) as Promise<{
          data?: PrintfulV2Product;
        } | null>,
        fetchJson(
          storeId,
          "creation.variants",
          `/catalog-products/${externalProductId}/catalog-variants?limit=100`,
        ) as Promise<{ data?: PrintfulV2Variant[] } | null>,
      ]);

      const product = productBody?.data;
      if (!product) return null;
      return toGarment(product, variantBody?.data ?? []);
    },
  };
}

