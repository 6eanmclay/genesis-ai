import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPaypalAccessToken, paypalApiBase, type PaypalCredentials } from "@/lib/integrations/paypal";
import { decryptCredentials } from "@/lib/integrations/credentials";
import { recordExecution } from "@/lib/execution/log";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { writeBusinessEvents } from "@/lib/intelligence/businessEvents";
import { mapOrdersToTransactions, internalTransactionId } from "@/lib/businessModel/internalMapper";
import { fromPaypalShipping } from "@/lib/orders/shippingAddress";
import type { CheckoutProblem } from "@/lib/orders/checkoutOutcome";

/**
 * A durable, owner-visible record that money moved and Genesis could not finish
 * the order. Every caller is a path where PayPal has taken (or may have taken)
 * a real payment — without this the only trace was a console line nobody reads.
 */
async function recordCaptureProblem(storeId: string, token: string, reason: string): Promise<void> {
  try {
    await recordExecution({
      executionId: randomUUID(),
      action: EXECUTION_ACTIONS.CHECKOUT_PAYPAL_CAPTURE,
      status: "FAILED",
      verified: false,
      message: `PayPal order ${token}: ${reason}. Reconcile this in PayPal before assuming it is not a real sale.`,
      retryable: true,
      actorType: "USER",
      actorId: null,
      storeId,
      storeDraftId: null,
      schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
      timestamp: new Date(),
      metadata: { token, reason },
    });
  } catch (error) {
    // The redirect matters more than the record; never turn a logging failure
    // into a crash screen for someone who has just paid.
    console.error(`[paypal/return] could not record capture problem for ${token}:`, error);
  }
}

// The buyer lands here after approving on PayPal's site. No webhook for
// PH-06's MVP (see ARCHITECTURE.md) — capture happens synchronously right
// here, which is actually the authoritative payment-completion signal for
// this flow, not a workaround.
export async function GET(request: NextRequest) {
  // Every unhappy exit below used to be a bare redirect to the shop's front
  // page — no message, no reference, nothing. A person who had just approved a
  // payment on PayPal's site was left to guess whether they had been charged.
  // Now each one says which of the two situations they are actually in, and
  // carries the PayPal order id so a human can reconcile it. See
  // lib/orders/checkoutOutcome.ts.
  const problemUrl = (slug: string, problem: CheckoutProblem, reference: string | null) => {
    const url = new URL(`/store/${slug}`, request.url);
    url.searchParams.set("checkout_problem", problem);
    if (reference) url.searchParams.set("ref", reference);
    return url;
  };
  const searchParams = request.nextUrl.searchParams;
  const token = searchParams.get("token"); // PayPal order id
  const slug = searchParams.get("slug");

  if (!token || !slug) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
  });
  const credentials = integration?.credentials
    ? decryptCredentials<PaypalCredentials>(integration.credentials)
    : null;
  if (!credentials) {
    console.error(`[paypal/return] no credentials for store ${store.id}`);
    // Nothing was captured — the approval expires at PayPal on its own.
    return NextResponse.redirect(problemUrl(slug, "payment_not_completed", token));
  }

  // Unguarded before this: a PayPal auth failure threw out of the route and a
  // buyer mid-checkout got a crash screen.
  let accessToken: string;
  try {
    accessToken = await getPaypalAccessToken(
      credentials.clientId,
      credentials.clientSecret,
      credentials.environment
    );
  } catch (error) {
    console.error(`[paypal/return] could not authenticate with PayPal for store ${store.id}:`, error);
    return NextResponse.redirect(problemUrl(slug, "payment_not_completed", token));
  }
  const base = paypalApiBase(credentials.environment);

  let captureRes: Response;
  try {
    captureRes = await fetch(`${base}/v2/checkout/orders/${token}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
  } catch (error) {
    // The request never completed, so whether PayPal captured is genuinely
    // unknown. "Don't pay again" is the only safe thing to say.
    console.error(`[paypal/return] capture request failed to complete for order ${token}:`, error);
    await recordCaptureProblem(store.id, token, "capture request did not complete — capture state unknown");
    return NextResponse.redirect(problemUrl(slug, "payment_taken_unconfirmed", token));
  }

  let orderData: {
    purchase_units?: {
      custom_id?: string;
      amount?: { value?: string };
      payments?: { captures?: { custom_id?: string; amount?: { value?: string } }[] };
      shipping?: {
        name?: { full_name?: string | null } | null;
        address?: {
          address_line_1?: string | null;
          address_line_2?: string | null;
          admin_area_2?: string | null;
          admin_area_1?: string | null;
          postal_code?: string | null;
          country_code?: string | null;
        } | null;
      };
    }[];
    payer?: { email_address?: string };
  };

  if (captureRes.ok) {
    orderData = await captureRes.json();
  } else {
    // A double-hit on this route (back button, reload) re-attempts capture
    // on an already-captured order — PayPal returns 422
    // ORDER_ALREADY_CAPTURED. Treat that as success and re-fetch the order
    // for its details, same idempotency posture as the Stripe webhook's
    // no-op upsert on redelivery.
    const errorBody = await captureRes.json().catch(() => ({}));
    const alreadyCaptured = (errorBody?.details as { issue?: string }[] | undefined)?.some(
      (d) => d.issue === "ORDER_ALREADY_CAPTURED"
    );
    if (!alreadyCaptured) {
      // Deliberately not logging errorBody wholesale — see
      // lib/integrations/providerError.ts for why provider bodies do not get
      // pasted into durable records.
      console.error(`[paypal/return] capture failed for order ${token} (${captureRes.status})`);
      return NextResponse.redirect(problemUrl(slug, "payment_not_completed", token));
    }
    const orderRes = await fetch(`${base}/v2/checkout/orders/${token}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!orderRes.ok) {
      console.error(`[paypal/return] re-fetch of already-captured order ${token} failed: ${orderRes.status}`);
      // The money HAS moved — ORDER_ALREADY_CAPTURED is how we got here.
      await recordCaptureProblem(store.id, token, `captured, but re-fetch failed (${orderRes.status})`);
      return NextResponse.redirect(problemUrl(slug, "payment_taken_unconfirmed", token));
    }
    orderData = await orderRes.json();
  }

  const purchaseUnit = orderData.purchase_units?.[0];
  // PayPal's GET /v2/checkout/orders/{id} response for an already-captured
  // order nests custom_id inside payments.captures[0], not duplicated at
  // the purchase_unit level the way the initial capture response has it —
  // check the capture-level one first, fall back to the top-level one.
  const customId = purchaseUnit?.payments?.captures?.[0]?.custom_id ?? purchaseUnit?.custom_id;
  const [customStoreId, productId] = customId?.split(":") ?? [];
  if (!productId || customStoreId !== store.id) {
    console.error(
      `[paypal/return] custom_id mismatch for order ${token}: got "${customId}", expected store ${store.id}`
    );
    // Capture already succeeded by this point, so real money moved and no
    // Order can be written for it. This left no trace anywhere before — not
    // for the buyer, and not for the owner either.
    await recordCaptureProblem(store.id, token, `captured, but custom_id did not match this store`);
    return NextResponse.redirect(problemUrl(slug, "payment_taken_unconfirmed", token));
  }

  const amountValue =
    purchaseUnit?.payments?.captures?.[0]?.amount?.value ?? purchaseUnit?.amount?.value ?? "0";
  const amountInCents = Math.round(parseFloat(amountValue) * 100);
  const buyerEmail = orderData.payer?.email_address ?? "unknown";

  // Real money has now moved (capture succeeded, custom_id matched this
  // store). Everything from here on (product lookup, Order.upsert) is a
  // separate DB step that could throw — without this durable marker, a
  // transient failure here would strand a real captured payment with zero
  // trace anywhere (no webhook exists for PayPal to backstop it — see this
  // route's own top-of-file comment). Written directly via recordExecution,
  // same pattern already used in app/api/integrations/[provider]/callback
  // and lib/execution/genesis.ts's recordGenesisExecution.
  const executionId = randomUUID();
  await recordExecution({
    executionId,
    action: EXECUTION_ACTIONS.CHECKOUT_PAYPAL_CAPTURE,
    status: "PENDING",
    verified: false,
    message: `PayPal capture succeeded for order ${token}, finishing order creation`,
    retryable: false,
    actorType: "USER",
    actorId: null,
    storeId: store.id,
    storeDraftId: null,
    schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
    timestamp: new Date(),
    metadata: { token, productId, amountInCents },
  });

  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });

    // Same existence-check-inside-a-transaction pattern as the Stripe
    // webhook handler — see PHASE1_DESIGN.md section 4-5. A double-hit on
    // this route (already handled above for the capture call itself) would
    // otherwise risk a duplicate transaction.created event for one real sale.
    const order = await prisma.$transaction(async (tx) => {
      const existing = await tx.order.findUnique({
        where: { paymentProvider_externalOrderId: { paymentProvider: "PAYPAL", externalOrderId: token } },
      });
      if (existing) return existing;

      const created = await tx.order.create({
        data: {
          storeId: store.id,
          productId,
          productName: product?.name ?? "Unknown product",
          amountInCents,
          buyerEmail,
          status: "paid",
          paymentProvider: "PAYPAL",
          externalOrderId: token,
          shippingAddress: fromPaypalShipping(purchaseUnit?.shipping) ?? undefined,
        },
      });

      const transaction = mapOrdersToTransactions([created])[0];
      await writeBusinessEvents(tx, store.id, "internal", [
        {
          recordId: internalTransactionId(created.id),
          entityType: "transaction",
          eventType: "transaction.created",
          summary: `Sale: ${created.productName} ($${(created.amountInCents / 100).toFixed(2)})`,
          data: transaction.data,
        },
      ]);

      return created;
    });

    return NextResponse.redirect(new URL(`/store/${slug}/success?order_id=${order.id}`, request.url));
  } catch (error) {
    console.error(`[paypal/return] order creation failed after real capture for order ${token}:`, error);
    await recordExecution({
      executionId,
      action: EXECUTION_ACTIONS.CHECKOUT_PAYPAL_CAPTURE,
      status: "FAILED",
      verified: false,
      message: error instanceof Error ? error.message : "Order creation failed after capture",
      retryable: true,
      actorType: "USER",
      actorId: null,
      storeId: store.id,
      storeDraftId: null,
      schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
      timestamp: new Date(),
      metadata: { token, productId, amountInCents },
    });
    // The payment is real and already captured — never show a crash screen
    // for this. Redirect to a calm, honest reassurance instead, with the
    // PayPal order token as the reference an admin can reconcile against.
    return NextResponse.redirect(
      new URL(`/store/${slug}?payment_pending=1&ref=${token}`, request.url)
    );
  }
}
