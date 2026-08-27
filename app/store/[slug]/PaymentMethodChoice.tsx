"use client";

import { useState } from "react";
import type { PaymentProviderChoice } from "@/lib/payments/providers";

// WHICH WAY THE CUSTOMER WANTS TO PAY.
//
// ============ IT RENDERS NOTHING WHEN THERE IS NO CHOICE =================
//
// One connected provider means one way to pay, and a radio group with a single
// option is a decision the customer does not have. Most stores have exactly
// one, so most checkouts look precisely as they did before this existed.
//
// The list comes from availableProviders(), which reads the connected
// integrations — so what is offered here and what the server can actually
// charge through cannot disagree. There is no second list to fall out of step.
//
// NATIVE RADIOS, ON PURPOSE. They are keyboard-navigable, announced correctly
// by screen readers, and submit with the form without any JavaScript of their
// own. The state below exists only to move the visual selection; if it never
// ran, the form would still submit the checked value.

export function PaymentMethodChoice({
  providers,
  labels,
  name = "paymentMethod",
}: {
  providers: PaymentProviderChoice[];
  labels: Record<PaymentProviderChoice, string>;
  name?: string;
}) {
  const [selected, setSelected] = useState<PaymentProviderChoice>(providers[0]);

  // Nothing to choose. Render nothing rather than a one-option control — and
  // no hidden field either: the server defaults to the only available provider
  // on its own, and a hidden field would be a second place for that to be
  // decided.
  if (providers.length < 2) return null;

  return (
    <fieldset className="mt-5">
      <legend className="text-[13px] text-[var(--brand-text-secondary)]">Pay with</legend>
      {/* Stacks on a phone, sits side by side from `sm` up — the tap targets
          stay full-width and comfortably tall on the narrow case, which is
          where the majority of storefront traffic is. */}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        {providers.map((provider) => {
          const isSelected = provider === selected;
          return (
            <label
              key={provider}
              className={[
                "flex flex-1 cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 text-[15px] transition",
                isSelected
                  ? "border-[var(--brand-accent)] bg-[var(--brand-accent)]/[.06] text-[var(--brand-text)]"
                  : "border-black/[.10] text-[var(--brand-text-secondary)] hover:border-black/[.20] dark:border-white/[.12] dark:hover:border-white/[.24]",
              ].join(" ")}
            >
              <input
                type="radio"
                name={name}
                value={provider}
                checked={isSelected}
                onChange={() => setSelected(provider)}
                className="h-4 w-4 accent-[var(--brand-accent)]"
              />
              <span className="font-medium">{labels[provider]}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
