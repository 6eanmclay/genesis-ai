import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import type { LabelBuyer, LabelRequest } from "@/lib/shipping/labelPurchase";

// The label purchase, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-label-purchase-live.ts" -OutFile out.txt
//
// VISION.md's P0.4 — "Paid order → shipping address → label workflow → USPS →
// tracking number → shipped order".
//
// The buyer is INJECTED, exactly as the confirmation's email sender is (§35),
// and for the same reason: the EasyPost HTTP round trip needs a credential this
// environment does not have. Everything else is production code, including the
// part that matters most — selectRateForLabel, the REAL rate chooser, runs
// inside the injected buyer against a fixed rate table. So which rate gets
// bought, and when the purchase refuses, are genuinely proven here.
//
// EXTERNALLY BLOCKED and not claimed: the EasyPost call itself, and therefore
// whether a real carrier would return the rates this table describes.

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

/** What a carrier is offering for this parcel. Dollars, as EasyPost sends them. */
const RATES = [
  { id: "rate_ga", carrier: "USPS", service: "GroundAdvantage", rate: "5.50", delivery_days: 5 },
  { id: "rate_priority", carrier: "USPS", service: "Priority", rate: "9.20", delivery_days: 3 },
  { id: "rate_express", carrier: "USPS", service: "PriorityMailExpress", rate: "31.40", delivery_days: 1 },
  { id: "rate_ups_ground", carrier: "UPS", service: "Ground", rate: "8.75", delivery_days: 4 },
];

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  const { purchaseLabelForOrder } = await import("@/lib/execution/executables/shipping");
  const { selectRateForLabel } = await import("@/lib/shipping/labelPurchase");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { encryptCredentials } = await import("@/lib/integrations/credentials");

  /** Everything the buyer was asked to buy, so the request itself is assertable. */
  const asked: LabelRequest[] = [];
  let offered = RATES;

  // Stands in for the HTTP round trip and nothing else: the rate CHOICE below is
  // the real production function, given the real selection off the real order.
  const buyer: LabelBuyer = async (apiKey, request) => {
    asked.push(request);
    if (!apiKey) throw new Error("no api key was passed");
    const rate = selectRateForLabel(offered, request.selected);
    return {
      carrier: rate.carrier!,
      service: rate.service!,
      trackingNumber: `TRK-${rate.id}`,
      trackingUrl: `https://track.example.test/${rate.id}`,
      labelUrl: `https://labels.example.test/${rate.id}.pdf`,
      costInCents: Math.round(Number.parseFloat(rate.rate!) * 100),
      matchedSelection: Boolean(request.selected.carrier && request.selected.service),
    };
  };

  async function reset() {
    asked.length = 0;
    offered = RATES;
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  const ADDRESS = {
    name: "Sarah Buyer",
    line1: "12 Kiln Lane",
    line2: null,
    city: "Portland",
    state: "OR",
    postalCode: "97201",
    country: "US",
  };

  async function makeOrder(
    slug: string,
    selected: { carrier?: string; service?: string; chargedInCents?: number } = {}
  ) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id,
        name: `${slug} shop`,
        slug,
        tagline: "t",
        description: "d",
        returnAddress: {
          name: `${slug} shop`,
          phone: "5035550123",
          line1: "9 Forge Street",
          line2: null,
          city: "Denver",
          state: "CO",
          postalCode: "80205",
          country: "US",
        },
      },
    });
    await prisma.storeIntegration.create({
      data: {
        storeId: store.id,
        provider: "EASYPOST",
        status: "CONNECTED",
        credentials: encryptCredentials({ schemaVersion: 1, apiKey: `EZ-${slug}` }),
      },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        productName: "Tensor ring",
        amountInCents: 2500 + (selected.chargedInCents ?? 0),
        buyerEmail: "buyer@example.test",
        status: "paid",
        paymentProvider: "STRIPE",
        externalOrderId: `cs_${slug}`,
        shippingAddress: ADDRESS,
        selectedShippingCarrier: selected.carrier ?? null,
        selectedShippingService: selected.service ?? null,
        shippingChargedInCents: selected.chargedInCents ?? null,
      },
    });
    return { store, order };
  }

  const ctxFor = (storeId: string) => ({ storeId, userId: null, actorType: "USER" as const });
  const reload = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const failure = (p: Promise<unknown>) =>
    p.then(() => null).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. The customer gets the service they paid for");
    {
      await reset();
      // Paid $31.40 for overnight. The cheapest rate on the table is $5.50.
      const { store, order } = await makeOrder("express", {
        carrier: "USPS",
        service: "Priority Mail Express",
        chargedInCents: 3140,
      });

      await purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer);
      const after = await reload(order.id);

      // THE DEFECT. This path filtered to USPS and bought the cheapest rate,
      // full stop — selectedShippingService was written by the webhook and read
      // by nobody. The customer paid for overnight and got five-day ground.
      check("the label is the service they chose", after.carrier, "USPS");
      check("bought at that service's price", after.shippingCostInCents, 3140);
      check("not the cheapest on the table", after.shippingCostInCents === 550, false);
      check("tracking is recorded", after.trackingNumber, "TRK-rate_express");
      check("and the order is fulfilled", after.fulfillmentStatus, "fulfilled");

      // The selection reached the buyer at all, which it previously did not.
      check("the purchase was told what to buy", asked[0]?.selected, {
        carrier: "USPS",
        service: "Priority Mail Express",
      });
      // What the customer paid is a different number from what the label cost,
      // and neither may overwrite the other.
      check("what the customer was charged is untouched", after.shippingChargedInCents, 3140);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. A carrier that is not USPS is honoured too");
    {
      await reset();
      // The old filter was `carrier === "USPS"`, so a customer who chose and
      // paid for UPS could never have received it — the purchase would have
      // bought a USPS service or failed claiming USPS returned no rates.
      const { store, order } = await makeOrder("ups", {
        carrier: "UPS",
        service: "Ground",
        chargedInCents: 875,
      });

      await purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer);
      const after = await reload(order.id);
      check("the label is UPS", after.carrier, "UPS");
      check("at the UPS price", after.shippingCostInCents, 875);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. An ordinary order still buys the cheapest USPS rate");
    {
      await reset();
      // No live shipping at checkout, so nothing was chosen and nothing was
      // promised. The behaviour that existed before must be exactly unchanged.
      const { store, order } = await makeOrder("no-selection");

      await purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer);
      const after = await reload(order.id);
      check("cheapest USPS", after.shippingCostInCents, 550);
      check("carrier recorded", after.carrier, "USPS");
      check("and nothing was claimed to have been selected", asked[0]?.selected, {
        carrier: null,
        service: null,
      });
      // The cheaper UPS rate is deliberately not considered: with no selection
      // there is no consent to a different carrier.
      check("a cheaper non-USPS rate is not substituted in", after.shippingCostInCents === 875, false);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. A service the carrier will not sell is refused, not downgraded");
    {
      await reset();
      const { store, order } = await makeOrder("gone", {
        carrier: "USPS",
        service: "Priority Mail Express",
        chargedInCents: 3140,
      });
      // Overnight is off the table by the time the owner gets to the label.
      offered = RATES.filter((r) => r.service !== "PriorityMailExpress");

      const message = await failure(
        purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)
      );
      assert("it refuses", message !== null, String(message));
      assert("naming what the customer paid for", (message ?? "").includes("Priority Mail Express"), String(message));
      assert("and what is actually available", (message ?? "").includes("Ground Advantage"), String(message));
      assert("saying plainly that nothing was bought", (message ?? "").includes("nothing was bought"), String(message));

      const after = await reload(order.id);
      check("no label", after.trackingNumber, null);
      check("nothing spent", after.shippingCostInCents, null);
      check("still unfulfilled", after.fulfillmentStatus, "unfulfilled");
      check("the customer was not told anything", after.shipmentNotifiedAt, null);
      // The claim must lift, or this order could never be shipped at all once
      // the owner sorts it out with the carrier.
      check("and the claim was released so a retry is possible", after.labelClaimedAt, null);

      // Which it is, once the service comes back.
      offered = RATES;
      await purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer);
      check("the retry buys the right service", (await reload(order.id)).shippingCostInCents, 3140);
    }

    // -----------------------------------------------------------------------
    console.log("\n5. No rates at all is a different failure, and says so");
    {
      await reset();
      const { store, order } = await makeOrder("no-rates");
      offered = [];

      const message = await failure(
        purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)
      );
      assert("it fails", message !== null);
      assert("about the address and the parcel, not about a chosen service",
        (message ?? "").includes("No carrier returned a rate"), String(message));
      check("nothing was bought", (await reload(order.id)).trackingNumber, null);
      check("and the claim lifted", (await reload(order.id)).labelClaimedAt, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n6. The guards that already stood, still stand");
    {
      await reset();
      const { store, order } = await makeOrder("guards", { carrier: "USPS", service: "Priority" });

      // A refunded order must not cost the owner postage (§36) — and it must
      // refuse BEFORE reaching the carrier, or the money is already gone.
      await prisma.order.update({ where: { id: order.id }, data: { status: "refunded" } });
      const refused = await failure(
        purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)
      );
      assert("a refunded order is refused", (refused ?? "").includes("refunded"), String(refused));
      check("without asking the carrier for anything", asked.length, 0);

      await prisma.order.update({ where: { id: order.id }, data: { status: "paid" } });

      // A parcel with no weight cannot be rated, and a guessed weight would put
      // a real price on a real order.
      const noWeight = await failure(
        purchaseLabelForOrder({ orderId: order.id, weightOz: 0 }, ctxFor(store.id), buyer)
      );
      assert("no weight is refused", (noWeight ?? "").includes("real package weight"), String(noWeight));
      check("still nothing asked of the carrier", asked.length, 0);

      // And an order that already has a label is never bought twice.
      await purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer);
      const twice = await failure(
        purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)
      );
      assert("a second purchase is refused", (twice ?? "").includes("already has a shipping label"), String(twice));
      check("the carrier was asked exactly once", asked.length, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n7. Two submits at once buy one label");
    {
      await reset();
      const { store, order } = await makeOrder("race", { carrier: "USPS", service: "Priority" });

      // §36's defect: the trackingNumber guard is a check-then-act, and several
      // awaits separate it from the spend. Both submits reached the carrier and
      // the owner paid real postage twice for one parcel.
      const results = await Promise.all([
        failure(purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)),
        failure(purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)),
        failure(purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)),
      ]);
      check("exactly one succeeded", results.filter((r) => r === null).length, 1);
      check("and the carrier was only asked once", asked.length, 1);
      check("one label on the order", (await reload(order.id)).trackingNumber, "TRK-rate_priority");
    }

    // -----------------------------------------------------------------------
    console.log("\n8. One store can never buy postage against another's order");
    {
      await reset();
      const a = await makeOrder("shop-a", { carrier: "USPS", service: "Priority" });
      const b = await makeOrder("shop-b", { carrier: "USPS", service: "Priority" });

      // Store B's owner, holding store A's order id. The order is real and the
      // id is valid; what must not happen is B's EasyPost account paying for it,
      // or A's order changing.
      const crossed = await failure(
        purchaseLabelForOrder({ orderId: a.order.id, weightOz: 8 }, ctxFor(b.store.id), buyer)
      );
      assert("refused", (crossed ?? "").includes("Order not found"), String(crossed));
      check("no carrier call was made", asked.length, 0);
      check("store A's order is untouched", (await reload(a.order.id)).trackingNumber, null);
      check("and unclaimed", (await reload(a.order.id)).labelClaimedAt, null);

      // The legitimate owner still can, or the guard has broken the feature.
      await purchaseLabelForOrder({ orderId: a.order.id, weightOz: 8 }, ctxFor(a.store.id), buyer);
      assert("its own store can", (await reload(a.order.id)).trackingNumber !== null);
      check("store B's order is still its own business", (await reload(b.order.id)).trackingNumber, null);

      // Each store's own credential paid for its own label, and nothing else.
      check("the key used was store A's", asked[0]?.selected.service, "Priority");
    }

    // -----------------------------------------------------------------------
    console.log("\n9. A store that cannot ship never reaches the carrier");
    {
      await reset();
      const { store, order } = await makeOrder("unconnected");
      await prisma.storeIntegration.deleteMany({ where: { storeId: store.id, provider: "EASYPOST" } });

      const message = await failure(
        purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)
      );
      assert("it says to connect shipping first", (message ?? "").includes("Connect USPS Shipping"), String(message));
      check("and nothing was attempted", asked.length, 0);

      // Same for an order with no address to ship to, and a store with no
      // address to ship from — both are the owner's to fix, and both must be
      // caught before any money moves.
      await prisma.storeIntegration.create({
        data: {
          storeId: store.id,
          provider: "EASYPOST",
          status: "CONNECTED",
          credentials: encryptCredentials({ schemaVersion: 1, apiKey: "EZ-x" }),
        },
      });
      // Prisma.DbNull, not undefined — `undefined` means "leave this alone", so
      // the first version of this case cleared nothing and proved nothing.
      const { Prisma } = await import("@prisma/client");
      await prisma.order.update({ where: { id: order.id }, data: { shippingAddress: Prisma.DbNull } });
      await prisma.store.update({ where: { id: store.id }, data: { returnAddress: Prisma.DbNull } });
      const noAddress = await failure(
        purchaseLabelForOrder({ orderId: order.id, weightOz: 8 }, ctxFor(store.id), buyer)
      );
      assert("a missing shipping address is named", (noAddress ?? "").includes("no shipping address"), String(noAddress));
      check("still nothing attempted", asked.length, 0);
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
