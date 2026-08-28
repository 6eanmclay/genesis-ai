"use client";

import { useState } from "react";
import type { Garment, BlankImage } from "@/lib/creation/garment";
import type { LibraryAsset } from "@/lib/creation/assetLibrary";
import type { ProductDesign } from "@/lib/creation/design";
import { CreationStation } from "./CreationStation";
import { addDesignToStore } from "./actions";

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
}: {
  slug: string;
  garment: Garment;
  assets: LibraryAsset[];
  /** The supplier's blanks, and why there are none if there are none. */
  blanks: { images: BlankImage[]; problem: string | null };
  /** What the supplier charges, in cents, keyed by external variant id. */
  supplierPrices: Record<string, number>;
  creatableId: string;
}) {
  const [name, setName] = useState(garment.name);
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
    supplierCost === null ? "" : String(Math.max(Math.round((supplierCost * 3) / 100), 1)),
  );

  async function handleAdd(design: ProductDesign): Promise<string | null> {
    const dollars = Number(price);
    if (!Number.isFinite(dollars) || dollars <= 0) return "Give it a price first.";
    const result = await addDesignToStore(slug, design, {
      name,
      retailPriceInCents: Math.round(dollars * 100),
    });
    return result.ok ? null : (result.error ?? "Couldn't add that to your store.");
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
        onAddToStore={handleAdd}
      />
    </div>
  );
}
