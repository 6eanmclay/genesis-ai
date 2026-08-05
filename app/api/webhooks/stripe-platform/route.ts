import Stripe from "stripe";
import { creditGrowthPointsFromPurchase } from "@/lib/growthPoints/ledger";

// Chapter 5 (Payments) — a genuinely separate webhook endpoint from
// app/api/webhooks/stripe/route.ts, not an extension of it. That route
// exists for the MERCHANT's own connected-account activity (their
// customers paying them) and its event.account-based Connect-vs-platform
// branching would be dead weight here: every event this route ever
// receives is a platform-key event (Genesis billing the store owner
// directly), so session.metadata is trusted directly, with no
// externalAccountId disambiguation needed. Stripe supports multiple
// webhook endpoints with independent secrets on one account — this is
// normal, not a workaround.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET!;

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

    if (session.mode === "payment") {
      const storeId = session.metadata?.storeId;
      const pointAmountRaw = session.metadata?.pointAmount;
      const pointAmount = pointAmountRaw ? Number(pointAmountRaw) : NaN;

      if (!storeId || !Number.isFinite(pointAmount) || pointAmount <= 0) {
        console.error("[stripe-platform webhook] could not resolve a Growth Point purchase", {
          sessionId: session.id,
          storeId: storeId ?? null,
          pointAmountRaw: pointAmountRaw ?? null,
        });
      } else {
        await creditGrowthPointsFromPurchase({
          storeId,
          amount: pointAmount,
          externalRef: session.id,
          description: `Purchased ${pointAmount} Growth Point${pointAmount === 1 ? "" : "s"}`,
        });
      }
    }
  }

  return new Response("OK", { status: 200 });
}
