import { prisma } from "@/lib/prisma";
import { partnerParcelFor, parcelToProductData } from "@/lib/fulfillment/parcel";
import { writeBusinessEvents } from "@/lib/intelligence/businessEvents";
import { internalItemId } from "@/lib/businessModel/internalMapper";
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

  // RULED_OUT IS NOT CHECKED HERE, AND THAT IS THE POINT (2026-08-21).
  //
  // Genesis's own verdict is a recommendation, and a recommendation the owner
  // cannot overrule is not a recommendation — it is a rule Genesis made about
  // somebody else's business. The owner knows things Genesis does not, and the
  // whole reason `RULED_OUT` is a separate status from `DISMISSED` is that one
  // is an opinion and the other is a decision. Only the decision binds.
  //
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

  // CLAIM AND CREATE IN ONE TRANSACTION (2026-08-20).
  //
  // THE DEFECT THIS REPLACES, found by this function's own suite on a re-run
  // after passing once — it was a race, so it was flaky, which is exactly why
  // it had to be run more than once. The claim and the create were separate
  // statements, and the loser of the claim FELL THROUGH to create anyway
  // whenever the winner had not yet written `adoptedProductId`. Three
  // simultaneous adoptions produced three identical products.
  //
  // Together in one transaction, the winner's row lock is what serialises this:
  // a second caller's conditional update blocks until the winner commits, then
  // re-evaluates its predicate against the committed row and matches nothing. By
  // the time a loser sees count 0, the product id it needs is committed too,
  // because both writes are in the same transaction.
  //
  // The predicate is not simply `status != ADOPTED`: a row whose product was
  // deleted is still ADOPTED with a null `adoptedProductId`, and that genuinely
  // should be adoptable again.
  // ASKED BEFORE THE TRANSACTION OPENS, deliberately. This is a network call to
  // the partner, and holding a row lock across one would let a slow partner
  // serialise every adoption in the business behind it. It never throws — an
  // unreachable partner simply means no packaging was learned.
  const parcel = await partnerParcelFor({
    provider: candidate.fulfillmentProvider,
    storeId,
    storeDraftId: null,
    externalProductId: candidate.externalProductId,
    externalVariantId: fromVariantKey(candidate.externalVariantId),
  });

  const outcome = await prisma.$transaction(async (tx) => {
    const claimed = await tx.sourcedProduct.updateMany({
      where: {
        id: candidate.id,
        storeId,
        OR: [{ status: { not: "ADOPTED" } }, { adoptedProductId: null }],
      },
      data: { status: "ADOPTED" },
    });
    if (claimed.count === 0) return { won: false as const };

    const product = await tx.product.create({
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
        // Read off the row, not re-derived from the registry. It said
        // `createsListings ? "PRINTFUL" : null`, which is correct exactly until a
        // second print-on-demand partner exists and every product from it gets
        // labelled Printful and handed to Printful's order routing.
        //
        // Null for a wholesale listing: it has an external id, but nobody is
        // fulfilling on our behalf, and claiming otherwise would put it in front
        // of order-routing code with no idea what to do with it.
        fulfillmentProvider: candidate.fulfillmentProvider,
        // PACKAGING FROM THE PARTNER, when the partner knows it (2026-08-26).
        //
        // Spread rather than assigned, so a partner that supplies nothing
        // leaves these null instead of writing zeroes over them — and a
        // partner that supplies a weight but no box contributes just the
        // weight. Neither Printful nor Printify exposes a parcel today; see
        // lib/fulfillment/parcel.ts for the field-by-field check.
        ...parcelToProductData(parcel),
      },
      select: { id: true },
    });

    await tx.sourcedProduct.updateMany({
      where: { id: candidate.id, storeId },
      data: { adoptedProductId: product.id },
    });

    // SOMETHING HAPPENED IN THIS BUSINESS, so the memory pipeline hears about it
    // (2026-08-21). Adopting a suggestion creates a real owned product without
    // going through `create_product`, so the execution engine never saw it and
    // the event log had a hole exactly where a first-party store's catalogue
    // comes from.
    //
    // The SAME seam every other event uses — writeBusinessEvents — inside the
    // SAME transaction as the product and the claim, so an event can never
    // describe an adoption that did not commit. No new event system, no second
    // ledger, and nothing about SupplierEconomics is copied: this records that
    // an item was added and where it came from, not what it costs.
    await writeBusinessEvents(tx, storeId, "internal", [
      {
        recordId: internalItemId(product.id),
        entityType: "item",
        eventType: "item.created",
        summary: `Product added from a suggestion: ${candidate.name}`,
        data: {
          sourcedProductId: candidate.id,
          sourceKey: candidate.sourceKey,
          externalProductId: candidate.externalProductId,
        },
      },
    ]);

    return { won: true as const, productId: product.id };
  });

  if (outcome.won) return { ok: true, productId: outcome.productId, alreadyAdopted: false };

  // Somebody else won. Their product id is committed, because their claim and
  // their create were the same transaction.
  const winner = await prisma.sourcedProduct.findFirst({
    where: { id: candidate.id, storeId },
    select: { adoptedProductId: true },
  });
  if (winner?.adoptedProductId) {
    return { ok: true, productId: winner.adoptedProductId, alreadyAdopted: true };
  }
  // No claim, and no product to point at. Refuse rather than create a second
  // one — a duplicate in the owner's catalogue is worse than a retry.
  return {
    ok: false,
    reason: "not_found",
    detail: "This is already being added to your store.",
  };
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
