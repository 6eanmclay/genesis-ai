import crypto from "crypto";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { carriageProviderFor, getCarriageProviders, providerCan } from "@/lib/carriage/registry";
import { isValidEasyPostSignature, applyShipmentUpdate } from "@/lib/carriage/delivery";
// The pure lifecycle, from its own module: delivery.ts imports prisma and node
// crypto, and OrdersList renders this in the browser.
import { stageOf, STAGE_LABEL, type OrderStage } from "@/lib/carriage/lifecycle";

// WHERE THE PARCEL ACTUALLY IS:
//
//   npx tsx scripts/run-db-suites.ts carriage-delivery
//
// The last arrow of the commerce chain. Until this, the system knew a label
// had been bought and a tracking number existed; whether the thing ARRIVED was
// unknowable, so an order stopped at "shipped" and stayed there forever.
//
// THE MAPPER IS REUSED, NOT REBUILT. mapTrackerToShipment already turned a
// carrier tracker into a canonical Shipment and already had its own suite
// (verify-easypost-shipments.ts). What did not exist was ingestion: no route
// received an update and no column held the result. This covers that half.
//
// THE SIGNATURE IS THE MOST IMPORTANT THING IN THIS FILE. The webhook endpoint
// is public. Without verification, marking somebody's order delivered is a
// curl command away — which is worse than not having the feature at all,
// because the owner would believe it.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, detail: "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const SECRET = "a-real-webhook-secret-for-this-test";
const sign = (body: string, secret = SECRET) =>
  `hmac-sha256-hex=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

const uniq = () => Math.random().toString(36).slice(2);

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({ data: { email: `carriage-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `carriage-${uniq()}` },
  });

  const makeOrder = (trackingNumber: string | null) =>
    prisma.order.create({
      data: {
        storeId: store.id,
        productName: "Tensor Ring",
        amountInCents: 8_500,
        buyerEmail: "buyer@carriage.test",
        paymentProvider: "STRIPE",
        externalOrderId: `ord-${uniq()}`,
        ...(trackingNumber ? { trackingNumber, carrier: "USPS" } : {}),
      },
    });

  try {
    // ========================================================================
    console.log("\n=== 1. A public endpoint that anyone can POST to ===\n");
    // ========================================================================
    const body = JSON.stringify({ description: "tracker.updated", result: {} });

    check("a correct signature verifies",
      isValidEasyPostSignature({ rawBody: body, header: sign(body), secret: SECRET }), true);

    // EVERY WAY A FORGERY COULD GET IN.
    check("a signature from the wrong secret is refused",
      isValidEasyPostSignature({ rawBody: body, header: sign(body, "not-the-secret"), secret: SECRET }), false);
    check("a signature over a DIFFERENT body is refused",
      isValidEasyPostSignature({ rawBody: body, header: sign('{"description":"tracker.updated"}'), secret: SECRET }), false);
    check("no signature at all is refused",
      isValidEasyPostSignature({ rawBody: body, header: null, secret: SECRET }), false);
    check("an empty signature is refused",
      isValidEasyPostSignature({ rawBody: body, header: "", secret: SECRET }), false);
    check("a bare hex digest with no algorithm is refused",
      isValidEasyPostSignature({
        rawBody: body,
        header: crypto.createHmac("sha256", SECRET).update(body).digest("hex"),
        secret: SECRET,
      }), false);
    check("an algorithm we do not compute is refused rather than guessed at",
      isValidEasyPostSignature({ rawBody: body, header: `hmac-sha512-hex=${"0".repeat(128)}`, secret: SECRET }), false);
    check("and a truncated signature does not throw",
      isValidEasyPostSignature({ rawBody: body, header: "hmac-sha256-hex=abc", secret: SECRET }), false);

    // Without a secret nothing can be authenticated, so nothing is accepted.
    check("no configured secret means nothing verifies",
      isValidEasyPostSignature({ rawBody: body, header: sign(body), secret: "" }), false);
    // THE PROPERTY A BEHAVIOURAL TEST CANNOT SEE. Replacing timingSafeEqual
    // with `===` gives an identical verdict on every case above — the
    // negative control proved exactly that by passing all of them. What
    // changes is how long a wrong answer takes, which leaks how many leading
    // characters were right, one request at a time. So it is asserted
    // structurally, because there is no other honest way to hold it.
    const source = (await import("fs")).readFileSync("lib/carriage/delivery.ts", "utf8");
    assert(
      "the comparison is timing-safe",
      source.includes("crypto.timingSafeEqual"),
      "a === on a hex digest leaks the prefix length that matched"
    );
    assert(
      "and lengths are checked first, so a forgery is refused rather than crashing",
      source.includes("a.length !== b.length"),
      "timingSafeEqual throws on unequal lengths — that would be a 500 on a forged request"
    );

    assert(
      "so marking an order delivered is never one curl away",
      isValidEasyPostSignature({ rawBody: body, header: sign(body, "guess"), secret: SECRET }) === false,
      "the endpoint is public; the signature is the whole of the door"
    );

    // ========================================================================
    console.log("\n=== 2. The provider registry, and what it admits it cannot do ===\n");
    // ========================================================================
    check("one provider is registered", getCarriageProviders().length, 1);
    assert("EasyPost resolves", carriageProviderFor("EASYPOST")?.id === "EASYPOST");
    check("an unknown provider is null", carriageProviderFor("SHIPPO"), null);

    // A lookup keyed by a value from outside. On a plain object literal,
    // PROVIDERS["constructor"] is a function — truthy, not undefined, and it
    // walks straight through `?? null`. See verify-registry-lookups.ts.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      check(`"${key}" resolves to no provider`, carriageProviderFor(key), null);
    }

    assert("it can buy labels", providerCan("EASYPOST", "buysLabels"));
    assert("and receives tracking updates", providerCan("EASYPOST", "pushesTrackingUpdates"));
    assert(
      "and says plainly that it cannot void a label",
      providerCan("EASYPOST", "voidsLabels") === false,
      "declared false rather than left unimplemented — 'we chose not to' and 'it cannot' are different facts"
    );
    check("an unknown provider can do nothing", providerCan("SHIPPO", "buysLabels"), false);

    // ========================================================================
    console.log("\n=== 3. An update reaches the order it belongs to ===\n");
    // ========================================================================
    const tracked = await makeOrder("TRK-DELIVERED-1");
    const provider = carriageProviderFor("EASYPOST")!;

    const inTransit = provider.toShipment!(
      {
        tracking_code: "TRK-DELIVERED-1",
        carrier: "USPS",
        status: "in_transit",
        tracking_details: [
          { datetime: "2026-08-20T10:00:00Z", status: "in_transit", message: "Departed facility" },
        ],
      },
      null
    );
    check("an in-transit update lands", (await applyShipmentUpdate(inTransit)).updated, true);

    const afterTransit = await prisma.order.findUniqueOrThrow({ where: { id: tracked.id } });
    check("the status is recorded", afterTransit.shipmentStatus, "in_transit");
    assert("the scan time too", afterTransit.lastScanAt !== null, String(afterTransit.lastScanAt));
    check("and it is NOT delivered", afterTransit.deliveredAt, null);

    // Matched by tracking number, which is the only thing both sides share — a
    // carrier has never heard of a Genesis order id.
    const stranger = provider.toShipment!(
      { tracking_code: "TRK-NOBODY-HAS-THIS", status: "delivered" },
      null
    );
    check("an unknown parcel matches no order",
      await applyShipmentUpdate(stranger), { updated: false, reason: "no_matching_order" });
    assert(
      "which is normal rather than an error",
      true,
      "one carrier account can carry parcels this platform did not create"
    );

    const untracked = provider.toShipment!({ status: "delivered" }, null);
    check("a payload with no tracking code has nothing to match on",
      await applyShipmentUpdate(untracked), { updated: false, reason: "no_tracking_code" });

    // ========================================================================
    console.log("\n=== 4. Delivered means the carrier said so ===\n");
    // ========================================================================
    const delivered = provider.toShipment!(
      {
        tracking_code: "TRK-DELIVERED-1",
        carrier: "USPS",
        status: "delivered",
        tracking_details: [
          { datetime: "2026-08-21T14:30:00Z", status: "delivered", message: "Delivered, front porch" },
        ],
      },
      null
    );
    const outcome = await applyShipmentUpdate(delivered);
    check("the delivery lands", outcome, { updated: true, orderId: tracked.id, delivered: true });

    const arrived = await prisma.order.findUniqueOrThrow({ where: { id: tracked.id } });
    assert("and the order knows when", arrived.deliveredAt !== null, String(arrived.deliveredAt));
    check("with the carrier's own status", arrived.shipmentStatus, "delivered");

    // OUT-OF-ORDER WEBHOOKS ARE THE NORMAL CASE, not an edge one. Carriers
    // replay and reorder, and an order walking backwards out of "delivered" in
    // front of the owner is the failure this prevents.
    const late = provider.toShipment!(
      {
        tracking_code: "TRK-DELIVERED-1",
        status: "in_transit",
        tracking_details: [
          { datetime: "2026-08-20T08:00:00Z", status: "in_transit", message: "An earlier scan, arriving late" },
        ],
      },
      null
    );
    check("an older scan is refused", await applyShipmentUpdate(late), { updated: false, reason: "stale" });

    const stillArrived = await prisma.order.findUniqueOrThrow({ where: { id: tracked.id } });
    check("the delivery is not undone", stillArrived.deliveredAt?.toISOString(), arrived.deliveredAt?.toISOString());
    check("nor is the status walked backwards", stillArrived.shipmentStatus, "delivered");
    assert(
      "so a replayed webhook cannot un-deliver a parcel",
      stillArrived.deliveredAt !== null,
      "carriers reorder and replay; delivery is terminal here"
    );

    // ========================================================================
    console.log("\n=== 5. The lifecycle, every stage from something real ===\n");
    // ========================================================================
    const stage = (over: Partial<Parameters<typeof stageOf>[0]>) =>
      stageOf({
        status: "paid",
        fulfillmentStatus: "unfulfilled",
        trackingNumber: null,
        deliveredAt: null,
        ...over,
      });

    check("money arrived and nothing since", stage({}), "paid");
    check("the owner marked it fulfilled by hand", stage({ fulfillmentStatus: "fulfilled" }), "processing");
    check("a label exists, so it is really in the post", stage({ trackingNumber: "TRK-1" }), "shipped");
    check("the carrier said it arrived", stage({ trackingNumber: "TRK-1", deliveredAt: new Date() }), "delivered");
    check("and a reversal outranks all of it", stage({ status: "refunded", deliveredAt: new Date() }), "refunded");

    // DELIVERED BEATS SHIPPED, which is only true because delivery is read
    // from the carrier rather than assumed from the label.
    assert(
      "a delivered parcel does not read as merely shipped",
      stage({ trackingNumber: "TRK-1", deliveredAt: new Date() }) === "delivered",
      "the whole point of the ingestion"
    );

    // Every stage the type allows has a label an owner can read.
    for (const s of ["paid", "processing", "shipped", "delivered", "refunded"] as OrderStage[]) {
      const label = STAGE_LABEL[s];
      assert(`"${s}" reads as something a person would say`,
        typeof label === "string" && label.length > 0 && !label.includes("_"), String(label));
    }

    // AND NO STAGE THAT CANNOT HAPPEN. Every Order row in this system is
    // created by a completed payment, so an unpaid order has never existed —
    // and a stage that can never occur reads as a real one and misleads.
    assert(
      "there is no unreachable 'new' stage",
      !Object.keys(STAGE_LABEL).includes("new"),
      "a lifecycle with a stage nothing can be in is a lifecycle that lies"
    );

    // ========================================================================
    console.log("\n=== 6. Nothing is inferred from the passage of time ===\n");
    // ========================================================================
    const silent = await makeOrder("TRK-NO-SCANS-YET");
    const noScans = provider.toShipment!(
      { tracking_code: "TRK-NO-SCANS-YET", carrier: "USPS", status: "pre_transit", tracking_details: [] },
      null
    );
    await applyShipmentUpdate(noScans);
    const quiet = await prisma.order.findUniqueOrThrow({ where: { id: silent.id } });
    check("a parcel with no scans has no scan time", quiet.lastScanAt, null);
    check("and no delivery time", quiet.deliveredAt, null);
    check("but its status is still recorded honestly", quiet.shipmentStatus, "pre_transit");
    assert(
      "so 'we have not heard' is never dressed up as 'not delivered yet'",
      quiet.lastScanAt === null && quiet.shipmentStatus === "pre_transit",
      "the order date never stands in for a scan that has not happened"
    );
  } finally {
    await prisma.store.deleteMany({ where: { id: store.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
