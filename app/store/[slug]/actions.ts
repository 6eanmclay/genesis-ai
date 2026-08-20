"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { quoteShippingForProduct, type DestinationAddress, type ShippingOption } from "@/lib/shipping/rates";
import { confirmSelectedRate, toCheckoutMetadata, type SelectedShipping } from "@/lib/shipping/checkoutShipping";
import { getBaseUrl } from "@/lib/integrations/util";
import { getPaypalAccessToken, paypalApiBase, type PaypalCredentials } from "@/lib/integrations/paypal";
import { decryptCredentials } from "@/lib/integrations/credentials";
import { selectProvider } from "@/lib/payments/router";
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
  // Present only when the customer chose a shipping service on the storefront.
  // Absent for every other checkout, which behaves exactly as it always has.
  shipping?: { destination: DestinationAddress; selected: SelectedShipping }
): Promise<string> {
  const storeStripe = await getStripeClientForStore(store.id);

  const session = await storeStripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: product.name },
          unit_amount: product.priceInCents,
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
                fixed_amount: { amount: shipping.selected.amountInCents, currency: "usd" },
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
    metadata: shipping
      ? toCheckoutMetadata({
          storeId: store.id,
          productId: product.id,
          destination: shipping.destination,
          selected: shipping.selected,
        })
      : {
          storeId: store.id,
          productId: product.id,
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
  baseUrl: string
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
          custom_id: `${store.id}:${product.id}`,
          amount: {
            currency_code: "USD",
            value: (product.priceInCents / 100).toFixed(2),
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
  _formData: FormData
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

    const baseUrl = await getBaseUrl();
    const provider = await selectProvider(store.id);

    redirectUrl =
      provider === "PAYPAL"
        ? await createPaypalCheckoutSession(store, product, slug, baseUrl)
        : await createStripeCheckoutSession(store, product, slug, baseUrl);
  } catch (error) {
    unstable_rethrow(error);
    return toActionState(error);
  }

  redirect(redirectUrl);
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

  return { status: "quoted", options: quote.options, address };
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

    const baseUrl = await getBaseUrl();
    redirectUrl = await createStripeCheckoutSession(store, product, slug, baseUrl, {
      destination: address,
      selected: confirmed.selected,
    });
  } catch (error) {
    unstable_rethrow(error);
    return toActionState(error);
  }
  redirect(redirectUrl);
}
