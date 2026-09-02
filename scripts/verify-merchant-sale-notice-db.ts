import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { runDueOrderNotifications } from "@/lib/orders/notificationSweep";
import { buildOwnerSaleEmail, notifyOwnerOfSale } from "@/lib/orders/notifyOwnerOfSale";
import { notificationJobKey } from "@/lib/orders/notificationJobs";
import { orderUrl, emailOrigin } from "@/lib/email/origin";
import { readFileSync } from "node:fs";

// THE MERCHANT FINDS OUT THEY MADE A SALE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts merchant-sale-notice-db
//
// ============ WHAT WAS ALREADY RIGHT (2026-09-01) ======================
//
// notifyOwnerOfSale has existed since 2026-08-22 and is careful: it checks the
// email configuration BEFORE claiming, claims `ownerNotifiedAt` with a
// conditional update, and wraps the send in runOnce so a redelivered webhook
// cannot tell somebody twice. None of that needed changing.
//
// ============ AND THE ONE THING IT NEVER HAD ==========================
//
// A backstop. It was called inline from the Stripe handler and the PayPal
// return route, and NOTHING enqueued `ownerSale` or looked for an order whose
// claim was still null — the sweep's own header listed `ownerNotifiedAt` as
// deliberately out of scope, on reasoning true of shipping notices and not of
// this one. So a process that died between recording the order and sending the
// email lost the merchant's notification permanently.
//
// The three CUSTOMER notifications all had the retry this one lacked, and the
// merchant is the person with work to do.

let failures = 0;
let passes = 0;
const failed: string[] = [];
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const OLD = new Date(Date.now() - 60 * 60 * 1000);

let seq = 0;
async function makeStore(stamp: number) {
  const n = ++seq;
  const user = await prisma.user.create({
    data: { email: `owner-${stamp}-${n}@example.test`, name: "Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `msn-${stamp}-${n}`, tagline: "t", description: "d" },
  });
  return { user, store };
}

let orderSeq = 0;
async function order(storeId: string, stamp: number, o: { status?: string; ownerNotifiedAt?: Date | null; createdAt?: Date } = {}) {
  const n = ++orderSeq;
  return prismaSystem.order.create({
    data: {
      storeId, productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet",
      quantity: 2, amountInCents: 4783, buyerEmail: `buyer-${stamp}-${n}@example.test`,
      paymentProvider: "STRIPE", externalOrderId: `cs_msn_${stamp}_${n}`,
      status: o.status ?? "paid",
      ownerNotifiedAt: o.ownerNotifiedAt ?? null,
      createdAt: o.createdAt ?? OLD,
      shippingAddress: { name: "Rooney Barreto", line1: "2127 33RD ST", city: "ASTORIA", postalCode: "11105", country: "US" },
    },
  });
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const sent: { to: string; subject: string; html: string }[] = [];
  const sender = async (m: { to: string; subject: string; html: string }) => {
    sent.push(m);
  };

  console.log("\n--- nothing is sent until an email provider is configured ---\n");
  {
    // Sean: "Do not send customer or merchant emails until the external email
    // provider is configured." The harness has no RESEND_API_KEY, so this is
    // the real production state rather than a simulated one.
    const { store } = await makeStore(stamp);
    await order(store.id, stamp);

    const result = await runDueOrderNotifications(new Date(), sender);
    eq("the sweep reports it skipped", result.skipped, true);
    eq("and queued no merchant notice", result.ownerSales, 0);
    eq("nothing was sent", sent.length, 0);

    const outcome = await notifyOwnerOfSale({ orderId: (await prismaSystem.order.findFirst({ where: { storeId: store.id } }))!.id, storeId: store.id }, sender);
    eq("and calling it directly refuses for the same reason", outcome, { sent: false, reason: "email_not_configured" });
    eq("without claiming the order",
      (await prismaSystem.order.findFirst({ where: { storeId: store.id } }))!.ownerNotifiedAt, null);
  }

  console.log("\n--- with a provider configured, a paid order queues a merchant notice ---\n");
  const original = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM_ADDRESS;
  process.env.RESEND_API_KEY = "re_harness_not_a_real_key";
  // AND THE BACKSTOP MUST BE AUTHORISED TO REACH BACK (2026-09-02).
  // Turning email on no longer authorises the sweep to sweep history —
  // EMAIL_NOTIFICATIONS_START_AT is a second, independent switch, and
  // without it the sweep correctly reaches back for nothing. Set generously
  // here so these fixtures' own orders are inside it; the horizon's own
  // behaviour is asserted in verify-order-notifications-db.ts section 6.
  process.env.EMAIL_NOTIFICATIONS_START_AT = new Date(0).toISOString();
  process.env.EMAIL_FROM_ADDRESS = "genesis@example.test";
  try {
    const { store } = await makeStore(stamp);
    const paid = await order(store.id, stamp);

    const result = await runDueOrderNotifications(new Date(), sender);
    assert("the sweep now runs", result.skipped === false);
    assert("and queues at least this one", result.ownerSales >= 1, String(result.ownerSales));

    // ============ THE DURABLE INFRASTRUCTURE, NOT A SEND ==========
    //
    // The sweep hands the work to the queue rather than sending inline, so a
    // failure retries instead of waiting a full day for the next tick.
    const job = await prismaSystem.job.findUnique({
      where: { idempotencyKey: notificationJobKey("ownerSale", paid.id) },
    });
    assert("a durable job exists for it", !!job, "no job was enqueued");
    eq("of the notification kind", job?.kind, "notification.order");
    eq("carrying the business", job?.storeId, store.id);
    eq("and it is retryable rather than fire-and-forget", (job?.maxAttempts ?? 0) > 1, true);

    console.log("\n--- queuing it twice does not notify twice ---\n");
    const again = await runDueOrderNotifications(new Date(), sender);
    eq("the second sweep queues nothing new", again.ownerSales, 0);
    eq("and there is still exactly one job",
      await prismaSystem.job.count({ where: { idempotencyKey: notificationJobKey("ownerSale", paid.id) } }), 1);

    console.log("\n--- an order already announced is left alone ---\n");
    const { store: s2 } = await makeStore(stamp);
    const told = await order(s2.id, stamp, { ownerNotifiedAt: new Date() });
    const third = await runDueOrderNotifications(new Date(), sender);
    eq("no job for an order whose owner was already told",
      await prismaSystem.job.count({ where: { idempotencyKey: notificationJobKey("ownerSale", told.id) } }), 0);
    void third;

    console.log("\n--- only a real sale counts ---\n");
    {
      // ============ MONEY THAT WENT BACK IS NOT A SALE ==========
      const { store: s3 } = await makeStore(stamp);
      const refunded = await order(s3.id, stamp, { status: "refunded" });
      const disputed = await order(s3.id, stamp, { status: "disputed" });
      await runDueOrderNotifications(new Date(), sender);
      eq("a refunded order raises no merchant sale notice",
        await prismaSystem.job.count({ where: { idempotencyKey: notificationJobKey("ownerSale", refunded.id) } }), 0);
      eq("nor a disputed one",
        await prismaSystem.job.count({ where: { idempotencyKey: notificationJobKey("ownerSale", disputed.id) } }), 0);
    }

    console.log("\n--- and an order recorded moments ago is given time first ---\n");
    {
      // The inline path is the primary sender. The backstop must not race it,
      // or every order gets a job it never needed.
      const { store: s4 } = await makeStore(stamp);
      const fresh = await order(s4.id, stamp, { createdAt: new Date() });
      await runDueOrderNotifications(new Date(), sender);
      eq("a brand-new order is not swept yet",
        await prismaSystem.job.count({ where: { idempotencyKey: notificationJobKey("ownerSale", fresh.id) } }), 0);
    }
  } finally {
    if (original === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = original;
    if (originalFrom === undefined) delete process.env.EMAIL_FROM_ADDRESS;
    else process.env.EMAIL_FROM_ADDRESS = originalFrom;
  }

  console.log("\n--- the merchant's email says a sale happened and how to reach it ---\n");
  {
    const email = buildOwnerSaleEmail({
      ownerEmail: "owner@example.test",
      store: { name: "Cubit & Coil", currency: "USD", slug: "cubit-and-coil" },
      order: {
        id: "order_abc123", productName: "Copper Tensor Ring Cuff", quantity: 2,
        amountInCents: 4783, buyerEmail: "rooney@example.test",
        externalOrderId: "cs_live_xyz",
        shippingAddress: { name: "Rooney Barreto", line1: "2127 33RD ST", city: "ASTORIA", postalCode: "11105", country: "US" },
      },
    });

    assert("the subject says a sale happened", /New order/.test(email.subject), email.subject);
    assert("with the product", /Copper Tensor Ring Cuff/.test(email.subject), email.subject);
    assert("and the money, so a phone lock screen is enough",
      /\$47\.83/.test(email.subject), email.subject);
    assert("it goes to the owner", email.to === "owner@example.test");
    assert("the body names the customer", /rooney@example\.test/.test(email.html));
    assert("and where it is going", /2127 33RD ST/.test(email.html));
  }

  console.log("\n--- the link goes to the order, in the right business ---\n");
  {
    const originalUrl = process.env.NEXTAUTH_URL;
    try {
      process.env.NEXTAUTH_URL = "https://genesis.example.test/";
      eq("a trailing slash does not double up",
        orderUrl("cubit-and-coil", "order_abc123"),
        "https://genesis.example.test/b/cubit-and-coil/orders/order_abc123");

      // ============ THE BUSINESS IS IN THE PATH =================
      //
      // /dashboard/orders/:id resolves whichever business the ACCOUNT last made
      // active, so a link sent about one business can open in another or bounce
      // to the chooser. A link in an email has to name the business.
      const link = orderUrl("cubit-and-coil", "order_abc123")!;
      assert("the link names the business", link.includes("/b/cubit-and-coil/"), link);
      assert("and not the ambient route", !link.includes("/dashboard/orders"), link);

      const email = buildOwnerSaleEmail({
        ownerEmail: "owner@example.test",
        store: { name: "Cubit & Coil", currency: "USD", slug: "cubit-and-coil" },
        order: {
          id: "order_abc123", productName: "Cuff", quantity: 1, amountInCents: 3232,
          buyerEmail: "b@example.test", externalOrderId: "cs_live_xyz", shippingAddress: null,
        },
      });
      assert("the email carries it", email.html.includes(link), email.html);
      assert("as a way in, not a bare string", /<a href=/.test(email.html), email.html);

      // ============ AND IS OMITTED RATHER THAN GUESSED ==========
      delete process.env.NEXTAUTH_URL;
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      eq("with no origin configured there is no link", emailOrigin(), null);
      const linkless = buildOwnerSaleEmail({
        ownerEmail: "owner@example.test",
        store: { name: "Cubit & Coil", currency: "USD", slug: "cubit-and-coil" },
        order: {
          id: "order_abc123", productName: "Cuff", quantity: 1, amountInCents: 3232,
          buyerEmail: "b@example.test", externalOrderId: "cs_live_xyz", shippingAddress: null,
        },
      });
      assert("and the email simply has none", !/<a href=/.test(linkless.html), linkless.html);
      assert("rather than a broken one", !/href="\/|href="undefined/.test(linkless.html), linkless.html);
      assert("the rest of it survives", /Cuff/.test(linkless.html));
    } finally {
      if (originalUrl === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = originalUrl;
    }
  }

  console.log("\n--- merchant and customer notices are separate things ---\n");
  {
    // Sean: "a new-sale notification to the merchant is a separate required
    // event from the customer's order confirmation/shipping emails."
    const sweep = readFileSync("lib/orders/notificationSweep.ts", "utf8");
    const code = sweep.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert("the sweep counts merchant notices on their own", /ownerSales/.test(code));
    assert("separately from customer confirmations", /confirmations/.test(code));
    assert("and claims them on a different column", /ownerNotifiedAt/.test(code));
    // Different keys, so one can never satisfy the other.
    assert("their queue keys cannot collide",
      notificationJobKey("ownerSale", "x") !== notificationJobKey("confirmation", "x"));
  }

  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "owner-" } } });
  await prismaSystem.job.deleteMany({ where: { idempotencyKey: { contains: ":cm" } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
