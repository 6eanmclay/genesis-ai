"use server";

import { redirect } from "next/navigation";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { getBaseUrl } from "@/lib/integrations/util";
import { getPaypalAccessToken, paypalApiBase, type PaypalCredentials } from "@/lib/integrations/paypal";
import { selectProvider } from "@/lib/payments/router";
import type { Product, Store } from "@prisma/client";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Standard Connect accounts: the OAuth access_token functions as that
// account's own secret key, so a per-store checkout is just "use a
// different Stripe client." Stores that haven't connected their own
// account yet fall back to the platform-wide key (today's behavior) so
// nothing already live breaks on rollout — see PH-02 in the roadmap.
async function getStripeClientForStore(storeId: string): Promise<Stripe> {
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "STRIPE" } },
  });
  const credentials =
    integration?.status === "CONNECTED"
      ? (integration.credentials as { accessToken?: string } | null)
      : null;

  return credentials?.accessToken ? new Stripe(credentials.accessToken) : stripe;
}

async function createStripeCheckoutSession(
  store: Store,
  product: Product,
  slug: string,
  baseUrl: string
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
    success_url: `${baseUrl}/store/${slug}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/store/${slug}`,
    metadata: {
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
  const credentials = integration?.credentials as PaypalCredentials | null;
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

export async function createCheckoutSession(slug: string, productId: string) {
  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store || !store.published) {
    throw new Error("Store not found");
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, storeId: store.id, active: true },
  });
  if (!product) {
    throw new Error("Product not found");
  }

  const baseUrl = await getBaseUrl();
  const provider = await selectProvider(store.id);

  const redirectUrl =
    provider === "PAYPAL"
      ? await createPaypalCheckoutSession(store, product, slug, baseUrl)
      : await createStripeCheckoutSession(store, product, slug, baseUrl);

  redirect(redirectUrl);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function subscribeToNewsletter(slug: string, formData: FormData) {
  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store || !store.published) {
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
