import { prisma } from "@/lib/prisma";
import { verifiedUnless, namedKeyMismatches } from "../verification";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import { DesignSchema } from "@/lib/businessModel/entities";
import { getFulfillmentConnectors } from "@/lib/fulfillment/registry";
import { partnerParcelFor, parcelToProductData } from "@/lib/fulfillment/parcel";
import { SURFACES } from "@/lib/design/surfaces";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
import { composePrintFile } from "@/lib/creation/composePrintFile";
import { composeMockup } from "@/lib/creation/composeMockup";
import type { Design } from "@/lib/businessModel/entities";
import type { ExecutionContext } from "../executable";

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
  /** Placements the supplier confirmed, read back. Absent on the composed path. */
  placements?: string[];
  /** How many storefront images were composed. Zero is a real answer. */
  mockupCount?: number;
}

// ============ THE MEASURED DPI (2026-08-28) ============================
//
// Printful states a print area in INCHES on v2 and a printfile in PIXELS on v1,
// and the two agree at 150: product 146's front composes to 2100x2100 and its
// back to 1800x2400, which is exactly 14x14in and 12x16in at 150dpi. Both
// numbers were read from the live account rather than assumed, and they
// cross-check each other.
//
// The printfiles also declare fill_mode "fit", so Printful fits what it is
// given -- the ASPECT RATIO is what must be right and the resolution only has
// to be sufficient. That is why this is a constant rather than another API call
// at creation time.
const PRINT_DPI = 150;

/** The supplier's canvas for one placement, in real pixels. */
function canvasFor(area: { width: number; height: number; unit: string }): { width: number; height: number } {
  const scale = area.unit === "in" ? PRINT_DPI : 1;
  return {
    width: Math.max(1, Math.round(area.width * scale)),
    height: Math.max(1, Math.round(area.height * scale)),
  };
}

async function fetchArtwork(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`That artwork could not be read (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Create a product from a design the owner laid out themselves.
 *
 * ============ THE ORDER IS THE SAFETY (2026-08-28) ====================
 *
 * The supplier is called FIRST and verified BEFORE anything is written to
 * Genesis. Sean: "Create must actually work end-to-end before the button
 * exists... Verify the supplier creation and then read the resulting product
 * back to confirm it exists and matches what the owner created."
 *
 * If the supplier refuses, or confirms fewer placements than were sent, this
 * throws -- execute() records FAILED, and because Growth Points are deducted
 * only on a non-FAILED outcome, THE OWNER IS NOT CHARGED for a product that
 * does not exist. The other order would leave a storefront product nobody can
 * manufacture, which is the exact dishonesty active:false was introduced to
 * avoid.
 */
async function createFromPlacementDesign(
  design: Design,
  input: CreateProductFromDesignInput,
  ctx: ExecutionContext,
  recordId: string,
): Promise<ProductFromDesignMetadata> {
  const placement = design.placement;
  if (!placement) throw new Error("That design has no product design on it.");
  if (!placement.externalVariantId) throw new Error("That design has no colour and size chosen.");

  const sides = Object.entries(placement.placements).filter(([, layers]) => layers.length > 0);
  if (sides.length === 0) throw new Error("That design has no artwork on it yet.");

  const connector = getFulfillmentConnectors().find((c) => c.provider === placement.provider);
  if (!connector?.createProductWithPlacements) {
    throw new Error("That supplier cannot create a product with placements yet.");
  }
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: ctx.storeId, provider: connector.provider } },
    select: { credentials: true },
  });
  if (!integration?.credentials) throw new Error("That print supplier is not connected.");

  // ---- one print-ready file per placement -----------------------------
  //
  // Composed rather than passed through, because a placement can hold several
  // layers and the supplier takes one file per placement. Each is composed
  // against ITS OWN canvas: front and back are not the same shape.
  const areas = new Map(placement.printAreas.map((a) => [a.placement, a]));
  const files: { placement: string; url: string }[] = [];
  for (const [side, layers] of sides) {
    const area = areas.get(side);
    if (!area) throw new Error(`Your supplier no longer prints on the ${side}.`);
    const composed = await composePrintFile(layers, canvasFor(area), fetchArtwork);
    const blob = await put(`printfiles/${randomUUID()}-${side}.png`, composed, {
      access: "public",
      contentType: "image/png",
    });
    files.push({ placement: side, url: blob.url });
  }

  // ---- and one PICTURE per placement, which is a different thing -------
  //
  // ============ WHY THE PRINT FILE IS NOT THE PRODUCT PHOTO (2026-08-28) =
  //
  // Sean, after a created product arrived showing "Photos (0/10), No image":
  // "The product created from Creation Station should arrive in the store with
  // the correct generated product image(s), including the front/back design
  // that was actually created... the actual composition the user previewed, not
  // a generic supplier image or a newly generated approximation."
  //
  // A print file is artwork alone on transparency — correct for a printer,
  // useless as a storefront photograph. So each side is ALSO composed as a
  // mockup: the supplier's own blank, tinted to the colour the owner chose,
  // with the artwork laid into the same print-area rectangle at the same
  // fractions the canvas drew it at.
  //
  // The blank and the hex come off the DRAFT, recorded when the owner was
  // looking at them, so this rebuilds that picture rather than re-deriving one
  // that might differ. Where a draft predates that recording there is nothing
  // honest to compose from, and the product is created without a mockup rather
  // than with an invented one.
  const mockups: { placement: string; url: string }[] = [];
  if (placement.colorHex) {
    for (const [side, layers] of sides) {
      const blankUrl = placement.blanks[side];
      if (!blankUrl) continue;
      try {
        const image = await composeMockup({
          blank: await fetchArtwork(blankUrl),
          colorHex: placement.colorHex,
          layers,
          fetchImage: fetchArtwork,
        });
        const blob = await put(`mockups/${randomUUID()}-${side}.png`, image, {
          access: "public",
          contentType: "image/png",
        });
        mockups.push({ placement: side, url: blob.url });
      } catch {
        // NON-FATAL, DELIBERATELY. A supplier CDN that will not answer is not a
        // reason to refuse a product the supplier has already agreed to make.
        // The product is created either way; what varies is whether it arrives
        // with its photograph, and that is visible rather than silent.
      }
    }
  }

  // Front first where there is one, because that is the picture a customer
  // sees on a card. Otherwise the order the owner designed in.
  mockups.sort((a, b) => (a.placement === "front" ? -1 : b.placement === "front" ? 1 : 0));

  // ---- the supplier, and then the supplier again ----------------------
  const created = await connector.createProductWithPlacements({
    storeId: ctx.storeId,
    storeDraftId: null,
    name: input.name,
    retailPriceInCents: input.priceInCents,
    externalVariantId: placement.externalVariantId,
    files,
  });

  // WHAT WAS ASKED FOR, AGAINST WHAT THE SUPPLIER SAYS IT HAS. This is the
  // check that stops a two-sided design becoming a one-sided product.
  const missing = files.map((f) => f.placement).filter((p) => !created.placements.includes(p));
  if (missing.length > 0) {
    throw new Error(
      `Your supplier created the product but did not record the ${missing.join(" or ")} print. ` +
        `It confirmed: ${created.placements.join(", ") || "nothing"}. Nothing has been put on sale.`,
    );
  }

  // ---- only now does Genesis have a product ---------------------------
  const productCount = await prisma.product.count({ where: { storeId: ctx.storeId } });
  const parcel = await partnerParcelFor({
    provider: connector.provider,
    storeId: ctx.storeId,
    storeDraftId: null,
    externalProductId: created.externalProductId,
    externalVariantId: placement.externalVariantId,
  });

  const product = await prisma.product.create({
    data: {
      storeId: ctx.storeId,
      name: input.name,
      description: input.description ?? "",
      priceInCents: input.priceInCents,
      position: productCount,
      // THE MOCKUP, which is what a customer looks at. Falls back to the print
      // file only when no mockup could be composed — a picture of the artwork
      // is a poor product photo, but it beats the empty tile that sent Sean
      // looking for where the image had been lost.
      imageUrl: mockups[0]?.url ?? files[0]?.url ?? null,
      // ON SALE. This is the whole difference between Save and Create -- the
      // supplier has confirmed it holds every placement, so it can be made.
      active: true,
      sourceKind: "PRINT_ON_DEMAND",
      externalProductId: created.externalProductId,
      externalVariantId: placement.externalVariantId,
      fulfillmentProvider: connector.provider,
      sourceKey: connector.provider.toLowerCase(),
      richContent: {
        // THE RELATIONSHIP KEPT. Sean: "Creating a product should preserve the
        // relationship to the design so J4 knows what happened."
        designId: recordId,
        placements: files.map((f) => f.placement),
        printFileUrls: files.map((f) => f.url),
      },
      ...parcelToProductData(parcel),
    },
  });

  // ============ THE GALLERY COUNTS ProductImage ROWS ==================
  //
  // "Photos (0/10)" is `ordered.length` in ProductImageGallery, and ordered is
  // built from ProductImage rows. lib/creation/saveDesign.ts set the scalar
  // imageUrl and wrote NO ProductImage at all, so the gallery was empty however
  // that column was filled. Both are written here, and the scalar column and
  // the table must not disagree — the same rule every other product-creating
  // path in this codebase follows.
  const gallery = mockups.length > 0 ? mockups : files;
  await prisma.productImage.createMany({
    data: gallery.map((image, index) => ({
      productId: product.id,
      url: image.url,
      position: index,
    })),
  });

  // The draft now knows what became of it, so reopening it cannot offer a
  // second paid Create for a product that already exists.
  await prisma.businessRecord.updateMany({
    where: { id: recordId, storeId: ctx.storeId },
    data: {
      data: {
        ...design,
        placement: { ...placement, productId: product.id, supplierProductCreated: true },
      },
    },
  });

  return {
    productId: product.id,
    designId: recordId,
    externalProductId: created.externalProductId,
    registeredWithProvider: true,
    placements: created.placements,
    mockupCount: mockups.length,
  };
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

    // TWO SHAPES, ONE ENTITY. A product design carries placements and a chosen
    // variant; a composed design carries a flattened mockup. They share the
    // `design` record type deliberately -- one design system -- and the branch
    // is here rather than in a second executable so both end at a Product that
    // records which design it came from.
    if (design.placement) {
      const metadata = await createFromPlacementDesign(design, input, ctx, record.id);
      return {
        // NAMES THE SIDES, because "added a product" would hide the one thing
        // the owner most needs confirmed: that the back really is printed.
        message:
          `Created "${input.name}" with your supplier` +
          `${metadata.placements?.length ? ` (${metadata.placements.join(" and ")})` : ""}` +
          `, and it is on sale in your storefront.`,
        metadata,
      };
    }

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

          // WHO SHIPS THIS, RECORDED (2026-08-26).
          //
          // This wrote externalProductId and nothing else, so a product J4 had
          // just handed to Printful looked, to the rest of Genesis, exactly
          // like something the owner makes in their kitchen. sourceKind was
          // null, which whoShips.ts reads as owner-shipped — so the owner was
          // asked for a packaged weight and box size for a parcel that is
          // packed in Printful's warehouse and that they will never see.
          //
          // These three facts are what stop that. They are also what
          // productSupportsLiveShipping and the Buy Label button read, so a
          // partner-shipped product no longer gets quoted against the owner's
          // own EasyPost account or offered a label for a box they do not have.
          const parcel = await partnerParcelFor({
            provider: connector.provider,
            storeId: ctx.storeId,
            storeDraftId: null,
            externalProductId: registered.externalProductId,
            externalVariantId: candidate.variant.externalVariantId,
          });

          await prisma.product.update({
            where: { id: product.id, storeId: ctx.storeId },
            data: {
              externalProductId,
              externalVariantId: candidate.variant.externalVariantId,
              fulfillmentProvider: connector.provider,
              // Printed per order by a partner who ships it — the schema's own
              // words for this kind. Read off the connector that actually
              // accepted the product, never assumed from a provider name.
              sourceKind: "PRINT_ON_DEMAND",
              sourceKey: connector.provider.toLowerCase(),
              // Empty for every partner today: neither Printful nor Printify
              // exposes a parcel. Spread so that stays a no-op rather than
              // writing zeroes. See lib/fulfillment/parcel.ts.
              ...parcelToProductData(parcel),
            },
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
