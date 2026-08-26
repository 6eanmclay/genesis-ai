"use client";

import { formatMoney } from "@/lib/money";
import { useActionState } from "react";
import { quoteShippingOptions, checkoutWithShipping, previewCheckoutPrice, type ShippingQuoteState } from "../../actions";
import type { CheckoutPreviewState } from "@/lib/promotions/checkoutPreview";
import { priceOrder } from "@/lib/pricing/orderPricing";
import { PriceBreakdown } from "../../checkout/PriceBreakdown";
import { DiscountCodeField } from "../../checkout/DiscountCodeField";
import { useState } from "react";
import { verificationStateOf } from "@/lib/shipping/addressVerification";
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
  // THE BREAKDOWN AND THE CODE (2026-08-26). This step showed "price plus
  // shipping" and the price of each service, and never a total — the first
  // figure adding the two together appeared on Stripe's own page, after the
  // decision to buy.
  //
  // priceOrder is called here with no discounts purely to build the SHAPE the
  // breakdown renders while nothing has been applied; every figure that
  // survives a code being entered comes back from the server.
  const [preview, previewAction, previewPending] = useActionState<CheckoutPreviewState, FormData>(
    previewCheckoutPrice.bind(null, slug, productId),
    { ok: true, pricing: priceOrder({ unitPriceInCents: priceInCents }), code: null }
  );
  const [code, setCode] = useState("");
  // Which service is selected, so the breakdown can move with it. The AMOUNT is
  // still never submitted — this drives a re-price whose numbers come from the
  // server, and the checkout form below sends only the rate id.
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);

  const appliedCode = preview.ok && preview.code?.applied ? preview.code.candidate.code : null;
  const codeError = preview.ok && preview.code && !preview.code.applied ? preview.code.message : null;

  const reprice = (nextCode: string, rateId: string | null, shippingInCents: number) => {
    setCode(nextCode);
    const data = new FormData();
    data.set("discountCode", nextCode);
    if (rateId) {
      data.set("rateId", rateId);
      data.set("shippingInCents", String(shippingInCents));
    }
    previewAction(data);
  };

  const address = quote.address;
  const verification = quote.verification;
  // The suggested address, when the postal service writes it differently. Held
  // in state so accepting it re-fills the form the customer can still see and
  // edit — never applied behind their back.
  const suggestion = verification?.outcome === "corrected" ? verification.suggestion : null;
  const [useSuggested, setUseSuggested] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const shown = useSuggested && suggestion ? suggestion : address;

  return (
    <div className="mx-auto w-full max-w-lg px-5 py-10">
      <p className="text-[13px] text-[var(--brand-text-secondary)]">Shipping for</p>
      <h1 className="mt-1 text-[22px] font-semibold text-[var(--brand-text)]">{productName}</h1>
      <p className="mt-1 text-[15px] text-[var(--brand-text-secondary)]">
        {formatMoney(priceInCents, currency)} plus shipping
      </p>

      <form
        key={useSuggested ? "suggested" : "entered"}
        action={quoteAction}
        className="mt-7 flex flex-col gap-3"
      >
        <div>
          <label className={labelClass} htmlFor="name">Full name</label>
          <input id="name" name="name" className={field} defaultValue={shown?.name ?? ""} autoComplete="name" />
        </div>
        <div>
          <label className={labelClass} htmlFor="line1">Street address</label>
          <input id="line1" name="line1" required className={field} defaultValue={shown?.line1 ?? ""} autoComplete="address-line1" />
        </div>
        <div>
          <label className={labelClass} htmlFor="line2">Apartment, suite (optional)</label>
          <input id="line2" name="line2" className={field} defaultValue={shown?.line2 ?? ""} autoComplete="address-line2" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className={labelClass} htmlFor="city">City</label>
            <input id="city" name="city" required className={field} defaultValue={shown?.city ?? ""} autoComplete="address-level2" />
          </div>
          <div className="w-24">
            <label className={labelClass} htmlFor="state">State</label>
            <input id="state" name="state" className={field} defaultValue={shown?.state ?? ""} autoComplete="address-level1" />
          </div>
          <div className="w-28">
            <label className={labelClass} htmlFor="postalCode">ZIP</label>
            <input id="postalCode" name="postalCode" required className={field} defaultValue={shown?.postalCode ?? ""} autoComplete="postal-code" />
          </div>
        </div>
        <input type="hidden" name="country" value="US" />
        {/* Set once the customer has SEEN what the address service said and
            chosen anyway — either by taking the suggestion or by keeping their
            own. Without it a correction or an unverifiable address stops and
            asks rather than proceeding. */}
        <input type="hidden" name="addressAcknowledged" value={acknowledged ? "1" : ""} />
        <SubmitButton pendingText="Checking rates..." className="mt-1 w-full rounded-full bg-[var(--brand-accent)] px-5 py-2.5 text-[15px] font-medium text-white">
          {quote.status === "quoted" ? "Update shipping options" : "See shipping options"}
        </SubmitButton>
      </form>

      {quote.status === "error" && quote.message && (
        <p className="mt-4 text-[14px] text-red-600 dark:text-red-400">{quote.message}</p>
      )}

      {/* DID YOU MEAN THIS? The postal service writes this address differently,
          so the customer is shown both and picks. Accepting fills the form
          above with the standardised version — visible, and still editable. */}
      {suggestion && !acknowledged && (
        <div className="mt-4 rounded-2xl border border-[var(--brand-border)] p-4">
          <p className="text-[15px] font-medium text-[var(--brand-text)]">Did you mean this address?</p>
          <p className="mt-2 text-[14px] text-[var(--brand-text)]">
            {suggestion.line1}
            {suggestion.line2 ? `, ${suggestion.line2}` : ""}
            <br />
            {suggestion.city}
            {suggestion.state ? `, ${suggestion.state}` : ""} {suggestion.postalCode}
          </p>
          <p className="mt-2 text-[13px] text-[var(--brand-text-secondary)]">
            You entered: {address?.line1}
            {address?.line2 ? `, ${address.line2}` : ""}, {address?.city}
            {address?.state ? `, ${address.state}` : ""} {address?.postalCode}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setUseSuggested(true);
                setAcknowledged(true);
              }}
              className="rounded-full bg-[var(--brand-accent)] px-4 py-2 text-[14px] font-medium text-white"
            >
              Use this address
            </button>
            <button
              type="button"
              onClick={() => {
                setUseSuggested(false);
                setAcknowledged(true);
              }}
              className="rounded-full border border-[var(--brand-border)] px-4 py-2 text-[14px] text-[var(--brand-text)]"
            >
              Keep what I entered
            </button>
          </div>
          <p className="mt-2 text-[13px] text-[var(--brand-text-secondary)]">
            Then choose &ldquo;See shipping options&rdquo; again.
          </p>
        </div>
      )}

      {/* COULD NOT BE CONFIRMED. Not a rejection — the customer may know
          something the database does not, and a new-build address is a real
          case. But they are told plainly and have to say so, rather than
          discovering it when the parcel comes back. */}
      {verification?.outcome === "unverifiable" && !acknowledged && (
        <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/30">
          <p className="text-[15px] font-medium text-amber-900 dark:text-amber-200">
            We couldn&apos;t confirm this address
          </p>
          <p className="mt-1 text-[14px] text-amber-800 dark:text-amber-300">{verification.reason}</p>
          <p className="mt-2 text-[13px] text-amber-800 dark:text-amber-300">
            Check it above, or continue if you know it&apos;s right.
          </p>
          <button
            type="button"
            onClick={() => setAcknowledged(true)}
            className="mt-3 rounded-full border border-amber-400 px-4 py-2 text-[14px] text-amber-900 dark:text-amber-200"
          >
            Use this address anyway
          </button>
        </div>
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
          {/* WHAT THE CUSTOMER ORIGINALLY TYPED, carried forward so the order
              can keep it. Once a suggestion is accepted the form above holds
              the standardised address and the original is otherwise lost —
              and the original is exactly what an audit needs. Empty when the
              address was never changed, because storing a duplicate is noise. */}
          <input
            type="hidden"
            name="addressEntered"
            value={useSuggested && quote.address ? JSON.stringify(quote.address) : ""}
          />
          <input
            type="hidden"
            name="addressVerification"
            value={verification ? verificationStateOf(verification.outcome) : ""}
          />

          <ul className="mt-3 flex flex-col gap-2">
            {quote.options.map((option, index) => (
              <li key={option.rateId}>
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/[.10] px-4 py-3 hover:border-black/[.22] dark:border-white/[.12] dark:hover:border-white/[.24]">
                  <input
                    type="radio"
                    name="rateId"
                    value={option.rateId}
                    defaultChecked={index === 0}
                    required
                    onChange={() => {
                      setSelectedRateId(option.rateId);
                      reprice(appliedCode ?? code, option.rateId, option.amountInCents);
                    }}
                  />
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

          <div className="mt-5">
            <DiscountCodeField
              applied={appliedCode}
              error={codeError}
              pending={previewPending}
              onApply={(value) => {
                const chosen = quote.options?.find((o) => o.rateId === selectedRateId) ?? quote.options?.[0];
                reprice(value, chosen?.rateId ?? null, chosen?.amountInCents ?? 0);
              }}
              onRemove={() => {
                const chosen = quote.options?.find((o) => o.rateId === selectedRateId) ?? quote.options?.[0];
                reprice("", chosen?.rateId ?? null, chosen?.amountInCents ?? 0);
              }}
            />
          </div>

          {/* The code, never the discount. Re-resolved server-side at the
              moment of the charge, so a promotion that expired while the
              customer was choosing a service is not honoured by a stale field. */}
          <input type="hidden" name="discountCode" value={appliedCode ?? code} />

          <div className="mt-5 rounded-2xl border border-black/[.10] px-5 py-5 dark:border-white/[.12]">
            <PriceBreakdown
              pricing={
                preview.ok
                  ? preview.pricing
                  : priceOrder({ unitPriceInCents: priceInCents })
              }
              currency={currency}
              productName={productName}
            />
            {/* Until a service is chosen the breakdown has no delivery cost to
                show. Said out loud rather than left as a total that quietly
                omits it. */}
            {preview.ok && preview.pricing.shippingInCents === 0 && (
              <p className="mt-3 text-[13px] text-[var(--brand-text-secondary)]">
                Shipping is added once you choose a service above.
              </p>
            )}
          </div>

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
