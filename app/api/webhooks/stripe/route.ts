import Stripe from "stripe";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { runDeterministicObservationSweep } from "@/lib/dashboard/genesisObservations";
import { measureDueMeasurements } from "@/lib/dashboard/postExecutionMeasurement";
import { writeBusinessEvents } from "@/lib/intelligence/businessEvents";
import { mapOrdersToTransactions, internalTransactionId } from "@/lib/businessModel/internalMapper";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const productId = session.metadata?.productId;

    // `event.account` is set when this event came from a connected
    // account's own activity (a store using its connected Stripe account,
    // not the platform-wide key). Metadata on the session is set by our
    // own createCheckoutSession action — but a connected merchant holds an
    // API-key-equivalent access token for their own account and could call
    // Stripe directly, so metadata alone isn't trustworthy for connected
    // events. `event.account` is controlled by Stripe, not the merchant,
    // so for connected events it's the source of truth for which store
    // this belongs to; metadata is only trusted for platform-key events
    // (no event.account), which we control end-to-end ourselves.
    let storeId: string | undefined;
    if (event.account) {
      const integration = await prisma.storeIntegration.findFirst({
        where: { provider: "STRIPE", externalAccountId: event.account },
        select: { storeId: true },
      });
      storeId = integration?.storeId;
    } else {
      storeId = session.metadata?.storeId;
    }

    if (storeId && productId) {
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });

      // Idempotent: Stripe can redeliver the same event more than once. An
      // existence check (rather than inferring "was this new" from upsert's
      // return value) inside the same transaction as the Order write means
      // the Order and its BusinessEvent commit together or not at all — see
      // PHASE1_DESIGN.md section 4. A retry that finds an existing Order is
      // a genuine no-op, exactly like the upsert this replaced.
      await prisma.$transaction(async (tx) => {
        const existing = await tx.order.findUnique({
          where: { paymentProvider_externalOrderId: { paymentProvider: "STRIPE", externalOrderId: session.id } },
        });
        if (existing) return;

        const order = await tx.order.create({
          data: {
            storeId,
            productId,
            productName: product?.name ?? "Unknown product",
            amountInCents: session.amount_total ?? 0,
            buyerEmail: session.customer_details?.email ?? "unknown",
            status: "paid",
            paymentProvider: "STRIPE",
            externalOrderId: session.id,
          },
        });

        const transaction = mapOrdersToTransactions([order])[0];
        await writeBusinessEvents(tx, storeId, "internal", [
          {
            recordId: internalTransactionId(order.id),
            entityType: "transaction",
            eventType: "transaction.created",
            summary: `Sale: ${order.productName} ($${(order.amountInCents / 100).toFixed(2)})`,
            data: transaction.data,
          },
        ]);
      });

      // Phase 4 — a completed order is exactly a "business state may have
      // just changed" moment (e.g. inventory heading toward a stockout).
      // Scheduled via after() so Stripe still gets its expected fast ack.
      // Phase 5's measurement sweep rides the same trigger — deterministic,
      // zero AI cost, a no-op unless a past approval's window has elapsed.
      after(() =>
        Promise.all([
          runDeterministicObservationSweep(storeId),
          measureDueMeasurements(storeId),
        ]).catch(() => {})
      );
    }
  }

  return new Response("OK", { status: 200 });
}
