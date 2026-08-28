// WHAT A PRODUCT'S richContent ACTUALLY CONTAINS.
//
// ============ IT IS NOT ONE SHAPE (2026-08-28) =========================
//
// `Product.richContent` is untyped JSON serving two unrelated purposes:
//
//   marketing copy    { keyFeatures, benefits, specifications }
//   design provenance { designId, placements, printFileUrls, ... }
//
// The storefront detail page cast it to the first and read
// `.keyFeatures.length`. For every product ever created from a design that
// property is undefined, so the read threw and a customer pressing View Details
// got "Something went wrong" — on the hoodie, the mug, the t-shirt, all of them.
//
// The two purposes cannot simply be separated: a unique index over
// `richContent->>'designId'` is what enforces one product per design, so
// provenance has to stay where it is. What has to change is the reading.
//
// ============ A STOREFRONT PAGE MUST NOT THROW =========================
//
// It is the one screen a paying customer sees. A product with no marketing copy
// should render without those sections — which is what an owner-entered product
// has always done — rather than take the page down. So this normalises anything
// into the shape the page needs, and every field it cannot find becomes empty.

export interface StorefrontRichContent {
  keyFeatures: string[];
  benefits: string[];
  specifications: { label: string; value: string }[];
}

/** Only the strings. A malformed entry is dropped rather than rendered as junk. */
function stringsIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The marketing copy on a product, whatever else its richContent holds.
 *
 * Total: every input produces a valid object, including null, a string, an
 * array, or design provenance. There is no shape this can be handed that makes
 * the page fail.
 */
export function storefrontRichContent(value: unknown): StorefrontRichContent {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

  return {
    keyFeatures: stringsIn(source.keyFeatures),
    benefits: stringsIn(source.benefits),
    specifications: Array.isArray(source.specifications)
      ? source.specifications
          .filter(
            (spec): spec is { label: string; value: string } =>
              !!spec &&
              typeof spec === "object" &&
              typeof (spec as { label?: unknown }).label === "string" &&
              typeof (spec as { value?: unknown }).value === "string",
          )
          .map((spec) => ({ label: spec.label, value: spec.value }))
      : [],
  };
}
