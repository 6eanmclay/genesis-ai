import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

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
    const storeId = session.metadata?.storeId;
    const productId = session.metadata?.productId;

    if (storeId && productId) {
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });

      // Idempotent: Stripe can redeliver the same event more than once, so
      // upsert on the unique session id rather than always creating.
      await prisma.order.upsert({
        where: { stripeSessionId: session.id },
        create: {
          storeId,
          productId,
          productName: product?.name ?? "Unknown product",
          amountInCents: session.amount_total ?? 0,
          buyerEmail: session.customer_details?.email ?? "unknown",
          status: "paid",
          stripeSessionId: session.id,
        },
        update: {},
      });
    }
  }

  return new Response("OK", { status: 200 });
}
