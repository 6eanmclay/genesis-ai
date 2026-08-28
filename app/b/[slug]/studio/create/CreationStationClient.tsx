"use client";

import { useState } from "react";
import type { Garment, BlankImage } from "@/lib/creation/garment";
import type { LibraryAsset } from "@/lib/creation/assetLibrary";
import type { ProductDesign } from "@/lib/creation/design";
import { CreationStation } from "./CreationStation";
import { saveDesignDraft, createProductFromDesign } from "./actions";

// THE THIN LAYER BETWEEN THE WORKSPACE AND THE SERVER.
//
// CreationStation is deliberately ignorant of how a product gets made — it
// takes an onAddToStore and reports whatever comes back. That keeps the whole
// design surface testable without a database, a supplier or a session, which
// is most of why the pure model was worth having.
//
// The name and price live here rather than inside the workspace because they
// are facts about a PRODUCT, not about a design. A design is what is printed;
// a product is what is sold, and the two are not the same decision.

export function CreationStationClient({
  slug,
  garment,
  assets,
  blanks,
  supplierPrices,
  creatableId,
  initialDraftId,
  initialDesign,
  initialName,
  initialPriceInCents,
  alreadyCreated,
}: {
  slug: string;
  garment: Garment;
  assets: LibraryAsset[];
  /** The supplier's blanks, and why there are none if there are none. */
  blanks: { images: BlankImage[]; problem: string | null };
  /** What the supplier charges, in cents, keyed by external variant id. */
  supplierPrices: Record<string, number>;
  creatableId: string;
  /** Reopening a saved design, when the owner came back to one. */
  initialDraftId?: string | null;
  initialDesign?: ProductDesign;
  initialName?: string;
  initialPriceInCents?: number | null;
  /** The reopened draft has already been made into a product. */
  alreadyCreated?: boolean;
}) {
  const [name, setName] = useState(initialName || garment.name);
  // ============ THE $75 (2026-08-27) ==================================
  //
  // This read the blank's cost off the variant, and Printful's catalog-variants
  // response has no price field at all — so `suggested` was ALWAYS the 2500
  // placeholder, tripled to 7500, printed as $75. Every product, every time.
  //
  // The real supplier price now comes from Printful's prices endpoint. Where
  // they price it, the starting selling price is three times that — a normal
  // apparel margin, and a starting point rather than a recommendation. Where
  // they do not, the field starts EMPTY: a number nobody can source is worse
  // than an empty box that has to be filled in.
  const supplierCost =
    garment.variants.map((v) => supplierPrices[v.externalVariantId]).find((c) => c) ?? null;
  const [price, setPrice] = useState(
    // A REOPENED DRAFT KEEPS THE OWNER'S PRICE. Recomputing the suggestion
    // would quietly overwrite a number they had already decided on.
    initialPriceInCents != null
      ? String(Math.round(initialPriceInCents / 100))
      : supplierCost === null
        ? ""
        : String(Math.max(Math.round((supplierCost * 3) / 100), 1)),
  );

  // THE DRAFT'S OWN ID, so the second save updates the first rather than
  // leaving the owner with ten copies of one design. Null until the first save
  // returns one; carried in state because a draft belongs to this editing
  // session until the owner leaves.
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null);
  const [created, setCreated] = useState(alreadyCreated === true);

  async function handleCreate(design: ProductDesign): Promise<string | null> {
    const dollars = Number(price);
    // A PRICE IS REQUIRED TO SELL, and this is where that is true — Save
    // deliberately does not ask, because an unpriced design is still work worth
    // keeping.
    if (!Number.isFinite(dollars) || dollars <= 0) return "Give it a price first.";
    const result = await createProductFromDesign(slug, design, {
      name,
      retailPriceInCents: Math.round(dollars * 100),
      draftId,
    });
    if (result.ok && result.productId) setCreated(true);
    return result.ok ? null : (result.error ?? "That product could not be created.");
  }

  async function handleSave(design: ProductDesign): Promise<string | null> {
    // A PRICE IS NOT REQUIRED TO SAVE. It is required to sell, and Create is
    // where that is checked — refusing to save an unpriced design would be
    // refusing to keep exactly the work somebody is not finished with.
    const dollars = Number(price);
    const priced = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null;
    const result = await saveDesignDraft(slug, design, { name, retailPriceInCents: priced, draftId });
    if (result.ok && result.designId) setDraftId(result.designId);
    return result.ok ? null : (result.error ?? "Couldn't save that design.");
  }

  return (
    <div>
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-end gap-4 px-5 pt-8">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] text-zinc-500">Product name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-black/[.12] bg-transparent px-3 py-2 text-[14px] dark:border-white/[.16]"
          />
        </label>
        <label className="flex w-32 flex-col gap-1">
          <span className="text-[12px] text-zinc-500">Your price</span>
          <input
            value={price}
            inputMode="decimal"
            onChange={(e) => setPrice(e.target.value)}
            className="rounded-lg border border-black/[.12] bg-transparent px-3 py-2 text-[14px] dark:border-white/[.16]"
          />
        </label>
      </div>

      <CreationStation
        slug={slug}
        garment={garment}
        assets={assets}
        blankImages={blanks.images}
        blankProblem={blanks.problem}
        supplierPrices={supplierPrices}
        creatableId={creatableId}
        onSave={handleSave}
        onCreate={handleCreate}
        alreadyCreated={created}
        initialDesign={initialDesign}
      />
    </div>
  );
}
