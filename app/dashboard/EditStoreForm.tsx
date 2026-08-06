"use client";

import { editStore } from "./actions";
import { SubmitButton } from "./SubmitButton";
import { useActionFormState } from "./useActionFormState";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

// Labels hardcoded rather than imported from lib/execution/genesisActions
// (FIELD_LABELS) — that module transitively pulls in every Executable,
// which pull in prisma, which can't be part of a client bundle (the exact
// bug pattern already caught once this session with navConfig.ts).
export function EditStoreForm({
  store,
}: {
  store: { name: string; tagline: string | null; description: string | null };
}) {
  const { state, formAction, resetKey } = useActionFormState(editStore);

  return (
    <form key={resetKey} action={formAction} className="mt-4 flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Business Name
        </label>
        <input
          name="name"
          type="text"
          defaultValue={!state.ok && state.values?.name !== undefined ? state.values.name : store.name}
          required
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Tagline</label>
        <input
          name="tagline"
          type="text"
          defaultValue={!state.ok && state.values?.tagline !== undefined ? state.values.tagline : (store.tagline ?? "")}
          placeholder="Tagline (optional)"
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Description</label>
        <textarea
          name="description"
          defaultValue={
            !state.ok && state.values?.description !== undefined
              ? state.values.description
              : (store.description ?? "")
          }
          placeholder="Description (optional)"
          rows={3}
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>
      <SubmitButton pendingText="Saving..." className={`mt-2 self-start px-5 py-2 ${ACCENT_BUTTON}`}>
        Save
      </SubmitButton>
      {!state.ok && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
