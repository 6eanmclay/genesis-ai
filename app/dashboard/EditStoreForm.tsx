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
  slug,
  store,
}: {
  /**
   * The business this form belongs to, when it was rendered inside one.
   *
   * Bound into the action, so a form on one business's page writes to THAT
   * business rather than to whichever one the account was last active in.
   */
  slug?: string;
  store: { name: string; tagline: string | null; description: string | null; contactEmail: string | null };
}) {
  const { state, formAction, resetKey } = useActionFormState(editStore.bind(null, slug));

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
          // 3 rows was shorter than what an owner actually writes about their
          // own business, so the field scrolled internally while editing —
          // you could not see what you had already written. 8 rows fits a
          // real description without scrolling; resize-y lets it grow further
          // rather than capping anyone who writes more.
          rows={8}
          className="resize-y rounded-lg border border-black/[.08] px-4 py-2 leading-relaxed dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>

      {/* WHERE A CUSTOMER CAN REACH THIS BUSINESS.
          Added here rather than in Settings because this page is already
          "Business Identity" - the name, tagline and description a customer
          sees - and a public contact address is the same kind of fact. It is
          deliberately NOT prefilled from the account's login address: an
          empty box means the owner has not published one, and the storefront
          shows no contact at all rather than an address they never chose. */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Customer contact email
        </label>
        <input
          name="contactEmail"
          type="email"
          inputMode="email"
          autoComplete="off"
          defaultValue={store.contactEmail ?? ""}
          placeholder="Optional - shown to customers"
          className="rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <p className="text-xs text-zinc-500">
          Shown on your storefront and used for replies to order confirmations. Leave blank to show
          none. This is never your sign-in address unless you type it here.
        </p>
      </div>
      <SubmitButton pendingText="Saving..." className={`mt-2 self-start px-5 py-2 ${ACCENT_BUTTON}`}>
        Save
      </SubmitButton>
      {!state.ok && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
