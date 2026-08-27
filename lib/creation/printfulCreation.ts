import type { Garment, GarmentVariant, CreationProvider, BlankImage } from "./garment";
import { brandFromTitle } from "./garment";
import type { PrintArea } from "./design";
import {
  withSellingRegion,
  PRINTFUL_MAX_LIMIT,
  PRINTFUL_MAX_IMAGE_LIMIT,
} from "./printfulRequest";

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

    // ============ ONE CALL, AND IT IS THE ONLY CHEAP ONE ==============
    //
    // Printful's index returns id, name, type and a photograph for up to 100
    // products at once. That is everything needed to decide WHAT to make and
    // to choose WHICH blank — so both of those screens now cost exactly one
    // request, where together they used to cost forty-nine.
    async listBlanks({ storeId }) {
      const body = (await fetchJson(
        storeId,
        "creation.catalog",
        withSellingRegion(`/catalog-products?limit=${PRINTFUL_MAX_LIMIT}`),
      )) as { data?: PrintfulV2Product[] } | null;

      return (body?.data ?? [])
        .filter((p): p is PrintfulV2Product & { id: number } => typeof p.id === "number")
        .map((p) => ({
          externalProductId: String(p.id),
          name: p.name ?? "",
          type: p.type ?? null,
          imageUrl: p.image ?? null,
        }));
    },

    // ============ AND THE EXPENSIVE ONE, ON NAMED IDS ONLY ============
    //
    // Two requests per blank, so the caller passes the ids somebody is
    // actually going to be shown rather than a slice of the whole catalogue.
    //
    // SEQUENTIAL, DELIBERATELY. Printful allows 120 requests a minute and
    // restores them at two per second; firing a dozen blanks in parallel is
    // how a shelf spends the whole allowance in one burst and then fails for
    // everybody else using this account. A shelf of a handful is fast enough
    // in order, and one that is not is a reason to show fewer.
    async getGarments({ storeId, externalProductIds }) {
      const garments: Garment[] = [];
      for (const externalProductId of externalProductIds) {
        const garment = await this.getGarment({ storeId, externalProductId });
        if (garment) garments.push(garment);
      }
      return garments;
    },

    // ============ WHAT PRINTFUL CHARGES, FROM PRINTFUL ================
    //
    // catalog-variants carries no price — their own reference lists the fields
    // and price is not among them — which is why every product showed the same
    // placeholder. This is where the number actually lives.
    //
    // Their documented shape puts the blank's own cost under
    // variant.techniques[].price and the cost of PRINTING under
    // product.placements[].price. Only the first is the supplier price for the
    // blank; the second is a charge for a decoration that has not been chosen
    // yet, and adding them together would invent a number for a product nobody
    // has finished designing.
    //
    // Walked rather than indexed, for the same reason as the blank images: the
    // reference has been wrong twice, and a price read from the wrong field is
    // worse than no price at all — so anything ambiguous is left out.
    async getSupplierPrices({ storeId, externalProductId }) {
      const body = (await fetchJson(
        storeId,
        "creation.prices",
        withSellingRegion(`/catalog-products/${externalProductId}/prices`),
      )) as { data?: unknown } | null;

      const payload = (body?.data ?? body) as Record<string, unknown> | null;
      const out: Record<string, number> = {};
      if (!payload || typeof payload !== "object") return out;

      const variants = Array.isArray(payload.variants)
        ? (payload.variants as unknown[])
        : payload.variant
          ? [payload.variant]
          : [];

      for (const entry of variants) {
        if (!entry || typeof entry !== "object") continue;
        const v = entry as Record<string, unknown>;
        const id = v.id ?? v.catalog_variant_id;
        if (typeof id !== "number" && typeof id !== "string") continue;

        // The cheapest technique is the blank's own price: a technique is a way
        // of decorating, and the owner has not picked one. Taking the lowest is
        // the honest floor rather than a guess at which they will use.
        const techniques = Array.isArray(v.techniques) ? (v.techniques as unknown[]) : [];
        const prices = techniques
          .map((tech) =>
            tech && typeof tech === "object"
              ? priceToCents((tech as Record<string, unknown>).price as string | undefined)
              : null,
          )
          .filter((c): c is number => c !== null);
        const direct = priceToCents(v.price as string | undefined);
        const cents = prices.length > 0 ? Math.min(...prices) : direct;
        if (cents !== null) out[String(id)] = cents;
      }
      return out;
    },

    // ============ THE BLANK ITSELF, FOR THE CANVAS ====================
    //
    // Printful's own words for this endpoint's imagery: blank images are
    // "transparent and require the developer to overlay them on top of the
    // color defined on the resource."
    //
    // ============ PARSED BY SHAPE, NOT BY FAITH =======================
    //
    // Printful's published reference has been wrong twice today — it omitted
    // selling_region_name from an endpoint that rejects requests without it,
    // and it does not spell out this response at all. So this walks whatever
    // comes back and collects anything that carries a placement and a URL,
    // rather than reaching for field names nobody has verified.
    //
    // When it finds nothing it says WHAT IT GOT — the shape's own keys, never
    // its values — because the alternative is another round of guessing at a
    // response only a connected account can see.
    async getBlankImages({ storeId, externalProductId }) {
      const body = await fetchJson(
        storeId,
        "creation.blanks",
        // TWENTY, not a hundred — this endpoint's own ceiling. See
        // PRINTFUL_MAX_IMAGE_LIMIT for the 400 that established it.
        withSellingRegion(
          `/catalog-products/${externalProductId}/images?limit=${PRINTFUL_MAX_IMAGE_LIMIT}`,
        ),
      );

      const found: BlankImage[] = [];
      const seen = new Set<string>();

      const walk = (
        node: unknown,
        placement: string | null,
        colorCode: string | null,
        colorName: string | null,
      ): void => {
        if (Array.isArray(node)) {
          for (const entry of node) walk(entry, placement, colorCode, colorName);
          return;
        }
        if (!node || typeof node !== "object") return;
        const obj = node as Record<string, unknown>;

        // Placement and colour are inherited downward: Printful nests images
        // under the variant or placement they belong to.
        const nextPlacement =
          typeof obj.placement === "string" ? obj.placement : placement;
        // A HEX AND A NAME ARE DIFFERENT FACTS. Collapsing them into one
        // string and then testing it against a hex pattern is what threw the
        // names away: "Black" failed the test, became null, and every blank
        // looked colour-neutral.
        const nextCode = typeof obj.color_code === "string" ? obj.color_code : colorCode;
        const nextName = typeof obj.color === "string" ? obj.color : colorName;

        // ANY string that is an image, under any key.
        //
        // WIDENED (2026-08-27) after the first live run produced no blank at
        // all. The previous version looked under four key names I had guessed
        // — image_url, url, image, src — which is the same mistake as trusting
        // the published schema, one level down. Printful's real response may
        // key these as mockup_url, thumbnail_url, or nest them in a list of
        // plain strings, and none of those would have been seen.
        //
        // So: anything that looks like an image URL counts, wherever it sits.
        // A false positive is a picture of the right product from the wrong
        // field; a false negative is a blank canvas, which is what happened.
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value !== "string" || !/^https?:\/\//.test(value)) continue;
          const looksLikeImage =
            /\.(png|jpe?g|webp|avif)(\?|$)/i.test(value) || /image|url|src|mockup|thumb/i.test(key);
          if (!looksLikeImage || seen.has(value)) continue;
          seen.add(value);
          found.push({
            placement: nextPlacement ?? "front",
            colorCode: nextCode && /^#?[0-9a-f]{3,8}$/i.test(nextCode) ? nextCode : null,
            // A name that is a hex is a code, not a name — keeping it as both
            // would make one image match two different colours.
            colorName: nextName && !/^#?[0-9a-f]{3,8}$/i.test(nextName) ? nextName : null,
            url: value,
          });
        }

        for (const value of Object.values(obj)) walk(value, nextPlacement, nextCode, nextName);
      };

      walk(body, null, null, null);

      if (found.length === 0) {
        // AN EMPTY ANSWER IS REAL — a supplier may publish no blank imagery.
        // A SHAPE WE COULD NOT READ IS NOT, and the two must not look alike.
        //
        // TIGHTENED (2026-08-27). This only complained when the top-level key
        // was not `data`, so a response that WAS shaped {data: ...} but
        // carried its URLs somewhere unexpected returned an empty list and
        // read as "your supplier has no pictures". That is the failure mode
        // this check exists to prevent, and it walked straight past it.
        //
        // Now: an empty container is a real empty answer; a container with
        // something in it and no image we could find is a shape we cannot read.
        const container = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
        const payload = container?.data ?? container;
        const isEmpty =
          payload === null ||
          payload === undefined ||
          (Array.isArray(payload) && payload.length === 0) ||
          (typeof payload === "object" && Object.keys(payload as object).length === 0);

        if (!isEmpty) {
          const keys = container ? Object.keys(container).join(", ") : typeof body;
          const inner =
            payload === container
              ? ""
              : payload && typeof payload === "object" && !Array.isArray(payload)
              ? ` / ${Object.keys(payload as object).slice(0, 12).join(", ")}`
              : Array.isArray(payload)
                ? ` / array of ${payload.length}, first: ${
                    payload[0] && typeof payload[0] === "object"
                      ? Object.keys(payload[0] as object).slice(0, 12).join(", ")
                      : typeof payload[0]
                  }`
                : "";
          throw new Error(
            `Printful sent blank images in a shape with no image in it (keys: ${keys}${inner}).`,
          );
        }
      }
      return found;
    },

    async getGarment({ storeId, externalProductId }) {
      const [productBody, variantBody] = await Promise.all([
        // Same parameter, same reason — this endpoint documents it too.
        fetchJson(
          storeId,
          "creation.product",
          withSellingRegion(`/catalog-products/${externalProductId}`),
        ) as Promise<{
          data?: PrintfulV2Product;
        } | null>,
        // HERE TOO — AND THE DOCUMENTATION SAYS OTHERWISE (2026-08-27).
        //
        // Printful's v2 reference lists selling_region_name on
        // /catalog-products and /catalog-products/{id} and NOT on this one, so
        // it was deliberately left off: sending a parameter an endpoint does
        // not know is its own way of earning a 400.
        //
        // The live API disagreed, and said so precisely once the failure
        // carried the request:
        //
        //     Printful creation.variants failed (400): Selling region not found
        //     (asked for /catalog-products/1/catalog-variants?limit=100)
        //
        // The two calls that send it had just started working. This one, alone
        // in not sending it, failed with the same message it used to fail with.
        // Behaviour beats the reference.
        fetchJson(
          storeId,
          "creation.variants",
          withSellingRegion(`/catalog-products/${externalProductId}/catalog-variants?limit=100`),
        ) as Promise<{ data?: PrintfulV2Variant[] } | null>,
      ]);

      const product = productBody?.data;
      if (!product) return null;
      return toGarment(product, variantBody?.data ?? []);
    },
  };
}

