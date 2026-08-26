"use client";

import { editProduct } from "../actions";
import { SubmitButton } from "../SubmitButton";
import { useActionFormState } from "../useActionFormState";
import { toPoundsAndOunces } from "@/lib/shipping/packagedWeight";
import { packagingHandledBy } from "@/lib/shipping/whoShips";
import type { ProductSourceKind } from "@prisma/client";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

// Responsive layout fix (2026-08-09) — "the description field is being
// clipped/squeezed... this needs a responsive layout fix, not a font-size
// fix" (Sean, from real mobile + desktop testing). Two real causes, both
// fixed here: rows={2} was never enough room for a real product
// description, and the field order (name/description/price) didn't match
// what a stacked mobile layout should read as (name, then price, then the
// long-form description last, right before Save — Sean's own explicit
// order). Field order and sizing are this form's own concern regardless of
// column width; the actual two-column-vs-stacked layout is the parent
// page's job (see products/page.tsx).
export function EditProductForm({
  product,
}: {
  product: {
    id: string;
    name: string;
    description: string | null;
    priceInCents: number;
    weightOz: number | null;
    lengthIn: number | null;
    widthIn: number | null;
    heightIn: number | null;
    // Who ships it. Null for every manually created product, which genuinely
    // is owner-shipped.
    sourceKind: ProductSourceKind | null;
    fulfillmentPartner: string | null;
  };
}) {
  const { state, formAction, resetKey } = useActionFormState(editProduct.bind(null, product.id));
  // Shown as the merchant weighed it. A value stored as 20 oz comes back as
  // "1 lb 4 oz", not 20 and not 1.25 — see toPoundsAndOunces.
  const saved = toPoundsAndOunces(product.weightOz);
  // Blank rather than 0 for an unset dimension, so an empty box reads as "not
  // given" and not as a claim that the parcel is flat.
  const savedIn = (value: number | null) => (value && value > 0 ? String(value) : "");
  // A sentence when somebody else packs this, null when the owner does.
  const packedByOther = packagingHandledBy(product.sourceKind, product.fulfillmentPartner);

  return (
    <form key={resetKey} action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Name</span>
        <input
          name="name"
          type="text"
          defaultValue={!state.ok && state.values?.name !== undefined ? state.values.name : product.name}
          required
          className="w-full rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Price</span>
        <input
          name="price"
          type="number"
          step="0.01"
          min="0"
          defaultValue={
            !state.ok && state.values?.price !== undefined
              ? state.values.price
              : (product.priceInCents / 100).toFixed(2)
          }
          required
          className="w-full max-w-[10rem] rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </label>
      {/* PACKAGING, BUT ONLY FROM WHOEVER ACTUALLY PACKS IT (2026-08-26).
          A print-on-demand shirt is boxed in a partner's warehouse; asking this
          owner what it weighs is asking them to invent a number that becomes
          real postage. ProductSourceKind already recorded who ships it — see
          lib/shipping/whoShips.ts. */}
      {packedByOther ? (
        <div className="rounded-xl border border-black/[.08] px-4 py-3 dark:border-white/[.145]">
          <p className="text-xs font-medium text-zinc-500">Shipping</p>
          <p className="mt-1 text-sm text-zinc-500">{packedByOther}</p>
        </div>
      ) : (
        <>
      {/* THE FIELD THE WHOLE SHIPPING SUBSYSTEM WAS WAITING ON (2026-08-25).
          Product.weightOz has been read by checkout rating since 2026-08-20 and
          written by nothing, so every product had a null weight and shipping
          quoting was unreachable everywhere.

          PACKAGED, and the label says so. What a carrier prices is the parcel —
          product, box, filler, tape. A merchant entering the bare product
          weight under-quotes every order they ship and absorbs the difference
          without ever seeing it. */}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-zinc-500">Shipping weight</legend>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Weigh it boxed and ready to post — the product plus its packaging. This is what
          shipping is quoted from at checkout.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <input
            name="weightLb"
            type="number"
            step="1"
            min="0"
            defaultValue={
              !state.ok && state.values?.weightLb !== undefined ? state.values.weightLb : saved.pounds
            }
            className="w-20 rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
          />
          <span className="text-xs text-zinc-500">lb</span>
          <input
            name="weightOz"
            type="number"
            step="0.1"
            min="0"
            defaultValue={
              !state.ok && state.values?.weightOz !== undefined ? state.values.weightOz : saved.ounces
            }
            className="w-20 rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
          />
          <span className="text-xs text-zinc-500">oz</span>
        </div>
        {/* Leaving both blank is a real answer, not an error: it clears the
            weight, and a product with no weight is simply one Genesis will not
            quote shipping for. */}
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          Leave both blank if this product isn&apos;t shipped.
        </p>
      </fieldset>
      {/* AND THE OTHER HALF OF THE PARCEL (2026-08-26). lengthIn/widthIn/heightIn
          were added alongside weightOz and written by nothing either, so every
          quote in the system was rated against a 6x4x2 default. That default is
          about right for a tensor ring in a padded mailer and wrong for
          anything larger, and Priority Mail prices dimensional weight — so a
          merchant shipping a big light box was being quoted for a small one and
          absorbing the gap on every order. */}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-zinc-500">Package dimensions</legend>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          The box as it goes out, in inches. Carriers price large light parcels by size, not
          just weight.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <input
            name="lengthIn"
            type="number"
            step="0.1"
            min="0"
            aria-label="Package length in inches"
            placeholder="L"
            defaultValue={
              !state.ok && state.values?.lengthIn !== undefined
                ? state.values.lengthIn
                : savedIn(product.lengthIn)
            }
            className="w-20 rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
          />
          <span className="text-xs text-zinc-500">&times;</span>
          <input
            name="widthIn"
            type="number"
            step="0.1"
            min="0"
            aria-label="Package width in inches"
            placeholder="W"
            defaultValue={
              !state.ok && state.values?.widthIn !== undefined
                ? state.values.widthIn
                : savedIn(product.widthIn)
            }
            className="w-20 rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
          />
          <span className="text-xs text-zinc-500">&times;</span>
          <input
            name="heightIn"
            type="number"
            step="0.1"
            min="0"
            aria-label="Package height in inches"
            placeholder="H"
            defaultValue={
              !state.ok && state.values?.heightIn !== undefined
                ? state.values.heightIn
                : savedIn(product.heightIn)
            }
            className="w-20 rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
          />
          <span className="text-xs text-zinc-500">in</span>
        </div>
        {/* All three or none — see parsePackagedDimensions. Two of three would
            leave the rating code substituting a default for the third, which is
            the invented number this field exists to remove. */}
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          Enter all three, or leave them blank to use a standard mailer size.
        </p>
      </fieldset>
        </>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Description</span>
        <textarea
          name="description"
          defaultValue={
            !state.ok && state.values?.description !== undefined
              ? state.values.description
              : (product.description ?? "")
          }
          placeholder="Description (optional)"
          rows={8}
          className="w-full min-h-[10rem] resize-y rounded-lg border border-black/[.08] px-3 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </label>
      <SubmitButton
        pendingText="Saving..."
        className={`self-start px-4 py-1 text-sm ${ACCENT_BUTTON}`}
      >
        Save
      </SubmitButton>
      {!state.ok && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
