"use client";

import { useActionState } from "react";
import { checkoutFromBag } from "../actions";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import type { ActionState } from "@/lib/actionState";

// THE ONE WAY OUT OF THE BAG.
//
// It submits nothing but the request itself — no lines, no quantities, no
// code, no total. Every one of those is read from the cookie server-side and
// re-priced at that moment, so nothing the browser holds can influence what is
// charged.
//
// This is also the click that first writes a database row. Everything before
// it — browsing, adding, removing, applying a code — has been a cookie.

export function CheckoutButton({ slug }: { slug: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    checkoutFromBag.bind(null, slug),
    { ok: true }
  );

  return (
    <form action={formAction}>
      {!state.ok && state.error && (
        <p className="mb-3 text-[14px] text-red-600 dark:text-red-400">{state.error}</p>
      )}
      <SubmitButton
        pendingText="Preparing checkout..."
        className="w-full rounded-full bg-[var(--brand-accent)] px-5 py-2.5 text-[15px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
      >
        Continue to payment
      </SubmitButton>
    </form>
  );
}
