"use client";

import { formatMoney } from "@/lib/money";
import type { OrderPricing } from "@/lib/pricing/orderPricing";

// WHAT THE CUSTOMER IS ABOUT TO PAY, ITEMISED.
//
// Until this existed a Genesis shopper never saw a total before Stripe's own
// hosted page: the storefront showed a price, the shipping step showed "price
// plus shipping", and the two were added for the first time by the provider,
// after the decision to buy. A discount would have appeared as a number that
// was simply lower than the one on the product page, with nothing to say why.
//
// DISPLAY ONLY, AND STRUCTURALLY SO. Every figure here comes from an
// OrderPricing the server computed; this component does no arithmetic of its
// own — not even the total — so there is no second implementation to disagree
// with the charge. Nothing it renders is submitted, either: the form carries a
// CODE, never an amount.

export function PriceBreakdown({
  pricing,
  currency,
  productName,
}: {
  pricing: OrderPricing;
  currency: string;
  productName: string;
}) {
  return (
    <dl className="flex flex-col gap-2 text-[15px]">
      <Row label={productName} value={formatMoney(pricing.listSubtotalInCents, currency)} />

      {pricing.discount && (
        <Row
          label={pricing.discount.label}
          // Signed, because a line that reads "3.60" among other positive
          // numbers is ambiguous about which direction it moves the total.
          value={`−${formatMoney(pricing.discount.amountInCents, currency)}`}
          tone="credit"
        />
      )}

      {/* Shown whenever there is shipping to show. Never discounted — see
          priceOrder, where it is added after the discount rather than
          included in what a percentage is taken from. */}
      {pricing.shippingInCents > 0 && (
        <Row label="Shipping" value={formatMoney(pricing.shippingInCents, currency)} />
      )}

      <div className="mt-1 border-t border-black/[.10] pt-3 dark:border-white/[.12]">
        <Row label="Total" value={formatMoney(pricing.totalInCents, currency)} strong />
      </div>
    </dl>
  );
}

function Row({
  label,
  value,
  strong = false,
  tone = "normal",
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "normal" | "credit";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt
        className={
          strong
            ? "text-[15px] font-medium text-[var(--brand-text)]"
            : tone === "credit"
              ? "text-[15px] text-emerald-700 dark:text-emerald-400"
              : "text-[15px] text-[var(--brand-text-secondary)]"
        }
      >
        {label}
      </dt>
      <dd
        className={
          strong
            ? "text-[17px] font-semibold text-[var(--brand-text)] tabular-nums"
            : tone === "credit"
              ? "text-[15px] text-emerald-700 tabular-nums dark:text-emerald-400"
              : "text-[15px] text-[var(--brand-text)] tabular-nums"
        }
      >
        {value}
      </dd>
    </div>
  );
}
