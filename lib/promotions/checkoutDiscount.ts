import type { OrderPricing } from "@/lib/pricing/orderPricing";

// GETTING THE DISCOUNT TO THE ORDER, ACROSS TWO RAILS THAT CARRY DATA
// DIFFERENTLY.
//
// The discount is decided in one place (lib/promotions/resolve.ts) at one
// moment, and the Order is written minutes later in a different process. What
// joins them is whatever the payment provider agreed to hold on our behalf, and
// the two providers hold very different things:
//
//   Stripe   up to 50 metadata keys of 500 characters each. Roomy. The shipping
//            metadata already lives here (lib/shipping/checkoutShipping.ts) and
//            this follows its shape exactly.
//
//   PayPal   ONE string, `custom_id`, capped at 127 characters. That is the
//            entire channel. It already carries storeId and productId packed
//            with a colon, and this extends that packing rather than inventing
//            a second mechanism.
//
// WHAT MUST SURVIVE IS THE MONEY, NOT THE WORDS. The amounts are the record of
// what somebody actually paid and are carried verbatim on both rails. The
// promotion's label and code are carried where there is room (Stripe) and read
// back from the promotion row where there is not (PayPal) — seconds after the
// charge, with the amounts as the authority if the row has since gone.

export interface CheckoutDiscountFacts {
  listSubtotalInCents: number | null;
  discountInCents: number | null;
  promotionId: string | null;
  promotionLabel: string | null;
  promotionCode: string | null;
  promotionKind: "SALE" | "CODE" | null;
}

export const NO_DISCOUNT_FACTS: CheckoutDiscountFacts = {
  listSubtotalInCents: null,
  discountInCents: null,
  promotionId: null,
  promotionLabel: null,
  promotionCode: null,
  promotionKind: null,
};

/** Stripe metadata values are strings and nothing else. */
const MAX_METADATA_VALUE = 500;

/**
 * The discount, as Stripe metadata.
 *
 * NOTHING IS WRITTEN WHEN NOTHING WAS DISCOUNTED — an order that paid list
 * price carries no discount keys at all, so its metadata is byte-identical to
 * what it would have been before promotions existed.
 */
export function toDiscountMetadata(pricing: OrderPricing): Record<string, string> {
  // KEYED ON THE MONEY, not on whether one promotion can be named. A bag whose
  // lines were discounted by several different sales has a real discount and no
  // single promotion — `discount` is null there by design, and guarding on it
  // would silently drop the discount metadata for exactly that order.
  if (pricing.discountInCents <= 0 || !pricing.discount) return {};
  return {
    listSubtotalInCents: String(pricing.listSubtotalInCents),
    discountInCents: String(pricing.discount.amountInCents),
    promotionId: pricing.discount.promotionId,
    promotionLabel: pricing.discount.label.slice(0, MAX_METADATA_VALUE),
    promotionKind: pricing.discount.kind,
    ...(pricing.discount.code ? { promotionCode: pricing.discount.code.slice(0, MAX_METADATA_VALUE) } : {}),
  };
}

/** A metadata number, or null. Never a default — see parseCheckoutShipping. */
function intOrNull(raw: string | undefined, { allowZero = true } = {}): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  if (!allowZero && value === 0) return null;
  return value;
}

/**
 * The discount back out of Stripe metadata.
 *
 * A checkout that carried none parses to all nulls, which is exactly what an
 * order predating promotions reads as.
 */
export function parseDiscountMetadata(
  metadata: Record<string, string> | null | undefined
): CheckoutDiscountFacts {
  if (!metadata) return NO_DISCOUNT_FACTS;

  // A discount of zero is not a discount — see priceOrder, which refuses to
  // record one. Treating it as absent here keeps the two consistent.
  const discountInCents = intOrNull(metadata.discountInCents, { allowZero: false });
  if (discountInCents === null) return NO_DISCOUNT_FACTS;

  const kind = metadata.promotionKind;
  return {
    listSubtotalInCents: intOrNull(metadata.listSubtotalInCents),
    discountInCents,
    promotionId: metadata.promotionId?.trim() || null,
    promotionLabel: metadata.promotionLabel?.trim() || null,
    promotionCode: metadata.promotionCode?.trim() || null,
    // Anything we did not write is discarded rather than stored.
    promotionKind: kind === "SALE" || kind === "CODE" ? kind : null,
  };
}

// PayPal's single field. Colons separate; cuids never contain one, which is why
// the existing two-part packing has always been safe to split back apart.
const PAYPAL_CUSTOM_ID_MAX = 127;

/**
 * storeId, productId and the money, in one PayPal-sized string.
 *
 * ORDER MATTERS: the two ids stay first and unchanged, so a checkout already in
 * flight when this shipped — one packed with the old two-part format — still
 * parses. Anything after them is additive.
 */
export function packPaypalCustomId(params: {
  storeId: string;
  productId: string;
  pricing: OrderPricing;
}): string {
  const base = `${params.storeId}:${params.productId}`;
  const discount = params.pricing.discount;
  if (!discount) return base;

  // The label and code are deliberately NOT packed — there is not room for an
  // arbitrary merchant string, and truncating a code would store one that was
  // never entered. They are read back from the promotion row instead.
  const packed = `${base}:${discount.promotionId}:${discount.amountInCents}:${params.pricing.listSubtotalInCents}`;

  // If a future id length ever pushes this over PayPal's limit, the sale must
  // still complete: fall back to the two ids, and the order records its total
  // correctly with the discount attribution lost rather than the purchase.
  return packed.length <= PAYPAL_CUSTOM_ID_MAX ? packed : base;
}

export interface ParsedPaypalCustomId {
  storeId: string | null;
  productId: string | null;
  promotionId: string | null;
  discountInCents: number | null;
  listSubtotalInCents: number | null;
}

/**
 * Back out of PayPal's `custom_id`.
 *
 * Tolerant by construction: two parts is the pre-promotions format and stays
 * valid forever; five is one with a discount; anything else yields nulls rather
 * than throwing, because a malformed field must lose attribution, never an
 * order that has already been paid for.
 */
export function parsePaypalCustomId(customId: string | null | undefined): ParsedPaypalCustomId {
  const parts = (customId ?? "").split(":");
  const storeId = parts[0]?.trim() || null;
  const productId = parts[1]?.trim() || null;

  if (parts.length < 5) {
    return { storeId, productId, promotionId: null, discountInCents: null, listSubtotalInCents: null };
  }

  const discountInCents = intOrNull(parts[3], { allowZero: false });
  return {
    storeId,
    productId,
    // A discount that did not parse takes its promotion with it: recording an
    // attribution with no amount would say a promotion was used and refuse to
    // say for how much.
    promotionId: discountInCents === null ? null : parts[2]?.trim() || null,
    discountInCents,
    listSubtotalInCents: discountInCents === null ? null : intOrNull(parts[4]),
  };
}
