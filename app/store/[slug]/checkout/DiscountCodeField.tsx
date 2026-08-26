"use client";

// THE ONE THING THE CUSTOMER SENDS: A CODE.
//
// Never an amount, never a promotion id, never a discounted price. Everything
// the charge is built from is derived on the server from rows the store owns —
// which is what makes tampering pointless rather than merely detected. The
// shipping step established this shape first (it submits a rate id and the
// server re-quotes); a discount has the same problem with a stronger motive.

export function DiscountCodeField({
  applied,
  error,
  pending,
  onApply,
  onRemove,
}: {
  /** The code currently applied, as the SERVER resolved it. */
  applied: string | null;
  /** Why the last attempt did not work, in the provider's own terms. */
  error: string | null;
  pending: boolean;
  onApply: (code: string) => void;
  onRemove: () => void;
}) {
  if (applied) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-600/30 bg-emerald-50/60 px-4 py-3 dark:bg-emerald-500/[.08]">
        <span className="text-[14px] text-emerald-800 dark:text-emerald-300">
          Code <span className="font-medium">{applied}</span> applied
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-[13px] text-emerald-800 underline underline-offset-2 dark:text-emerald-300"
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* NOT a nested <form>: this sits inside the checkout form on the shipping
          step, and HTML forbids nesting one. The button calls onApply directly
          and stays type="button" so it can never submit the outer form — a
          customer pressing Apply must not be sent to a payment page. */}
      <div className="flex items-stretch gap-2">
        <input
          name="discountCodeEntry"
          aria-label="Discount code"
          placeholder="Discount code"
          autoCapitalize="characters"
          autoComplete="off"
          disabled={pending}
          onKeyDown={(event) => {
            // Enter inside a text input submits the enclosing form by default,
            // which here would mean paying before the code was applied.
            if (event.key !== "Enter") return;
            event.preventDefault();
            onApply((event.target as HTMLInputElement).value);
          }}
          className="min-w-0 flex-1 rounded-lg border border-black/[.12] bg-white px-3 py-2 text-[15px] uppercase text-zinc-900 outline-none placeholder:normal-case focus:border-black/[.30] disabled:opacity-60 dark:border-white/[.14] dark:bg-white/[.04] dark:text-zinc-100"
        />
        <button
          type="button"
          disabled={pending}
          onClick={(event) => {
            const input = event.currentTarget.parentElement?.querySelector("input");
            onApply(input instanceof HTMLInputElement ? input.value : "");
          }}
          className="shrink-0 rounded-lg border border-black/[.14] px-4 text-[14px] font-medium text-[var(--brand-text)] disabled:opacity-60 dark:border-white/[.16]"
        >
          {pending ? "Checking..." : "Apply"}
        </button>
      </div>
      {error && <p className="mt-2 text-[13px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
