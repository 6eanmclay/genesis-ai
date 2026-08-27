"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { requireStorePermission } from "@/lib/permissions";
import { designProblem, toProviderPlacements, usedPlacements, type ProductDesign } from "@/lib/creation/design";
import { creationProviderFor } from "@/lib/creation/provider";

// TURNING A DESIGN INTO SOMETHING THE STORE SELLS.
//
// ============ THE SERVER ASKS THE SAME QUESTION THE BUTTON DID ==========
//
// designProblem() is the one definition of whether a design can be made, and
// both the disabled button and this action call it. A rule duplicated in a
// component is a rule that disagrees with its action the first time either
// changes — and here the disagreement would be an owner told they could add
// something that is then refused.
//
// ============ WHAT IS AND IS NOT SENT TO THE SUPPLIER ==================
//
// This writes a real Product with the design frozen onto it, and it does NOT
// create the product at Printful. That is deliberate rather than unfinished:
// lib/fulfillment/printful.ts's createProduct takes a single imageUrl and has
// no placement model at all, so calling it with a two-sided design would send
// the front artwork and silently drop the back.
//
// Wiring multi-placement creation is a change to that connector against a live
// account, and doing it blind — with no Printful connection to verify against —
// is how a supplier ends up printing something nobody previewed. So the design
// is stored complete, the provider placements are computed and stored with it,
// and the supplier call is the next step rather than a guess made now.

export interface AddToStoreResult {
  ok: boolean;
  error?: string;
}

export async function addDesignToStore(
  slug: string,
  design: ProductDesign,
  meta: { name: string; retailPriceInCents: number },
): Promise<AddToStoreResult> {
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true } });
  if (!store) return { ok: false, error: "Store not found." };

  // Permission first, and through the same gate every other write uses.
  await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE, store.id);

  const provider = await creationProviderFor(store.id);
  if (!provider) {
    return { ok: false, error: "Connect a print supplier before adding a designed product." };
  }

  // THE GARMENT IS RE-READ, not trusted from the browser. The print areas that
  // position the artwork have to be the supplier's own, and a client that sent
  // its own would be choosing where its design prints.
  const garment = await provider.getGarment({ storeId: store.id, externalProductId: design.externalProductId });
  if (!garment) return { ok: false, error: "That blank is no longer available from your supplier." };

  const problem = designProblem(design, garment.printAreas);
  if (problem) return { ok: false, error: problem };

  const variant = garment.variants.find((v) => v.externalVariantId === design.externalVariantId);
  if (!variant) return { ok: false, error: "That colour and size is no longer available." };

  // Computed server-side from the supplier's own areas — the same pure
  // function the canvas draws with, so the record matches the preview.
  const placements = toProviderPlacements(design, garment.printAreas);

  await prisma.product.create({
    data: {
      storeId: store.id,
      name: meta.name.trim() || garment.name,
      description: garment.description ?? "",
      priceInCents: meta.retailPriceInCents,
      // The first placement's first layer is the product's own picture until a
      // supplier mockup exists. A real image of the artwork beats a blank card,
      // and it is honestly the artwork rather than a rendered garment.
      imageUrl: placements[0]?.layers[0]?.assetUrl ?? garment.imageUrl,
      sourceKind: "PRINT_ON_DEMAND",
      externalProductId: garment.externalProductId,
      externalVariantId: variant.externalVariantId,
      fulfillmentProvider: "PRINTFUL",
      costInCents: variant.costInCents,
      // THE DESIGN, FROZEN. Stored with the placements already resolved
      // against the supplier's areas, so what gets printed does not depend on
      // re-deriving them later from a catalogue that may have moved.
      designSpec: {
        externalProductId: design.externalProductId,
        externalVariantId: variant.externalVariantId,
        color: variant.color,
        size: variant.size,
        placements: design.placements,
        providerPlacements: placements,
        printAreas: garment.printAreas,
        capturedAt: new Date().toISOString(),
      },
    },
  });

  revalidatePath(`/b/${slug}/products`);
  revalidatePath(`/b/${slug}/studio`);
  return { ok: true };
}

/** What the owner is about to add, for the confirmation line. */
export async function describeDesign(design: ProductDesign): Promise<string> {
  const sides = usedPlacements(design);
  return sides.length === 0 ? "nothing yet" : sides.join(" and ");
}
