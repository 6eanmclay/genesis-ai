import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// The confirmation's DECISION and IDEMPOTENCY, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-confirmation-live.ts" -OutFile out.txt
//
// (Unelevated, because PostgreSQL refuses to start under an administrator.)
//
// verify-order-confirmation.ts proves the CONTENT. This proves the parts that
// only exist in the database: that a redelivered event cannot email the customer
// twice, that a failed send releases its claim so a retry can still tell them,
// that a missing Resend credential is a loud operator failure rather than a
// silent loss, and that a rolled-back order is never confirmed.
//
// The email sender is INJECTED — not to fake delivery, but because delivery is
// the one part that genuinely cannot be proven without a Resend credential. The
// application's decision to send, the exact recipient and payload, the claim,
// the release and the retry are all real.

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

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  // A real-looking configuration, so the "configured" path is exercised. No
  // network call is made — the sender is injected.
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  process.env.EMAIL_FROM_ADDRESS = "orders@example.test";

  const { sendOrderConfirmation } = await import("@/lib/orders/orderConfirmation");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const sent: { to: string; subject: string; html: string }[] = [];
  const recorder = async (input: { to: string; subject: string; html: string }) => {
    sent.push(input);
  };
  const failing = async () => {
    throw new Error("provider rejected the message");
  };

  async function reset() {
    sent.length = 0;
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;

    // ============ RETRIED ON DEADLOCK (2026-09-02) ==================
    //
    // This suite failed reproducibly with 'deadlock detected' (40P01) the
    // first time it had a runner, at the reset before section 5.
    //
    // TRUNCATE takes an ACCESS EXCLUSIVE lock on every table named, in
    // order. Two connections are live here — this suite's client and the
    // one lib/prisma.ts builds for the production code under test, each with
    // its own pool — so the other can hold a lock on a later table while
    // this waits for an earlier one. Postgres detects the cycle and kills a
    // victim, which is the error seen.
    //
    // A DEADLOCK IS TRANSIENT BY DEFINITION: the victim is killed precisely
    // so the other side completes, and the retry then finds no contender.
    // Bounded at three so a genuine hang still fails rather than spinning.
    //
    // This is honest rather than masking, and the distinction matters:
    // TRUNCATE-everything is a HARNESS operation. Nothing in production
    // truncates, so there is no production deadlock being hidden here — the
    // contention is between the test's own cleanup and the code it is
    // testing, and it exists only because both are in one process.
    const statement =
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`;
    for (let attempt = 1; ; attempt++) {
      try {
        await prisma.$executeRawUnsafe(statement);
        return;
      } catch (error) {
        const deadlocked = /deadlock detected|40P01/.test(String(error));
        if (!deadlocked || attempt === 3) throw error;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  }

  async function makeOrder(slug: string, buyerEmail = "buyer@example.test") {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: `${slug} shop`, slug, tagline: "t", description: "d" },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        productName: "Candle",
        amountInCents: 2500,
        buyerEmail,
        status: "paid",
        paymentProvider: "STRIPE",
        externalOrderId: `cs_${slug}`,
      },
    });
    return { store, order };
  }
  const confirmedAt = async (id: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id }, select: { confirmationSentAt: true } })).confirmationSentAt;

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. A committed order is confirmed exactly once");
    {
      await reset();
      const { store, order } = await makeOrder("once", "sarah@example.test");

      check("the first attempt sends", await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder), { sent: true });
      check("one email", sent.length, 1);
      check("to the buyer", sent[0].to, "sarah@example.test");
      assert("naming that store", sent[0].subject.includes(`${store.slug} shop`), sent[0].subject);
      assert("the order is marked confirmed", (await confirmedAt(order.id)) !== null);

      // Stripe redelivers, and after() runs on every delivery. Without the
      // claim the customer would be emailed again each time.
      check("a redelivery does not send again", await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder), {
        sent: false,
        reason: "already_sent",
      });
      await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder);
      await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder);
      check("still exactly one email after four attempts", sent.length, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Concurrent deliveries cannot both win the claim");
    {
      await reset();
      const { store, order } = await makeOrder("race");

      // The real shape of the problem: two deliveries of one event arriving at
      // once. A check-then-send would let both pass the check.
      const results = await Promise.all([
        sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder),
        sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder),
        sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder),
      ]);
      check("exactly one attempt sent", results.filter((r) => r.sent).length, 1);
      check("and exactly one email left the building", sent.length, 1);
      check("the others report why", results.filter((r) => !r.sent && r.reason === "already_sent").length, 2);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. A failed send releases its claim, so a retry still tells them");
    {
      await reset();
      const { store, order } = await makeOrder("retry");

      const failed = await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, failing);
      check("the failure is reported honestly", failed.sent, false);
      assert("with the provider's reason", !failed.sent && failed.reason === "send_failed");
      check("nothing was sent", sent.length, 0);

      // The critical part: the order must NOT be left marked as confirmed when
      // it never was, or this customer never hears anything again.
      check("the claim was released", await confirmedAt(order.id), null);

      check("so a later delivery succeeds", await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder), { sent: true });
      check("and the customer finally gets it", sent.length, 1);
      assert("now marked confirmed", (await confirmedAt(order.id)) !== null);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. No email configuration is an operator failure, not a silent loss");
    {
      await reset();
      const { store, order } = await makeOrder("unconfigured");
      const key = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;

      const result = await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder);
      check("it says exactly why", result, { sent: false, reason: "email_not_configured" });
      check("nothing was sent", sent.length, 0);

      // The order must NOT be marked confirmed — a platform that cannot send
      // anything must not record that it did.
      check("and the order is not marked confirmed", await confirmedAt(order.id), null);

      process.env.RESEND_API_KEY = key;
      check("once configured, the same order confirms", await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder), { sent: true });
      check("with a real email", sent.length, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n5. An order that never committed is never confirmed");
    {
      await reset();
      const { store, order } = await makeOrder("rollback");
      const orderId = order.id;
      // Stand-in for a transaction that rolled back: the row does not exist by
      // the time confirmation runs. Nothing can be loaded, so nothing is sent.
      await prisma.order.delete({ where: { id: orderId } });

      const result = await sendOrderConfirmation({ orderId, storeId: store.id }, recorder);
      assert("no email for an order that is not there", sent.length === 0, JSON.stringify(result));
      assert("and it is not reported as sent", !result.sent);
      // NOT "already_sent". Both fail to claim, but telling an operator that a
      // non-existent order was already confirmed is a false statement — and it
      // is the one they would be reading while working out why a customer never
      // heard anything.
      check("it says the order is not there", result, { sent: false, reason: "not_found" });

      // A real order claimed against the WRONG store is the same answer: no
      // row matches, and nothing is sent about another tenant's order.
      const other = await makeOrder("rollback-other");
      const crossed = await sendOrderConfirmation({ orderId: other.order.id, storeId: store.id }, recorder);
      check("a mismatched order/store pair sends nothing", crossed, { sent: false, reason: "not_found" });
      check("and no email", sent.length, 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n6. Confirmation is a different axis from paid, fulfilled and shipped");
    {
      await reset();
      const { store, order } = await makeOrder("axes");
      await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder);

      const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      // Telling the customer their order exists must not imply anything about
      // the owner having done something about it.
      check("still unfulfilled", after.fulfillmentStatus, "unfulfilled");
      check("no label bought", after.trackingNumber, null);
      check("not notified about a shipment", after.shipmentNotifiedAt, null);
      check("payment status untouched", after.status, "paid");
      assert("but confirmed", after.confirmationSentAt !== null);

      // And the reverse: a refund must not resurrect the confirmation claim.
      await prisma.order.update({ where: { id: order.id }, data: { status: "refunded" } });
      check("a refunded order stays confirmed", await sendOrderConfirmation({ orderId: order.id, storeId: store.id }, recorder), {
        sent: false,
        reason: "already_sent",
      });
      check("with no second email", sent.length, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n7. One customer never hears about another's order");
    {
      await reset();
      const a = await makeOrder("store-a", "alice@example.test");
      const b = await makeOrder("store-b", "bob@example.test");

      await sendOrderConfirmation({ orderId: a.order.id, storeId: a.store.id }, recorder);
      await sendOrderConfirmation({ orderId: b.order.id, storeId: b.store.id }, recorder);

      check("two emails", sent.length, 2);
      const alice = sent.find((e) => e.to === "alice@example.test");
      const bob = sent.find((e) => e.to === "bob@example.test");
      assert("Alice got one", alice !== undefined);
      assert("Bob got one", bob !== undefined);
      // Each names its OWN store — the store comes from the order's relation,
      // never from anything a caller supplied.
      assert("Alice's names store-a", alice!.subject.includes("store-a"), alice!.subject);
      assert("and not store-b", !alice!.subject.includes("store-b"));
      assert("Bob's names store-b", bob!.subject.includes("store-b"), bob!.subject);
      assert("and not store-a", !bob!.subject.includes("store-a"));

      // Confirming one must not mark the other.
      assert("each order tracked separately",
        (await confirmedAt(a.order.id)) !== null && (await confirmedAt(b.order.id)) !== null);
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
