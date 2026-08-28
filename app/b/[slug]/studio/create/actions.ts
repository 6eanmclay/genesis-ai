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
