"use client";

import { editProduct } from "../actions";
import { SubmitButton } from "../SubmitButton";
import { useActionFormState } from "../useActionFormState";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

export function EditProductForm({
  product,
}: {
  product: { id: string; name: string; description: string | null; priceInCents: number };
}) {
  const { state, formAction, resetKey } = useActionFormState(editProduct.bind(null, product.id));

  return (
    <form key={resetKey} action={formAction} className="flex flex-col gap-2">
      <input
        name="name"
        type="text"
        defaultValue={!state.ok && state.values?.name !== undefined ? state.values.name : product.name}
        required
        className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <textarea
        name="description"
        defaultValue={
          !state.ok && state.values?.description !== undefined
            ? state.values.description
            : (product.description ?? "")
        }
        placeholder="Description (optional)"
        rows={2}
        className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
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
        className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <SubmitButton
        pendingText="Saving..."
        className={`mt-1 self-start px-4 py-1 text-sm ${ACCENT_BUTTON}`}
      >
        Save
      </SubmitButton>
      {!state.ok && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
