import { sendOrderConfirmation } from "@/lib/orders/orderConfirmation";
import { notifyOwnerOfSale } from "@/lib/orders/notifyOwnerOfSale";
import { isPermanentOrderFailure } from "@/lib/orders/orderFailure";
import { checkWebhookSecret } from "@/lib/observability/webhookConfig";
import { reportIssue } from "@/lib/observability/reportIssue";
import { randomUUID } from "crypto";
import Stripe from "stripe";
import { after } from "next/server";
import { recordExecution } from "@/lib/execution/log";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { runDeterministicObservationSweep } from "@/lib/dashboard/genesisObservations";
import { measureDueMeasurements } from "@/lib/dashboard/postExecutionMeasurement";
import { writeBusinessEvents } from "@/lib/intelligence/businessEvents";
import { mapOrdersToTransactions, internalTransactionId } from "@/lib/businessModel/internalMapper";
import { fromStripeShippingDetails } from "@/lib/orders/shippingAddress";
import { parseCheckoutShipping } from "@/lib/shipping/checkoutShipping";
import { parseDiscountMetadata } from "@/lib/promotions/checkoutDiscount";
import { loadDraft, draftTotalMismatch } from "@/lib/bag/checkoutDraft";
import {
  linesFromDraft,
  linesFromStripe,
  noLines,
  primaryNameFor,
  primaryProductId,
  totalQuantity,
  type RecoveredLines,
} from "@/lib/bag/orderLines";
import { resolveWebhookStore } from "@/lib/orders/webhookStore";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/**
 * Money arrived and something about the order could not be established.
 *
 * The pattern this route already uses for a payment it cannot account for
 * (CHECKOUT_STRIPE_UNRECORDED), reused rather than reinvented — so a
 * contents-unknown order and a mismatched charge surface where an owner is
 * already looking. Never throws: a logging failure must not lose an order that
 * has already committed.
 */
async function recordCheckoutProblem(
  storeId: string,
  params: { message: string; metadata: Record<string, unknown> }
): Promise<void> {
  try {
    await recordExecution({
      executionId: randomUUID(),
      action: EXECUTION_ACTIONS.CHECKOUT_STRIPE_UNRECORDED,
      status: "FAILED",
      verified: false,
      message: params.message,
      retryable: false,
      actorType: "USER",
      actorId: null,
      storeId,
      storeDraftId: null,
      schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
      timestamp: new Date(),
      metadata: params.metadata,
    });
  } catch {
    // Deliberately swallowed. See above.
  }
}


export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  // Read per request, not at module load: a config check that runs once when
  // the lambda cold-starts cannot report anything useful, and the value can
  // change between deploys.
  const configured = checkWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET");
  if (!configured.ok) {
    // 500, NOT 400. 400 tells Stripe the request is permanently bad and it
    // stops retrying, which turns a missing environment variable into real
    // payments that never became orders. See lib/observability/webhookConfig.ts.
    reportIssue(configured.reason, new Error("STRIPE_WEBHOOK_SECRET is not set"), {
      subsystem: "payments",
      stage: "stripe.webhook.config",
    });
    return new Response("Webhook not configured", { status: configured.status });
  }

  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, configured.secret);
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
    //
    // Real bug found via live testing: externalAccountId has no unique
    // constraint (nothing stops two different stores from connecting the
    // same underlying Stripe account — an owner running more than one
    // store is a real, non-adversarial case), so findFirst-by-
    // externalAccountId-alone could resolve to the wrong store, or Stripe's
    // return order could differ from creation order. metadata.storeId is
    // now used to disambiguate, but only after confirming — via that
    // store's OWN stored externalAccountId, not the merchant's say-so —
    // that it really matches this event.account. That keeps the original
    // trust boundary intact (a forged metadata.storeId still can't claim
    // an event for an account it isn't genuinely connected to) while fixing
    // the ambiguity for stores that legitimately share one Stripe account.
    // The decision itself lives in lib/orders/webhookStore.ts so it can be
    // attacked directly with forged events — see verify-webhook-store.ts. The
    // rules are unchanged; only the lookups happen here.
    const metadataStoreId = session.metadata?.storeId;
    const claimed =
      event.account && metadataStoreId
        ? await prisma.storeIntegration.findUnique({
            where: { storeId_provider: { storeId: metadataStoreId, provider: "STRIPE" } },
            select: { storeId: true, externalAccountId: true },
          })
        : null;
    const byAccount = event.account
      ? await prisma.storeIntegration.findFirst({
          where: { provider: "STRIPE", externalAccountId: event.account },
          select: { storeId: true },
        })
      : null;

    const storeId =
      resolveWebhookStore({
        eventAccount: event.account,
        metadataStoreId,
        claimed,
        byAccount,
      }).storeId ?? undefined;

    if (!storeId || !productId) {
      console.error("[stripe webhook] could not resolve order target", {
        sessionId: session.id,
        account: event.account ?? null,
        metadataStoreId: metadataStoreId ?? null,
        productId: productId ?? null,
      });

      // Real money has arrived and no Order can be written for it. Until
      // 2026-08-20 the console line above was the ONLY trace: the customer got
      // their receipt from Stripe, the owner saw nothing at all, and Stripe got
      // a 200 so it never retried.
      //
      // When the store resolved, the owner gets a durable, visible record. When
      // it did not, there is genuinely no store to attach one to — a session
      // from an account we cannot match to any connection — and the console
      // line is the honest limit of what can be recorded. Stated rather than
      // quietly accepted.
      if (storeId) {
        try {
          await recordExecution({
            executionId: randomUUID(),
            action: EXECUTION_ACTIONS.CHECKOUT_STRIPE_UNRECORDED,
            status: "FAILED",
            verified: false,
            message:
              `A payment completed in Stripe (session ${session.id}) but no order could be created — ` +
              `the checkout did not carry a product. Reconcile this in Stripe before assuming it is not a real sale.`,
            retryable: false,
            actorType: "USER",
            actorId: null,
            storeId,
            storeDraftId: null,
            schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
            timestamp: new Date(),
            metadata: { sessionId: session.id, amountTotal: session.amount_total ?? null },
          });
        } catch (error) {
          reportIssue("could not record an unmatched payment", error, {
            subsystem: "payments",
            stage: "stripe.unrecorded.persist",
            storeId,
            extra: { sessionId: session.id },
          });
        }
      }
    }

    if (storeId && productId) {
      // Scoped to the store this event was resolved to (2026-08-20). The
      // lookup used to be by bare id, so a session carrying another store's
      // productId would have put THAT store's product name on this order. The
      // order is still created when the product is missing — the money is real
      // whatever the catalogue says — it just records an honest "Unknown
      // product" rather than a name borrowed from somewhere else.
      const product = await prisma.product.findFirst({
        where: { id: productId, storeId },
      });

      // What the checkout recorded about the discount, if anything. Read here
      // rather than inside the transaction because the promotion lookup below
      // needs it.
      const discountFacts = parseDiscountMetadata(session.metadata);

      // AND THE SAME FOR THE PROMOTION (2026-08-26).
      //
      // Order.appliedPromotionId is a foreign key, so writing an id from
      // metadata unchecked is the defect immediately above with a new column:
      // a merchant who deletes a promotion between a customer paying and
      // Stripe delivering the event makes order.create violate the constraint,
      // and the ENTIRE order is lost — money taken, nothing recorded. Caught by
      // scripts/verify-promotions.ts before it could reach anyone.
      //
      // Scoped to this store for the second reason productId is: an id
      // arriving in metadata is not proof of ownership, and linking another
      // store's promotion would leak it into this order.
      //
      // Losing the link costs nothing that matters. The label, the code and
      // the amount are frozen copies written below and stand entirely on their
      // own — the order still says exactly what was taken off and why.
      const appliedPromotion = discountFacts.promotionId
        ? await prisma.promotion.findFirst({
            where: { id: discountFacts.promotionId, storeId },
            select: { id: true },
          })
        : null;

      // ============ A BAG, IF THIS CHECKOUT WAS ONE (2026-08-26) ============
      //
      // Absent for every single-product checkout, which is every order this
      // route has ever written — those keep the productId path below entirely
      // unchanged. Present only when the customer came from the bag.
      //
      // THREE TIERS, and the rule is that a payment ALWAYS becomes an order
      // while line items are NEVER guessed:
      //
      //   DRAFT     the frozen contract. Normal.
      //   PROVIDER  the draft is gone or expired, so Stripe's own line items
      //             are used — not a fabrication, it is what the customer was
      //             actually charged for.
      //   NONE      neither. The financial record is kept and nothing invented.
      const draftId = session.metadata?.checkoutDraftId;
      let bagLines: RecoveredLines | null = null;
      let bagMismatch: { draft: number; settled: number } | null = null;
      let writtenOrderId: string | null = null;

      if (draftId) {
        const draft = await loadDraft(storeId, draftId);
        if (draft) {
          bagLines = linesFromDraft(draft.lines);
          // Recorded, never reconciled. Silently trusting either number is how
          // a wrong charge becomes invisible.
          bagMismatch = draftTotalMismatch(draft.totalInCents, session.amount_total);
        } else {
          // Stripe keeps the line items it was asked to charge, so a lost draft
          // is recoverable. Not on the event — one retrieval, and only on this
          // path, so the normal path pays nothing for it.
          try {
            // ON THE CONNECTED ACCOUNT, not the platform. This session belongs
            // to the merchant's own Stripe account, and the module client above
            // holds the PLATFORM key — asking it for these line items finds
            // nothing, which would have silently demoted every recoverable
            // order to tier NONE without ever erroring in an obvious way.
            const items = await stripe.checkout.sessions.listLineItems(
              session.id,
              { limit: 100 },
              event.account ? { stripeAccount: event.account } : undefined
            );
            bagLines = linesFromStripe(items.data);
          } catch {
            bagLines = noLines("The checkout draft was unavailable and Stripe's line items could not be read.");
          }
        }
      }

      // Idempotent: Stripe can redeliver the same event more than once. An
      // existence check (rather than inferring "was this new" from upsert's
      // return value) inside the same transaction as the Order write means
      // the Order and its BusinessEvent commit together or not at all — see
      // PHASE1_DESIGN.md section 4. A retry that finds an existing Order is
      // a genuine no-op, exactly like the upsert this replaced.
      // Wrapped 2026-08-20, after reproducing the failure it existed to allow.
      //
      // A PLATFORM-key event takes storeId straight from metadata, unvalidated.
      // If the store was deleted between checkout and delivery, order.create
      // violates the foreign key and that threw straight out of POST — Next
      // answers 500, Stripe retries for days against something that can never
      // succeed, then gives up. A real payment, no order, and no record.
      //
      // The split below is the whole point. A PERMANENT failure must be
      // acknowledged, because retrying it is only a slower way to lose the same
      // sale. A TRANSIENT one must NOT be, because a retry is exactly what
      // recovers it.
      try {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.order.findUnique({
          where: { paymentProvider_externalOrderId: { paymentProvider: "STRIPE", externalOrderId: session.id } },
        });
        if (existing) return;

        // Null for every checkout that did not go through the shipping step,
        // which is most of them — the parser returns honest nulls rather than
        // defaults, so nothing below changes for those.
        const chosenShipping = parseCheckoutShipping(session.metadata);

        const order = await tx.order.create({
          data: {
            storeId,
            // Only linked when the product genuinely exists in THIS store.
            //
            // This said `productId` unconditionally, and the comment above
            // promised the order would still be created with "Unknown product"
            // when the catalogue had moved on. It could not: Order.productId is
            // a foreign key, so naming a product that had been deleted violated
            // it and the whole order was lost — money taken, nothing recorded.
            //
            // Found 2026-08-20 by the first end-to-end run of this branch
            // through a real server (scripts/verify-order-webhook-live.ts). The
            // column is nullable and the relation is onDelete: SetNull, so an
            // order without a product was always the intended shape; the write
            // simply never honoured it.
            // A BAG OVERRIDES THE SINGLE-PRODUCT FIELDS, and only then. For a
            // multi-product order there is no one product this order "was for",
            // so linking one of four would make every report reading it quietly
            // wrong — primaryProductId returns null unless there is exactly one.
            productId: bagLines ? primaryProductId(bagLines) : (product?.id ?? null),
            productName: bagLines ? primaryNameFor(bagLines) : (product?.name ?? "Unknown product"),
            quantity: bagLines ? totalQuantity(bagLines) : undefined,
            lineItemSource: bagLines?.source ?? undefined,
            checkoutDraftId: draftId ?? undefined,
            ...(bagLines && bagLines.lines.length > 0
              ? {
                  items: {
                    create: bagLines.lines.map((line) => ({
                      // Only linked when the product still exists in this store;
                      // the captured name is what keeps the line readable.
                      productId: line.productId,
                      productName: line.productName,
                      quantity: line.quantity,
                      unitPriceInCents: line.unitPriceInCents,
                      listInCents: line.listInCents,
                      discountInCents: line.discountInCents,
                      subtotalInCents: line.subtotalInCents,
                      promotionId: line.promotionId,
                      promotionLabel: line.promotionLabel,
                    })),
                  },
                }
              : {}),
            amountInCents: session.amount_total ?? 0,
            buyerEmail: session.customer_details?.email ?? "unknown",
            status: "paid",
            paymentProvider: "STRIPE",
            externalOrderId: session.id,
            // Real gap closed (2026-08-09) — the charge-level id, distinct
            // from externalOrderId (the checkout-level id above). A refund
            // webhook (charge.refunded) arrives keyed by payment_intent, not
            // by Checkout Session — without this, a refund has no way to
            // find its own Order. Not expanded on this session (no `expand`
            // was requested), so it's always the plain id string here.
            externalPaymentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
            // Real, verified against the installed Stripe SDK's own types
            // before writing this — this API version nests it under
            // collected_information, not directly on the session (an
            // older-version shape this codebase's training data would
            // have assumed instead — see AGENTS.md's warning about that).
            // Live shipping (2026-08-20). When the customer chose a shipping
            // service on the storefront, they typed their address there and
            // Stripe was never asked to collect it again — so it arrives in
            // metadata instead. Stripe's own collected_information remains the
            // source for every other checkout, unchanged.
            shippingAddress:
              (chosenShipping.address as object | null) ??
              fromStripeShippingDetails(session.collected_information?.shipping_details) ??
              undefined,
            // What the CUSTOMER paid to ship. Distinct from shippingCostInCents
            // (what the label later costs the owner) on purpose — see the
            // schema comment; the gap between them is the store's margin.
            // BOTH ADDRESSES. shippingAddress above is the one being shipped to
            // and is what the label will use; this is what the customer typed
            // before it was standardised, absent when nothing was changed.
            shippingAddressEntered: (chosenShipping.enteredAddress as object | null) ?? undefined,
            shippingAddressVerification: chosenShipping.addressVerification ?? undefined,
            shippingChargedInCents: chosenShipping.amountInCents ?? undefined,
            selectedShippingCarrier: chosenShipping.carrier ?? undefined,
            selectedShippingService: chosenShipping.service ?? undefined,
            selectedShippingRateId: chosenShipping.rateId ?? undefined,
            selectedShippingEstDays: chosenShipping.estimatedDays ?? undefined,
            // HOW THIS TOTAL WAS ARRIVED AT (2026-08-26).
            //
            // amountInCents above is unchanged and still Stripe's own settled
            // total. These say why it is what it is, which nothing could say
            // before: a discounted order looked exactly like a cheap one, and
            // profitability read the discount as thinner margin with nothing to
            // attribute it to.
            //
            // FROZEN, not looked up. The label and code are copied here rather
            // than read back through the relation, so this order stays true
            // after the merchant renames the sale, changes its percentage,
            // switches it off, or deletes it — the promotion may be gone, but
            // what this customer paid and why cannot change.
            listSubtotalInCents: discountFacts.listSubtotalInCents ?? undefined,
            discountInCents: discountFacts.discountInCents ?? undefined,
            // Only when the promotion genuinely still exists in THIS store —
            // see the lookup above. The three fields below are unconditional
            // because they are copies, not references.
            appliedPromotionId: appliedPromotion?.id ?? undefined,
            appliedPromotionLabel: discountFacts.promotionLabel ?? undefined,
            appliedPromotionCode: discountFacts.promotionCode ?? undefined,
            appliedPromotionKind: discountFacts.promotionKind ?? undefined,
          },
        });

        // THE DRAFT BECOMES AN ORDER, in the SAME transaction as the order
        // itself — so a draft can never read CONVERTED against an order that
        // did not commit, and a redelivered event finds the order already
        // there and returns before reaching this at all.
        //
        // Store-scoped and only from a draft that actually reached payment.
        if (draftId) {
          await tx.checkoutDraft.updateMany({
            where: { id: draftId, storeId, status: { in: ["OPEN", "PAYMENT_STARTED"] } },
            data: { status: "CONVERTED", orderId: order.id },
          });
        }
        // Carried out of the transaction so the two records below can be
        // written AFTER it commits — an execution row must never be able to
        // roll back a paid order.
        writtenOrderId = order.id;

        const transaction = mapOrdersToTransactions([order])[0];
        await writeBusinessEvents(tx, storeId, "internal", [
          {
            recordId: internalTransactionId(order.id),
            entityType: "transaction",
            eventType: "transaction.created",
            // Stripe's own session currency, which is what the customer was
            // actually charged — not what this store is configured to charge.
            // This line is read back to the owner in their activity feed, so a
            // figure carrying the wrong symbol is a claim about which money
            // came in.
            summary: `Sale: ${order.productName} (${formatMoney(order.amountInCents, session.currency ?? "USD")})`,
            data: transaction.data,
          },
        ]);
      });

      // ============ WHAT MUST BE SEEN, NOT MERELY STORED ==================
      //
      // Written after the transaction commits, deliberately: neither of these
      // may ever be the reason a paid order rolls back.
      if (writtenOrderId && bagLines?.source === "NONE") {
        // An order whose contents could not be established is a real thing the
        // owner has to reconcile against their Stripe dashboard. A column
        // nobody looks at would not tell them.
        await recordCheckoutProblem(storeId, {
          message:
            `Order ${writtenOrderId} was paid for but its contents could not be established. ` +
            `${bagLines.note ?? ""} Reconcile it against Stripe session ${session.id}.`,
          metadata: { orderId: writtenOrderId, sessionId: session.id, draftId: draftId ?? null },
        });
      }
      if (writtenOrderId && bagMismatch) {
        // NEVER RECONCILED SILENTLY. Recording it is the only way a wrong
        // charge is ever found.
        await recordCheckoutProblem(storeId, {
          message:
            `Order ${writtenOrderId}: the draft quoted ${bagMismatch.draft} but Stripe settled ` +
            `${bagMismatch.settled}. The order records what was settled.`,
          metadata: { orderId: writtenOrderId, ...bagMismatch },
        });
      }
      } catch (error) {
        // See lib/orders/orderFailure.ts for why the two are told apart.
        const permanent = isPermanentOrderFailure(error);

        reportIssue(
          permanent
            ? `a payment could not become an order and never will (${String((error as { code?: unknown }).code)})`
            : "a payment could not become an order",
          error,
          {
            subsystem: "payments",
            stage: permanent ? "stripe.order.permanent" : "stripe.order.transient",
            storeId,
            extra: { sessionId: session.id, amountTotal: session.amount_total ?? null },
          }
        );

        if (!permanent) {
          // Rethrow so Next answers 500 and Stripe retries — which is the
          // behaviour that actually recovers a transient database failure.
          throw error;
        }
        return new Response("OK", { status: 200 });
      }

      // Phase 4 — a completed order is exactly a "business state may have
      // just changed" moment (e.g. inventory heading toward a stockout).
      // Scheduled via after() so Stripe still gets its expected fast ack.
      // Phase 5's measurement sweep rides the same trigger — deterministic,
      // zero AI cost, a no-op unless a past approval's window has elapsed.
      after(async () => {
        // The customer confirmation runs HERE, and the placement is the point.
        //
        // after() fires once the response is sent, which is strictly after the
        // transaction above has committed — so a rolled-back order can never be
        // confirmed. Putting the send inside the transaction would risk the
        // opposite: an email about an order that then failed to commit.
        //
        // Its own idempotency claim means a redelivered event does not email the
        // customer twice, even though after() runs on every delivery.
        //
        // Awaited before the sweeps rather than raced with them, so a slow
        // intelligence pass cannot delay the one thing the customer is waiting
        // for. It never throws — see sendOrderConfirmation.
        const created = await prisma.order.findUnique({
          where: { paymentProvider_externalOrderId: { paymentProvider: "STRIPE", externalOrderId: session.id } },
          select: { id: true },
        });
        if (created) {
          await sendOrderConfirmation({ orderId: created.id, storeId });
          // And the OWNER (2026-08-22, P1.8). Its own claim column means a
          // redelivered event does not tell them twice, and it never throws.
          //
          // After the customer's, deliberately: if only one of the two can get
          // through, the person who has just parted with money is the one who
          // must hear something. The owner is told by the dashboard either way;
          // the customer has nothing else.
          await notifyOwnerOfSale({ orderId: created.id, storeId });
        }

        await Promise.all([
          runDeterministicObservationSweep(storeId),
          measureDueMeasurements(storeId),
        ]).catch(() => {});
      });
    }
  }

  // Real gap closed (2026-08-09) — refunds previously had no code path at
  // all: an owner refunding a customer directly in their own Stripe
  // Dashboard left Genesis's own Order.status stuck on "paid" forever, even
  // though the UI already had a "Refunded" label ready and
  // internalMapper.ts already reads order.status === "refunded" for
  // reporting. This is the writer that label/read path was always missing.
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
    // Only a genuinely full refund flips status — a partial refund doesn't
    // change what the owner still needs to fulfill/ship, and silently
    // relabeling a still-substantially-paid order "refunded" would mislead
    // the owner. Partial refunds are a real, named gap (not reflected in
    // Order.status at all yet), not a silent oversight.
    const isFullRefund = charge.amount_refunded >= charge.amount;
    if (paymentIntentId && isFullRefund) {
      // Fetch-then-scope, the same confirmed-safe pattern used elsewhere in
      // this codebase (lib/tenantIsolation.ts): a bare single-record lookup
      // (findFirst) is allowed unscoped, but the actual mutation must carry
      // a real storeId in its own where clause — the refund event itself
      // only gives us a payment_intent id, so the store has to be resolved
      // first before the update can satisfy that guard.
      const target = await prisma.order.findFirst({
        where: { paymentProvider: "STRIPE", externalPaymentId: paymentIntentId },
        select: { id: true, storeId: true, status: true },
      });
      if (target && target.status !== "refunded") {
        await prisma.order.update({
          where: { id: target.id, storeId: target.storeId },
          data: { status: "refunded" },
        });
      }
    }
  }

  return new Response("OK", { status: 200 });
}
