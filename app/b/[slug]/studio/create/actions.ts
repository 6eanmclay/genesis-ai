"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ingestBusinessAsset } from "@/lib/businessAssets/ingest";
import type { Asset } from "@/lib/businessModel/entities";
import { removedFromLibrary, restoredToLibrary } from "@/lib/creation/assetLibrary";
import { PERMISSIONS } from "@/lib/permissions";
import { requireStorePermission } from "@/lib/permissions";
import { usedPlacements, type ProductDesign } from "@/lib/creation/design";
import { saveDesignAsProduct } from "@/lib/creation/saveDesign";
import { creationProviderFor } from "@/lib/creation/provider";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { DesignSchema } from "@/lib/businessModel/entities";
import { toDraft, toDesign } from "@/lib/creation/designDraft";
import { blankFor } from "@/lib/creation/garment";
import { randomUUID } from "crypto";
import { execute } from "@/lib/execution/engine";
import { createProductFromDesignExecutable } from "@/lib/execution/executables/productFromDesign";

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
//
// ============ AND THE PRODUCT SAYS SO (2026-08-28) =====================
//
// That reasoning was right and the product record did not carry it. It was
// written ACTIVE, marked PRINT_ON_DEMAND, with a Printful provider and a
// catalogue id — indistinguishable, to every other part of Genesis, from a
// product a supplier could actually make. The button said "Add to my store"
// and the note said "Added to your store."
//
// Two states, and they are not the same thing:
//
//   I have designed this
//   this product has been created with my supplier and is ready to sell
//
// Only the first is true today, so only the first is claimed: active false,
// supplierProductCreated false on the design, and copy that says which one it
// is. Nothing about the design is thrown away — when the supplier contract is
// wired and verified, this becomes a transition rather than a rebuild.

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

  // THE DECISION AND THE WRITE LIVE IN lib/creation/saveDesign.ts, which a
  // suite can call with a garment of its own. What stays here is what only an
  // action can do: the permission check, and asking the supplier what the blank
  // actually is. See that file for why the split exists.
  const result = await saveDesignAsProduct({
    storeId: store.id,
    design,
    meta,
    garment,
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/b/${slug}/products`);
  revalidatePath(`/b/${slug}/studio`);
  return { ok: true };
}

// ============ SAVE IS A DESIGN STATE, NOT A PRODUCT (2026-08-28) ========
//
// Sean, after testing the live deployment: "Save = save the current design as a
// design/draft so the user can leave, come back later, and continue editing it.
// No product creation and no Growth Points spent... The user should be able to
// save something 10 times while working on it without paying Growth Points
// every time."
//
// What Save did before was call addDesignToStore, which wrote a PRODUCT row
// carrying a designSpec blob. The trace found the reason it felt like nothing
// happened: `designSpec` HAS NO READERS ANYWHERE. Nothing listed it, nothing
// loaded it, no route reopened it. The design went into a field that is only
// ever written.
//
// A save now writes a `design` BusinessRecord — the entity that already exists,
// that createDesign writes, and that productFromDesign consumes — so there is
// one design system with two ways into it rather than two.

/** The source name this Creation Station's drafts are written under. */
const DRAFT_SOURCE = "genesis_creation";

export interface SaveDraftResult {
  ok: boolean;
  error?: string;
  /** The draft's id, so the next save updates rather than duplicates. */
  designId?: string;
}

/**
 * Save the design the owner is working on. Free, repeatable, recoverable.
 *
 * UPSERT BY draftId, which is the whole reason it is a parameter. Ten saves of
 * one design must leave one draft, not ten — persistSyncedRecords keys on
 * (storeId, entityType, sourceProvider, externalId), so passing the id back in
 * updates the same record. The first save has no id and gets one.
 */
export async function saveDesignDraft(
  slug: string,
  design: ProductDesign,
  meta: { name: string; retailPriceInCents: number | null; draftId?: string | null },
): Promise<SaveDraftResult> {
  const { store, userId } = await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE, slug);

  const provider = await creationProviderFor(store.id);
  if (!provider) return { ok: false, error: "Connect a print supplier before saving a design." };

  // THE GARMENT IS RE-READ, for the same reason addDesignToStore re-reads it:
  // the print areas frozen onto a draft have to be the supplier's own.
  const garment = await provider.getGarment({ storeId: store.id, externalProductId: design.externalProductId });
  if (!garment) return { ok: false, error: "That blank is no longer available from your supplier." };

  const draftId = meta.draftId || randomUUID();

  // Carried forward so re-saving a draft that has already been created does not
  // make it look uncreated — which would offer a second paid Create for a
  // product that already exists.
  const existing = meta.draftId
    ? await prisma.businessRecord.findFirst({
        where: {
          storeId: store.id,
          entityType: "design",
          sourceProvider: DRAFT_SOURCE,
          externalId: draftId,
        },
        select: { data: true },
      })
    : null;
  const previous = existing ? DesignSchema.safeParse(existing.data) : null;

  // WHICH BLANK EACH SIDE WAS SHOWING, resolved from the supplier's own images
  // through the same pure function the editor draws with — so the picture the
  // product ends up with is the picture that was on screen.
  const variant = garment.variants.find((v) => v.externalVariantId === design.externalVariantId) ?? null;
  const blankImages = await provider.getBlankImages({
    storeId: store.id,
    externalProductId: design.externalProductId,
  });
  const blanks: Record<string, string> = {};
  for (const [placement, layers] of Object.entries(design.placements)) {
    if (layers.length === 0) continue;
    const blank = blankFor(blankImages, placement, variant?.colorHex ?? null, variant?.color ?? null);
    if (blank.url) blanks[placement] = blank.url;
  }

  const data = toDraft(design, {
    garment,
    name: meta.name,
    retailPriceInCents: meta.retailPriceInCents,
    blanks,
  }, previous?.success ? previous.data.placement : null);

  const result = await persistSyncedRecords(store.id, DRAFT_SOURCE, [
    { entityType: "design", externalId: draftId, data },
  ], {
    // THE OWNER MADE THIS. They positioned every layer themselves, so the
    // provenance is theirs rather than GENERATED — which is what createDesign
    // records for a composition J4 produced. The distinction is the same one
    // J4_BUSINESS_UNDERSTANDING_MODEL.md draws everywhere else.
    provenance: "OWNER",
    provenanceDetail: "creation station",
    statedById: userId,
    modelExtracted: false,
  });
  if (result.errors.length > 0) {
    return { ok: false, error: "That design could not be saved." };
  }

  revalidatePath(`/b/${slug}/studio`);
  return { ok: true, designId: draftId };
}

/** Every design the owner has saved and not yet turned into a product. */
export async function savedDesignsFor(storeId: string): Promise<
  { draftId: string; recordId: string; externalProductId: string; name: string; summary: string; updatedAt: string | null; created: boolean }[]
> {
  const rows = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "design", sourceProvider: DRAFT_SOURCE },
    select: { id: true, externalId: true, data: true },
    orderBy: { syncedAt: "desc" },
    take: 40,
  });

  const drafts: { draftId: string; recordId: string; externalProductId: string; name: string; summary: string; updatedAt: string | null; created: boolean }[] = [];
  for (const row of rows) {
    const parsed = DesignSchema.safeParse(row.data);
    if (!parsed.success || !parsed.data.placement) continue;
    const p = parsed.data.placement;
    drafts.push({
      draftId: row.externalId ?? row.id,
      recordId: row.id,
      // WHICH BLANK IT WAS DESIGNED ON. Carried so reopening can land in the
      // editor: the create page needs ?garment= to open one at all, and a link
      // with only ?design= would drop the owner back at the doorway they were
      // trying to leave.
      externalProductId: p.externalProductId,
      name: p.productName ?? "Untitled design",
      summary: draftSummaryOf(p.color, p.placements),
      updatedAt: p.updatedAt,
      created: p.productId !== null,
    });
  }
  return drafts;
}

/** A saved design, ready to go back into the editor. */
export async function loadDesignDraft(
  storeId: string,
  draftId: string,
): Promise<{ design: ProductDesign; name: string; retailPriceInCents: number | null; created: boolean } | null> {
  const row = await prisma.businessRecord.findFirst({
    where: { storeId, entityType: "design", sourceProvider: DRAFT_SOURCE, externalId: draftId },
    select: { data: true },
  });
  if (!row) return null;
  const parsed = DesignSchema.safeParse(row.data);
  if (!parsed.success) return null;
  const design = toDesign(parsed.data);
  if (!design) return null;
  return {
    design,
    name: parsed.data.placement?.productName ?? "",
    retailPriceInCents: parsed.data.placement?.retailPriceInCents ?? null,
    // Reopening something already made must not offer to make it again.
    created: parsed.data.placement?.productId != null,
  };
}

/** The one-line description shown in the saved list. Kept beside its reader. */
function draftSummaryOf(color: string | null, placements: Record<string, unknown[]>): string {
  const sides = Object.entries(placements).filter(([, l]) => l.length > 0).map(([k]) => k);
  const where = sides.length === 0 ? "nothing on it yet" : sides.join(" and ");
  return `${color ? `${color}, ` : ""}${where}`;
}

// ============ CREATE IS THE COMMITMENT (2026-08-28) =====================
//
// Sean: "Create = 2 Growth Points. This is the actual commitment. It must take
// the saved/current design, create the product with the connected print
// supplier using the exact variant/color/size and all selected placements, and
// then make that product available in the owner's Genesis storefront."
//
// Everything that makes that true lives in the executable, not here: the
// supplier call, the read-back that proves the placements exist, the Product
// row, and the link back to the design. This function's whole job is to save
// the current state first and then hand the design's id to the engine.
//
// THROUGH execute(), which is what makes the 2 points real. The engine checks
// the balance, deducts on a non-FAILED outcome, and writes the ExecutionLog —
// so a supplier refusal costs nothing, because the deduction never happens on a
// failure. Charging here by hand would have to reimplement all three.

export interface CreateProductResult {
  ok: boolean;
  error?: string;
  productId?: string;
  /** The placements the supplier confirmed it holds. */
  placements?: string[];
  message?: string;
}

/**
 * Turn the design on screen into a real product.
 *
 * SAVES FIRST, ALWAYS. The owner may have moved something since their last
 * save, and creating a product from a stale draft would put a different design
 * in the shop than the one they were looking at.
 */
export async function createProductFromDesign(
  slug: string,
  design: ProductDesign,
  meta: { name: string; retailPriceInCents: number; draftId?: string | null },
): Promise<CreateProductResult> {
  const { store } = await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE, slug);

  if (!Number.isFinite(meta.retailPriceInCents) || meta.retailPriceInCents <= 0) {
    return { ok: false, error: "Give it a price before creating the product." };
  }

  const saved = await saveDesignDraft(slug, design, {
    name: meta.name,
    retailPriceInCents: meta.retailPriceInCents,
    draftId: meta.draftId ?? null,
  });
  if (!saved.ok || !saved.designId) {
    return { ok: false, error: saved.error ?? "That design could not be saved." };
  }

  // The record id, which is what the executable takes — the draft id is the
  // externalId the owner's URL carries, and the two are deliberately different
  // things.
  const record = await prisma.businessRecord.findFirst({
    where: {
      storeId: store.id,
      entityType: "design",
      sourceProvider: DRAFT_SOURCE,
      externalId: saved.designId,
    },
    select: { id: true },
  });
  if (!record) return { ok: false, error: "That design could not be found after saving." };

  const result = await execute(
    createProductFromDesignExecutable,
    { designId: record.id, name: meta.name, priceInCents: meta.retailPriceInCents },
    { storeId: store.id, actionType: "create_product_from_design" },
  );

  if (result.status === "FAILED") {
    // THE SUPPLIER'S OWN WORDS. A refusal here is the most important message in
    // the whole flow — it is the difference between the owner knowing their
    // back print was rejected and finding out from a customer.
    return { ok: false, error: result.message || "That product could not be created." };
  }

  revalidatePath(`/b/${slug}/products`);
  revalidatePath(`/b/${slug}/studio`);
  return {
    ok: true,
    productId: result.metadata?.productId,
    placements: result.metadata?.placements,
    message: result.message,
  };
}

/** What the owner is about to add, for the confirmation line. */
export async function describeDesign(design: ProductDesign): Promise<string> {
  const sides = usedPlacements(design);
  return sides.length === 0 ? "nothing yet" : sides.join(" and ");
}

// ============ THE CREATION STATION'S ASSET LIBRARY (2026-08-28) =========
//
// Three actions, and the shape of them is the guarantee. Sean: "Deleting it
// from the creation library should not accidentally erase something J4 needs
// to remember about the business."
//
// So there is no delete here. Removing writes a date onto the record J4
// already holds; restoring clears it. Neither touches role, origin,
// classification, supersession or the file itself, and no code path in this
// file can remove a BusinessRecord even by mistake — the capability is simply
// absent rather than guarded.

/**
 * Bring an uploaded file into the business's assets and its Creation Station.
 *
 * REUSES ingestBusinessAsset RATHER THAN WRITING A SECOND STORE. That function
 * already writes the permanent record, sets origin "uploaded", and now measures
 * the file's real alpha. An upload made here and an upload made in chat produce
 * the same asset, which is the point: the library is a lens over J4's memory,
 * not a parallel collection.
 */
export async function addAssetToLibrary(
  slug: string,
  uploaded: { url: string; originalFilename: string; contentType: string },
): Promise<{ ok: boolean; error?: string }> {
  const { store } = await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE, slug);
  if (!uploaded?.url || !uploaded.url.startsWith("https://")) {
    return { ok: false, error: "That upload did not complete." };
  }

  await ingestBusinessAsset(store.id, uploaded);
  revalidatePath(`/b/${slug}/studio/create`);
  return { ok: true };
}

/**
 * Take an asset out of the Creation Station. J4 still remembers it.
 *
 * The record is read, one field is set, and it is written back — so anything
 * else on it survives untouched, including fields added after this was written.
 */
export async function removeAssetFromLibrary(
  slug: string,
  recordId: string,
): Promise<{ ok: boolean; error?: string }> {
  return setLibraryMembership(slug, recordId, false);
}

/** Put it back. The exact inverse — removal was never destructive. */
export async function restoreAssetToLibrary(
  slug: string,
  recordId: string,
): Promise<{ ok: boolean; error?: string }> {
  return setLibraryMembership(slug, recordId, true);
}

async function setLibraryMembership(
  slug: string,
  recordId: string,
  present: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { store } = await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE, slug);

  // SCOPED TO THE BUSINESS, not just to the id. A record id from another store
  // must not resolve here — the same rule every other read of these records
  // follows.
  const record = await prisma.businessRecord.findFirst({
    where: { id: recordId, storeId: store.id, entityType: "asset" },
    select: { id: true, data: true },
  });
  if (!record) return { ok: false, error: "That asset is not in this business." };

  const asset = record.data as unknown as Asset;
  const next = present ? restoredToLibrary(asset) : removedFromLibrary(asset);

  // STORE-SCOPED ON THE WRITE, not only on the read (2026-08-28).
  //
  // The findFirst above already proved this record belongs to this business,
  // and updating by id alone would still have been a bare cross-tenant write —
  // one refactor away from losing the check that made it safe. The tenant
  // isolation extension refused it, correctly, the first time this ran.
  await prisma.businessRecord.update({
    where: { id: record.id, storeId: store.id },
    data: { data: next as unknown as Prisma.InputJsonValue },
  });

  revalidatePath(`/b/${slug}/studio/create`);
  return { ok: true };
}
