import { prisma } from "@/lib/prisma";
import { printfulFulfillmentConnector } from "@/lib/fulfillment/printful";
import type { ProductSource, SourceQuoteResult, SourceSearchResult, SourcedCandidate, SourcingIntent } from "./types";

// Printful, as a product SOURCE.
//
// A thin adapter over the fulfillment connector that already exists and is
// already validated against Printful's real API. Nothing in lib/fulfillment/
// changed to make this work, which is the point: that layer answers "what will
// this cost to print", and this one answers "what could this business sell".
// Collapsing them would have meant rewriting validated code to serve a naming
// preference.
//
// Cost is deliberately NOT fetched here. getCost() is two more HTTP round trips
// per candidate, and discovery surfaces eight at a time — that is sixteen calls
// to populate a list the owner may glance at once. A candidate's cost is null
// until somebody is actually interested, and null means unknown, which is the
// truth about it. See lib/sourcing/quote.ts.

export const printfulSource: ProductSource = {
  key: "printful",
  displayName: "Printful",
  kind: "PRINT_ON_DEMAND",
  capabilities: {
    // The only registered source for which this is true today, and the reason
    // the capability is declared rather than inferred: "it's Printful, so it
    // must be customisable" stops being a safe inference the moment a second
    // source exists.
    customization: true,
    createsListings: true,
    shipsDirect: true,
    quotesCost: true,
  },
  fulfillmentProvider: "PRINTFUL",
  blockedOn: [],

  async search(intent: SourcingIntent): Promise<SourceSearchResult> {
    // Connected-ness is checked here rather than left to the connector throwing,
    // because "this store has not connected Printful" is an owner action and
    // must never look like a provider outage.
    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: intent.storeId, provider: "PRINTFUL" } },
      select: { status: true },
    });
    if (integration?.status !== "CONNECTED") {
      return {
        ok: false,
        reason: "not_connected",
        detail: "Printful isn't connected for this store, so its catalog can't be searched.",
      };
    }

    try {
      const candidates = await printfulFulfillmentConnector.browseCandidates({
        storeId: intent.storeId,
        storeDraftId: null,
        brandPositioning: intent.brandPositioning,
        keywords: intent.keywords,
      });

      return {
        ok: true,
        candidates: candidates.slice(0, intent.limit).map((candidate) => ({
          sourceKey: "printful",
          externalProductId: candidate.externalProductId,
          externalVariantId: candidate.variant.externalVariantId,
          kind: "PRINT_ON_DEMAND" as const,
          name: candidate.name,
          description: candidate.description || null,
          imageUrl: candidate.imageUrl,
          // Unknown, not zero. Priced on demand — see this file's header.
          unitCostInCents: null,
          suggestedRetailInCents: null,
          currency: "USD",
          customizable: true,
          fulfillmentProvider: "PRINTFUL" as const,
        })),
      };
    } catch (error) {
      return {
        ok: false,
        reason: "provider_error",
        detail: error instanceof Error ? error.message.slice(0, 200) : "Printful search failed",
      };
    }
  },

  async quote({ storeId, candidate }: { storeId: string; candidate: SourcedCandidate }): Promise<SourceQuoteResult> {
    if (!candidate.externalVariantId) {
      // Printful prices a VARIANT, not a product. A candidate without one cannot
      // be quoted, and saying so is better than quoting the wrong thing.
      return {
        ok: false,
        reason: "provider_error",
        detail: "This item has no Printful variant, so it can't be priced.",
      };
    }
    try {
      const estimate = await printfulFulfillmentConnector.getCost({
        storeId,
        storeDraftId: null,
        candidate: {
          provider: "PRINTFUL",
          externalProductId: candidate.externalProductId,
          name: candidate.name,
          description: candidate.description ?? "",
          imageUrl: candidate.imageUrl,
          variant: { externalVariantId: candidate.externalVariantId, name: candidate.name },
        },
      });
      return { ok: true, unitCostInCents: estimate.costInCents, shippingInCents: estimate.shippingInCents };
    } catch (error) {
      return {
        ok: false,
        reason: "provider_error",
        detail: error instanceof Error ? error.message.slice(0, 200) : "Printful could not price this item",
      };
    }
  },
};
