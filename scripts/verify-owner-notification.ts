import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { notifyOwnerOfSale, buildOwnerSaleEmail } from "@/lib/orders/notifyOwnerOfSale";

// TELLING THE OWNER A SALE HAPPENED:
//
//   npx tsx scripts/run-db-suites.ts
//
// P1.8 of the Cubit & Coil Live milestone names four notifications: "order
// confirmation, payment confirmation, shipping confirmation, tracking
// (customer); new-order notification (owner)." The three customer ones existed.
// The owner one did not, so the chain the milestone is defined by — "purchase →
// pay → order is recorded → I RECEIVE THE ORDER" — had a gap at the arrow that
// matters most to the person running the shop. An order arrived, the customer
// was thanked, and the owner found out by opening the dashboard and looking.
//
// SENDING IS EXTERNALLY BLOCKED and stays so: there is no RESEND_API_KEY here,
// and per this project's standing rule the real dependency is never mocked. But
// the sender is INJECTABLE, exactly as sendOrderConfirmation's is, so every
// decision — whether to send, to whom, what it says, and whether a redelivery
// sends again — is provable without a provider existing. That is the half that
// can be wrong in a way nobody notices.
//
// IDEMPOTENCY IS A CLAIM, NOT A CHECK, and it is the assertion that matters
// most: `ownerNotifiedAt` is won by a conditional update that only matches
// while it is still null. A check-then-send would let two deliveries of the
// same Stripe event both pass the check and email the owner twice.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  await requireTestDatabase(prismaSystem);

  // The real configuration gate reads env. Set for the duration so the decision
  // path under test is reachable; nothing is ever actually sent, because every
  // call below injects its own sender.
  const priorKey = process.env.RESEND_API_KEY;
  const priorFrom = process.env.EMAIL_FROM_ADDRESS;
  process.env.RESEND_API_KEY = "test-key-never-used";
  process.env.EMAIL_FROM_ADDRESS = "genesis@test.local";

  const user = await prisma.user.create({
    data: { email: "owner@notify.test", name: "Owner" },
  });
  const stores: string[] = [];

  const store = async (userId: string, currency = "GBP") => {
    const created = await prisma.store.create({
      data: { userId, name: "Copper & Coil", slug: `notify-${Math.random().toString(36).slice(2)}`, currency },
    });
    stores.push(created.id);
    return created;
  };

  const order = async (storeId: string, over: Record<string, unknown> = {}) =>
    prisma.order.create({
      data: {
        storeId,
        productName: "Tensor Ring",
        quantity: 1,
        amountInCents: 8_500,
        buyerEmail: "buyer@notify.test",
        paymentProvider: "STRIPE",
        externalOrderId: `ord-${Math.random().toString(36).slice(2)}`,
        ...over,
      },
    });

  try {
    const mine = await store(user.id);

    // ========================================================================
    console.log("\n=== 1. The owner is told, once ===\n");
    // ========================================================================
    const sold = await order(mine.id);
    const sent: { to: string; subject: string; html: string }[] = [];
    const sender = async (input: { to: string; subject: string; html: string }) => {
      sent.push(input);
    };

    const first = await notifyOwnerOfSale({ orderId: sold.id, storeId: mine.id }, sender);
    check("a new order notifies the owner", first.sent === true, JSON.stringify(first));
    check("exactly one email", sent.length === 1, String(sent.length));
    check("to the owner's own address", sent[0]?.to === "owner@notify.test", String(sent[0]?.to));

    // THE ASSERTION THAT MATTERS. A redelivered webhook must not send again.
    const second = await notifyOwnerOfSale({ orderId: sold.id, storeId: mine.id }, sender);
    check("a redelivery is refused as already sent",
      second.sent === false && second.reason === "already_sent", JSON.stringify(second));
    check("and no second email is produced", sent.length === 1, String(sent.length));
    check(
      "so two deliveries of one Stripe event cannot both tell the owner",
      sent.length === 1,
      "a check-then-send would let both pass the check"
    );

    const marked = await prisma.order.findUniqueOrThrow({ where: { id: sold.id } });
    check("the order records that the owner was told", marked.ownerNotifiedAt !== null,
      String(marked.ownerNotifiedAt));

    // ========================================================================
    console.log("\n=== 2. A failure releases the claim, so a retry can work ===\n");
    // ========================================================================
    // Marking the owner as told when nothing was sent would lose the sale
    // notification permanently, and silently.
    const failing = await order(mine.id);
    const refused = await notifyOwnerOfSale({ orderId: failing.id, storeId: mine.id }, async () => {
      throw new Error("provider rejected it");
    });
    check("a send failure is reported as one",
      refused.sent === false && refused.reason === "send_failed", JSON.stringify(refused));
    check("carrying the real reason",
      refused.sent === false && refused.reason === "send_failed" && refused.detail.includes("provider rejected"),
      JSON.stringify(refused));

    const released = await prisma.order.findUniqueOrThrow({ where: { id: failing.id } });
    check("and the claim is released", released.ownerNotifiedAt === null, String(released.ownerNotifiedAt));

    const retried: unknown[] = [];
    const retry = await notifyOwnerOfSale({ orderId: failing.id, storeId: mine.id }, async (i) => {
      retried.push(i);
    });
    check("so the next delivery genuinely retries", retry.sent === true, JSON.stringify(retry));
    check("and it lands", retried.length === 1, String(retried.length));

    // ========================================================================
    console.log("\n=== 3. One store's sale never reaches another's owner ===\n");
    // ========================================================================
    const theirs = await store(user.id);
    const theirOrder = await order(theirs.id);
    const crossed: unknown[] = [];
    const wrongStore = await notifyOwnerOfSale({ orderId: theirOrder.id, storeId: mine.id }, async (i) => {
      crossed.push(i);
    });
    check("an order/store pair that does not match is not found",
      wrongStore.sent === false && wrongStore.reason === "not_found", JSON.stringify(wrongStore));
    check("and nothing is sent", crossed.length === 0, String(crossed.length));
    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: theirOrder.id } });
    check("nor is the other order marked as told", untouched.ownerNotifiedAt === null,
      String(untouched.ownerNotifiedAt));
    check(
      "so a mismatched pair fails closed rather than notifying the wrong tenant",
      wrongStore.sent === false && crossed.length === 0,
      "the store is in the claim's where clause, not checked after it"
    );

    // ========================================================================
    console.log("\n=== 4. The subject carries the fact ===\n");
    // ========================================================================
    // Often all an owner reads on a phone. "You have a notification" would make
    // them open it to learn what the subject could have told them.
    const email = buildOwnerSaleEmail({
      order: {
        id: "o1",
        productName: "Tensor Ring",
        quantity: 2,
        amountInCents: 8_500,
        buyerEmail: "buyer@notify.test",
        externalOrderId: "ext-123",
        shippingAddress: { name: "A Buyer", line1: "1 High St", city: "Hartlepool", postalCode: "TS24", country: "GB" },
      },
      store: { name: "Copper & Coil", currency: "GBP" },
      ownerEmail: "owner@notify.test",
    });
    check("the subject names the product", email.subject.includes("Tensor Ring"), email.subject);
    check("the quantity", email.subject.includes("2"), email.subject);
    check("and the money, in the store's own currency", email.subject.includes("£85.00"), email.subject);
    check("the body gives the customer's address to reply to",
      email.html.includes("buyer@notify.test"), email.html);
    check("and where to ship it", email.html.includes("Hartlepool"), email.html);
    check("with a reference a human can quote", email.html.includes("ext-123"), email.html);

    // It reports, and does not advise. J4 speaks in the Office; this is a
    // notification.
    check("it offers no advice", !/you should|we recommend|consider |great news/i.test(email.html), email.html);

    // An order with no shipping address renders no empty block — an absent
    // requirement must not read as a missing delivery address.
    const digital = buildOwnerSaleEmail({
      order: {
        id: "o2", productName: "Gift card", quantity: 1, amountInCents: 2_000,
        buyerEmail: "b@test", externalOrderId: "ext-2", shippingAddress: null,
      },
      store: { name: "Copper & Coil", currency: "USD" },
      ownerEmail: "owner@notify.test",
    });
    check("an order with no address shows no shipping line", !digital.html.includes("Ship to:"), digital.html);
    check("and prices in that store's currency", digital.subject.includes("$20.00"), digital.subject);
    check("one item shows no quantity multiplier", !digital.subject.includes("&times;"), digital.subject);
  } finally {
    await prisma.store.deleteMany({ where: { id: { in: stores } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    if (priorKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = priorKey;
    if (priorFrom === undefined) delete process.env.EMAIL_FROM_ADDRESS;
    else process.env.EMAIL_FROM_ADDRESS = priorFrom;
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
