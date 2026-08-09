"use client";

import { editProduct } from "../actions";
import { SubmitButton } from "../SubmitButton";
import { useActionFormState } from "../useActionFormState";

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
  product: { id: string; name: string; description: string | null; priceInCents: number };
}) {
  const { state, formAction, resetKey } = useActionFormState(editProduct.bind(null, product.id));

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
