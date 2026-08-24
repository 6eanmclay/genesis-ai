import { prisma } from "@/lib/prisma";
import { verifiedUnless, namedKeyMismatches } from "../verification";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import { DesignSchema } from "@/lib/businessModel/entities";
import { getFulfillmentConnectors } from "@/lib/fulfillment/registry";
import { SURFACES } from "@/lib/design/surfaces";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface CreateProductFromDesignInput {
  /** The `design` BusinessRecord id the owner approved. */
  designId: string;
  name: string;
  priceInCents: number;
  description?: string;
}

interface ProductFromDesignMetadata {
  productId: string;
  designId: string;
  externalProductId: string | null;
  registeredWithProvider: boolean;
}

// Approval with a real consequence (2026-08-17).
//
// Sean: "an approved Design cannot stop at a Design record... Once approved,
// the owner should be able to leave Studio, open Storefront, and actually see
// the new product there." This is that step, and it is the last link in the
// chain WORK_STUDIO.md records:
//
//   Asset -> Design -> PRODUCT -> Provider -> Execution -> Verification -> Record
//
// NOT A PARALLEL PRODUCT SYSTEM. It writes an ordinary Product row through the
// ordinary executable contract, so everything the storefront, the catalog and
// the owner's own edit form already do with a product works on this one with
// no special cases. The only thing that makes it different is provenance:
// richContent records the design it came from, so a product can answer where
// its artwork came from instead of being a mystery image.
//
// THE MOCKUP SELLS, THE PRINT FILE PRINTS. imageUrl is the mockup, because
// that is what a customer needs to see; the print file goes to the provider,
// because that is what a press needs. Sending either one to the wrong place is
// the mistake this split exists to prevent — a catalog candidate's own image
// is not a valid print file, confirmed live against Printful.
//
// PROVIDER REGISTRATION IS NON-FATAL, matching the same decision onboarding
// already made at store confirmation: an external API call cannot sit inside
// the transaction, and a provider failure must not cost the owner the product
// they just approved. It is recorded honestly in metadata instead, so a later
// retry knows what still needs registering.
/**
 * Turn a duplicate into a sentence the owner can act on.
 *
 * A raw unique-violation would surface as a database error string, and the
 * owner's own word for what happened is "I already did that" rather than a
 * constraint name.
 */
async function createOnce<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (err) {
    if (
      typeof err === "object" && err !== null && "code" in err &&
      (err as { code?: unknown }).code === "P2002"
    ) {
      throw new Error("That design is already one of your products.");
    }
    throw err;
  }
}

export const createProductFromDesignExecutable: Executable<
  CreateProductFromDesignInput,
  ProductFromDesignMetadata
> = {
  action: EXECUTION_ACTIONS.PRODUCT_CREATE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const record = await prisma.businessRecord.findFirst({
      where: { id: input.designId, storeId: ctx.storeId, entityType: "design" },
      select: { id: true, data: true },
    });
    if (!record) throw new Error("That design no longer exists.");
    const parsed = DesignSchema.safeParse(record.data);
    if (!parsed.success) throw new Error("That design could not be read.");
    const design = parsed.data;
    if (!design.mockupUrl) throw new Error("That design has no mockup to sell from.");

    const productCount = await prisma.product.count({ where: { storeId: ctx.storeId } });
    const surfaceLabel = SURFACES[design.surface]?.label ?? design.surface;

    // ONE PRODUCT PER DESIGN, refused by the database (D3, 2026-08-23).
    //
    // A `Product_one_per_design` unique index over richContent->>'designId'
    // makes the second concurrent approval fail instead of succeeding. Checking
    // first and creating second would not have helped: that is the same
    // read-then-write window the two callers were already racing through.
    //
    // The throw matters as much as the constraint. execute() catches it, records
    // FAILED, and — because growth points are only deducted on a non-FAILED
    // outcome — the owner is not charged for the attempt that created nothing.
    // So the invariant holds in both halves: not two products, and not two
    // charges.
    const product = await createOnce(async () => prisma.product.create({
      data: {
        storeId: ctx.storeId,
        name: input.name,
        description: input.description ?? `${surfaceLabel} featuring your brand.`,
        priceInCents: input.priceInCents,
        position: productCount,
        imageUrl: design.mockupUrl,
        richContent: {
          // Provenance. A product made in Studio knows which design it came
          // from, which surface, and which print file a provider should use.
          designId: record.id,
          surface: design.surface,
          printFileUrl: design.printFileUrl,
          sourceAssetIds: design.assetIds,
        },
      },
    }));

    // Position 0 of the gallery, same as every other product-creating path —
    // the scalar column and the ProductImage table must not disagree.
    await prisma.productImage.create({
      data: { productId: product.id, url: design.mockupUrl, position: 0 },
    });

    // Register with whichever fulfillment provider is connected, if any. The
    // provider is chosen from the registry rather than named here: Printify
    // becomes a second connector, never a branch in this file.
    let externalProductId: string | null = null;
    if (design.printFileUrl) {
      for (const connector of getFulfillmentConnectors()) {
        // FulfillmentConnector deliberately has no status() — that belongs to
        // IntegrationConnector, the read-only sync side. The connection row is
        // the same one either way, so it is read directly.
        const integration = await prisma.storeIntegration.findUnique({
          where: { storeId_provider: { storeId: ctx.storeId, provider: connector.provider } },
          select: { status: true },
        });
        if (integration?.status !== "CONNECTED") continue;
        try {
          const candidates = await connector.browseCandidates({
            storeId: ctx.storeId,
            storeDraftId: null,
            brandPositioning: "",
            keywords: surfaceLabel,
          });
          const candidate = candidates[0];
          if (!candidate) break;
          const registered = await connector.createProduct({
            storeId: ctx.storeId,
            storeDraftId: null,
            candidate,
            imageUrl: design.printFileUrl,
            retailPriceInCents: input.priceInCents,
          });
          externalProductId = registered.externalProductId;
          await prisma.product.update({
            where: { id: product.id, storeId: ctx.storeId },
            data: { externalProductId },
          });
        } catch {
          // Non-fatal by design. See the note above.
        }
        break;
      }
    }

    return {
      message: `Added "${product.name}" to your store`,
      metadata: {
        productId: product.id,
        designId: record.id,
        externalProductId,
        registeredWithProvider: externalProductId !== null,
      },
    };
  },

  // CLASS C — the product must exist with what was asked for. The provider
  // registration is a separate concern and is verified where it is performed;
  // this checks what this executable itself persisted.
  async verify(input, ctx, metadata): Promise<VerificationOutcome> {
    const id = metadata?.productId;
    if (!id) return { state: "failed", mismatches: ["the run recorded no product id"] };
    const product = await prisma.product.findFirst({
      where: { id, storeId: ctx.storeId },
      select: { name: true, priceInCents: true },
    });
    if (!product) return { state: "failed", mismatches: ["product: no such row after the create"] };
    return verifiedUnless(
      namedKeyMismatches(
        { name: input.name, priceInCents: input.priceInCents },
        product as unknown as Record<string, unknown>,
        "product."
      )
    );
  },
};
