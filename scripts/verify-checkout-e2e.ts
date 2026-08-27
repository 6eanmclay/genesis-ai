import Stripe from "stripe";
import { startTestServer } from "@/scripts/lib/testServer";

// THE WHOLE CHAIN, ON ONE ORDER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-checkout-e2e.ts" -OutFile out.txt
//
//   bag → discounted total → checkout draft → available payment methods
//       → payment → webhook → order record
//
// Every step is proven against a REAL Postgres, using the REAL functions, and
// the payment step POSTs a genuinely Stripe-signed event to a REAL Next server
// over HTTP — exactly as Stripe would. No Stripe account is needed for that:
// constructEvent verifies an HMAC against the secret, and both sides of it are
// ours in a test.
//
// IT NEEDS THE SERVER, and that is not incidental. Calling the route handler
// as a function gets as far as Next's `after()`, which throws outside a
// request scope — so a suite that skipped the server would have proven the
// handler up to the point where it schedules its follow-up work and no
// further. That is why this brings its own, like verify-order-webhook-live.
//
// ============ WHY IT IS ONE SUITE AND NOT SEVEN ==========================
//
// Each link is already covered somewhere: pricing in verify-pricing-lines, the
// bag in verify-bag, the draft in verify-bag-checkout, the guards in
// verify-checkout-live. What NONE of them covers is that the links hold
// together — that the total the bag showed is the total the draft froze, is
// the total Stripe was asked for, is the total the order recorded. That is the
// property a customer actually experiences, and it is the one that breaks when
// two correct halves disagree.
//
// WHAT IS NOT PROVEN HERE, and cannot be without external credentials: the
// Stripe API call that creates a session, and PayPal's order API. Both are
// external blockers, named rather than quietly skipped.

let failures = 0;
let passes = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ============ THE ORDER THIS SUITE IS ABOUT ==============================
//
// Two of a $32.32 item at 26% off comes to $47.83, and that figure is the
// point rather than an example.
//
// $47.83 is what the discount does to the LINE, and $47.84 is what it does to
// each UNIT before multiplying. Both are defensible arithmetic; only one is
// what Genesis charges, and Sean confirmed the live figure is $47.83. Pinning
// the number here means a future "tidy-up" that moves the rounding inside the
// multiplication fails loudly instead of shifting a cent on every multi-unit
// order in the shop.
const UNIT_IN_CENTS = 3232;
const QUANTITY = 2;
const PERCENT_OFF = 26;
const LIST_TOTAL = 6464;
const EXPECTED_TOTAL = 4783;
const PER_UNIT_ROUNDING_WOULD_GIVE = 4784;

/** The secret scripts/lib/testServer.ts starts the server with. */
const WEBHOOK_SECRET = "whsec_harness_merchant";

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;

  process.env.DATABASE_URL = server.db.url;

  const { resolveBag } = await import("@/lib/bag/resolveBag");
  const { createCheckoutDraft, freezeLines, loadDraft } = await import("@/lib/bag/checkoutDraft");
  const { toStripeLineItems } = await import("@/lib/bag/providerLines");
  const { availableProviders, chooseProvider } = await import("@/lib/payments/router");

  // ---------------------------------------------------------------------
  console.log("\n1. A bag with a real product and a real promotion");
  const user = await prisma.user.create({ data: { email: `e2e-${Date.now()}@example.test` } });
  const store = await prisma.store.create({
    data: {
      userId: user.id,
      name: "Cubit & Coil",
      slug: `e2e-${Date.now()}`,
      tagline: "t",
      description: "d",
      currency: "USD",
    },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: "Copper tensor ring",
      description: "Hand-wound",
      priceInCents: UNIT_IN_CENTS,
      imageUrl: "https://images.example.test/ring.png",
    },
  });
  const promotion = await prisma.promotion.create({
    data: {
      storeId: store.id,
      name: `${PERCENT_OFF}% off`,
      kind: "SALE",
      discountType: "PERCENTAGE",
      percentOff: PERCENT_OFF,
      scope: "SELECTED_PRODUCTS",
      active: true,
    },
  });
  await prisma.promotionProduct.create({
    data: { promotionId: promotion.id, productId: product.id },
  });

  const resolved = await resolveBag({
    storeId: store.id,
    // The cookie shape: p is the product id, q the quantity.
    bag: { items: [{ p: product.id, q: QUANTITY }], code: null },
  });

  check("the bag has the line", resolved.lines.length, 1);
  check("with the product's image", resolved.lines[0].imageUrl, "https://images.example.test/ring.png");
  check("the list price before the sale", resolved.pricing.listSubtotalInCents, LIST_TOTAL);

  // ---------------------------------------------------------------------
  console.log("\n2. The discounted total — $47.83, and why not $47.84");
  check("the sale is applied", resolved.pricing.discountInCents, LIST_TOTAL - EXPECTED_TOTAL);
  check("the total is $47.83", resolved.pricing.totalInCents, EXPECTED_TOTAL);
  // THE ASSERTION THAT PROTECTS THE CENT. Rounding each unit and then
  // multiplying gives 4784 for this order. It is a plausible refactor and it
  // would change what every multi-unit order in the shop is charged.
  assert(
    "and NOT $47.84, which is what per-unit rounding would give",
    resolved.pricing.totalInCents !== PER_UNIT_ROUNDING_WOULD_GIVE,
    `discounting the line gives ${EXPECTED_TOTAL}; discounting each unit first gives ${PER_UNIT_ROUNDING_WOULD_GIVE}`,
  );

  // ---------------------------------------------------------------------
  console.log("\n3. The draft freezes exactly what the bag showed");
  const draftId = await createCheckoutDraft({
    storeId: store.id,
    lines: resolved.lines,
    pricing: resolved.pricing,
  });
  const lines = freezeLines(resolved.lines, resolved.pricing);

  check("the frozen line carries the image", lines[0].imageUrl, "https://images.example.test/ring.png");
  check("and the quantity", lines[0].quantity, QUANTITY);
  check("and the discounted line total", lines[0].subtotalInCents, EXPECTED_TOTAL);

  const draft = await loadDraft(store.id, draftId);
  assert("the draft is readable", draft !== null);
  check("and stored the same total", draft?.totalInCents, EXPECTED_TOTAL);
  // A DRAFT BELONGS TO ONE STORE. Reading it as another must find nothing,
  // or a neighbouring shop could resurrect somebody else's order.
  const otherStore = await prisma.store.create({
    data: { userId: user.id, name: "Other", slug: `other-${Date.now()}`, tagline: "t", description: "d" },
  });
  check("and is invisible to another store", await loadDraft(otherStore.id, draftId), null);

  // ---------------------------------------------------------------------
  console.log("\n4. What Stripe is asked to charge is what the bag promised");
  const stripeLines = toStripeLineItems(lines, store.currency);
  const stripeTotal = stripeLines.reduce(
    (sum, item) => sum + item.price_data.unit_amount * item.quantity,
    0,
  );
  // A CENT OF DRIFT IS A WRONG CHARGE. Stripe sums these and bills that.
  check("Stripe's line items sum to the promised total", stripeTotal, EXPECTED_TOTAL);
  // THE FIX SEAN ASKED FOR: the picture of the thing being bought reaches
  // Stripe's hosted page, so its order summary is not a name and a number.
  check("and the product image travels with them",
    stripeLines[0].price_data.product_data.images, ["https://images.example.test/ring.png"]);
  assert("named with the sale, so the lower price has a reason",
    stripeLines[0].price_data.product_data.name.includes(`${PERCENT_OFF}%`),
    stripeLines[0].price_data.product_data.name);

  // ---------------------------------------------------------------------
  console.log("\n5. Which payment methods the customer is actually offered");
  // ============ THE BUG THIS SECTION EXISTS FOR ========================
  // selectProvider preferred Stripe and returned ONE provider, so a store
  // with PayPal connected had a rail no customer could ever reach.
  check("nothing connected offers nothing", await availableProviders(store.id), []);

  await prisma.storeIntegration.create({
    data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_1" },
  });
  check("Stripe alone offers Stripe", await availableProviders(store.id), ["STRIPE"]);

  await prisma.storeIntegration.create({
    data: { storeId: store.id, provider: "PAYPAL", status: "CONNECTED", externalAccountId: "pp_1" },
  });
  const both = await availableProviders(store.id);
  check("both connected offers BOTH", both, ["STRIPE", "PAYPAL"]);

  // The customer can now actually pick PayPal, which is the whole fix.
  check("and a customer choosing PayPal gets PayPal", chooseProvider(both, "PAYPAL"), "PAYPAL");
  check("choosing Card gets Stripe", chooseProvider(both, "STRIPE"), "STRIPE");
  check("choosing nothing gets the default", chooseProvider(both, null), "STRIPE");
  // A FORM FIELD COMES FROM THE BROWSER. A provider that is not connected must
  // not fail the sale mid-purchase; it falls back to one that works.
  check("a provider that isn't connected falls back", chooseProvider(["STRIPE"], "PAYPAL"), "STRIPE");
  check("and so does nonsense", chooseProvider(both, "bitcoin"), "STRIPE");

  // A DISCONNECTED ROW IS NOT AN OFFER.
  await prisma.storeIntegration.updateMany({
    where: { storeId: store.id, provider: "PAYPAL" },
    data: { status: "DISCONNECTED" },
  });
  check("disconnecting PayPal stops offering it", await availableProviders(store.id), ["STRIPE"]);
  await prisma.storeIntegration.updateMany({
    where: { storeId: store.id, provider: "PAYPAL" },
    data: { status: "CONNECTED" },
  });

  // ---------------------------------------------------------------------
  console.log("\n6. A successful payment becomes an order");
  const stripe = new Stripe("sk_test_unused_for_signature_generation");
  const webhookUrl = `${server.baseUrl}/api/webhooks/stripe`;

  /** Post a genuinely Stripe-signed event over HTTP, exactly as Stripe would. */
  const postEvent = (payload: string, signature: string) =>
    fetch(webhookUrl, {
      method: "POST",
      headers: { "stripe-signature": signature, "content-type": "application/json" },
      body: payload,
    });

  const sessionId = `cs_test_${Date.now()}`;
  const payload = JSON.stringify({
    id: `evt_${Date.now()}`,
    object: "event",
    // A CONNECTED-ACCOUNT DELIVERY, which is what a real storefront charge is.
    // event.account is set by Stripe rather than by the merchant, so the route
    // trusts it to decide which store this belongs to.
    account: "acct_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout_session",
        amount_total: EXPECTED_TOTAL,
        currency: "usd",
        customer_details: { email: "buyer@example.test" },
        // THE DRAFT ID TRAVELS IN METADATA, which is how the order is rebuilt
        // with the lines the customer actually agreed to.
        // EXACTLY WHAT createStripeBagSession SENDS: the store, and which
        // draft. No productId -- a bag has no single product.
        metadata: {
          storeId: store.id,
          checkoutDraftId: draftId,
        },
        payment_status: "paid",
      },
    },
  });

  // A REAL SIGNATURE. constructEvent runs for true — this does not bypass it.
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const response = await postEvent(payload, signature);
  check("the webhook accepts a correctly signed delivery", response.status, 200);

  // AND REFUSES A FORGED ONE. Without this, the assertion above proves only
  // that the handler runs, not that it checks anything.
  const forged = await postEvent(payload, "t=1,v1=deadbeef");
  check("and refuses a forged one", forged.status, 400);

  // ---------------------------------------------------------------------
  console.log("\n7. The order record, against the right store");
  const orders = await prisma.order.findMany({ where: { storeId: store.id } });
  check("exactly one order exists", orders.length, 1);
  // GUARDED, so a failure above reports the rest instead of taking the suite
  // down with it. A run that stops at its first disagreement hides every
  // assertion after it -- which is exactly when the extra detail is worth most.
  const order = orders[0];
  if (!order) {
    console.error("      no order to inspect - skipping the record assertions");
  } else {
  check("belonging to this store", order.storeId, store.id);
  check("for the amount the customer approved", order.amountInCents, EXPECTED_TOTAL);
  check("paid through Stripe", order.paymentProvider, "STRIPE");
  check("carrying the buyer", order.buyerEmail, "buyer@example.test");
  check("marked paid", order.status, "paid");
  check("and linked to the session", order.externalOrderId, sessionId);
  }

  // NOT THE NEIGHBOUR'S. Tenant isolation is the thing that turns a wrong
  // order into somebody else's money.
  check("the other store got nothing", (await prisma.order.findMany({ where: { storeId: otherStore.id } })).length, 0);

  // A REPLAYED DELIVERY IS NOT A SECOND SALE. Stripe retries, so this is a
  // real event rather than a hypothetical one.
  const replay = await postEvent(payload, signature);
  assert("a replayed webhook is accepted", replay.status === 200, `got ${replay.status}`);
  check("and creates no second order", (await prisma.order.findMany({ where: { storeId: store.id } })).length, 1);

  await server.close();

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log(
      "\nNOT verified here (needs external credentials): the Stripe API call that\n" +
        "creates a session, and PayPal's order API. Both are external blockers.\n",
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
