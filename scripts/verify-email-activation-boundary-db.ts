import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { sendOrderConfirmation } from "@/lib/orders/orderConfirmation";
import { notifyOwnerOfSale } from "@/lib/orders/notifyOwnerOfSale";
import { runDueOrderNotifications } from "@/lib/orders/notificationSweep";
import { drain } from "@/lib/jobs/queue";
import { makeNotificationHandler } from "@/lib/orders/notificationJobs";

// THE DAY EMAIL IS SWITCHED ON, THE BACKLOG MUST STAY UNTOUCHED:
//
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/run-db-suites.ts email-activation-boundary" \
//     -OutFile "C:/Users/hyper/AppData/Local/Temp/genesis-activation.txt"
//
// ISOLATED DATABASE ONLY. Every send is injected; nothing reaches Resend, and
// the suite runs with no Resend account at all.
//
// ============ THE STATE THIS PINS (2026-09-24) =======================
//
// Production holds TWENTY paid orders, the oldest from 2026-07-19, with
// confirmationSentAt and ownerNotifiedAt null on every single one. Email has
// never been configured, so no customer has ever been told their order was
// received and the owner has never been told a sale happened.
//
// Activation is therefore not "turn email on". It is "turn email on for
// FUTURE orders without writing to twenty people about purchases they made
// weeks or months ago". Those two are separated by exactly one variable being
// absent, and this suite exists so that separation cannot be reversed by
// accident later.
//
//   RESEND_API_KEY + EMAIL_FROM_ADDRESS   -> inline sending works
//   EMAIL_NOTIFICATIONS_START_AT UNSET    -> the sweep selects nothing
//
// The pieces are each asserted elsewhere. What was NOT covered, and is
// covered here, is the two of them TOGETHER in one scenario: a historical
// order sitting unsent while a new one sends inline, under the exact
// configuration production will be in.
//
// SECTION 3 IS THE POINT. It proves the old order is genuinely SELECTABLE —
// that the sweep would reach it the moment a horizon appeared — so section 2
// is evidence of protection rather than evidence of a broken sweep.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  // Looks configured. The values are never used: every call injects a sender.
  process.env.RESEND_API_KEY = "harness-not-a-real-key";
  process.env.EMAIL_FROM_ADDRESS = "orders@harness.test";
  // THE WHOLE INVARIANT. Absent, exactly as production will be.
  delete process.env.EMAIL_NOTIFICATIONS_START_AT;

  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const user = await prisma.user.create({ data: { email: `act-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `act-${stamp}`, tagline: "t", description: "d" },
  });

  const sent: string[] = [];
  const record = async (input: { to: string }) => {
    sent.push(input.to);
  };

  let seq = 0;
  async function makeOrder(createdAt: Date) {
    seq++;
    return prisma.order.create({
      data: {
        storeId: store.id,
        productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet",
        quantity: 1,
        amountInCents: 28585,
        buyerEmail: `buyer-${stamp}-${seq}@example.test`,
        status: "paid",
        paymentProvider: "STRIPE",
        externalOrderId: `cs_test_${stamp}_${seq}`,
        createdAt,
      },
    });
  }

  // Stands for the twenty real ones: paid weeks ago, never told.
  const historical = await makeOrder(new Date(Date.now() - 60 * DAY));

  console.log("\n=== 1. THE BACKLOG IS REAL BEFORE WE START ===\n");
  {
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: historical.id },
      select: { confirmationSentAt: true, ownerNotifiedAt: true, status: true },
    });
    eq("an old PAID order with nobody told", row,
      { confirmationSentAt: null, ownerNotifiedAt: null, status: "paid" });
    assert("  and email is configured", !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM_ADDRESS);
    eq("  while the horizon is absent", process.env.EMAIL_NOTIFICATIONS_START_AT, undefined);
  }

  console.log("\n=== 2. ACTIVATION: new order sends, old order is not swept ===\n");
  {
    const before = sent.length;

    // (a) The sweep, in exactly the production state. It must select nothing.
    const swept = await runDueOrderNotifications(new Date(), record);
    eq("the sweep refuses for want of a horizon", swept,
      { confirmations: 0, deliveries: 0, refunds: 0, ownerSales: 0, skipped: true, skipReason: "no_horizon" });

    const afterSweep = await prisma.order.findUniqueOrThrow({
      where: { id: historical.id },
      select: { confirmationSentAt: true, ownerNotifiedAt: true },
    });
    eq("  the 60-day-old order was NOT written to", afterSweep,
      { confirmationSentAt: null, ownerNotifiedAt: null });
    eq("  and nothing was sent to anyone at all", sent.length, before);

    // (b) A NEW purchase, same moment, same configuration. It must send.
    const fresh = await makeOrder(new Date());
    const confirmation = await sendOrderConfirmation({ orderId: fresh.id, storeId: store.id }, record);
    eq("a NEW order still gets its receipt inline", confirmation, { sent: true });

    const owner = await notifyOwnerOfSale({ orderId: fresh.id, storeId: store.id }, record);
    assert("  and the owner is told about the sale", owner.sent === true, JSON.stringify(owner));

    eq("  two emails went out, both about the new order", sent.length, before + 2);
    assert("  neither of them went to the historical buyer",
      !sent.slice(before).includes(historical.buyerEmail),
      `sent: ${JSON.stringify(sent.slice(before))}`);

    const freshRow = await prisma.order.findUniqueOrThrow({
      where: { id: fresh.id },
      select: { confirmationSentAt: true, ownerNotifiedAt: true },
    });
    assert("  and the new order is truthfully claimed",
      freshRow.confirmationSentAt !== null && freshRow.ownerNotifiedAt !== null);

    // THE INVARIANT, STATED AS ONE SENTENCE.
    const stillUntold = await prisma.order.findUniqueOrThrow({
      where: { id: historical.id },
      select: { confirmationSentAt: true },
    });
    assert("*** INVARIANT: email on, horizon absent -> future yes, history no ***",
      stillUntold.confirmationSentAt === null && freshRow.confirmationSentAt !== null,
      "this is the entire safety property of the activation");
  }

  console.log("\n=== 3. SABOTAGE: the old order IS reachable, if a horizon appears ===\n");
  {
    // Without this, section 2 would pass just as well for a sweep that has
    // silently stopped working -- which is the failure this change could most
    // easily become. Setting a horizon behind the old order must pick it up.
    const before = sent.length;
    process.env.EMAIL_NOTIFICATIONS_START_AT = new Date(Date.now() - 90 * DAY).toISOString();

    const swept = await runDueOrderNotifications(new Date(), record);
    assert("SABOTAGE CAUGHT: a backdated horizon DOES select the old order",
      swept.skipped === false && swept.confirmations >= 1,
      JSON.stringify(swept));

    // THE SWEEP QUEUES, IT DOES NOT SEND. Its counts are what was handed to
    // the durable queue; whether an email left is the job's outcome. Draining
    // here is what turns "it was selected" into "that customer was written
    // to", which is the thing that must never happen to the backlog.
    await drain({ "notification.order": makeNotificationHandler(record) }, { maxJobs: 50 });
    assert("  and once drained, the old buyer really IS written to",
      sent.slice(before).includes(historical.buyerEmail),
      `sent after sabotage: ${JSON.stringify(sent.slice(before))}`);

    // Restore the production state immediately, and prove it took.
    delete process.env.EMAIL_NOTIFICATIONS_START_AT;
    const reSwept = await runDueOrderNotifications(new Date(), record);
    eq("  removing the horizon closes it again", reSwept.skipReason, "no_horizon");

    assert("  so section 2 measured protection, not a broken sweep",
      swept.confirmations >= 1 && reSwept.confirmations === 0,
      `with horizon: ${swept.confirmations}, without: ${reSwept.confirmations}`);
  }

  console.log("\n=== 4. A TYPO MUST NOT BECOME THE BEGINNING OF TIME ===\n");
  {
    // An unparseable date resolving to 1970 would sweep the entire backlog.
    // It has to fail closed, identically to unset.
    for (const bad of ["yesterday please", "", "   ", "not-a-date", "2026-13-45"]) {
      process.env.EMAIL_NOTIFICATIONS_START_AT = bad;
      const r = await runDueOrderNotifications(new Date(), record);
      assert(`  ${JSON.stringify(bad)} -> fails closed`,
        r.skipped === true && r.skipReason === "no_horizon",
        JSON.stringify(r));
    }
    delete process.env.EMAIL_NOTIFICATIONS_START_AT;
  }

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
