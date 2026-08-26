"use client";

import { useState } from "react";
import { createPromotion } from "./actions";
import { SubmitButton } from "../SubmitButton";
import { useActionFormState } from "../useActionFormState";

// CREATING AN OFFER, WITH ONLY THE FIELDS THAT OFFER NEEDS.
//
// The four choices — sale or code, percentage or amount, everything or some
// things, dates or not — genuinely change which inputs mean anything, so the
// form shows what applies and hides what does not. A code field on a store-wide
// sale is not harmless clutter: it is a control that looks like it does
// something and does nothing.

const field =
  "w-full rounded-lg border border-black/[.08] px-3 py-1.5 text-[15px] dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50";
const legend = "text-xs font-medium text-zinc-500";
const hint = "text-xs text-zinc-400 dark:text-zinc-500";

export function CreatePromotionForm({
  slug,
  products,
}: {
  slug?: string;
  products: { id: string; name: string }[];
}) {
  const { state, formAction, resetKey } = useActionFormState(createPromotion.bind(null, slug));

  const [kind, setKind] = useState<"SALE" | "CODE">("SALE");
  const [discountType, setDiscountType] = useState<"PERCENTAGE" | "FIXED_AMOUNT">("PERCENTAGE");
  const [scope, setScope] = useState<"ALL_PRODUCTS" | "SELECTED_PRODUCTS">("ALL_PRODUCTS");

  return (
    <form key={resetKey} action={formAction} className="flex flex-col gap-4">
      {/* --- sale or code ------------------------------------------------ */}
      <fieldset className="flex flex-col gap-1">
        <legend className={legend}>What is this?</legend>
        <div className="mt-1 flex gap-2">
          <Choice name="kind" value="SALE" checked={kind === "SALE"} onSelect={() => setKind("SALE")}>
            A sale
            <span className={`block ${hint}`}>Applies on its own</span>
          </Choice>
          <Choice name="kind" value="CODE" checked={kind === "CODE"} onSelect={() => setKind("CODE")}>
            A discount code
            <span className={`block ${hint}`}>Customer types it</span>
          </Choice>
        </div>
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className={legend}>{kind === "CODE" ? "Name it (for you)" : "Name"}</span>
        <input
          name="name"
          type="text"
          required
          placeholder={kind === "CODE" ? "Spring email campaign" : "Spring Sale"}
          defaultValue={!state.ok && state.values?.name !== undefined ? state.values.name : ""}
          className={field}
        />
        {kind === "SALE" && <span className={hint}>Customers see this on their price breakdown.</span>}
      </label>

      {kind === "CODE" && (
        <label className="flex flex-col gap-1">
          <span className={legend}>Code</span>
          <input
            name="code"
            type="text"
            required
            placeholder="SAVE10"
            autoCapitalize="characters"
            autoComplete="off"
            defaultValue={!state.ok && state.values?.code !== undefined ? state.values.code : ""}
            className={`${field} uppercase`}
          />
          {/* Said out loud because a merchant printing a code on a card needs
              to know that case and spacing will not fail a customer. */}
          <span className={hint}>Case doesn&apos;t matter — save10 and SAVE 10 both work.</span>
        </label>
      )}

      {/* --- percentage or amount ----------------------------------------- */}
      <fieldset className="flex flex-col gap-1">
        <legend className={legend}>How much off?</legend>
        <div className="mt-1 flex gap-2">
          <Choice
            name="discountType"
            value="PERCENTAGE"
            checked={discountType === "PERCENTAGE"}
            onSelect={() => setDiscountType("PERCENTAGE")}
          >
            A percentage
          </Choice>
          <Choice
            name="discountType"
            value="FIXED_AMOUNT"
            checked={discountType === "FIXED_AMOUNT"}
            onSelect={() => setDiscountType("FIXED_AMOUNT")}
          >
            A fixed amount
          </Choice>
        </div>
        <div className="mt-2 flex items-center gap-2">
          {discountType === "PERCENTAGE" ? (
            <>
              <input name="percentOff" type="number" min="1" max="100" step="1" required className={`${field} w-24`} />
              <span className="text-xs text-zinc-500">% off</span>
            </>
          ) : (
            <>
              <span className="text-xs text-zinc-500">$</span>
              <input name="amountOff" type="number" min="0.01" step="0.01" required className={`${field} w-28`} />
              <span className="text-xs text-zinc-500">off</span>
            </>
          )}
        </div>
        {/* The clamp is real and structural (see priceOrder), so it is stated
            rather than left for a merchant to discover on an order. */}
        <span className={`mt-1 ${hint}`}>
          A discount never takes a total below zero, and never comes off shipping.
        </span>
      </fieldset>

      {/* --- everything or some things ------------------------------------ */}
      <fieldset className="flex flex-col gap-1">
        <legend className={legend}>What does it apply to?</legend>
        <div className="mt-1 flex gap-2">
          <Choice
            name="scope"
            value="ALL_PRODUCTS"
            checked={scope === "ALL_PRODUCTS"}
            onSelect={() => setScope("ALL_PRODUCTS")}
          >
            Everything
          </Choice>
          <Choice
            name="scope"
            value="SELECTED_PRODUCTS"
            checked={scope === "SELECTED_PRODUCTS"}
            onSelect={() => setScope("SELECTED_PRODUCTS")}
          >
            Chosen products
          </Choice>
        </div>

        {scope === "SELECTED_PRODUCTS" && (
          <div className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]">
            {products.length === 0 ? (
              <p className={hint}>This business has no products yet.</p>
            ) : (
              products.map((product) => (
                <label key={product.id} className="flex items-center gap-2 text-[15px]">
                  <input type="checkbox" name="productIds" value={product.id} />
                  <span>{product.name}</span>
                </label>
              ))
            )}
          </div>
        )}
      </fieldset>

      {/* --- when -------------------------------------------------------- */}
      <fieldset className="flex flex-col gap-1">
        <legend className={legend}>When does it run?</legend>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input name="startsAt" type="date" aria-label="Start date" className={`${field} w-44`} />
          <span className="text-xs text-zinc-500">to</span>
          <input name="endsAt" type="date" aria-label="End date" className={`${field} w-44`} />
        </div>
        {/* Both optional, and that is the common case rather than an oversight. */}
        <span className={`mt-1 ${hint}`}>Leave blank to run until you switch it off.</span>
      </fieldset>

      {!state.ok && state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      )}

      <SubmitButton
        pendingText="Creating..."
        className="self-start rounded-full bg-[var(--brand-accent)] px-4 py-1 text-sm text-white transition hover:opacity-90 disabled:opacity-50"
      >
        Create
      </SubmitButton>
    </form>
  );
}

/** A radio that looks like a card. Real radios, so the form posts without JS. */
function Choice({
  name,
  value,
  checked,
  onSelect,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={`flex-1 cursor-pointer rounded-xl border px-3 py-2 text-[15px] ${
        checked
          ? "border-[var(--brand-accent)] bg-[var(--brand-accent)]/[.06]"
          : "border-black/[.10] dark:border-white/[.12]"
      }`}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} className="sr-only" />
      {children}
    </label>
  );
}
