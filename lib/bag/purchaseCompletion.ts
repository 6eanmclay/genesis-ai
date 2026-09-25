import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

// NO `server-only`, AND NO STATIC IMPORT OF bagStore — deliberately.
//
// bagStore reaches for `next/headers`, which cannot be imported into anything
// a suite calls directly; bagCookie.ts and bagStore.ts are already split for
// exactly that reason. This module holds the DECISION, which is the part worth
// proving, so it stays reachable from a test. The cookie jar is pulled in
// dynamically below, only on the path that actually writes one.

// ============ WHAT A COMPLETED PURCHASE MEANS, IN ONE PLACE =========
//
// THE DEFECT THIS EXISTS FOR (2026-09-24). A real customer paid $285.85 for a
// twelve-unit order, reached the confirmed success page, and her bag still
// held all twelve items. `clearBagCookie` had been written months earlier and
// was never called from anywhere — its only occurrence in the repository was
// its own definition. Twenty live orders were taken with the bag never once
// emptied.
//
// THE DECISION HAS ONE OWNER. Two surfaces need to know whether a purchase
// really completed: the success page, which tells the customer, and the bag
// clear, which throws their basket away. If those two ever disagreed, a
// customer would be told "confirmed" while keeping a full bag, or — far worse
// — lose a bag they had not yet paid for. So both call `resolvePurchase`
// rather than each deciding for themselves.
//
// THE REDIRECT IS NOT A RECEIPT. Arriving at the success URL proves only that
// somebody came back from a checkout. Only persisted state proves payment:
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

export type PurchaseOutcome = "confirmed" | "pending" | "unknown";

export interface ResolvedPurchase {
  outcome: PurchaseOutcome;
  amountInCents: number | null;
  productName: string | null;
  currency: string;
}

export interface ResolvePurchaseInput {
  slug: string;
  sessionId?: string | null;
  orderId?: string | null;
}

/**
 * Retrieves a Stripe Checkout Session. Injectable for the same reason
 * sendOrderConfirmation's sender is: a suite must be able to exercise the
 * real decision without reaching Stripe, and the one step that talks to a
 * payment provider is the step a test must not perform.
 */
export type SessionFetcher = (
  sessionId: string,
  stripeAccount: string | undefined
) => Promise<{
  amount_total: number | null;
  currency: string | null;
  payment_status: string;
  firstLineDescription: string | null;
}>;

const liveSessionFetcher: SessionFetcher = async (sessionId, stripeAccount) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const session = await stripe.checkout.sessions.retrieve(
    sessionId,
    { expand: ["line_items"] },
    stripeAccount ? { stripeAccount } : undefined
  );
  return {
    amount_total: session.amount_total,
    currency: session.currency,
    payment_status: session.payment_status,
    firstLineDescription: session.line_items?.data[0]?.description ?? null,
  };
};

export async function resolvePurchase(
  input: ResolvePurchaseInput,
  fetchSession: SessionFetcher = liveSessionFetcher
): Promise<ResolvedPurchase> {
  const { slug, sessionId, orderId } = input;

  const store = await prisma.store.findUnique({ where: { slug } });
  let currency = store?.currency ?? "USD";
  let amountInCents: number | null = null;
  let productName: string | null = null;
  let outcome: PurchaseOutcome = "unknown";

  if (sessionId) {
    try {
      // A session for a store on its own connected account lives in that
      // account's context, not the platform's. Retrieving it with only the
      // platform key returns a real 404, which is why this once fell back to
      // a generic thank-you for every connected-account store.
      const integration = store
        ? await prisma.storeIntegration.findUnique({
            where: { storeId_provider: { storeId: store.id, provider: "STRIPE" } },
          })
        : null;
      const stripeAccount =
        integration?.status === "CONNECTED" ? (integration.externalAccountId ?? undefined) : undefined;

      const session = await fetchSession(sessionId, stripeAccount);
      amountInCents = session.amount_total;
      productName = session.firstLineDescription;
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
    // ============ THE SLUG IN THE URL IS THE SCOPE ==================
    //
    // This is reached from a PUBLIC page where `order_id` is a query
    // parameter, so the id arrives from whoever typed the URL. Looked up by
    // id alone it returned any order on the platform. Scoped to the store the
    // slug resolves to, a stranger's id finds nothing.
    const order = store
      ? await prisma.order.findFirst({ where: { id: orderId, storeId: store.id } })
      : null;
    if (order) {
      amountInCents = order.amountInCents;
      productName = order.productName;
      // PAID IS THE ONLY STATUS THAT CONFIRMS. A refunded order rendered as
      // "Returned Ring — $50.00 · Your order is confirmed.", which is money
      // the customer has already had back.
      outcome = order.status === "paid" ? "confirmed" : "pending";
    }
  }

  return { outcome, amountInCents, productName, currency };
}

export interface BagClearResult {
  cleared: boolean;
  outcome: PurchaseOutcome;
}

/**
 * Empty the bag, but ONLY for a purchase that provably completed.
 *
 * WHAT MUST NOT CLEAR IT, and why each one matters:
 *
 *   pending   — a delayed-notification payment that has not settled. Clearing
 *               here throws away a basket for money that may never arrive.
 *   unknown   — nothing identifies a purchase. Anyone visiting /success with
 *               no query string would otherwise empty their own bag.
 *   refunded  — `status` is not "paid", so it resolves pending, not confirmed.
 *   cancelled — never reaches a success URL at all; the failure exits carry a
 *               CheckoutProblem instead (lib/orders/checkoutOutcome.ts).
 *   other store's order id — resolvePurchase scopes by slug, so it finds
 *               nothing and the outcome is unknown.
 *
 * IDEMPOTENT. Clearing an already-empty bag writes the same empty cookie
 * again, so a customer refreshing the success page costs nothing and a second
 * call cannot resurrect anything.
 *
 * `clear` is injectable because clearBagCookie reaches for `next/headers`,
 * which cannot be imported into anything a suite calls directly — the same
 * reason bagStore.ts is kept separate from bagCookie.ts.
 */
export async function clearBagOnConfirmedPurchase(
  input: ResolvePurchaseInput,
  deps: {
    resolve?: (i: ResolvePurchaseInput) => Promise<ResolvedPurchase>;
    clear?: (slug: string) => Promise<void>;
  } = {}
): Promise<BagClearResult> {
  const resolve = deps.resolve ?? ((i: ResolvePurchaseInput) => resolvePurchase(i));
  // Loaded here, not at module scope: bagStore pulls in `next/headers`, which
  // only exists inside a request. A suite injects `clear` and never reaches
  // this line, which is what keeps the decision above testable.
  const clear =
    deps.clear ??
    (async (slug: string) => {
      const { clearBagCookie } = await import("./bagStore");
      await clearBagCookie(slug);
    });

  const { outcome } = await resolve(input);
  if (outcome !== "confirmed") return { cleared: false, outcome };

  await clear(input.slug);
  return { cleared: true, outcome };
}
