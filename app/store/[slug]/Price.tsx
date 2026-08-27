import { formatMoney } from "@/lib/money";
import { isOnSale, type DisplayPrice } from "@/lib/pricing/displayPrice";

// THE ONE PLACE A PRICE IS RENDERED.
//
// Used by the product card, the product page, the bag line and the checkout
// breakdown. Four call sites, one component — so the storefront and the charge
// cannot show different numbers, which is the whole point of the milestone.
//
// It does no arithmetic. Every figure comes from a DisplayPrice the server
// computed with the same function the charge uses.

export function Price({
  price,
  currency,
  size = "normal",
}: {
  price: DisplayPrice;
  currency: string;
  /** `lead` is the product page's headline price; `normal` is everywhere else. */
  size?: "normal" | "lead" | "small";
}) {
  const text =
    size === "lead" ? "text-[22px]" : size === "small" ? "text-[14px]" : "text-[16px]";

  if (!isOnSale(price)) {
    return <span className={`${text} text-[var(--brand-text)]`}>{formatMoney(price.listInCents, currency)}</span>;
  }

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {/* The original, struck through. Shown first because that is the number
          the customer may already have in their head from somewhere else. */}
      <span className={`${text} text-[var(--brand-text-secondary)] line-through`}>
        {formatMoney(price.listInCents, currency)}
      </span>
      <span className={`${text} font-semibold text-[var(--brand-text)]`}>
        {formatMoney(price.saleInCents!, currency)}
      </span>
      {price.percentOff !== null && price.percentOff > 0 && (
        <span className="rounded-full bg-emerald-600/[.12] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-400/[.16] dark:text-emerald-300">
          {price.percentOff}% off
        </span>
      )}
    </span>
  );
}

/**
 * The sale's own name, when there is one.
 *
 * Separate from the price itself because the product card has no room for it
 * and the product page does — a customer looking at one item deserves to know
 * it is the Spring Sale rather than an unexplained lower number.
 */
export function SaleName({ price }: { price: DisplayPrice }) {
  if (!isOnSale(price) || !price.label) return null;
  return <span className="text-[13px] text-[var(--brand-text-secondary)]">{price.label}</span>;
}
