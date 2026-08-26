"use client";

import { useTransition } from "react";
import { setPromotionActive, deletePromotion } from "./actions";

// ONE PROMOTION, AND WHETHER IT IS ACTUALLY WORKING RIGHT NOW.
//
// "Active" and "running" are different things and both are true states: a
// merchant can switch a sale on that has not started, or pause one inside its
// window. Reporting only the switch would tell somebody their sale is live
// when no customer can use it.

type Status = "running" | "inactive" | "not_started" | "expired" | "not_eligible_for_product";

const STATUS_LABEL: Record<Status, string> = {
  running: "Running",
  inactive: "Switched off",
  not_started: "Scheduled",
  expired: "Ended",
  // Unreachable from this page (the row is judged without a product), but the
  // map is total so a new eligibility reason cannot silently render blank.
  not_eligible_for_product: "Limited",
};

const STATUS_CLASS: Record<Status, string> = {
  running: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/[.12] dark:text-emerald-300",
  inactive: "bg-zinc-100 text-zinc-600 dark:bg-white/[.06] dark:text-zinc-400",
  not_started: "bg-amber-50 text-amber-700 dark:bg-amber-500/[.12] dark:text-amber-300",
  expired: "bg-zinc-100 text-zinc-500 dark:bg-white/[.06] dark:text-zinc-500",
  not_eligible_for_product: "bg-zinc-100 text-zinc-600 dark:bg-white/[.06] dark:text-zinc-400",
};

export function PromotionRow({
  slug,
  promotion,
}: {
  slug?: string;
  promotion: {
    id: string;
    name: string;
    kind: "SALE" | "CODE";
    code: string | null;
    active: boolean;
    startsAt: string | null;
    endsAt: string | null;
    orderCount: number;
    productNames: string[];
    scope: "ALL_PRODUCTS" | "SELECTED_PRODUCTS";
    amountLabel: string;
    status: Status;
  };
}) {
  const [pending, startTransition] = useTransition();

  const when =
    promotion.startsAt || promotion.endsAt
      ? [
          promotion.startsAt ? new Date(promotion.startsAt).toLocaleDateString() : "now",
          promotion.endsAt ? new Date(promotion.endsAt).toLocaleDateString() : "no end date",
        ].join(" - ")
      : null;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-medium text-zinc-900 dark:text-zinc-50">{promotion.name}</span>
          {promotion.code && (
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-[13px] text-zinc-700 dark:bg-white/[.08] dark:text-zinc-200">
              {promotion.code}
            </code>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[12px] ${STATUS_CLASS[promotion.status]}`}>
            {STATUS_LABEL[promotion.status]}
          </span>
        </div>

        <p className="mt-1 text-[13px] text-zinc-500">
          {promotion.amountLabel}
          {" · "}
          {promotion.scope === "ALL_PRODUCTS"
            ? "everything"
            : promotion.productNames.length === 0
              ? "no products selected"
              : promotion.productNames.length <= 2
                ? promotion.productNames.join(", ")
                : `${promotion.productNames.slice(0, 2).join(", ")} and ${promotion.productNames.length - 2} more`}
          {when ? ` · ${when}` : ""}
        </p>

        {promotion.orderCount > 0 && (
          <p className="mt-1 text-[13px] text-zinc-400 dark:text-zinc-500">
            Used on {promotion.orderCount} order{promotion.orderCount === 1 ? "" : "s"}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={pending}
          // The value is passed, not toggled from what this render happened to
          // see — two tabs on this page would otherwise flip each other.
          onClick={() =>
            startTransition(() => {
              void setPromotionActive(slug, promotion.id, !promotion.active);
            })
          }
          className="rounded-full border border-black/[.12] px-3 py-1 text-[13px] text-zinc-700 disabled:opacity-50 dark:border-white/[.16] dark:text-zinc-200"
        >
          {promotion.active ? "Switch off" : "Switch on"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            // Deleting is safe for history — every order keeps its own copy of
            // the discount — but it is still not undoable, so it is confirmed.
            if (!window.confirm(`Delete "${promotion.name}"? Orders that used it keep their records.`)) return;
            startTransition(() => {
              void deletePromotion(slug, promotion.id);
            });
          }}
          className="rounded-full px-3 py-1 text-[13px] text-red-600 disabled:opacity-50 dark:text-red-400"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
