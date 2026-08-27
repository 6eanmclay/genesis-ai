import { applyBagCode, clearBagCode } from "../bagActions";
import type { BagCodeOutcome } from "@/lib/bag/resolveBag";

// THE DISCOUNT CODE, IN THE BAG.
//
// The customer types a code and the server decides what it is worth — against
// this bag, at this moment, from this store's own rows. Nothing about the
// discount is decided here, and no amount is ever submitted.
//
// A REJECTED CODE KEEPS WHAT THEY TYPED. Clearing the field on a failure hides
// the typo that caused it, which is the one thing they need to see.

export function BagCodeField({
  slug,
  typed,
  outcome,
}: {
  slug: string;
  /** What is in the cookie, right or wrong. */
  typed: string | null;
  /** The server's verdict, or null when nobody has entered anything. */
  outcome: BagCodeOutcome | null;
}) {
  const applied = outcome?.applied ? outcome.code : null;

  if (applied) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-600/30 bg-emerald-50/60 px-4 py-3 dark:bg-emerald-500/[.08]">
        <span className="text-[14px] text-emerald-800 dark:text-emerald-300">
          Code <span className="font-medium">{applied}</span> applied
        </span>
        <form action={clearBagCode.bind(null, slug)}>
          <button
            type="submit"
            className="text-[13px] text-emerald-800 underline underline-offset-2 dark:text-emerald-300"
          >
            Remove
          </button>
        </form>
      </div>
    );
  }

  return (
    <form action={applyBagCode.bind(null, slug)}>
      <div className="flex items-stretch gap-2">
        <input
          name="discountCode"
          aria-label="Discount code"
          placeholder="Discount code"
          autoCapitalize="characters"
          autoComplete="off"
          defaultValue={typed ?? ""}
          className="min-w-0 flex-1 rounded-lg border border-[var(--brand-text)]/[.14] bg-transparent px-3 py-2 text-[15px] uppercase outline-none placeholder:normal-case placeholder:text-[var(--brand-text-secondary)] focus:border-[var(--brand-text)]/[.32]"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg border border-[var(--brand-text)]/[.16] px-4 text-[14px] font-medium transition hover:border-[var(--brand-text)]/[.32]"
        >
          Apply
        </button>
      </div>
      {outcome && !outcome.applied && (
        <p className="mt-2 text-[13px] text-red-600 dark:text-red-400">{outcome.message}</p>
      )}
    </form>
  );
}
