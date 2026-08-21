import { prisma } from "@/lib/prisma";
import { printfulFulfillmentConnector, printfulEconomicsQuote } from "@/lib/fulfillment/printful";
import { fromVariantKey } from "./types";
import { isBudgetExhausted } from "./sourcingBudget";
import type {
  ProductSource,
  SourceEconomicsResult,
  SourceEconomicsStatement,
  SourceQuoteResult,
  SourceSearchResult,
  SourcedCandidate,
  SourcingIntent,
} from "./types";

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
    statesEconomics: true,
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

  /**
   * PRINTFUL'S STANDING TERMS — the first real economics producer (2026-08-21).
   *
   * Reads what this business actually sells through Printful and states, per
   * product, only what Printful genuinely says:
   *
   *   unitCost   — the variant's real price.
   *   shipping   — the real rate, or NULL when the rate lookup fails. Never 0
   *                for unknown; `printfulEconomicsQuote` is a separate function
   *                from `getCost` precisely so those two can be told apart.
   *   minimum    — 1, and this is a STATED FACT rather than a default. Print on
   *                demand genuinely has no minimum: one is what you can order.
   *                It is the one place in this codebase where a minimum of 1 is
   *                true rather than a missing value wearing a number, and it is
   *                only true because the method makes it true.
   *   tiers      — an empty array, meaning "this supplier publishes no price
   *                breaks", which is a different statement from null.
   *   leadTime   — NOT STATED. Printful's fulfilment time varies by product and
   *                the API does not commit to one here, so nothing is recorded.
   *
   * Per product, not per catalogue: a supplier's terms are only worth fetching
   * for things the business already sells, and Printful prices a VARIANT, so a
   * product without one cannot be priced and is skipped rather than guessed at.
   */
  async economics({ storeId }: { storeId: string }): Promise<SourceEconomicsResult> {
    const adopted = await prisma.sourcedProduct.findMany({
      where: { storeId, sourceKey: "printful", NOT: { adoptedProductId: null } },
      select: { externalProductId: true, externalVariantId: true },
    });
    if (adopted.length === 0) {
      return { ok: true, currency: "USD", statements: [] };
    }

    const statements: SourceEconomicsStatement[] = [];
    let currency: string | null = null;

    for (const row of adopted) {
      const variantId = fromVariantKey(row.externalVariantId);
      if (!variantId) continue;

      try {
        const quote = await printfulEconomicsQuote({
          storeId,
          externalProductId: row.externalProductId,
          externalVariantId: variantId,
        });
        // ONE CURRENCY PER ACCOUNT. If Printful ever answered differently for
        // two products, that is a fact nobody can act on rather than one to
        // average — the batch stops rather than mixing money.
        if (currency && currency !== quote.currency) {
          return {
            ok: false,
            reason: "provider_error",
            detail: `Printful returned prices in both ${currency} and ${quote.currency}.`,
          };
        }
        currency = quote.currency;

        statements.push({
          externalProductId: row.externalProductId,
          externalVariantId: variantId,
          unitCostInCents: quote.unitCostInCents,
          shippingPerUnitInCents: quote.shippingPerUnitInCents,
          // See the note above: real for print on demand, and only for it.
          minimumOrderUnits: 1,
          tiers: [],
          leadTimeDays: null,
        });
      } catch (error) {
        // A BUDGET REFUSAL IS NOT A PRODUCT THAT COULD NOT BE PRICED. This catch
        // exists so one unpriceable product does not lose the rest — but
        // swallowing an exhausted budget here would turn the ceiling into a
        // suggestion, quietly continuing the loop and asking again for every
        // remaining product. It has to leave.
        if (isBudgetExhausted(error)) throw error;
        // One product Printful cannot price does not lose the rest, and nothing
        // is stated for it. Skipping is the honest outcome: the gap stays a gap.
        continue;
      }
    }

    if (!currency) {
      return { ok: false, reason: "provider_error", detail: "Printful priced none of these products." };
    }
    return { ok: true, currency, statements };
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
      // Same reasoning as economics() above: a refused budget is not a supplier
      // that failed, and reporting it as one would hide the ceiling.
      if (isBudgetExhausted(error)) throw error;
      return {
        ok: false,
        reason: "provider_error",
        detail: error instanceof Error ? error.message.slice(0, 200) : "Printful could not price this item",
      };
    }
  },
};
