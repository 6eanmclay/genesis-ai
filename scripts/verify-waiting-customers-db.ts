import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { getWaitingCustomerIssues } from "@/lib/dashboard/waitingCustomers";
import { getAttentionItems } from "@/lib/dashboard/needsAttention";
import { getObligations } from "@/lib/businessModel/obligations";
import { readFileSync } from "node:fs";

// SOMEBODY HAS PAID AND IS WAITING:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts waiting-customers-db
//
// ============ THE CASE THIS EXISTS FOR (2026-09-01) ====================
//
// A real order sat paid and unfulfilled on a live store and the owner found it
// by looking. The dashboard raised three state issues at the time — unpublished,
// no products, no payment method — every one of them a reason a shop CANNOT
// sell. Nothing was raised for the shop having sold something.
//
// ============ AND THE FOUR FACTS IT MUST NOT BLUR =====================
//
// obligations.ts names them and this suite holds the card to them:
//
//   money arrived            status "paid"
//   money went back          status "refunded" — NO package is owed
//   the owner's own record   fulfillmentStatus, never evidence about a parcel
//   a label was bought       real money spent on postage; not delivery, and
//                            not the same as the order being marked fulfilled
//
// A card that added refunded orders to what is owed would tell an owner to post
// goods for money they have already given back. A card that said "you have not
// shipped this" would accuse them of neglecting a customer whose parcel they
// posted on Tuesday. Both are asserted against below.

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

let seq = 0;
async function makeStore(stamp: number) {
  const n = ++seq;
  const user = await prisma.user.create({ data: { email: `wc-${stamp}-${n}@example.test` } });
  return prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `wc-${stamp}-${n}`, tagline: "t", description: "d" },
  });
}

const DAY = 24 * 60 * 60 * 1000;
let orderSeq = 0;
async function order(storeId: string, stamp: number, o: {
  status?: string; fulfillmentStatus?: string; daysAgo?: number;
  trackingNumber?: string; carrier?: string; productName?: string;
}) {
  const n = ++orderSeq;
  return prismaSystem.order.create({
    data: {
      storeId,
      productName: o.productName ?? "Hand-Wound Copper Tensor Ring Cuff Bracelet",
      quantity: 1, amountInCents: 3232, buyerEmail: `buyer-${stamp}-${n}@example.test`,
      paymentProvider: "STRIPE", externalOrderId: `cs_wc_${stamp}_${n}`,
      status: o.status ?? "paid",
      fulfillmentStatus: o.fulfillmentStatus ?? "unfulfilled",
      trackingNumber: o.trackingNumber ?? null,
      carrier: o.carrier ?? null,
      createdAt: new Date(Date.now() - (o.daysAgo ?? 0) * DAY),
    },
  });
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- a shop with nothing outstanding is told nothing ---\n");
  {
    const store = await makeStore(stamp);
    eq("silence when there are no orders at all", await getWaitingCustomerIssues(store.id), []);

    await order(store.id, stamp, { fulfillmentStatus: "fulfilled" });
    eq("and silence when everything is fulfilled", await getWaitingCustomerIssues(store.id), []);
  }

  console.log("\n--- one paid, unfulfilled order raises exactly one card ---\n");
  {
    const store = await makeStore(stamp);
    await order(store.id, stamp, { daysAgo: 2, productName: "Copper Tensor Ring Cuff" });

    const items = await getWaitingCustomerIssues(store.id);
    eq("one card", items.length, 1);
    eq("a warning, not a failure — nothing is broken", items[0].severity, "WARNING");
    assert("it names the product", /Copper Tensor Ring Cuff/.test(items[0].message), items[0].message);
    assert("it says how long they have waited", /waiting 2 days/.test(items[0].message), items[0].message);
    eq("and points at the orders screen", items[0].actionHref, "/dashboard/orders");
  }

  console.log("\n--- it never accuses the owner of failing to ship ---\n");
  {
    // ============ THE SENTENCE THAT MUST NEVER APPEAR ==========
    //
    // fulfillmentStatus is the owner's own record, not evidence about a parcel.
    // An owner who posted it on Tuesday and did not tell Genesis must not read
    // "you have not shipped this".
    const store = await makeStore(stamp);
    await order(store.id, stamp, { daysAgo: 30 });
    const message = (await getWaitingCustomerIssues(store.id))[0].message;
    assert("it does not say the owner has not shipped", !/have\s?n[o']t shipped|not shipped/i.test(message), message);
    assert("nor call the order late", !/\blate\b/i.test(message), message);
    assert("nor overdue", !/\boverdue\b/i.test(message), message);
    assert("it reports the age as a number instead", /30 days/.test(message), message);
    // Thirty days is still a WARNING. Escalating on age would be the threshold
    // obligations.ts deliberately refuses to have.
    eq("and thirty days is still not an emergency",
      (await getWaitingCustomerIssues(store.id))[0].severity, "WARNING");
  }

  console.log("\n--- a refunded order is not something anybody is owed ---\n");
  {
    const store = await makeStore(stamp);
    await order(store.id, stamp, { status: "refunded", daysAgo: 10 });

    eq("a refunded, unfulfilled order raises nothing",
      await getWaitingCustomerIssues(store.id), []);
    // And the underlying module agrees, so the card is not silently disagreeing
    // with what J4 would say about the same shop.
    const obligations = await getObligations(store.id);
    eq("obligations says nothing is outstanding", obligations.outstandingCount, 0);
    eq("but still counts it as refunded-and-unfulfilled", obligations.refundedUnfulfilledCount, 1);
  }

  console.log("\n--- and a refunded order sitting BESIDE a real one is not added to it ---\n");
  {
    // ============ THE SHOP THAT HAS BOTH ======================
    //
    // The test above has only a refunded order, so the card returns early and
    // never reaches the counting at all. The sabotage run proved that: adding
    // refundedUnfulfilledCount to the total left the suite green, because no
    // fixture had one of each. A shop with both is the case where conflating
    // them actually shows, and it is the ordinary case for a real business.
    const store = await makeStore(stamp);
    await order(store.id, stamp, { daysAgo: 3 });
    await order(store.id, stamp, { status: "refunded", daysAgo: 9 });

    const items = await getWaitingCustomerIssues(store.id);
    eq("one card", items.length, 1);
    assert("it counts ONE person waiting, not two",
      /is waiting to go out/.test(items[0].message) && !/2 orders/.test(items[0].message),
      items[0].message);
    assert("and the oldest wait is the real order's, not the refunded one's",
      /waiting 3 days/.test(items[0].message), items[0].message);
  }

  console.log("\n--- a label already bought is named as the different thing it is ---\n");
  {
    const store = await makeStore(stamp);
    await order(store.id, stamp, { daysAgo: 1, trackingNumber: "94001", carrier: "USPS" });

    const message = (await getWaitingCustomerIssues(store.id))[0].message;
    assert("it says postage is already bought", /postage is already bought/i.test(message), message);
    assert("and says marking it fulfilled would clear it",
      /marking it fulfilled/i.test(message), message);
    assert("without claiming it has been delivered", !/delivered/i.test(message), message);
  }

  console.log("\n--- an order placed today says it arrived today, not that it left ---\n");
  {
    // The zero-day branch has its own wording and no fixture rendered it, so
    // the sabotage that turned "came in today" into "was delivered today"
    // passed unnoticed. An order is something that ARRIVES at the shop; only a
    // parcel is delivered, and this card never knows about parcels.
    const store = await makeStore(stamp);
    await order(store.id, stamp, { daysAgo: 0 });
    const message = (await getWaitingCustomerIssues(store.id))[0].message;
    assert("it says the order came in today", /came in today/i.test(message), message);
    assert("and never says anything was delivered", !/delivered/i.test(message), message);
    assert("nor shipped", !/shipped/i.test(message), message);
  }

  console.log("\n--- several waiting orders are one card, not several ---\n");
  {
    const store = await makeStore(stamp);
    await order(store.id, stamp, { daysAgo: 1 });
    await order(store.id, stamp, { daysAgo: 5 });
    await order(store.id, stamp, { daysAgo: 3 });

    const items = await getWaitingCustomerIssues(store.id);
    eq("still one card", items.length, 1);
    assert("it counts them", /3 orders are waiting/.test(items[0].message), items[0].message);
    assert("and reports the OLDEST wait", /waiting 5 days/.test(items[0].message), items[0].message);
  }

  console.log("\n--- the count is part of the card's identity ---\n");
  {
    // Dismissing "two people are waiting" must not also dismiss "five people
    // are waiting" — a condition getting worse is a new finding.
    const store = await makeStore(stamp);
    await order(store.id, stamp, { daysAgo: 1 });
    const one = (await getWaitingCustomerIssues(store.id))[0].id;
    await order(store.id, stamp, { daysAgo: 1 });
    const two = (await getWaitingCustomerIssues(store.id))[0].id;
    assert("a different number of waiting customers is a different card", one !== two, `${one} vs ${two}`);
  }

  console.log("\n--- it reaches the owner's real attention list ---\n");
  {
    const store = await makeStore(stamp);
    await order(store.id, stamp, { daysAgo: 4 });

    const { recentOutcomes } = await getAttentionItems(store.id, {
      store: { published: true }, products: [{ active: true }],
      stripeIntegration: { status: "CONNECTED" }, paypalIntegration: null,
    });
    const waiting = recentOutcomes.filter((i) => i.kind === "waiting-customer");
    eq("the card is in what the dashboard reads", waiting.length, 1);
    assert("carrying its destination", waiting[0].actionHref === "/dashboard/orders");
  }

  console.log("\n--- one business's waiting customers are its own ---\n");
  {
    const a = await makeStore(stamp);
    const b = await makeStore(stamp);
    await order(a.id, stamp, { daysAgo: 2 });

    eq("the shop with the order is told", (await getWaitingCustomerIssues(a.id)).length, 1);
    eq("the other is not", (await getWaitingCustomerIssues(b.id)).length, 0);
  }

  console.log("\n--- it counts nothing itself ---\n");
  {
    // Source-asserted, apart from the executed evidence: the whole point of
    // this module is that it does NOT re-derive what obligations.ts already
    // decides, because a second count is a second chance to conflate the four
    // facts that look alike.
    const source = readFileSync("lib/dashboard/waitingCustomers.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert("it asks obligations rather than querying orders", /getObligations\(/.test(source));
    assert("it never touches the Order table itself", !/prisma\.order|prismaSystem/.test(source));
    assert("and it has no age threshold in it", !/\b(7|14|30|LATE|OVERDUE)\b/.test(source), source.slice(0, 200));
  }

  // Planted rows cleared: Order is read by platform-wide reporting and this
  // lane shares one database. Deleting the accounts cascades to both.
  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "wc-" } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
