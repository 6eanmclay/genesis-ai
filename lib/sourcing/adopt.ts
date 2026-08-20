import { prisma } from "@/lib/prisma";
import { fromVariantKey } from "./types";

// Turning something Genesis found into something the store sells.
//
// The one place a SourcedProduct becomes a Product, and the place the sourcing
// facts have to survive the transition. A product adopted from a dropship
// supplier that forgets it came from one is worse than never having recorded it:
// the owner will be shown a "buy a shipping label" button for a parcel they will
// never hold.

export type AdoptionOutcome =
  | { ok: true; productId: string; alreadyAdopted: boolean }
  | { ok: false; reason: "not_found" | "dismissed"; detail: string };

/**
 * Adopt a discovered candidate into the store's own catalogue.
 *
 * The price is the owner's, always. A supplier's suggested retail is a
 * suggestion — see the default below, which uses it only when the owner has not
 * said, and refuses rather than inventing one when neither exists.
 */
export async function adoptSourcedProduct(params: {
  storeId: string;
  sourcedProductId: string;
  /** What the owner will charge. Falls back to the source's suggestion. */
  priceInCents?: number;
}): Promise<AdoptionOutcome> {
  const { storeId, sourcedProductId } = params;

  // Scoped to the store on the way in. A candidate id is not a capability.
  const candidate = await prisma.sourcedProduct.findFirst({
    where: { id: sourcedProductId, storeId },
  });
  if (!candidate) {
    return { ok: false, reason: "not_found", detail: "That suggestion isn't in this store." };
  }

  // Adopting something the owner threw away would undo a decision they made.
  if (candidate.status === "DISMISSED") {
    return {
      ok: false,
      reason: "dismissed",
      detail: "You turned this suggestion down. Bring it back first if you've changed your mind.",
    };
  }

  // Already adopted, and the product still exists: a genuine no-op. Two clicks
  // on one button must not put two of the same thing in the catalogue.
  if (candidate.status === "ADOPTED" && candidate.adoptedProductId) {
    const existing = await prisma.product.findFirst({
      where: { id: candidate.adoptedProductId, storeId },
      select: { id: true },
    });
    if (existing) return { ok: true, productId: existing.id, alreadyAdopted: true };
    // The product was deleted. Falling through re-creates it, which is right:
    // the candidate is still a real thing the supplier offers.
  }

  const priceInCents = params.priceInCents ?? candidate.suggestedRetailInCents;
  if (priceInCents === null || priceInCents === undefined || priceInCents <= 0) {
    return {
      ok: false,
      reason: "not_found",
      detail: "This suggestion has no price yet — set what you'll charge for it first.",
    };
  }

  // CLAIM, then create. Two concurrent adoptions of one candidate would
  // otherwise both pass the status check above and both create a product, which
  // is the same check-then-act that put two shipping labels on one parcel.
  const claimed = await prisma.sourcedProduct.updateMany({
    where: { id: candidate.id, storeId, status: { not: "ADOPTED" } },
    data: { status: "ADOPTED" },
  });
  if (claimed.count === 0 && candidate.status !== "ADOPTED") {
    const winner = await prisma.sourcedProduct.findFirst({
      where: { id: candidate.id, storeId },
      select: { adoptedProductId: true },
    });
    if (winner?.adoptedProductId) {
      return { ok: true, productId: winner.adoptedProductId, alreadyAdopted: true };
    }
  }

  try {
    const product = await prisma.product.create({
      data: {
        storeId,
        name: candidate.name,
        description: candidate.description,
        priceInCents,
        imageUrl: candidate.imageUrl,
        costInCents: candidate.unitCostInCents,
        // THE FACTS THAT MUST SURVIVE. Everything downstream that behaves
        // differently for a dropshipped product than an owner-made one reads
        // these: who buys the label, whether there is stock, whether "customise
        // this" means anything at all.
        sourceKind: candidate.kind,
        sourceKey: candidate.sourceKey,
        externalProductId: candidate.externalProductId,
        // Back to null: Product.externalVariantId genuinely means "there is no
        // variant", and the empty-string sentinel is a storage detail of the
        // discovery table, not a fact about the product.
        externalVariantId: fromVariantKey(candidate.externalVariantId),
        // Read off the row, not re-derived from the registry (2026-08-20).
        //
        // Two things wrong with looking it up again. It said
        // `createsListings ? "PRINTFUL" : null`, which is correct exactly until
        // a second print-on-demand partner exists and every product from it gets
        // labelled Printful and handed to Printful's order routing. And it made
        // adoption fail outright for a source that had since been de-registered,
        // stranding a suggestion the owner was looking at — when everything
        // needed to create the product was already recorded on the row.
        //
        // Null for a wholesale listing: it has an external id, but nobody is
        // fulfilling on our behalf, and claiming otherwise would put it in front
        // of order-routing code with no idea what to do with it.
        fulfillmentProvider: candidate.fulfillmentProvider,
      },
      select: { id: true },
    });

    await prisma.sourcedProduct.updateMany({
      where: { id: candidate.id, storeId },
      data: { status: "ADOPTED", adoptedProductId: product.id },
    });

    return { ok: true, productId: product.id, alreadyAdopted: false };
  } catch (error) {
    // Release the claim, or a failed adoption locks the candidate out forever.
    await prisma.sourcedProduct
      .updateMany({ where: { id: candidate.id, storeId, adoptedProductId: null }, data: { status: "SUGGESTED" } })
      .catch(() => {});
    throw error;
  }
}

/**
 * Turn a suggestion down, and have it stay down.
 *
 * Remembered rather than deleted, because the next discovery run would find the
 * same supplier listing again — and raising something the owner has already
 * rejected is the difference between a partner and a nag.
 */
export async function dismissSourcedProduct(params: {
  storeId: string;
  sourcedProductId: string;
}): Promise<{ ok: boolean; detail?: string }> {
  const claimed = await prisma.sourcedProduct.updateMany({
    where: { id: params.sourcedProductId, storeId: params.storeId, status: "SUGGESTED" },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });
  if (claimed.count === 0) {
    const existing = await prisma.sourcedProduct.findFirst({
      where: { id: params.sourcedProductId, storeId: params.storeId },
      select: { status: true },
    });
    if (!existing) return { ok: false, detail: "That suggestion isn't in this store." };
    if (existing.status === "ADOPTED") {
      return { ok: false, detail: "You've already added this to your store — remove the product instead." };
    }
  }
  return { ok: true };
}
