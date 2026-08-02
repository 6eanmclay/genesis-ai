import Link from "next/link";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export default async function CheckoutSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ session_id?: string; order_id?: string }>;
}) {
  const { slug } = await params;
  const { session_id: sessionId, order_id: orderId } = await searchParams;

  let amountInCents: number | null = null;
  let productName: string | null = null;

  if (sessionId) {
    try {
      // Launch-readiness fix — a checkout session for a store using its own
      // connected Stripe account lives in that account's own context, not
      // the platform's. Retrieving it with only the platform key returns a
      // real 404 ("No such checkout.session"), confirmed live — silently
      // caught below, which is why this previously fell back to a generic
      // thank-you instead of the real product/amount for any connected-
      // account store. Same store-scoped Stripe client pattern already used
      // in app/store/[slug]/actions.ts's getStripeClientForStore.
      const store = await prisma.store.findUnique({ where: { slug } });
      const integration = store
        ? await prisma.storeIntegration.findUnique({
            where: { storeId_provider: { storeId: store.id, provider: "STRIPE" } },
          })
        : null;
      const stripeAccount =
        integration?.status === "CONNECTED" ? (integration.externalAccountId ?? undefined) : undefined;

      const session = await stripe.checkout.sessions.retrieve(
        sessionId,
        { expand: ["line_items"] },
        stripeAccount ? { stripeAccount } : undefined
      );
      amountInCents = session.amount_total;
      productName = session.line_items?.data[0]?.description ?? null;
    } catch {
      // Invalid or missing session id — still show a generic thank-you below.
    }
  } else if (orderId) {
    // PayPal's flow captures synchronously and passes our own Order.id
    // (see app/api/checkout/paypal/return/route.ts), so no external API
    // call is needed here — the order is already in our own database.
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (order) {
      amountInCents = order.amountInCents;
      productName = order.productName;
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-8 text-center dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
        Thank you for your purchase!
      </h1>
      {productName && (
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          {productName}
          {amountInCents != null &&
            ` — $${(amountInCents / 100).toFixed(2)}`}
        </p>
      )}
      <p className="mt-2 text-sm text-zinc-500">
        Your order is confirmed.
      </p>
      <Link
        href={`/store/${slug}`}
        className="mt-6 rounded-full bg-foreground px-5 py-2 text-sm text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        Back to store
      </Link>
    </div>
  );
}
