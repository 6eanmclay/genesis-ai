import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { readFileSync } from "node:fs";
// THE PAGE'S OWN FUNCTION, not a copy of it. The first version of this suite
// reimplemented the arithmetic here and the sabotage run caught it: breaking
// the page left the suite green, because the suite was checking its own
// duplicate. See lib/orders/orderMoney.ts.
import { orderMoney } from "@/lib/orders/orderMoney";

// EVERYTHING NEEDED TO ACTUALLY POST THE PARCEL:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts order-detail-db
//
// ============ THE REAL ORDER THAT PROMPTED THIS (2026-08-31) ===========
//
// Two live orders on Cubit & Coil. One of them is for two DIFFERENT products —
// a cuff bracelet and a necklace — and Order.productName records it as
// "Hand-Wound Copper Tensor Ring Cuff Bracelet and 1 more". That summary was
// the only thing the order detail page rendered.
//
// So the one screen that exists to fulfil an order could not tell its owner
// that a necklace was in the box. The lines were there the whole time, in
// OrderItem, since bags were built.
//
// The fixtures below are that order's real shape — two items, a promotion on
// both, null listSubtotalInCents and null discountInCents on the ORDER row
// while every item carries its own. That last detail is the reason the page
// derives from items rather than trusting the columns, and it is asserted here
// rather than assumed.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let seq = 0;
async function makeStore(stamp: number) {
  const n = ++seq;
  const user = await prisma.user.create({ data: { email: `od-${stamp}-${n}@example.test` } });
  return prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `od-${stamp}-${n}`, tagline: "t", description: "d" },
  });
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const store = await makeStore(stamp);

  // The live two-product order, to the cent.
  const multi = await prismaSystem.order.create({
    data: {
      storeId: store.id,
      productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet and 1 more",
      quantity: 2, amountInCents: 6980, buyerEmail: `buyer-${stamp}@example.test`,
      paymentProvider: "STRIPE", externalOrderId: `cs_live_od_${stamp}`,
      externalPaymentId: `pi_od_${stamp}`,
      shippingAddress: {
        name: "Gabriel Mendies", line1: "7090 SW 68th Ave", city: "Portland",
        state: "OR", postalCode: "97223", country: "US",
      },
      fulfillmentStatus: "fulfilled", fulfilledAt: new Date(),
      lineItemSource: "DRAFT",
      items: {
        create: [
          {
            productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet", quantity: 1,
            unitPriceInCents: 3232, listInCents: 3232, discountInCents: 840,
            subtotalInCents: 2392, promotionLabel: "Back to School Sale!",
          },
          {
            productName: "Double Sacred Cubit Copper Tensor Ring Necklace", quantity: 1,
            unitPriceInCents: 6200, listInCents: 6200, discountInCents: 1612,
            subtotalInCents: 4588, promotionLabel: "Back to School Sale!",
          },
        ],
      },
    },
    include: { items: true },
  });

  console.log("\n--- the page can name every item in the box ---\n");
  {
    const loaded = await prisma.order.findFirst({
      where: { id: multi.id, storeId: store.id },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
    assert("the order loads", !!loaded);
    eq("both lines are there", loaded!.items.length, 2);
    assert("including the one the summary hid",
      loaded!.items.some((i) => i.productName.includes("Necklace")),
      loaded!.items.map((i) => i.productName).join(" | "));
    assert("and the row's own name really is only a summary",
      loaded!.productName.includes("and 1 more"), loaded!.productName);
  }

  console.log("\n--- the money adds up, from the lines when the columns are silent ---\n");
  {
    eq("the ORDER row records no subtotal — as the live ones do not", multi.listSubtotalInCents, null);
    eq("nor a discount", multi.discountInCents, null);

    const money = orderMoney(multi, multi.items);
    eq("the subtotal comes from the lines", money.subtotal, 9432);
    eq("so does the discount", money.discount, 2452);
    eq("and the promotion is named", money.promotionLabel, "Back to School Sale!");
    eq("subtotal − discount is what was actually paid",
      money.subtotal! - money.discount!, multi.amountInCents);
  }

  console.log("\n--- an order-level column wins over the lines when it is set ---\n");
  {
    const withColumns = { listSubtotalInCents: 5000, discountInCents: 500, appliedPromotionLabel: "Column Sale" };
    const money = orderMoney(withColumns, multi.items);
    eq("the recorded subtotal is used", money.subtotal, 5000);
    eq("and the recorded discount", money.discount, 500);
    eq("and the recorded promotion", money.promotionLabel, "Column Sale");
  }

  console.log("\n--- an older order with no lines still reads correctly ---\n");
  {
    const legacy = await prismaSystem.order.create({
      data: {
        storeId: store.id, productName: "Haul & Co.", quantity: 1, amountInCents: 11211,
        buyerEmail: `legacy-${stamp}@example.test`, paymentProvider: "STRIPE",
        externalOrderId: `cs_test_od_${stamp}`,
      },
      include: { items: true },
    });
    eq("it has no line items, which is the truth about it", legacy.items.length, 0);
    const money = orderMoney(legacy, legacy.items);
    eq("so no subtotal is invented", money.subtotal, null);
    eq("and no discount is invented", money.discount, null);
  }

  console.log("\n--- everything needed to post the parcel is present ---\n");
  {
    const loaded = await prisma.order.findFirst({
      where: { id: multi.id, storeId: store.id },
      include: { items: true },
    });
    const address = loaded!.shippingAddress as Record<string, string>;
    // The fields a merchant physically cannot post without.
    for (const field of ["name", "line1", "city", "state", "postalCode", "country"]) {
      assert(`the address carries ${field}`, !!address[field], JSON.stringify(address));
    }
    assert("the customer's email is there", !!loaded!.buyerEmail);
    assert("the Stripe payment reference is there", !!loaded!.externalPaymentId);
    assert("the checkout reference is there", !!loaded!.externalOrderId);
    assert("and the purchase time", loaded!.createdAt instanceof Date);
  }

  console.log("\n--- payment facts and fulfilment facts stay apart ---\n");
  {
    // ============ PAID IS NOT SHIPPED ==========================
    //
    // Sean: "Do not assume that receiving payment means an order has shipped."
    // Four independent axes on one row, and this proves they really are
    // independent rather than merely documented as such.
    const paidNotShipped = await prismaSystem.order.create({
      data: {
        storeId: store.id, productName: "Cuff", quantity: 2, amountInCents: 4783,
        buyerEmail: `rb-${stamp}@example.test`, paymentProvider: "STRIPE",
        externalOrderId: `cs_live_od2_${stamp}`, status: "paid",
      },
    });
    eq("money says paid", paidNotShipped.status, "paid");
    eq("fulfilment says nothing of the kind", paidNotShipped.fulfillmentStatus, "unfulfilled");
    eq("no carrier has been told", paidNotShipped.shipmentStatus, null);
    eq("and the customer has not been told either", paidNotShipped.shipmentNotifiedAt, null);

    // And the reverse: marked fulfilled by hand does NOT mean a label exists,
    // a carrier has it, or anybody was emailed. This is the exact state the
    // live order was left in.
    eq("a hand-marked order still has no tracking", multi.trackingNumber, null);
    eq("no label was bought", multi.labelUrl, null);
    eq("and nobody was told it shipped", multi.shipmentNotifiedAt, null);
  }

  console.log("\n--- one business's order cannot be opened from another ---\n");
  {
    const other = await makeStore(stamp);
    const throughOther = await prisma.order.findFirst({
      where: { id: multi.id, storeId: other.id },
      include: { items: true },
    });
    eq("scoped to the wrong business, the order is not found", throughOther, null);
    // The line items must not be reachable either — an item is a product name
    // and a price belonging to somebody else's customer.
    const itemsThroughOther = await prismaSystem.orderItem.findMany({
      where: { id: { in: multi.items.map((i) => i.id) }, order: { storeId: other.id } },
    });
    eq("and neither are its line items", itemsThroughOther.length, 0);
  }

  console.log("\n--- the page holds to all of it ---\n");
  {
    // Source-asserted, kept apart from the executed evidence above.
    const page = readFileSync("app/dashboard/orders/OrderDetail.tsx", "utf8");
    const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert("it loads the line items", /items:\s*\{\s*orderBy/.test(code));
    assert("it renders every line", /items\.map\(/.test(code));
    assert("it reads the order store-scoped", /where:\s*\{\s*id:\s*orderId,\s*storeId\s*\}/.test(code));
    assert("it shows a history", /timeline\.map\(/.test(code));
    assert("it says tax is not recorded rather than showing a zero",
      /Not recorded — check Stripe/.test(page));
    assert("the dispute block is conditional on there being a dispute",
      /order\.disputeStatus\s*&&/.test(code));
    // The matchers must be able to fail.
    assert("that store-scoping check would catch an unscoped read",
      !/where:\s*\{\s*id:\s*orderId\s*\}/.test(code));
  }

  // Planted rows removed: Order and OrderItem are read by platform-wide
  // reporting, and this lane shares one database.
  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "od-" } } });

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
