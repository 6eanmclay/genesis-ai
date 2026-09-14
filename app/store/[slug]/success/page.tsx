import Link from "next/link";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";

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

  // ============ THE REDIRECT IS NOT A RECEIPT (2026-09-14) ============
  //
  // This page printed "Thank you for your purchase!" and "Your order is
  // confirmed." unconditionally — for every arrival, with no evidence of any
  // kind. Rendered, five different arrivals produced the same claim:
  //
  //   no query string at all          "Your order is confirmed."
  //   another store's order id        "Your order is confirmed."
  //   a REFUNDED order                "Returned Ring — $50.00 · confirmed."
  //   a Stripe session that is gone   "Your order is confirmed."
  //   a real paid order               correct, and the only evidenced one
  //
  // Sean's standing rule is that Genesis must never infer the money was
  // received simply because an order exists; this inferred it from the URL
  // being visited. The contract is the one already set for Billing's own
  // return states: the provider's redirect establishes that somebody came back
  // from checkout, and only persisted state establishes that they paid. The
  // webhook remains the authority — for Stripe it is what creates the paid
  // Order row at all (lib/payments/stripeEvent.ts), so at redirect time the
  // row may legitimately not exist yet.
  //
  //   confirmed  Stripe says payment_status "paid", or a real Order for THIS
  //              store is already recorded as paid.
  //   pending    they plainly came back from a checkout, and nothing confirms
  //              it yet. Said plainly rather than dressed as success.
  //   unknown    nothing identifies a purchase at all. Not a thank-you.
  //
  // Delayed-notification payment methods are the ordinary case for pending:
  // Stripe returns payment_status "unpaid" at redirect and settles later, and
  // which methods a merchant enables is their choice, not Genesis's.
  let outcome: "confirmed" | "pending" | "unknown" = "unknown";

  // WHICH MONEY THE CUSTOMER JUST SPENT (2026-08-22). Hoisted out of the
  // Stripe branch below, which already needed the store for its connected
  // account and is no longer the only branch that needs it.
  //
  // Stripe's own session.currency is preferred when there is one, because it is
  // what was ACTUALLY charged rather than what this store is configured to
  // charge. If those two ever disagree, a receipt that quietly reported the
  // configuration would be the one place a customer could not catch it.
  const store = await prisma.store.findUnique({ where: { slug } });
  let currency = store?.currency ?? "USD";

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
      if (session.currency) currency = session.currency.toUpperCase();
      // STRIPE'S OWN ANSWER, not the fact that it answered. A retrieved
      // session proves a checkout existed; payment_status is the only field
      // that says money moved.
      outcome = session.payment_status === "paid" ? "confirmed" : "pending";
    } catch {
      // The session could not be read. They still arrived from a checkout, so
      // this is not "no purchase" — it is a purchase Genesis cannot confirm
      // from here, which is what pending says.
      outcome = "pending";
    }
  } else if (orderId) {
    // PayPal's flow captures synchronously and passes our own Order.id
    // (see app/api/checkout/paypal/return/route.ts), so no external API
    // call is needed here — the order is already in our own database.
    // ============ THE SLUG IN THE URL IS THE SCOPE (2026-08-31) =====
    //
    // This is a PUBLIC page and `order_id` is a query parameter, so the id
    // arrives from whoever typed the URL. Looked up by id alone it returned
    // any order on the platform, and this page then printed what was bought
    // and for how much — another shop's product name and another customer's
    // amount, on a page that never checked they had anything to do with each
    // other.
    //
    // The business was already resolved from the slug a few lines up for the
    // currency. Nothing needed fetching; the filter simply had to use it.
    // Scoped, a stranger's id finds nothing and the page falls through to the
    // same generic thank-you it shows when the id is missing entirely.
    const order = store
      ? await prisma.order.findFirst({ where: { id: orderId, storeId: store.id } })
      : null;
    if (order) {
      amountInCents = order.amountInCents;
      productName = order.productName;
      // PAID IS THE ONLY STATUS THAT CONFIRMS. A refunded order rendered here
      // as "Returned Ring — $50.00 · Your order is confirmed.", which is money
      // the customer has already had back.
      outcome = order.status === "paid" ? "confirmed" : "pending";
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-8 text-center dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50" data-testid="success-heading">
        {outcome === "unknown" ? "We couldn’t find that order" : "Thank you for your purchase!"}
      </h1>
      {productName && (
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          {productName}
          {amountInCents != null && ` — ${formatMoney(amountInCents, currency)}`}
        </p>
      )}
      <p className="mt-2 text-sm text-zinc-500" data-testid="success-status">
        {outcome === "confirmed"
          ? "Your order is confirmed."
          : outcome === "pending"
            ? "We’re confirming your payment. You’ll get an email as soon as it’s complete."
            : "If you have just paid, check the link in your confirmation email."}
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
