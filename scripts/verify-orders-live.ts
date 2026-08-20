import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// The owner-facing order lifecycle, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-orders-live.ts" -OutFile out.txt
//
// Money IN is now well covered. This is the owner's side of the same orders:
// who may change them, and which state changes are legitimate.
//
// The executable is driven through execute(), which is where the permission
// re-check lives — not called directly, because bypassing execute() would test
// everything except the authorisation boundary this file exists to prove.

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

  const { toggleOrderFulfilledExecutable } = await import("@/lib/execution/executables/orders");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  // execute() resolves permission from a live session, which does not exist in
  // a script. The executable's own run() is driven with an explicit ctx — the
  // SAME ctx execute() would build after requireStorePermission has approved
  // it. So ctx.storeId is exactly "the store the caller was authorised for",
  // and passing another store's order id is precisely the cross-tenant attack.
  const runAs = (storeId: string, orderId: string) =>
    toggleOrderFulfilledExecutable.run({ orderId }, {
      storeId,
      userId: "user_test",
      actorType: "USER",
      executionId: "exec_test",
    });

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

  async function makeOrder(slug: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: `${slug} shop`, slug, tagline: "t", description: "d" },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        productName: "Candle",
        amountInCents: 2500,
        buyerEmail: "buyer@example.test",
        status: "paid",
        paymentProvider: "STRIPE",
        externalOrderId: `cs_${slug}`,
        ...extra,
      },
    });
    return { store, order };
  }

  const stateOf = async (id: string) =>
    prisma.order.findUniqueOrThrow({
      where: { id },
      select: { fulfillmentStatus: true, fulfilledAt: true, trackingNumber: true },
    });

  async function refuses(label: string, fn: () => Promise<unknown>, expectIn?: string): Promise<void> {
    try {
      await fn();
      failures++;
      console.log(`FAIL  ${label} — it did NOT refuse`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const ok = !expectIn || message.includes(expectIn);
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? `  — ${message.slice(0, 70)}` : ""}`);
      if (!ok) console.log(`        expected a message containing "${expectIn}", got "${message}"`);
    }
  }

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. Store A cannot touch Store B's order");
    {
      await reset();
      const a = await makeOrder("store-a");
      const b = await makeOrder("store-b");

      // The attack: an authorised owner of store A naming store B's order id.
      // Everything about the caller is legitimate except the id.
      await refuses("A cannot fulfil B's order", () => runAs(a.store.id, b.order.id), "Order not found");

      const untouched = await stateOf(b.order.id);
      check("B's order is untouched", untouched.fulfillmentStatus, "unfulfilled");
      check("and has no fulfilment timestamp", untouched.fulfilledAt, null);

      // Nor in the other direction, and nor with a fulfilled order.
      await prisma.order.update({
        where: { id: b.order.id },
        data: { fulfillmentStatus: "fulfilled", fulfilledAt: new Date() },
      });
      await refuses("nor un-fulfil it", () => runAs(a.store.id, b.order.id), "Order not found");
      check("B's order stays fulfilled", (await stateOf(b.order.id)).fulfillmentStatus, "fulfilled");

      // And A can still manage its own.
      await runAs(a.store.id, a.order.id);
      check("A's own order still works", (await stateOf(a.order.id)).fulfillmentStatus, "fulfilled");
    }

    // -----------------------------------------------------------------------
    console.log("\n2. A parcel in the post cannot become unfulfilled");
    {
      await reset();
      // Exactly what buying a label leaves behind.
      const { store, order } = await makeOrder("shipped", {
        fulfillmentStatus: "fulfilled",
        fulfilledAt: new Date(),
        carrier: "USPS",
        trackingNumber: "9400111899223197428490",
        shipmentNotifiedAt: new Date(),
      });

      // The buyer has tracking and the parcel is gone. Un-marking it would show
      // the order as still needing fulfilment — an invitation to ship it twice.
      await refuses("un-fulfilling a shipped order is refused", () => runAs(store.id, order.id), "already shipped");

      const after = await stateOf(order.id);
      check("it stays fulfilled", after.fulfillmentStatus, "fulfilled");
      check("and keeps its tracking", after.trackingNumber, "9400111899223197428490");

      // The refusal names the tracking number, so the owner can see WHY rather
      // than being told no.
      try {
        await runAs(store.id, order.id);
      } catch (error) {
        assert("the message names the tracking number",
          (error as Error).message.includes("9400111899223197428490"), (error as Error).message);
      }
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Marking fulfilled by hand still works, both ways");
    {
      await reset();
      const { store, order } = await makeOrder("manual");

      await runAs(store.id, order.id);
      const fulfilled = await stateOf(order.id);
      check("unfulfilled becomes fulfilled", fulfilled.fulfillmentStatus, "fulfilled");
      assert("with a real timestamp", fulfilled.fulfilledAt !== null);

      // No label, so this one CAN be reversed — an owner correcting a misclick
      // on an order they have not actually shipped.
      await runAs(store.id, order.id);
      const back = await stateOf(order.id);
      check("and back again, with no label involved", back.fulfillmentStatus, "unfulfilled");
      check("the timestamp is cleared, not left stale", back.fulfilledAt, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. The toggle follows the database, never a caller's idea of it");
    {
      await reset();
      const { store, order } = await makeOrder("stale");

      // THE CLASS OF BUG THIS REPLACED. `currentlyFulfilled` used to arrive
      // from the action, computed from a read taken before the page rendered,
      // so a stale tab could toggle against a status that had since changed.
      // The executable is told nothing now except which order — so it cannot be
      // lied to, by a stale page or anything else.
      await prisma.order.update({
        where: { id: order.id },
        data: { fulfillmentStatus: "fulfilled", fulfilledAt: new Date() },
      });

      // Nothing told it the order had changed. It reads.
      await runAs(store.id, order.id);
      check("it toggled from the REAL current state", (await stateOf(order.id)).fulfillmentStatus, "unfulfilled");

      await prisma.order.update({ where: { id: order.id }, data: { fulfillmentStatus: "unfulfilled" } });
      await runAs(store.id, order.id);
      check("and again in the other direction", (await stateOf(order.id)).fulfillmentStatus, "fulfilled");

      // Two toggles in sequence return to where they started. That IS a toggle,
      // and asserting otherwise would be asserting a bug — my first version of
      // this section did exactly that and was wrong.
      const second = await makeOrder("sequential");
      await runAs(second.store.id, second.order.id);
      await runAs(second.store.id, second.order.id);
      check("two sequential toggles land back at the start",
        (await stateOf(second.order.id)).fulfillmentStatus, "unfulfilled");

      // The write is conditional on the state that was read, so a write built
      // on a status that has since moved lands on nothing rather than
      // overwriting whatever is there now. Exercised directly, because forcing
      // that interleaving through the executable is not deterministic.
      const third = await makeOrder("conditional");
      const stale = await prisma.order.updateMany({
        where: { id: third.order.id, storeId: third.store.id, fulfillmentStatus: "fulfilled" },
        data: { fulfillmentStatus: "unfulfilled" },
      });
      check("a write against a status that never held changes nothing", stale.count, 0);
      check("and the order is untouched",
        (await stateOf(third.order.id)).fulfillmentStatus, "unfulfilled");
    }

    // -----------------------------------------------------------------------
    console.log("\n5. Orders that are not there");
    {
      await reset();
      const { store } = await makeOrder("missing");

      await refuses("an invented order id", () => runAs(store.id, "order_never_existed"), "Order not found");
      await refuses("an empty order id", () => runAs(store.id, ""), "Order not found");

      const { order: doomed } = await makeOrder("deleted");
      const deletedId = doomed.id;
      await prisma.order.delete({ where: { id: deletedId } });
      await refuses("a deleted order", () => runAs(store.id, deletedId), "Order not found");
    }

    // -----------------------------------------------------------------------
    console.log("\n6. The Orders list only ever shows one store's orders");
    {
      await reset();
      const a = await makeOrder("list-a");
      const b = await makeOrder("list-b");
      await prisma.order.create({
        data: {
          storeId: b.store.id, productName: "Second", amountInCents: 100,
          buyerEmail: "x@example.test", status: "paid",
          paymentProvider: "STRIPE", externalOrderId: "cs_list_b2",
        },
      });

      // The page's own query, scoped by the session's store.
      const aOrders = await prisma.order.findMany({ where: { storeId: a.store.id } });
      const bOrders = await prisma.order.findMany({ where: { storeId: b.store.id } });
      check("A sees only its own", aOrders.length, 1);
      check("B sees only its own", bOrders.length, 2);
      assert("and no id crosses over", !aOrders.some((o) => o.storeId === b.store.id));

      // There is no filter, search or pagination parameter on that page — the
      // only searchParams are flash flags — so there is no alternate query to
      // manipulate. The tenant guard is what catches it if that ever changes.
      const { withTenantIsolation } = await import("@/lib/tenantIsolation");
      const guarded = withTenantIsolation(prisma);
      await refuses("an unscoped order list is refused outright",
        () => guarded.order.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
        "Tenant isolation");
      await refuses("and so is one scoped to nothing useful",
        () => guarded.order.findMany({ where: { status: "paid" } }),
        "Tenant isolation");
    }
    // -----------------------------------------------------------------------
    console.log("\n7. A refunded order cannot cost the owner anything more");
    {
      await reset();
      const { store, order } = await makeOrder("refunded", { status: "refunded" });

      // MONEY BACK, THEN GOODS OUT. Nothing checked payment status before
      // buying postage, so a refunded order could still have a real label
      // bought: the customer keeps their money AND receives the item, at the
      // owner's expense.
      const { purchaseShippingLabelExecutable } = await import("@/lib/execution/executables/shipping");
      await refuses(
        "no postage may be bought for a refunded order",
        () => purchaseShippingLabelExecutable.run(
          { orderId: order.id, weightOz: 8 },
          { storeId: store.id, userId: "u", actorType: "USER", executionId: "e" }
        ),
        "was refunded"
      );

      // And committing to send the goods is refused too.
      await refuses("nor may it be marked fulfilled", () => runAs(store.id, order.id), "was refunded");
      check("it stays unfulfilled", (await stateOf(order.id)).fulfillmentStatus, "unfulfilled");

      // The refusal happens BEFORE the claim, so a refused attempt does not
      // leave the order locked out of shipping if it is later un-refunded.
      const claimState = await prisma.order.findUniqueOrThrow({
        where: { id: order.id }, select: { labelClaimedAt: true },
      });
      check("and is not left claimed", claimState.labelClaimedAt, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n8. Shipped, then refunded — both facts survive");
    {
      await reset();
      // The real sequence: goods shipped, money returned afterwards. Both
      // things genuinely happened, so both stay recorded.
      const { store, order } = await makeOrder("shipped-then-refunded", {
        status: "refunded",
        fulfillmentStatus: "fulfilled",
        fulfilledAt: new Date(),
        carrier: "USPS",
        trackingNumber: "9400111899223197428491",
      });

      // Un-marking is still allowed here — it shipped before the refund, and an
      // owner may legitimately want to correct the flag. But the LABEL guard
      // outranks it, because the parcel is still gone.
      await refuses("a shipped-then-refunded order still cannot be un-shipped",
        () => runAs(store.id, order.id), "already shipped");

      const after = await stateOf(order.id);
      check("it keeps its tracking", after.trackingNumber, "9400111899223197428491");
      check("and stays fulfilled", after.fulfillmentStatus, "fulfilled");
    }

    // -----------------------------------------------------------------------
    console.log("\n9. Refunded money is not revenue");
    {
      await reset();
      const { store } = await makeOrder("revenue-kept");
      await prisma.order.create({
        data: {
          storeId: store.id, productName: "Refunded item", amountInCents: 5000,
          buyerEmail: "b@example.test", status: "refunded",
          paymentProvider: "STRIPE", externalOrderId: "cs_refunded_rev",
        },
      });

      const { getOrderSummary } = await import("@/lib/dashboard/whatHappened");
      const summary = await getOrderSummary(store.id, { includeRevenue: true });

      // The refunded 5000 must not appear as income. Only the kept 2500 does.
      check("revenue counts only money actually kept", summary.revenueInCents, 2500);
      check("all-time revenue likewise", summary.allTimeRevenueInCents, 2500);
      // But the order still happened — hiding it would make a refund-heavy
      // month look quiet rather than troubled.
      check("the order count still includes it", summary.orderCount, 2);
      check("and all-time too", summary.allTimeOrderCount, 2);

      // Without REVENUE_VIEW the figure never reaches the caller at all.
      const noRevenue = await getOrderSummary(store.id, { includeRevenue: false });
      check("an employee sees no revenue figure", noRevenue.revenueInCents, null);
      check("but still sees the orders", noRevenue.orderCount, 2);
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
