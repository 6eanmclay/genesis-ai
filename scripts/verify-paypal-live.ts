import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// The PayPal payment rail, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-paypal-live.ts" -OutFile out.txt
//
// VISION.md's own P0.3: "PayPal as the second payment rail, via the existing
// integration architecture, SAME LIFECYCLE GUARANTEES AS STRIPE." Stripe's rail
// has now been audited to that standard (COMPLIANCE.md §34, §37, §40); this is
// the same standard applied to the rail beside it, which has never had it.
//
// The REAL route handler runs, against a real Postgres. Only PayPal's own HTTP
// responses are supplied here — that is the externally blocked boundary (no
// PayPal sandbox credential exists), and it is the ONLY thing substituted. The
// capture decision, the store/product resolution, the transaction, the order,
// the business event and the confirmation claim are all the production code.
//
// This route matters more than a webhook does, because there is no webhook
// behind it. When it fails after a capture, real money has already moved and
// nothing else will ever come along to finish the job.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

// --- PayPal, as far as this environment can honestly go ---------------------

interface CaptureScript {
  /** What POST /v2/checkout/orders/{id}/capture answers. */
  capture: { status: number; body: unknown };
  /** What GET /v2/checkout/orders/{id} answers, on the already-captured path. */
  get?: { status: number; body: unknown };
  tokenExchange?: { status: number; body: unknown };
}

const paypalCalls: string[] = [];
let script: CaptureScript;

function paypalOrderBody(opts: {
  customId: string;
  amount?: string;
  captureId?: string;
  payerEmail?: string | null;
  withShipping?: boolean;
}) {
  return {
    id: "PAYPAL-ORDER",
    status: "COMPLETED",
    payer: opts.payerEmail === null ? {} : { email_address: opts.payerEmail ?? "buyer@example.test" },
    purchase_units: [
      {
        reference_id: "default",
        custom_id: opts.customId,
        amount: { currency_code: "USD", value: opts.amount ?? "25.00" },
        ...(opts.withShipping === false
          ? {}
          : {
              shipping: {
                name: { full_name: "Sarah Buyer" },
                address: {
                  address_line_1: "12 Kiln Lane",
                  admin_area_2: "Portland",
                  admin_area_1: "OR",
                  postal_code: "97201",
                  country_code: "US",
                },
              },
            }),
        payments: {
          captures: [
            {
              id: opts.captureId ?? "CAPTURE-1",
              status: "COMPLETED",
              custom_id: opts.customId,
              amount: { currency_code: "USD", value: opts.amount ?? "25.00" },
            },
          ],
        },
      },
    ],
  };
}

function installPaypalStub() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/v1/oauth2/token")) {
      paypalCalls.push("token");
      const t = script.tokenExchange ?? { status: 200, body: { access_token: "A-TOKEN" } };
      return new Response(JSON.stringify(t.body), {
        status: t.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v2/checkout/orders/") && url.endsWith("/capture") && method === "POST") {
      paypalCalls.push("capture");
      return new Response(JSON.stringify(script.capture.body), {
        status: script.capture.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v2/checkout/orders/")) {
      paypalCalls.push("get-order");
      const g = script.get ?? { status: 404, body: {} };
      return new Response(JSON.stringify(g.body), {
        status: g.status,
        headers: { "content-type": "application/json" },
      });
    }
    return real(input as never, init);
  }) as typeof fetch;
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  // A real key, so the credentials the route decrypts are genuinely encrypted
  // ones — the encryption itself is proven in verify-credential-encryption.
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  installPaypalStub();

  const { NextRequest } = await import("next/server");
  const { GET } = await import("@/app/api/checkout/paypal/return/route");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { encryptCredentials } = await import("@/lib/integrations/credentials");

  const call = async (token: string | null, slug: string | null) => {
    paypalCalls.length = 0;
    const url = new URL("https://shop.example.test/api/checkout/paypal/return");
    if (token !== null) url.searchParams.set("token", token);
    if (slug !== null) url.searchParams.set("slug", slug);
    const res = await GET(new NextRequest(url));
    return { status: res.status, location: res.headers.get("location") ?? "" };
  };

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  async function makeStore(slug: string, opts: { connected?: boolean } = {}) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: `${slug} shop`, slug, tagline: "t", description: "d", published: true },
    });
    if (opts.connected !== false) {
      await prisma.storeIntegration.create({
        data: {
          storeId: store.id,
          provider: "PAYPAL",
          status: "CONNECTED",
          externalAccountId: `client_${slug}`,
          credentials: encryptCredentials({
            schemaVersion: 1,
            clientId: `client_${slug}`,
            clientSecret: "secret",
            environment: "sandbox",
          }),
        },
      });
    }
    const product = await prisma.product.create({
      data: { storeId: store.id, name: `${slug} candle`, description: "d", priceInCents: 2500, active: true },
    });
    return { store, product };
  }

  const ordersFor = (storeId: string) => prisma.order.findMany({ where: { storeId } });
  const problemsFor = (storeId: string) =>
    prisma.executionLog.findMany({ where: { storeId, action: "checkout.paypal.capture", status: "FAILED" } });

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. A real capture becomes a real order");
    {
      await reset();
      const { store, product } = await makeStore("happy");
      script = { capture: { status: 201, body: paypalOrderBody({ customId: `${store.id}:${product.id}` }) } };

      const res = await call("PP-1", store.slug);
      const orders = await ordersFor(store.id);
      check("exactly one order", orders.length, 1);
      check("paid", orders[0]?.status, "paid");
      check("for the right amount", orders[0]?.amountInCents, 2500);
      check("linked to the product", orders[0]?.productId, product.id);
      check("with the product's real name", orders[0]?.productName, product.name);
      check("the buyer's email", orders[0]?.buyerEmail, "buyer@example.test");
      assert("and their shipping address", orders[0]?.shippingAddress != null);
      assert("the buyer lands on the success page", res.location.includes("/success"), res.location);

      // THE REFUND HOOK. Order.externalPaymentId exists precisely so a refund
      // can find its order without re-deriving it — the Stripe rail writes the
      // payment intent there. If PayPal never records its CAPTURE id, a PayPal
      // refund has nothing to attach to, and the schema's own guarantee is
      // silently true for only one of the two rails.
      check("the capture id is recorded, so a refund has somewhere to land", orders[0]?.externalPaymentId, "CAPTURE-1");

      const events = await prisma.businessEvent.findMany({ where: { storeId: store.id } });
      check("one transaction.created event", events.filter((e) => e.eventType === "transaction.created").length, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. A product deleted mid-checkout must not lose a real payment");
    {
      await reset();
      const { store, product } = await makeStore("deleted-product");
      const customId = `${store.id}:${product.id}`;
      // The real window: the buyer is on PayPal's site approving, and the owner
      // tidies the catalogue. The capture still succeeds — the money leaves the
      // buyer either way — so the order MUST still be written.
      await prisma.product.delete({ where: { id: product.id } });
      script = { capture: { status: 201, body: paypalOrderBody({ customId }) } };

      const res = await call("PP-2", store.slug);
      const orders = await ordersFor(store.id);
      check("the sale is still recorded", orders.length, 1);
      check("paid", orders[0]?.status, "paid");
      check("for the amount actually captured", orders[0]?.amountInCents, 2500);
      check("with no product to link to", orders[0]?.productId, null);
      assert("but a name the owner can still read", (orders[0]?.productName ?? "").length > 0, orders[0]?.productName);
      assert("and the buyer is not left on an error page", res.location.includes("/success"), res.location);
      check("no unresolved capture problem", (await problemsFor(store.id)).length, 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Another store's product cannot be attached to this sale");
    {
      await reset();
      const victim = await makeStore("victim");
      const attacker = await makeStore("attacker");
      // custom_id is built server-side, so this is defence in depth: if anything
      // ever put a foreign product id in it, the order must not end up naming —
      // or linking to — a product this store does not own.
      script = {
        capture: { status: 201, body: paypalOrderBody({ customId: `${attacker.store.id}:${victim.product.id}` }) },
      };

      await call("PP-3", attacker.store.slug);
      const orders = await ordersFor(attacker.store.id);
      if (orders.length === 1) {
        check("the foreign product is not linked", orders[0].productId, null);
        assert("and its name is not copied across", !orders[0].productName.includes("victim"), orders[0].productName);
      } else {
        assert("a captured payment is never dropped", false, `${orders.length} orders written`);
      }
      check("the victim's store gains nothing", (await ordersFor(victim.store.id)).length, 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. A reload after paying does not sell the same thing twice");
    {
      await reset();
      const { store, product } = await makeStore("double-hit");
      const customId = `${store.id}:${product.id}`;
      script = { capture: { status: 201, body: paypalOrderBody({ customId }) } };
      await call("PP-4", store.slug);

      // The back button. PayPal refuses a second capture; the route re-fetches.
      script = {
        capture: { status: 422, body: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } },
        get: { status: 200, body: paypalOrderBody({ customId }) },
      };
      const again = await call("PP-4", store.slug);
      const orders = await ordersFor(store.id);
      check("still exactly one order", orders.length, 1);
      assert("and the buyer still sees their receipt", again.location.includes("/success"), again.location);
      check(
        "one transaction event, not two",
        (await prisma.businessEvent.findMany({ where: { storeId: store.id, eventType: "transaction.created" } })).length,
        1
      );
      check("still one capture id, unchanged", orders[0]?.externalPaymentId, "CAPTURE-1");
    }

    // -----------------------------------------------------------------------
    console.log("\n5. A capture belonging to another store is refused, loudly");
    {
      await reset();
      const a = await makeStore("store-a");
      const b = await makeStore("store-b");
      // custom_id names store B; the URL names store A. The money has already
      // moved by the time this is discovered, so it must leave a record.
      script = { capture: { status: 201, body: paypalOrderBody({ customId: `${b.store.id}:${b.product.id}` }) } };

      const res = await call("PP-5", a.store.slug);
      check("no order for the store named in the URL", (await ordersFor(a.store.id)).length, 0);
      check("and none for the store in the custom_id either", (await ordersFor(b.store.id)).length, 0);
      assert(
        "the buyer is told the payment may have been taken",
        res.location.includes("payment_taken_unconfirmed"),
        res.location
      );
      assert("with the PayPal reference to quote", res.location.includes("ref=PP-5"), res.location);
      check("and the owner has a durable record of it", (await problemsFor(a.store.id)).length, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n6. A failed capture never becomes a paid order");
    {
      await reset();
      const { store, product } = await makeStore("declined");
      script = { capture: { status: 422, body: { details: [{ issue: "INSTRUMENT_DECLINED" }] } } };

      const res = await call("PP-6", store.slug);
      check("nothing is recorded as sold", (await ordersFor(store.id)).length, 0);
      assert("and the buyer is told it did not complete", res.location.includes("payment_not_completed"), res.location);

      // The same order id, now genuinely captured, still works — a decline must
      // not poison a later retry.
      script = { capture: { status: 201, body: paypalOrderBody({ customId: `${store.id}:${product.id}` }) } };
      const ok = await call("PP-6", store.slug);
      check("a later successful capture is recorded", (await ordersFor(store.id)).length, 1);
      assert("and completes", ok.location.includes("/success"), ok.location);
    }

    // -----------------------------------------------------------------------
    console.log("\n7. A store that cannot be paid never reaches PayPal");
    {
      await reset();
      const bare = await makeStore("no-paypal", { connected: false });
      script = { capture: { status: 201, body: paypalOrderBody({ customId: `${bare.store.id}:${bare.product.id}` }) } };

      const res = await call("PP-7", bare.store.slug);
      check("no capture was attempted", paypalCalls.includes("capture"), false);
      check("no order", (await ordersFor(bare.store.id)).length, 0);
      assert("and nothing was captured, so say so plainly", res.location.includes("payment_not_completed"), res.location);

      // An unknown slug, and a missing token, are not crashes either.
      const unknown = await call("PP-7", "no-such-store");
      check("an unknown store does not reach PayPal", paypalCalls.includes("capture"), false);
      assert("it just goes home", unknown.location.endsWith("/"), unknown.location);
      const noToken = await call(null, bare.store.slug);
      assert("a missing token goes home too", noToken.location.endsWith("/"), noToken.location);
    }

    // -----------------------------------------------------------------------
    console.log("\n8. What the money state says, and what it does not");
    {
      await reset();
      const { store, product } = await makeStore("axes");
      script = { capture: { status: 201, body: paypalOrderBody({ customId: `${store.id}:${product.id}` }) } };
      await call("PP-8", store.slug);
      const order = (await ordersFor(store.id))[0];

      check("paid does not mean fulfilled", order.fulfillmentStatus, "unfulfilled");
      check("nor shipped", order.trackingNumber, null);
      check("the provider is recorded", order.paymentProvider, "PAYPAL");
      check("keyed by the PayPal order id", order.externalOrderId, "PP-8");
      // Both rails must be readable the same way, or every consumer of Order
      // has to branch on paymentProvider.
      assert(
        "and by its capture id, exactly as the Stripe rail is by its payment intent",
        order.externalPaymentId !== null,
        String(order.externalPaymentId)
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
