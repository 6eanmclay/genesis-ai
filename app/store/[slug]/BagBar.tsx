import Link from "next/link";

// THE BAG, ALWAYS REACHABLE.
//
// A storefront where you can add things needs somewhere they went. Rendered
// above the hero on every page of the store, so "continue shopping" has a way
// back — which is the half of the flow a Buy Now button never had.
//
// SERVER-RENDERED FROM THE COOKIE. There is no client state and no fetch: the
// count comes from the same cookie the add action writes, so it is correct on
// first paint rather than appearing a moment later.
//
// ABSENT WHEN THE BAG IS EMPTY AND NOTHING CAN BE BOUGHT — an informational
// store with no products should not carry a shopping bag it will never use.

export function BagBar({
  slug,
  count,
  canAcceptPayments,
}: {
  slug: string;
  count: number;
  canAcceptPayments: boolean;
}) {
  if (!canAcceptPayments && count === 0) return null;

  return (
    <div className="border-b border-[var(--brand-text)]/[.08]">
      <div className="mx-auto flex max-w-6xl items-center justify-end px-8 py-3">
        <Link
          href={`/store/${slug}/bag`}
          className="inline-flex items-center gap-2 rounded-full border border-[var(--brand-text)]/[.14] px-4 py-1.5 text-[14px] transition hover:border-[var(--brand-text)]/[.3]"
          // The count is in the label as well as the badge, because a number in
          // a circle beside a bag icon means nothing to a screen reader.
          aria-label={count === 1 ? "Bag, 1 item" : `Bag, ${count} items`}
        >
          <BagIcon />
          <span>Bag</span>
          {count > 0 && (
            <span
              aria-hidden="true"
              className="inline-flex min-w-[1.4rem] items-center justify-center rounded-full bg-[var(--brand-accent)] px-1.5 py-0.5 text-[12px] font-medium leading-none text-white"
            >
              {count}
            </span>
          )}
        </Link>
      </div>
    </div>
  );
}

function BagIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
      <path d="M3 6h18" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}
