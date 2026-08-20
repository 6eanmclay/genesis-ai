import { prisma } from "@/lib/prisma";
import { getProductSource } from "./registry";
import { recommendPrice } from "@/lib/onboarding/pricing";
import { scoreCandidate, type SourcingContext } from "./recommend";
import { fromVariantKey, type SourcedCandidate } from "./types";

// What a suggestion actually costs, asked when somebody is interested.
//
// The half of `capabilities.quotesCost` that had nothing behind it. Discovery
// deliberately records a null cost — pricing eight candidates is sixteen HTTP
// round trips to populate a list the owner may glance at once — so until this
// existed, `unitCostInCents` was permanently null for the one source that
// works, and the margin signal in the recommender could never fire at all.
//
// RE-SCORING IS THE POINT, not a nicety. A cost changes the margin, the margin
// changes the score, and the score changes the order the owner reads. A row
// that took on a real price while keeping reasoning written when the price was
// unknown would be a recommendation arguing against its own numbers.

export type QuoteOutcome =
  | {
      ok: true;
      unitCostInCents: number;
      shippingInCents: number;
      suggestedRetailInCents: number;
      /** The recommendation as it now stands, with margin taken into account. */
      score: number;
      reasons: string[];
    }
  | { ok: false; reason: "not_found" | "not_quotable" | "unavailable"; detail: string };

/**
 * Price one suggestion, and re-reason about it.
 *
 * The suggested retail comes from the same `recommendPrice()` the onboarding
 * flow uses, so a price Genesis suggests here and a price it suggests there are
 * the same number for the same reasons. It stays a suggestion: the owner sets
 * what they charge, and `adoptSourcedProduct` takes their figure over this one.
 */
export async function quoteSourcedProduct(params: {
  storeId: string;
  sourcedProductId: string;
  /** The business, for re-scoring. Built by buildSourcingContext(). */
  context: SourcingContext;
}): Promise<QuoteOutcome> {
  const { storeId, sourcedProductId, context } = params;

  // Scoped on the way in. A suggestion id is not a capability, and this one
  // spends a real API call against the store's own connected account.
  const row = await prisma.sourcedProduct.findFirst({
    where: { id: sourcedProductId, storeId },
  });
  if (!row) return { ok: false, reason: "not_found", detail: "That suggestion isn't in this store." };

  const source = getProductSource(row.sourceKey);
  if (!source) {
    return {
      ok: false,
      reason: "not_quotable",
      detail: `This came from "${row.sourceKey}", which Genesis can no longer reach.`,
    };
  }
  if (source.blockedOn.length > 0 || !source.quote) {
    // Declared as unable, so it is not asked. Turning a known configuration gap
    // into a provider error in the logs reads as something being broken.
    return {
      ok: false,
      reason: "not_quotable",
      detail:
        source.blockedOn.length > 0
          ? `${source.displayName} needs ${source.blockedOn.join(", ")} before it can price anything.`
          : `${source.displayName} doesn't give prices before an order.`,
    };
  }

  const candidate: SourcedCandidate = {
    sourceKey: row.sourceKey,
    externalProductId: row.externalProductId,
    externalVariantId: fromVariantKey(row.externalVariantId),
    kind: row.kind,
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl,
    unitCostInCents: row.unitCostInCents,
    suggestedRetailInCents: row.suggestedRetailInCents,
    currency: row.currency,
    customizable: row.customizable,
    fulfillmentProvider: row.fulfillmentProvider,
  };

  const quoted = await source.quote({ storeId, candidate }).catch((error: unknown) => ({
    ok: false as const,
    reason: "provider_error" as const,
    detail: error instanceof Error ? error.message.slice(0, 200) : "Pricing failed",
  }));

  if (!quoted.ok) {
    // The row keeps its honest null rather than taking on a zero. An unknown
    // cost that becomes a zero would make this the most profitable thing in the
    // store.
    return { ok: false, reason: "unavailable", detail: quoted.detail };
  }

  const price = recommendPrice(quoted.unitCostInCents, quoted.shippingInCents, context.brandPositioning);

  const priced: SourcedCandidate = {
    ...candidate,
    unitCostInCents: quoted.unitCostInCents,
    suggestedRetailInCents: price.retailPriceInCents,
  };
  const recommendation = scoreCandidate(priced, context);

  await prisma.sourcedProduct.updateMany({
    where: { id: row.id, storeId },
    data: {
      unitCostInCents: quoted.unitCostInCents,
      suggestedRetailInCents: price.retailPriceInCents,
      recommendation: { ...recommendation },
      score: recommendation.score,
    },
  });

  return {
    ok: true,
    unitCostInCents: quoted.unitCostInCents,
    shippingInCents: quoted.shippingInCents,
    suggestedRetailInCents: price.retailPriceInCents,
    score: recommendation.score,
    reasons: recommendation.reasons,
  };
}
