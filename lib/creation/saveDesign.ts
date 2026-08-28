import { prisma } from "@/lib/prisma";
import { designProblem, toProviderPlacements, type ProductDesign } from "@/lib/creation/design";
import type { Garment } from "@/lib/creation/garment";

// SAVING A DESIGN AS A PRODUCT.
//
// ============ WHY THIS IS NOT IN THE ACTION (2026-08-28) ================
//
// It was, and it could never be run. `addDesignToStore` is a Server Function in
// a "use server" file, so every export from that module has to be an action —
// there is nowhere to put a helper a test could call. Reaching it meant
// standing up a connected Printful account, so the write was covered by regular
// expressions over its own source and had never once been executed.
//
// Next's own guidance is the shape this takes:
//
//   "Design your data access functions as secure primitives: validate inputs,
//    check authentication and authorization... When Server Functions delegate
//    to a Data Access Layer, these guarantees live in one place and apply
//    consistently."
//   — node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md
//
// So the action keeps what only it can do — permission, and fetching the
// supplier's own garment — and hands the decision and the write here, where a
// suite can pass a garment in and read the row back out.
//
// THE GARMENT IS A PARAMETER, AND THAT IS THE POINT. Every capability this
// function honours — which placements exist, which colours and sizes are real,
// what the blank costs, who makes it — arrives from the supplier's own record
// rather than being known here. That is what makes it testable, and it is the
// same property that lets a second supplier work without this file changing.

export interface SaveDesignResult {
  ok: boolean;
  error?: string;
  /** The product actually written, when one was. */
  productId?: string;
}

export interface SaveDesignInput {
  storeId: string;
  design: ProductDesign;
  meta: { name: string; retailPriceInCents: number };
  /** The supplier's own record of the blank, re-read server-side. */
  garment: Garment;
}

/**
 * Write a completed design as a product, or say why it cannot be.
 *
 * Refuses before it writes: a design that falls outside the supplier's declared
 * print areas, or names a variant the supplier no longer offers, produces an
 * error rather than a row. Both checks read the garment, so neither can be
 * satisfied by a client sending its own idea of what is printable.
 */
export async function saveDesignAsProduct(input: SaveDesignInput): Promise<SaveDesignResult> {
  const { storeId, design, meta, garment } = input;

  const problem = designProblem(design, garment.printAreas);
  if (problem) return { ok: false, error: problem };

  const variant = garment.variants.find((v) => v.externalVariantId === design.externalVariantId);
  if (!variant) return { ok: false, error: "That colour and size is no longer available." };

  // Computed server-side from the supplier's own areas — the same pure
  // function the canvas draws with, so the record matches the preview.
  const placements = toProviderPlacements(design, garment.printAreas);

  const product = await prisma.product.create({
    data: {
      storeId,
      name: meta.name.trim() || garment.name,
      description: garment.description ?? "",
      priceInCents: meta.retailPriceInCents,
      // The first placement's first layer is the product's own picture until a
      // supplier mockup exists. A real image of the artwork beats a blank card,
      // and it is honestly the artwork rather than a rendered garment.
      imageUrl: placements[0]?.layers[0]?.assetUrl ?? garment.imageUrl,
      // ============ NOT ON SALE, BECAUSE IT CANNOT BE MADE YET ==========
      //
      // Sean: "I don't want us to quietly fake that capability... Treat it as a
      // saved design/draft until the supplier creation contract is actually
      // wired."
      //
      // This wrote an ACTIVE product marked PRINT_ON_DEMAND with a Printful
      // provider and a catalogue id — every signal of a manufacturable item —
      // for a design Printful has never been told about. designSpec has no
      // readers, and createDraftOrder sends one file with no placement, so an
      // order against this would have printed the raw artwork at whatever
      // position Printful chose, or nothing.
      //
      // `active: false` is the whole correction. The design is kept complete,
      // the provenance is kept honest, and the product is not sellable until
      // something has actually created it with the supplier.
      active: false,
      sourceKind: "PRINT_ON_DEMAND",
      externalProductId: garment.externalProductId,
      externalVariantId: variant.externalVariantId,
      // ============ WHO MAKES IT, ASKED RATHER THAN ASSUMED (2026-08-28) ===
      //
      // This was the literal string "PRINTFUL". It was true — Printful is the
      // only creation provider connected today — and it was still wrong, for
      // the reason Sean gave when he asked for the supplier abstraction to stay
      // intact: a second supplier must be able to expose different capabilities
      // without the Creation Station being rebuilt around it.
      //
      // The other path that turns a design into a product,
      // lib/execution/executables/productFromDesign.ts, already reads this off
      // the connector that accepted the product and says why in its own words:
      // "never assumed from a provider name". Two paths that write the same
      // record disagreeing about where the answer comes from is precisely how
      // they become two systems, which is the thing to avoid.
      fulfillmentProvider: garment.provider,
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
        // WHETHER THE SUPPLIER HAS IT. False until multi-placement product
        // creation is wired and VERIFIED against a live account — recorded on
        // the design rather than inferred from the product's other fields, so
        // the day it becomes true there is one thing to flip and one thing to
        // read.
        supplierProductCreated: false,
      },
    },
    select: { id: true },
  });

  return { ok: true, productId: product.id };
}
