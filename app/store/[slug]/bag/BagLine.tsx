import Image from "next/image";
import Link from "next/link";
import { formatMoney } from "@/lib/money";
import type { DisplayPrice } from "@/lib/pricing/displayPrice";
import { Price } from "../Price";
import { setBagQuantity, removeFromBagAction } from "../bagActions";

// ONE LINE OF THE BAG.
//
// Quantity controls are FORMS posting server actions, not client state. The bag
// is a cookie the server owns, so a plus button that changed a number locally
// would be showing something the server has not agreed to — and would need a
// second implementation of the quantity rules that already live in bagCookie.
//
// It also means every control here works with no JavaScript.

export function BagLine({
  slug,
  productId,
  name,
  imageUrl,
  quantity,
  currency,
  unitPrice,
  lineSubtotalInCents,
  discountLabel,
}: {
  slug: string;
  productId: string;
  name: string;
  imageUrl: string | null;
  quantity: number;
  currency: string;
  /** Per unit, as the storefront shows it — struck through when on sale. */
  unitPrice: DisplayPrice;
  /** What this line costs in total, after its share of any discount. */
  lineSubtotalInCents: number;
  discountLabel: string | null;
}) {
  return (
    <div className="flex gap-4">
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt=""
          width={80}
          height={80}
          className="h-20 w-20 shrink-0 rounded-xl object-cover"
        />
      ) : (
        <div className="h-20 w-20 shrink-0 rounded-xl bg-[var(--brand-text)]/[.06]" />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`/store/${slug}/products/${productId}`}
              className="text-[15px] font-medium hover:underline"
            >
              {name}
            </Link>
            <div className="mt-1">
              <Price price={unitPrice} currency={currency} size="small" />
            </div>
            {discountLabel && (
              <p className="mt-1 text-[13px] text-emerald-700 dark:text-emerald-400">{discountLabel}</p>
            )}
          </div>
          {/* The line total, which is what this row contributes to the bill. */}
          <p className="text-[15px] font-medium tabular-nums">
            {formatMoney(lineSubtotalInCents, currency)}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-full border border-[var(--brand-text)]/[.14]">
            <QuantityButton
              slug={slug}
              productId={productId}
              to={quantity - 1}
              label={`Decrease quantity of ${name}`}
            >
              &minus;
            </QuantityButton>
            <span className="min-w-[2rem] text-center text-[14px] tabular-nums" aria-live="polite">
              {quantity}
            </span>
            <QuantityButton
              slug={slug}
              productId={productId}
              to={quantity + 1}
              label={`Increase quantity of ${name}`}
            >
              +
            </QuantityButton>
          </div>

          <form action={removeFromBagAction.bind(null, slug, productId)}>
            <button
              type="submit"
              className="text-[13px] text-[var(--brand-text-secondary)] underline underline-offset-2"
            >
              Remove
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/**
 * One step up or down.
 *
 * The target quantity travels in a hidden field rather than being computed
 * server-side from "the current one, plus one" — two quick clicks would
 * otherwise both read the same starting number and only one would land.
 */
function QuantityButton({
  slug,
  productId,
  to,
  label,
  children,
}: {
  slug: string;
  productId: string;
  to: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <form action={setBagQuantity.bind(null, slug, productId)}>
      <input type="hidden" name="quantity" value={Math.max(0, to)} />
      <button
        type="submit"
        aria-label={label}
        className="px-3 py-1.5 text-[15px] leading-none text-[var(--brand-text)] transition hover:opacity-70"
      >
        {children}
      </button>
    </form>
  );
}
