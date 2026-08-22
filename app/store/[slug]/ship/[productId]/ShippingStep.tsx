"use client";

import { formatMoney } from "@/lib/money";
import { useActionState } from "react";
import { quoteShippingOptions, checkoutWithShipping, type ShippingQuoteState } from "../../actions";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import type { ActionState } from "@/lib/actionState";

// The customer's shipping step (2026-08-20).
//
// Two stages on one page: type the address, then choose from what the carriers
// actually said. Deliberately not a wizard across routes — a shopper who mistypes
// a ZIP should fix it in place and requote, not start again.
//
// PRICES ARE DISPLAY ONLY HERE. The chosen rate's id is what gets submitted;
// the amount is re-fetched and matched server-side before anything reaches
// Stripe. Nothing this component renders can change what the customer is
// charged.

const field =
  "w-full rounded-lg border border-black/[.12] bg-white px-3 py-2 text-[15px] text-zinc-900 outline-none focus:border-black/[.30] dark:border-white/[.14] dark:bg-white/[.04] dark:text-zinc-100";
const labelClass = "block text-[13px] font-medium text-[var(--brand-text-secondary)] mb-1";

export function ShippingStep({
  slug,
  productId,
  productName,
  priceInCents,
  currency,
}: {
  slug: string;
  productId: string;
  productName: string;
  priceInCents: number;
  /** The store's own. Both the product price and the carrier rates below are
      quoted and charged in it. */
  currency: string;
}) {
  const [quote, quoteAction] = useActionState<ShippingQuoteState, FormData>(
    quoteShippingOptions.bind(null, slug, productId),
    { status: "idle" }
  );
  const [checkout, checkoutAction] = useActionState<ActionState, FormData>(
    checkoutWithShipping.bind(null, slug, productId),
    { ok: true }
  );

  const address = quote.address;

  return (
    <div className="mx-auto w-full max-w-lg px-5 py-10">
      <p className="text-[13px] text-[var(--brand-text-secondary)]">Shipping for</p>
      <h1 className="mt-1 text-[22px] font-semibold text-[var(--brand-text)]">{productName}</h1>
      <p className="mt-1 text-[15px] text-[var(--brand-text-secondary)]">
        {formatMoney(priceInCents, currency)} plus shipping
      </p>

      <form action={quoteAction} className="mt-7 flex flex-col gap-3">
        <div>
          <label className={labelClass} htmlFor="name">Full name</label>
          <input id="name" name="name" className={field} defaultValue={address?.name ?? ""} autoComplete="name" />
        </div>
        <div>
          <label className={labelClass} htmlFor="line1">Street address</label>
          <input id="line1" name="line1" required className={field} defaultValue={address?.line1 ?? ""} autoComplete="address-line1" />
        </div>
        <div>
          <label className={labelClass} htmlFor="line2">Apartment, suite (optional)</label>
          <input id="line2" name="line2" className={field} defaultValue={address?.line2 ?? ""} autoComplete="address-line2" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className={labelClass} htmlFor="city">City</label>
            <input id="city" name="city" required className={field} defaultValue={address?.city ?? ""} autoComplete="address-level2" />
          </div>
          <div className="w-24">
            <label className={labelClass} htmlFor="state">State</label>
            <input id="state" name="state" className={field} defaultValue={address?.state ?? ""} autoComplete="address-level1" />
          </div>
          <div className="w-28">
            <label className={labelClass} htmlFor="postalCode">ZIP</label>
            <input id="postalCode" name="postalCode" required className={field} defaultValue={address?.postalCode ?? ""} autoComplete="postal-code" />
          </div>
        </div>
        <input type="hidden" name="country" value="US" />
        <SubmitButton pendingText="Checking rates..." className="mt-1 w-full rounded-full bg-[var(--brand-accent)] px-5 py-2.5 text-[15px] font-medium text-white">
          {quote.status === "quoted" ? "Update shipping options" : "See shipping options"}
        </SubmitButton>
      </form>

      {quote.status === "error" && quote.message && (
        <p className="mt-4 text-[14px] text-red-600 dark:text-red-400">{quote.message}</p>
      )}

      {quote.status === "quoted" && quote.options && address && (
        <form action={checkoutAction} className="mt-8">
          <h2 className="text-[15px] font-semibold text-[var(--brand-text)]">Choose a shipping service</h2>

          {/* The address travels with the choice so the server re-quotes the
              same destination it priced, rather than trusting a session. */}
          <input type="hidden" name="name" value={address.name ?? ""} />
          <input type="hidden" name="line1" value={address.line1} />
          <input type="hidden" name="line2" value={address.line2 ?? ""} />
          <input type="hidden" name="city" value={address.city} />
          <input type="hidden" name="state" value={address.state ?? ""} />
          <input type="hidden" name="postalCode" value={address.postalCode} />
          <input type="hidden" name="country" value={address.country} />

          <ul className="mt-3 flex flex-col gap-2">
            {quote.options.map((option, index) => (
              <li key={option.rateId}>
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/[.10] px-4 py-3 hover:border-black/[.22] dark:border-white/[.12] dark:hover:border-white/[.24]">
                  <input type="radio" name="rateId" value={option.rateId} defaultChecked={index === 0} required />
                  <span className="flex-1">
                    <span className="block text-[15px] text-[var(--brand-text)]">
                      {option.carrier} {option.service}
                    </span>
                    <span className="block text-[13px] text-[var(--brand-text-secondary)]">
                      {option.estimatedDays !== null
                        ? `Estimated ${option.estimatedDays} day${option.estimatedDays === 1 ? "" : "s"}`
                        : "No delivery estimate from the carrier"}
                    </span>
                  </span>
                  <span className="text-[15px] font-medium text-[var(--brand-text)]">
                    {formatMoney(option.amountInCents, currency)}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {!checkout.ok && (
            <p className="mt-3 text-[14px] text-red-600 dark:text-red-400">{checkout.error}</p>
          )}

          <SubmitButton pendingText="Redirecting to checkout..." className="mt-5 w-full rounded-full bg-[var(--brand-accent)] px-5 py-2.5 text-[15px] font-medium text-white">
            Continue to payment
          </SubmitButton>
          <p className="mt-3 text-center text-[12px] text-[var(--brand-text-secondary)]">
            Shipping is confirmed with the carrier before you pay.
          </p>
        </form>
      )}
    </div>
  );
}
