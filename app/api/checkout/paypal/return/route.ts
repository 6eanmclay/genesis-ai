import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPaypalAccessToken, paypalApiBase, type PaypalCredentials } from "@/lib/integrations/paypal";
import { decryptCredentials } from "@/lib/integrations/credentials";
import { recordExecution } from "@/lib/execution/log";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// The buyer lands here after approving on PayPal's site. No webhook for
// PH-06's MVP (see ARCHITECTURE.md) — capture happens synchronously right
// here, which is actually the authoritative payment-completion signal for
// this flow, not a workaround.
export async function GET(request: NextRequest) {
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
  const storeUrl = new URL(`/store/${slug}`, request.url);

  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
  });
  const credentials = integration?.credentials
    ? decryptCredentials<PaypalCredentials>(integration.credentials)
    : null;
  if (!credentials) {
    console.error(`[paypal/return] no credentials for store ${store.id}`);
    return NextResponse.redirect(storeUrl);
  }

  const accessToken = await getPaypalAccessToken(
    credentials.clientId,
    credentials.clientSecret,
    credentials.environment
  );
  const base = paypalApiBase(credentials.environment);

  const captureRes = await fetch(`${base}/v2/checkout/orders/${token}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });

  let orderData: {
    purchase_units?: {
      custom_id?: string;
      amount?: { value?: string };
      payments?: { captures?: { custom_id?: string; amount?: { value?: string } }[] };
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
      console.error(`[paypal/return] capture failed for order ${token}:`, JSON.stringify(errorBody));
      return NextResponse.redirect(storeUrl);
    }
    const orderRes = await fetch(`${base}/v2/checkout/orders/${token}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!orderRes.ok) {
      console.error(`[paypal/return] re-fetch of already-captured order ${token} failed: ${orderRes.status}`);
      return NextResponse.redirect(storeUrl);
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
    return NextResponse.redirect(storeUrl);
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

    const order = await prisma.order.upsert({
      where: { paymentProvider_externalOrderId: { paymentProvider: "PAYPAL", externalOrderId: token } },
      create: {
        storeId: store.id,
        productId,
        productName: product?.name ?? "Unknown product",
        amountInCents,
        buyerEmail,
        status: "paid",
        paymentProvider: "PAYPAL",
        externalOrderId: token,
      },
      update: {},
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
