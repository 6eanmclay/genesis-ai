import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { readFileSync } from "fs";
import { join } from "path";

// A MERCHANT WHO ALREADY HAS A TRACKING NUMBER CAN USE IT:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-attach-tracking.ts" -OutFile out.txt
//
// Fulfilment MVP. Tracking could only ever be written by purchasing a label
// through a carrier API, so on a deployment with no carrier account every paid
// order sat at "paid" forever and the buyer was never told anything. The chain
// was not broken — it had one entrance and that entrance was locked.
//
// This is the other entrance: the merchant buys postage wherever they already
// do, and gives Genesis the number. Most of what follows is about the two ways
// that can go wrong with somebody's real shipment — writing over tracking a
// buyer is already watching, and telling them twice.
//
// BRINGS ITS OWN POSTGRES, and is therefore NOT in the shared runner — the same
// arrangement verify-owner-facts and verify-conversations already use. Added as
// the 43rd shared suite, the two suites that ran after it failed with
// "Connection terminated unexpectedly", and removing it returned the run to
// 42/42. Releasing the pool at the end did not help, so the cost is cumulative
// across the run rather than this suite holding anything: 43 is simply past
// what the shared harness carries. A green shared count does not include this
// file, so it has to be run.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const uniq = () => Math.random().toString(36).slice(2, 10);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  // Imported after the database is pointed at, so the client binds to it.
  const { prisma } = await import("@/lib/prisma");
  const { attachTrackingExecutable, trackingUrlFor, isPlausibleTrackingNumber } = await import(
    "@/lib/execution/executables/attachTracking"
  );

  const owner = await prisma.user.create({ data: { email: `tr-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `tr-${uniq()}` },
  });
  const ctx = { storeId: store.id } as never;

  const newOrder = () =>
    prisma.order.create({
      data: {
        storeId: store.id, productName: "Tensor Ring", quantity: 1, amountInCents: 2999,
        buyerEmail: `buyer-${uniq()}@test.local`, status: "paid", paymentProvider: "STRIPE",
        externalOrderId: `ext-${uniq()}`,
      } as never,
    });

  // ========================================================================
  console.log("\n=== 1. What may be stored ===\n");
  // ========================================================================
  assert("a real USPS number is accepted", isPlausibleTrackingNumber("9400111899223197428490"));
  assert("so is one with spaces, as printed on a label",
    isPlausibleTrackingNumber("9400 1118 9922 3197 4284 90"));
  assert("and a hyphenated carrier format", isPlausibleTrackingNumber("1Z-999AA1-0123456784"));
  assert("empty is refused", !isPlausibleTrackingNumber(""));
  assert("and whitespace is refused", !isPlausibleTrackingNumber("      "));
  assert("something far too short is refused", !isPlausibleTrackingNumber("123"));
  assert("and a scan that picked up a URL is refused",
    !isPlausibleTrackingNumber("https://example.com/label.pdf"),
    "a busy label carries several barcodes and not all of them are the tracking one");

  // ========================================================================
  console.log("\n=== 2. A tracking URL is built only when it can be honest ===\n");
  // ========================================================================
  eq("USPS gets its own public tracking page",
    trackingUrlFor("USPS", "9400111899223197428490"),
    "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490");
  eq("case does not matter", Boolean(trackingUrlFor("usps", "94001118")), true);
  eq("a carrier we cannot build a URL for gets none, rather than a guess",
    trackingUrlFor("Some Local Courier", "ABC123456"), null);
  assert("CONTROL: and the number is url-encoded",
    (trackingUrlFor("USPS", "94 00 11") ?? "").includes("94%2000%2011"),
    "a number with spaces must not break the link");

  // ========================================================================
  console.log("\n=== 3. Attaching it moves the order ===\n");
  // ========================================================================
  const order = await newOrder();
  const result = await attachTrackingExecutable.run(
    { orderId: order.id, trackingNumber: "9400111899223197428490", carrier: "USPS" },
    ctx
  );
  const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  eq("the number is stored", after.trackingNumber, "9400111899223197428490");
  eq("with the carrier", after.carrier, "USPS");
  eq("and a tracking URL the buyer can follow",
    after.trackingUrl, "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490");
  eq("the order reads fulfilled", after.fulfillmentStatus, "fulfilled");
  assert("and carries the timestamp", after.fulfilledAt !== null,
    "a fulfilled order with no timestamp is a half-applied write");

  // EMAIL IS NOT CONFIGURED IN A TEST DATABASE, and the message says so rather
  // than implying the buyer was told.
  assert("the merchant is told the customer was NOT emailed",
    result.message.includes("NOT emailed"),
    result.message);
  assert("and told to send it themselves",
    result.message.includes("send them the number yourself"),
    "only the merchant can put that right, so the message has to ask them to");

  // AND THE EXECUTABLE ACTUALLY USES THE CHECK. Asserting the pure function
  // alone was green with the call site removed — the validator worked and
  // nothing consulted it.
  const junk = await newOrder();
  let rejected = "";
  try {
    await attachTrackingExecutable.run(
      { orderId: junk.id, trackingNumber: "https://example.com/label.pdf" }, ctx
    );
  } catch (e) {
    rejected = e instanceof Error ? e.message : String(e);
  }
  assert("run() refuses an implausible number rather than storing it",
    rejected.includes("does not look like a tracking number"), rejected);

  // ========================================================================
  console.log("\n=== 4. It never overwrites tracking a buyer may be watching ===\n");
  // ========================================================================
  let refused = "";
  try {
    await attachTrackingExecutable.run(
      { orderId: order.id, trackingNumber: "9400111899223197400000", carrier: "USPS" },
      ctx
    );
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  assert("a second number is refused", refused.includes("already has tracking"), refused);
  assert("and the refusal names the number on file",
    refused.includes("9400111899223197428490"),
    "so the merchant can see whether it is the one they meant");
  eq("the original is untouched",
    (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).trackingNumber,
    "9400111899223197428490");

  // ========================================================================
  console.log("\n=== 5. The buyer is never told twice ===\n");
  // ========================================================================
  const second = await newOrder();
  await attachTrackingExecutable.run(
    { orderId: second.id, trackingNumber: "9400111899223197411111" }, ctx
  );
  const notified = await prisma.order.findUniqueOrThrow({ where: { id: second.id } });
  // Email is unconfigured here, so the claim is RELEASED — which is what lets a
  // later retry still tell them once it is configured.
  eq("an unsendable notification releases its claim, so a retry can still send",
    notified.shipmentNotifiedAt, null);
  eq("carrier defaults to USPS when the merchant does not say", notified.carrier, "USPS");

  // ========================================================================
  console.log("\n=== 6. Tenant isolation ===\n");
  // ========================================================================
  const neighbour = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `tr-n-${uniq()}` },
  });
  let crossStore = "";
  try {
    await attachTrackingExecutable.run(
      { orderId: order.id, trackingNumber: "9400111899223197422222" },
      { storeId: neighbour.id } as never
    );
  } catch (e) {
    crossStore = e instanceof Error ? e.message : String(e);
  }
  assert("another business cannot attach tracking to this order",
    crossStore.includes("Order not found"), crossStore);

  // ========================================================================
  console.log("\n=== 7. Verification reads the row back ===\n");
  // ========================================================================
  const outcome = await attachTrackingExecutable.verify(
    { orderId: order.id, trackingNumber: "9400111899223197428490" },
    ctx,
    { orderId: order.id, trackingNumber: "9400111899223197428490", carrier: "USPS", customerNotified: false }
  );
  eq("a real write verifies", outcome.state, "verified");

  const wrong = await attachTrackingExecutable.verify(
    { orderId: order.id, trackingNumber: "x" }, ctx,
    { orderId: order.id, trackingNumber: "not-what-was-stored", carrier: "USPS", customerNotified: false }
  );
  eq("CONTROL: and a mismatch does not", wrong.state, "failed");

  // ========================================================================
  console.log("\n=== 8. The scanner is offered only where it works ===\n");
  // ========================================================================
  const panel = codeOnly(readFileSync(join(process.cwd(), "app", "dashboard", "orders", "AddTrackingPanel.tsx"), "utf8"));
  assert("browser support is detected before the button is shown",
    /"BarcodeDetector" in window/.test(panel) && /\{canScan &&/.test(panel),
    "iOS Safari has no BarcodeDetector, and a scan button that never detects anything " +
      "leaves a merchant assuming they are holding it wrong");
  assert("manual entry is never hidden behind the scanner",
    /placeholder="Tracking number"/.test(panel),
    "it is the path that always works");
  assert("a scan fills the box rather than submitting",
    /setTrackingNumber\(value\)/.test(panel) && /stopCamera\(\)/.test(panel),
    "a label carries several barcodes, so the merchant confirms what was read");
  assert("and the camera is released when the component goes away",
    /return \(\) => stopCamera\(\)/.test(panel),
    "a page left with a live camera is a light on somebody's phone that will not go out");

  await db.close();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
