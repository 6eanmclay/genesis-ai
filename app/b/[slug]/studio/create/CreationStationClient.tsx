"use client";

import { useState } from "react";
import type { Garment, BlankImage } from "@/lib/creation/garment";
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
  blankImages,
  creatableId,
}: {
  slug: string;
  garment: Garment;
  assets: { id: string; url: string; name: string }[];
  blankImages: BlankImage[];
  creatableId: string;
}) {
  const [name, setName] = useState(garment.name);
  // A default that is a real number rather than zero: roughly three times the
  // blank's own cost, which is a normal apparel margin and is a starting point
  // the owner can change rather than a recommendation.
  const suggested = garment.variants.find((v) => v.costInCents)?.costInCents ?? 2500;
  const [price, setPrice] = useState(String(Math.max(Math.round((suggested * 3) / 100), 1)));

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
          <span className="text-[12px] text-zinc-500">Price</span>
          <input
            value={price}
            inputMode="decimal"
            onChange={(e) => setPrice(e.target.value)}
            className="rounded-lg border border-black/[.12] bg-transparent px-3 py-2 text-[14px] dark:border-white/[.16]"
          />
        </label>
      </div>

      <CreationStation
        garment={garment}
        assets={assets}
        blankImages={blankImages}
        creatableId={creatableId}
        onAddToStore={handleAdd}
      />
    </div>
  );
}
