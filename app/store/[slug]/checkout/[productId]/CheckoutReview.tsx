"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import { createCheckoutSession, previewCheckoutPrice } from "../../actions";
import type { CheckoutPreviewState } from "@/lib/promotions/checkoutPreview";
import type { ActionState } from "@/lib/actionState";
import type { OrderPricing } from "@/lib/pricing/orderPricing";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import { PriceBreakdown } from "../PriceBreakdown";
import { DiscountCodeField } from "../DiscountCodeField";

// One product, its price broken down, and a place to enter a code.
//
// THE CODE IS THE ONLY THING THAT LEAVES THIS COMPONENT. Applying one asks the
// server what the order would cost and re-renders from that answer; paying
// submits the same string again and the server derives the charge afresh. No
// number rendered here is ever sent anywhere.

export function CheckoutReview({
  slug,
  productId,
  productName,
  imageUrl,
  currency,
  initialPricing,
}: {
  slug: string;
  productId: string;
  productName: string;
  imageUrl: string | null;
  currency: string;
  /** Priced on the server, so any automatic sale is visible on arrival. */
  initialPricing: OrderPricing;
}) {
  const [preview, previewAction, previewPending] = useActionState<CheckoutPreviewState, FormData>(
    previewCheckoutPrice.bind(null, slug, productId),
    { ok: true, pricing: initialPricing, code: null }
  );
  const [checkout, checkoutAction] = useActionState<ActionState, FormData>(
    createCheckoutSession.bind(null, slug, productId),
    { ok: true }
  );

  // The code the SERVER accepted, never what is sitting in the input. A code
  // that was typed but rejected must not travel to checkout.
  const applied = preview.ok && preview.code?.applied ? preview.code.candidate.code : null;
  const codeError = preview.ok && preview.code && !preview.code.applied ? preview.code.message : null;
  const pricing = preview.ok ? preview.pricing : initialPricing;

  // Submitted through a hidden field on the payment form, and through the
  // preview form when re-checking. Held here only so the two agree.
  const [code, setCode] = useState("");

  const submitPreview = (value: string) => {
    setCode(value);
    const data = new FormData();
    data.set("discountCode", value);
    previewAction(data);
  };

  return (
    <div className="mx-auto w-full max-w-lg px-5 py-10">
      <p className="text-[13px] text-[var(--brand-text-secondary)]">Review your order</p>

      <div className="mt-4 flex items-center gap-4">
        {imageUrl && (
          <Image
            src={imageUrl}
            alt=""
            width={64}
            height={64}
            className="h-16 w-16 rounded-xl object-cover"
          />
        )}
        <h1 className="text-[22px] font-semibold text-[var(--brand-text)]">{productName}</h1>
      </div>

      <div className="mt-7 rounded-2xl border border-black/[.10] px-5 py-5 dark:border-white/[.12]">
        <PriceBreakdown pricing={pricing} currency={currency} productName={productName} />
      </div>

      <div className="mt-5">
        <DiscountCodeField
          applied={applied}
          error={codeError}
          pending={previewPending}
          onApply={submitPreview}
          onRemove={() => submitPreview("")}
        />
      </div>

      {!preview.ok && (
        <p className="mt-3 text-[14px] text-red-600 dark:text-red-400">{preview.error}</p>
      )}

      <form action={checkoutAction} className="mt-6">
        {/* The code, not the discount. The server resolves it again from its
            own rows at the moment of the charge — so a promotion that expired
            while this page was open is not honoured by a stale hidden field. */}
        <input type="hidden" name="discountCode" value={applied ?? code} />

        {!checkout.ok && (
          <p className="mb-3 text-[14px] text-red-600 dark:text-red-400">{checkout.error}</p>
        )}

        <SubmitButton
          pendingText="Redirecting to checkout..."
          className="w-full rounded-full bg-[var(--brand-accent)] px-5 py-2.5 text-[15px] font-medium text-white"
        >
          Continue to payment
        </SubmitButton>
      </form>

      <p className="mt-3 text-center text-[12px] text-[var(--brand-text-secondary)]">
        Your total is confirmed again before you pay.
      </p>
    </div>
  );
}
