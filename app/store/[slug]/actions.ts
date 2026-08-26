"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { quoteShippingForProduct, type DestinationAddress, type ShippingOption } from "@/lib/shipping/rates";
import { confirmSelectedRate, toCheckoutMetadata, type SelectedShipping } from "@/lib/shipping/checkoutShipping";
import { verifyShippingAddress } from "@/lib/shipping/verifyAddress";
import type { AddressVerification } from "@/lib/shipping/addressVerification";
import { getBaseUrl } from "@/lib/integrations/util";
import { getPaypalAccessToken, paypalApiBase, type PaypalCredentials } from "@/lib/integrations/paypal";
import { decryptCredentials } from "@/lib/integrations/credentials";
import { selectProvider } from "@/lib/payments/router";
import { priceCheckout } from "@/lib/promotions/resolve";
import type { CheckoutPreviewState } from "@/lib/promotions/checkoutPreview";
import { toDiscountMetadata, packPaypalCustomId } from "@/lib/promotions/checkoutDiscount";
import type { OrderPricing } from "@/lib/pricing/orderPricing";
import { canStoreAcceptPayments, CHECKOUT_UNAVAILABLE_MESSAGE } from "./shared";
import { RecoverableError, toActionState, type ActionState } from "@/lib/actionState";
import type { Product, Store } from "@prisma/client";

// Standard Connect accounts: the OAuth access_token functions as that
// account's own secret key, so a per-store checkout is just "use a
// different Stripe client." No platform-wide fallback exists — payment
// routing is explicit and deterministic by design. A store reaching
// checkout without its own connected Stripe account is a real
// misconfiguration (canStoreAcceptPayments and publishStoreExecutable both
// independently guard against this before a customer ever gets here).
async function getStripeClientForStore(storeId: string): Promise<Stripe> {
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "STRIPE" } },
  });
  const credentials =
    integration?.status === "CONNECTED" && integration.credentials
      ? decryptCredentials<{ accessToken?: string }>(integration.credentials)
      : null;

  if (!credentials?.accessToken) {
    throw new Error(`Store ${storeId} has no connected Stripe account — cannot create a checkout session.`);
  }
  return new Stripe(credentials.accessToken);
}

async function createStripeCheckoutSession(
  store: Store,
  product: Product,
  slug: string,
  baseUrl: string,
  // WHAT THIS ORDER COSTS, already decided. Required rather than optional, so
  // the compiler refuses any future call site that tries to charge a price this
  // function worked out for itself — which is how the two rails drifted apart
  // in the first place. See lib/pricing/orderPricing.ts.
  pricing: OrderPricing,
  // Present only when the customer chose a shipping service on the storefront.
  // Absent for every other checkout, which behaves exactly as it always has.
  shipping?: {
    destination: DestinationAddress;
    selected: SelectedShipping;
    /** What the customer typed, when accepting a suggestion changed it. */
    enteredAddress?: DestinationAddress | null;
    /** verified | unverified | not_checked. */
    addressVerification?: string | null;
  }
): Promise<string> {
  const storeStripe = await getStripeClientForStore(store.id);

  const session = await storeStripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          // THE STORE'S OWN CURRENCY, not the developer's (2026-08-22).
          //
          // Store.currency's schema comment already declares itself
          // authoritative for "every money value belonging to this business",
          // and both checkout rails ignored it. Nothing in the product writes
          // that field yet, so every store is USD today and this changes no
          // live charge — but the first store that is not would have been shown
          // a price in one currency and charged in another, which is not a
          // display bug, it is the wrong amount of money.
          currency: store.currency.toLowerCase(),
          // The discount is named on Stripe's own page too. The customer saw
          // the full breakdown on the review step before getting here; without
          // this line the price would simply be lower than the one on the
          // product page, with nothing to say why.
          product_data: {
            name: product.name,
            ...(pricing.discount ? { description: `${pricing.discount.label} applied` } : {}),
          },
          // THE DISCOUNTED SUBTOTAL, not the list price and not a Stripe
          // coupon. Applying it here rather than through Stripe's own discount
          // API is what lets the PayPal rail below charge the same arithmetic —
          // a Stripe Coupon would have been silently ignored there.
          //
          // This is the whole merchandise line because quantity is 1; see
          // priceOrder, which is where quantity lives if it ever stops being.
          unit_amount: pricing.merchandiseSubtotalInCents,
        },
        quantity: 1,
      },
    ],
    // Implementation roadmap Milestone 1 — every product sold through this
    // storefront is currently a physical good (no digital-product path
    // exists yet), so shipping collection is unconditional rather than
    // branching on a product type this schema doesn't represent yet.
    // allowed_countries scoped to where the built fulfillment path
    // (Printful) actually ships today — a real, easy-to-widen decision,
    // not an architectural limit.
    // When the customer already gave us their address to get real rates,
    // Stripe must not ask for it a second time — and the chosen service is
    // added as a fixed shipping line so the total they approve is the total
    // they were quoted. Without live shipping this is unchanged.
    ...(shipping
      ? {
          shipping_options: [
            {
              shipping_rate_data: {
                type: "fixed_amount" as const,
                fixed_amount: { amount: shipping.selected.amountInCents, currency: store.currency.toLowerCase() },
                display_name: `${shipping.selected.carrier} ${shipping.selected.service}`,
                ...(shipping.selected.estimatedDays !== null
                  ? {
                      delivery_estimate: {
                        maximum: { unit: "business_day" as const, value: shipping.selected.estimatedDays },
                      },
                    }
                  : {}),
              },
            },
          ],
        }
      : { shipping_address_collection: { allowed_countries: ["US" as const] } }),
    success_url: `${baseUrl}/store/${slug}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/store/${slug}`,
    metadata: {
      ...(shipping
        ? toCheckoutMetadata({
            storeId: store.id,
            productId: product.id,
            destination: shipping.destination,
            selected: shipping.selected,
            enteredAddress: shipping.enteredAddress ?? null,
            addressVerification: shipping.addressVerification ?? null,
          })
        : {
            storeId: store.id,
            productId: product.id,
          }),
      // Empty when nothing was discounted, so an undiscounted checkout's
      // metadata is byte-identical to what it was before promotions existed.
      ...toDiscountMetadata(pricing),
    },
  });

  if (!session.url) {
    throw new Error("Failed to create checkout session");
  }
  return session.url;
}

// PayPal's Orders API v2: create an order the buyer approves on PayPal's
// own site, then capture happens synchronously when they return (see
// app/api/checkout/paypal/return/route.ts) — no webhook for PH-06's MVP.
// custom_id is a single ≤127-char string (unlike Stripe's multi-key
// metadata), so storeId/productId are packed into one delimited value —
// cuids never contain ":", so splitting it back out on return is safe.
async function createPaypalCheckoutSession(
  store: Store,
  product: Product,
  slug: string,
  baseUrl: string,
  // The same priced order the Stripe rail is given, for the same reason.
  pricing: OrderPricing
): Promise<string> {
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
  });
  const credentials = integration?.credentials
    ? decryptCredentials<PaypalCredentials>(integration.credentials)
    : null;
  if (integration?.status !== "CONNECTED" || !credentials) {
    throw new Error("PayPal is not connected for this store");
  }

  const token = await getPaypalAccessToken(
    credentials.clientId,
    credentials.clientSecret,
    credentials.environment
  );

  const res = await fetch(`${paypalApiBase(credentials.environment)}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          // storeId and productId as always, plus the money when something was
          // discounted. PayPal gives us ONE 127-character string and no
          // metadata, so this is the entire channel back to the order — see
          // lib/promotions/checkoutDiscount.ts.
          custom_id: packPaypalCustomId({ storeId: store.id, productId: product.id, pricing }),
          amount: {
            // The store's own, exactly as the Stripe rail above. Uppercase
            // here because PayPal's API takes the ISO code as written.
            currency_code: store.currency.toUpperCase(),
            // THE DISCOUNTED SUBTOTAL — the same number the Stripe rail
            // charges, from the same function. This rail carries no shipping,
            // which is unchanged: checkoutWithShipping is Stripe-only.
            value: (pricing.merchandiseSubtotalInCents / 100).toFixed(2),
            // The breakdown PayPal shows the customer on its own approval page.
            // Written only when there is a discount to explain; item_total and
            // discount must sum to `value` above, which they do by construction
            // because both come out of the same OrderPricing.
            ...(pricing.discount
              ? {
                  breakdown: {
                    item_total: {
                      currency_code: store.currency.toUpperCase(),
                      value: (pricing.listSubtotalInCents / 100).toFixed(2),
                    },
                    discount: {
                      currency_code: store.currency.toUpperCase(),
                      value: (pricing.discount.amountInCents / 100).toFixed(2),
                    },
                  },
                }
              : {}),
          },
        },
      ],
      application_context: {
        return_url: `${baseUrl}/api/checkout/paypal/return?slug=${slug}`,
        cancel_url: `${baseUrl}/store/${slug}`,
        // Implementation roadmap Milestone 1 — GET_FROM_FILE collects a
        // real shipping address from the buyer's own PayPal profile and
        // returns it in the order/capture response; the default
        // (unset) preference doesn't reliably guarantee one.
        shipping_preference: "GET_FROM_FILE",
      },
    }),
  });

  if (!res.ok) {
    throw new Error("Failed to create PayPal order");
  }

  const data = await res.json();
  const approveLink = (data.links as { rel: string; href: string }[] | undefined)?.find(
    (l) => l.rel === "approve"
  )?.href;
  if (!approveLink) {
    throw new Error("Failed to create PayPal order");
  }
  return approveLink;
}

export async function createCheckoutSession(
  slug: string,
  productId: string,
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  let redirectUrl: string;

  try {
    // Real bug found via a live beta user (an owner previewing their own
    // unpublished store — an anonymous visitor can never reach this at all,
    // see app/store/[slug]/page.tsx's own notFound() gate): !store.published
    // used to throw the same "Store not found" a genuinely missing store
    // does, confusing an owner just trying their own real checkout before
    // going live. Only a real 404 (no store) should say that.
    const store = await prisma.store.findUnique({ where: { slug } });
    if (!store) {
      throw new RecoverableError("Store not found");
    }

    const product = await prisma.product.findFirst({
      where: { id: productId, storeId: store.id, active: true },
    });
    if (!product) {
      throw new RecoverableError("Product not found");
    }

    // Defense in depth, not just the UI gate (BuyButton already hides
    // itself when this is false) — the callback URL/action is still a
    // public POST target regardless of whether the button rendered.
    if (!(await canStoreAcceptPayments(store.id))) {
      throw new RecoverableError(CHECKOUT_UNAVAILABLE_MESSAGE);
    }

    // THE PRICE, RE-DERIVED HERE AND NOWHERE ELSE.
    //
    // The form submits a CODE — a string the customer typed — and never an
    // amount. Every figure below is worked out now, from this store's own rows,
    // at the moment of the charge. A tampered form can ask for a discount that
    // does not exist; it cannot invent one, because nothing it sends is
    // arithmetic. This is the rule the shipping step already established by
    // taking a rate id and re-quoting rather than trusting a posted price.
    //
    // Re-derived rather than carried from the review screen for the same
    // reason: a promotion that expired while the customer was reading must not
    // be honoured because a hidden field still remembers it.
    const { pricing } = await priceCheckout({
      storeId: store.id,
      productId: product.id,
      unitPriceInCents: product.priceInCents,
      code: String(formData.get("discountCode") ?? "").trim() || null,
    });

    const baseUrl = await getBaseUrl();
    const provider = await selectProvider(store.id);

    redirectUrl =
      provider === "PAYPAL"
        ? await createPaypalCheckoutSession(store, product, slug, baseUrl, pricing)
        : await createStripeCheckoutSession(store, product, slug, baseUrl, pricing);
  } catch (error) {
    unstable_rethrow(error);
    return toActionState(error);
  }

  redirect(redirectUrl);
}

/**
 * What this order would cost with that code — asked before paying.
 *
 * SEPARATE FROM THE CHARGE ON PURPOSE. This tells the customer what they would
 * be charged; it decides nothing. The checkout actions re-derive the price from
 * the same rows at the moment of the charge and do not read a single number
 * this returned, so a promotion that expires between the two is honoured
 * according to when the money moves, not according to when the page rendered.
 *
 * It takes a CODE and a rate id — never an amount — for the same reason.
 */
export async function previewCheckoutPrice(
  slug: string,
  productId: string,
  _prevState: CheckoutPreviewState,
  formData: FormData
): Promise<CheckoutPreviewState> {
  try {
    const store = await prisma.store.findUnique({ where: { slug }, select: { id: true } });
    if (!store) throw new RecoverableError("Store not found");

    const product = await prisma.product.findFirst({
      where: { id: productId, storeId: store.id, active: true },
      select: { id: true, priceInCents: true },
    });
    if (!product) throw new RecoverableError("Product not found");

    // Shipping arrives as the id of a rate the customer selected, and its
    // amount is looked up rather than accepted — the same rule as everything
    // else here. An unrecognised id simply prices without shipping, because a
    // preview that guessed a delivery cost would be worse than one that waits.
    const rateId = String(formData.get("rateId") ?? "").trim();
    const shippingInCents = Number(formData.get("shippingInCents") ?? 0);

    const { pricing, code } = await priceCheckout({
      storeId: store.id,
      productId: product.id,
      unitPriceInCents: product.priceInCents,
      shippingInCents: rateId && Number.isFinite(shippingInCents) ? Math.max(0, shippingInCents) : 0,
      code: String(formData.get("discountCode") ?? "").trim() || null,
    });

    return { ok: true, pricing, code };
  } catch (error) {
    unstable_rethrow(error);
    return {
      ok: false,
      error: error instanceof RecoverableError ? error.message : "We couldn't check that just now.",
    };
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function subscribeToNewsletter(slug: string, formData: FormData) {
  // Same real fix as createCheckoutSession above — only a genuine 404
  // should say "Store not found." The newsletter section renders
  // unconditionally on the storefront, so an owner naturally trying it
  // while previewing their own real, unpublished store hit this exact
  // crash live (Sentry-confirmed, first real beta user).
  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store) {
    throw new Error("Store not found");
  }

  const email = (formData.get("email") as string)?.trim().toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new Error("Enter a valid email address");
  }

  // Idempotent: resubmitting the same email (e.g. a double-click) shouldn't
  // error, just silently no-op on the duplicate.
  await prisma.newsletterSignup.upsert({
    where: { storeId_email: { storeId: store.id, email } },
    create: { storeId: store.id, email },
    update: {},
  });

  redirect(`/store/${slug}?subscribed=1`);
}

// ---------------------------------------------------------------------------
// Live shipping selection (2026-08-20).
//
// Only reachable for a store that connected its own EasyPost account and a
// product with a real weight. Everything else still uses createCheckoutSession
// above, unchanged.

export interface ShippingQuoteState {
  status: "idle" | "quoted" | "error";
  options?: ShippingOption[];
  message?: string;
  address?: DestinationAddress;
  /**
   * What the address service made of what was typed (2026-08-25).
   *
   * Present whenever an address was submitted. The step renders a suggestion or
   * a warning from this; nothing is ever swapped silently.
   */
  verification?: AddressVerification;
}

function readAddress(formData: FormData): DestinationAddress | null {
  const line1 = String(formData.get("line1") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const postalCode = String(formData.get("postalCode") ?? "").trim();
  if (!line1 || !city || !postalCode) return null;
  return {
    name: String(formData.get("name") ?? "").trim() || null,
    line1,
    line2: String(formData.get("line2") ?? "").trim() || null,
    city,
    state: String(formData.get("state") ?? "").trim() || null,
    postalCode,
    country: String(formData.get("country") ?? "US").trim() || "US",
  };
}

/** Ask the carrier what it would charge to send this product to this address. */
export async function quoteShippingOptions(
  slug: string,
  productId: string,
  _prevState: ShippingQuoteState,
  formData: FormData
): Promise<ShippingQuoteState> {
  const address = readAddress(formData);
  if (!address) {
    return { status: "error", message: "Please fill in the street address, city and ZIP code." };
  }

  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true } });
  if (!store) return { status: "error", message: "Store not found" };

  // CHECKED BEFORE ANYTHING IS QUOTED OR CHARGED (2026-08-25).
  //
  // Every required field being filled in is not the same as the parcel
  // arriving: a transposed house number passes every check on this form and
  // then fails in a sorting facility days later, at the merchant's expense.
  //
  // The customer decides what happens next — a correction is a suggestion they
  // accept, an unverifiable address is a warning they acknowledge. Nothing here
  // rejects an order or swaps an address behind their back.
  const acknowledged = String(formData.get("addressAcknowledged") ?? "") === "1";
  const verification = await verifyShippingAddress(store.id, address);

  // A correction the customer has not seen yet stops here and asks. Once they
  // have chosen — the suggested address becomes what the form holds, or they
  // acknowledged their own — the flow continues with what they picked.
  if (verification.outcome === "corrected" && !acknowledged) {
    return { status: "error", message: "", address, verification };
  }
  if (verification.outcome === "unverifiable" && !acknowledged) {
    return { status: "error", message: "", address, verification };
  }

  const quote = await quoteShippingForProduct({ storeId: store.id, productId, destination: address });
  if (!quote.ok) {
    // Each failure names itself rather than collapsing into "no options",
    // which a shopper cannot tell apart from a broken store.
    const message =
      quote.reason === "carrier_returned_none"
        ? "No carrier could quote a delivery to that address. Please check it and try again."
        : "Shipping options aren't available for this item right now.";
    return { status: "error", message, address };
  }

  return { status: "quoted", options: quote.options, address, verification };
}

/**
 * Take the chosen service to Stripe.
 *
 * The rate is re-quoted and matched by id server-side — the browser never gets
 * to name a shipping price.
 */
export async function checkoutWithShipping(
  slug: string,
  productId: string,
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  let redirectUrl: string;
  try {
    const address = readAddress(formData);
    const rateId = String(formData.get("rateId") ?? "").trim();
    if (!address || !rateId) throw new RecoverableError("Please choose a shipping option.");

    const store = await prisma.store.findUnique({ where: { slug } });
    if (!store) throw new RecoverableError("Store not found");

    const product = await prisma.product.findFirst({ where: { id: productId, storeId: store.id, active: true } });
    if (!product) throw new RecoverableError("Product not found");
    if (!(await canStoreAcceptPayments(store.id))) throw new RecoverableError(CHECKOUT_UNAVAILABLE_MESSAGE);

    const confirmed = await confirmSelectedRate({ storeId: store.id, productId, destination: address, rateId });
    if (!confirmed.ok) {
      throw new RecoverableError(
        confirmed.reason === "rate_expired"
          ? "Those shipping prices expired while you were choosing. Please pick again."
          : "Shipping options aren't available for this item right now."
      );
    }

    // BOTH ADDRESSES, forward to the order. The one being shipped to is
    // `address`; `addressEntered` is what the customer originally typed and is
    // present only when accepting a suggestion changed it.
    const enteredRaw = String(formData.get("addressEntered") ?? "").trim();
    let enteredAddress: DestinationAddress | null = null;
    if (enteredRaw) {
      try {
        enteredAddress = JSON.parse(enteredRaw) as DestinationAddress;
      } catch {
        // A malformed hidden field loses the audit copy and must not lose the
        // sale — the address being shipped to is unaffected.
        enteredAddress = null;
      }
    }

    // The same re-derivation as the no-shipping path above, with the shipping
    // the customer chose passed in. Shipping is added AFTER the discount inside
    // priceOrder and is never part of what a percentage is taken from, which is
    // the whole of "discounts do not apply to shipping" — there is no separate
    // rule to enforce anywhere else.
    const { pricing } = await priceCheckout({
      storeId: store.id,
      productId: product.id,
      unitPriceInCents: product.priceInCents,
      shippingInCents: confirmed.selected.amountInCents,
      code: String(formData.get("discountCode") ?? "").trim() || null,
    });

    const baseUrl = await getBaseUrl();
    redirectUrl = await createStripeCheckoutSession(store, product, slug, baseUrl, pricing, {
      destination: address,
      selected: confirmed.selected,
      enteredAddress,
      addressVerification: String(formData.get("addressVerification") ?? "").trim() || null,
    });
  } catch (error) {
    unstable_rethrow(error);
    return toActionState(error);
  }
  redirect(redirectUrl);
}
