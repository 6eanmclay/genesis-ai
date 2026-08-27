import Link from "next/link";
import { formatMoney } from "@/lib/money";

// THE BAG, WITHIN REACH FROM ANYWHERE ON THE PAGE.
//
// A storefront scrolls for sixteen products. Putting the only route to the bag
// in a bar at the very top means a customer who adds something near the bottom
// has to scroll the whole way back to find it — which is the moment a purchase
// gets abandoned.
//
// SERVER-RENDERED FROM THE COOKIE AND THE SAME PRICING FUNCTION the charge
// uses, so the amount on this pill is the amount they will be asked for. It is
// not a separate running total kept in the browser, which is how a floating
// cart widget usually ends up disagreeing with checkout.
//
// ABSENT WHEN THE BAG IS EMPTY. A persistent control showing "0 items" is
// clutter following somebody around their own shop.

export function FloatingBag({
  slug,
  count,
  totalInCents,
  currency,
}: {
  slug: string;
  count: number;
  /** What the bag is worth right now, discounts already applied. */
  totalInCents: number;
  currency: string;
}) {
  if (count === 0) return null;

  return (
    // BOTTOM CENTRE, above the safe area. On a phone the bottom corners belong
    // to the browser's own controls and, in the dashboard, to J4's summon
    // button — a pill parked in either would be fighting them for the same
    // thumb. `pb-[env(safe-area-inset-bottom)]` keeps it clear of the home
    // indicator rather than tucked under it.
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]"
      // Announced when it changes, so a screen-reader user adding items hears
      // the running total rather than discovering it at checkout.
      aria-live="polite"
    >
      <Link
        href={`/store/${slug}/bag`}
        className="pointer-events-auto inline-flex max-w-full items-center gap-3 rounded-full border border-[var(--brand-text)]/[.10] bg-[var(--brand-background)]/95 px-5 py-3 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.35)] backdrop-blur transition hover:border-[var(--brand-text)]/[.24]"
      >
        <BagGlyph />
        <span className="text-[15px] font-medium text-[var(--brand-text)]">Bag</span>
        <span aria-hidden="true" className="text-[var(--brand-text)]/[.25]">
          ·
        </span>
        <span className="text-[15px] text-[var(--brand-text-secondary)]">
          {count} {count === 1 ? "item" : "items"}
        </span>
        <span aria-hidden="true" className="text-[var(--brand-text)]/[.25]">
          ·
        </span>
        <span className="text-[15px] font-semibold tabular-nums text-[var(--brand-text)]">
          {formatMoney(totalInCents, currency)}
        </span>
        <span aria-hidden="true" className="text-[var(--brand-accent)]">
          →
        </span>
      </Link>
    </div>
  );
}

/**
 * The store's own mark, not a generic cart glyph.
 *
 * Drawn in currentColor at the storefront's accent so it reads as part of this
 * shop rather than a third-party widget dropped on top of it.
 */
function BagGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-[var(--brand-accent)]"
      aria-hidden="true"
    >
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
      <path d="M3 6h18" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}
