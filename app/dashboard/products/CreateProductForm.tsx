"use client";

import { createProduct } from "../actions";
import { SubmitButton } from "../SubmitButton";
import { useActionFormState } from "../useActionFormState";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

export function CreateProductForm() {
  const { state, formAction, resetKey } = useActionFormState(createProduct);

  return (
    <form key={resetKey} action={formAction} className="mt-4 flex max-w-md flex-col gap-4">
      <input
        name="name"
        type="text"
        defaultValue={!state.ok ? state.values?.name : undefined}
        placeholder="Product name"
        required
        className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <textarea
        name="description"
        defaultValue={!state.ok ? state.values?.description : undefined}
        placeholder="Description (optional)"
        rows={3}
        className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        name="price"
        type="number"
        step="0.01"
        min="0"
        defaultValue={!state.ok ? state.values?.price : undefined}
        placeholder="Price (e.g. 19.99)"
        required
        className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <SubmitButton pendingText="Adding..." className={`mt-2 px-5 py-2 ${ACCENT_BUTTON}`}>
        Add product
      </SubmitButton>
      {!state.ok && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
