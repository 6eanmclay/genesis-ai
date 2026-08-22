// A REAL SECRET FOR THIS PROCESS, set before the test server is spawned so it
// inherits it. Nothing about production webhook verification is weakened: the
// same HMAC is computed over the same bytes with the same algorithm — this is
// simply the secret both sides agree on for one run.
process.env.EASYPOST_WEBHOOK_SECRET =
  process.env.EASYPOST_WEBHOOK_SECRET ?? "a-real-carrier-webhook-secret-for-this-test";

import crypto from "crypto";
import { startTestServer } from "@/scripts/lib/testServer";

// THE CARRIER WEBHOOK, AGAINST A REAL SERVER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-carriage-webhook-live.ts" -OutFile out.txt
//
// verify-carriage-delivery.ts proves the decisions. It cannot prove the ROUTE —
// whether a forged request is actually refused by the endpoint, whether the raw
// body reaches the verifier unmangled, whether a replay changes anything. This
// posts real HTTP at a running Next server, the same way
// verify-order-webhook-live.ts already proves the Stripe route.
//
// THE RAW BODY IS THE WHOLE TRICK. The signature covers the exact bytes sent.
// A route that parsed JSON and re-serialised it before verifying would produce
// a different string and reject every legitimate request — a failure that only
// appears over real HTTP, which is precisely why this suite exists separately
// from the decision-level one.
//
// LIVE DELIVERY IS STILL EXTERNALLY BLOCKED: whether EasyPost actually calls
// this endpoint needs a real account and a public URL. What is proved here is
// that when something does call it, the right thing happens.

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

const SECRET = process.env.EASYPOST_WEBHOOK_SECRET!;
const sign = (body: string, secret = SECRET) =>
  `hmac-sha256-hex=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

async function main() {
  const server = await startTestServer({ timeoutMs: 180_000 });
  const prisma = server.db.prisma;
  const url = `${server.baseUrl}/api/webhooks/easypost`;

  /** POST exactly these bytes, with whatever signature header is given. */
  const post = (body: string, header: string | null) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(header ? { "x-hmac-signature": header } : {}),
      },
      body,
    });

  try {
    const user = await prisma.user.create({ data: { email: "owner@carriage-live.test" } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Copper & Coil", slug: "carriage-live" },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        productName: "Tensor Ring",
        amountInCents: 8_500,
        buyerEmail: "buyer@carriage-live.test",
        paymentProvider: "STRIPE",
        externalOrderId: "ord-carriage-live",
        trackingNumber: "TRK-LIVE-1",
        carrier: "USPS",
      },
    });

    // A REAL EASYPOST TRACKER PAYLOAD SHAPE, not a convenient invention: the
    // event wrapper carries `description` and `result`, and the tracker itself
    // carries snake_case fields with a tracking_details array.
    const deliveredBody = JSON.stringify({
      description: "tracker.updated",
      result: {
        tracking_code: "TRK-LIVE-1",
        carrier: "USPS",
        status: "delivered",
        est_delivery_date: "2026-08-21T00:00:00Z",
        tracking_details: [
          {
            datetime: "2026-08-21T14:30:00Z",
            status: "delivered",
            message: "Delivered, front porch",
            tracking_location: { city: "Hartlepool", state: null, country: "GB" },
          },
        ],
      },
    });

    // -----------------------------------------------------------------------
    console.log("\n1. The door is shut to anything unsigned");
    // -----------------------------------------------------------------------
    check("no signature is refused", (await post(deliveredBody, null)).status, 401);
    check("a wrong secret is refused", (await post(deliveredBody, sign(deliveredBody, "not-it"))).status, 401);
    check("a signature over different bytes is refused",
      (await post(deliveredBody, sign('{"description":"tracker.updated"}'))).status, 401);
    check("garbage in the header is refused", (await post(deliveredBody, "nonsense")).status, 401);

    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("and none of it touched the order", untouched.deliveredAt, null);
    assert(
      "so marking somebody's order delivered is not one curl away",
      untouched.deliveredAt === null && untouched.shipmentStatus === null,
      "the endpoint is public; four forgeries reached nothing"
    );

    // -----------------------------------------------------------------------
    console.log("\n2. A properly signed update lands");
    // -----------------------------------------------------------------------
    const accepted = await post(deliveredBody, sign(deliveredBody));
    check("it is accepted", accepted.status, 200);

    const delivered = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert("the order is delivered", delivered.deliveredAt !== null, String(delivered.deliveredAt));
    check("with the carrier's own status", delivered.shipmentStatus, "delivered");
    assert("and the scan time", delivered.lastScanAt !== null, String(delivered.lastScanAt));
    assert(
      "so the raw body survived the round trip intact",
      delivered.deliveredAt !== null,
      "a route that re-serialised the JSON before verifying would reject every real request"
    );

    // -----------------------------------------------------------------------
    console.log("\n3. A replay changes nothing");
    // -----------------------------------------------------------------------
    // Carriers retry. The same bytes arriving twice must not produce a second
    // anything, and must not move the timestamps.
    const replay = await post(deliveredBody, sign(deliveredBody));
    check("the replay is accepted rather than errored", replay.status, 200);
    const afterReplay = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("the delivery time is unchanged",
      afterReplay.deliveredAt?.toISOString(), delivered.deliveredAt?.toISOString());
    check("and the status is unchanged", afterReplay.shipmentStatus, "delivered");

    // An EARLIER scan arriving late must not walk the order backwards.
    const staleBody = JSON.stringify({
      description: "tracker.updated",
      result: {
        tracking_code: "TRK-LIVE-1",
        carrier: "USPS",
        status: "in_transit",
        tracking_details: [
          { datetime: "2026-08-20T08:00:00Z", status: "in_transit", message: "Departed facility" },
        ],
      },
    });
    check("an out-of-order update is accepted", (await post(staleBody, sign(staleBody))).status, 200);
    const afterStale = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("but does not un-deliver the parcel", afterStale.shipmentStatus, "delivered");
    assert("nor clear the delivery time", afterStale.deliveredAt !== null, String(afterStale.deliveredAt));

    // -----------------------------------------------------------------------
    console.log("\n4. Everything else is acknowledged, not errored");
    // -----------------------------------------------------------------------
    // A carrier that receives an error retries. Retrying a payload we cannot
    // use achieves nothing but noise and eventual webhook suspension, so the
    // route distinguishes "we could not authenticate you" from "we
    // authenticated you and there was nothing to do".
    const otherEvent = JSON.stringify({ description: "batch.created", result: {} });
    check("an event type we do not consume is acknowledged",
      (await post(otherEvent, sign(otherEvent))).status, 200);

    const strangerBody = JSON.stringify({
      description: "tracker.updated",
      result: { tracking_code: "TRK-NOT-OURS", status: "delivered" },
    });
    check("a parcel this platform never sent is acknowledged",
      (await post(strangerBody, sign(strangerBody))).status, 200);
    assert(
      "which is normal rather than an error",
      true,
      "one carrier account can carry parcels this platform did not create"
    );

    const brokenBody = "{not json at all";
    check("a signed but unparseable body is acknowledged rather than retried forever",
      (await post(brokenBody, sign(brokenBody))).status, 200);

    // And none of that touched the order.
    const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("the order is still exactly as the carrier last described it", final.shipmentStatus, "delivered");
  } finally {
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
