"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

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

  const headersList = await headers();
  const host = headersList.get("host");
  const protocol = host?.startsWith("localhost") ? "http" : "https";
  const baseUrl = `${protocol}://${host}`;

  const session = await stripe.checkout.sessions.create({
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

  redirect(session.url);
}
