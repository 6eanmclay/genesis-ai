import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { searchOrders, matchFieldFor, MIN_QUERY_LENGTH } from "@/lib/orders/orderSearch";
import { readFileSync } from "node:fs";

// FINDING ONE ORDER OUT OF ALL OF THEM:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts order-search-db
//
// ============ WHAT A MERCHANT IS HOLDING WHEN THEY LOOK ================
//
// The orders list showed the hundred most recent and offered no search, which
// is fine at seven orders and useless at seven hundred. Somebody fulfilling an
// order knows one of six things — a name, an email, a product, an order id, a
// tracking number, or a payment reference from Stripe — and does not know
// which. All six are searched, and each is proven here.
//
// ============ AND THE ONE THAT MATTERS MOST ===========================
//
// A search that could return another business's order would be worse than no
// search at all: it would show one merchant another's customer, by name and
// email, in a list that looks like their own. storeId is a required parameter
// rather than a filter a caller might forget, and the cross-store case is
// tested against the most obvious attempt — pasting somebody else's order id.

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
  const user = await prisma.user.create({ data: { email: `os-${stamp}-${n}@example.test` } });
  return prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `os-${stamp}-${n}`, tagline: "t", description: "d" },
  });
}

let orderSeq = 0;
async function order(storeId: string, stamp: number, over: {
  productName?: string; buyerEmail?: string; name?: string;
  trackingNumber?: string; externalOrderId?: string;
  items?: { productName: string; quantity: number }[];
} = {}) {
  const n = ++orderSeq;
  return prismaSystem.order.create({
    data: {
      storeId,
      productName: over.productName ?? "Hand-Wound Copper Tensor Ring Cuff Bracelet",
      quantity: 1, amountInCents: 3232,
      buyerEmail: over.buyerEmail ?? `buyer-${stamp}-${n}@example.test`,
      paymentProvider: "STRIPE",
      externalOrderId: over.externalOrderId ?? `cs_os_${stamp}_${n}`,
      trackingNumber: over.trackingNumber ?? null,
      shippingAddress: over.name
        ? { name: over.name, line1: "2127 33RD ST", city: "ASTORIA", postalCode: "11105", country: "US" }
        : undefined,
      items: over.items
        ? {
            create: over.items.map((i) => ({
              productName: i.productName, quantity: i.quantity,
              unitPriceInCents: 3232, listInCents: 3232, subtotalInCents: 3232,
            })),
          }
        : undefined,
    },
  });
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- all six things a merchant might be holding ---\n");
  {
    const store = await makeStore(stamp);
    const target = await order(store.id, stamp, {
      productName: "Double Sacred Cubit Copper Tensor Ring Necklace",
      buyerEmail: `rooney-${stamp}@example.test`,
      name: "Rooney Barreto",
      trackingNumber: "9400111899223817200001",
      externalOrderId: `cs_live_findme_${stamp}`,
    });
    // Noise, so a match is a match rather than the only row.
    for (let i = 0; i < 3; i++) await order(store.id, stamp);

    const byId = await searchOrders(store.id, target.id);
    eq("an order id finds it", byId.hits.map((h) => h.id), [target.id]);
    eq("and says that is why", byId.hits[0]?.matchedOn, "order id");

    const byEmail = await searchOrders(store.id, `rooney-${stamp}@example.test`);
    eq("an email finds it", byEmail.hits.map((h) => h.id), [target.id]);
    eq("and says that is why", byEmail.hits[0]?.matchedOn, "customer email");

    const byName = await searchOrders(store.id, "Rooney Barreto");
    eq("a customer name finds it", byName.hits.map((h) => h.id), [target.id]);
    eq("and says that is why", byName.hits[0]?.matchedOn, "customer name");

    const byProduct = await searchOrders(store.id, "Necklace");
    eq("a product name finds it", byProduct.hits.map((h) => h.id), [target.id]);

    const byTracking = await searchOrders(store.id, "9400111899223817200001");
    eq("a tracking number finds it", byTracking.hits.map((h) => h.id), [target.id]);
    eq("and says that is why", byTracking.hits[0]?.matchedOn, "tracking number");

    const byReference = await searchOrders(store.id, `cs_live_findme_${stamp}`);
    eq("a Stripe reference finds it", byReference.hits.map((h) => h.id), [target.id]);
    eq("and says that is why", byReference.hits[0]?.matchedOn, "payment reference");
  }

  console.log("\n--- and the product hidden behind 'and 1 more' ---\n");
  {
    // ============ THE SUMMARY IS NOT THE CONTENTS =============
    //
    // Order.productName on a multi-product order names the first item and
    // counts the rest. A merchant searching for the SECOND product would find
    // nothing while holding an order that contains it.
    const store = await makeStore(stamp);
    const multi = await order(store.id, stamp, {
      productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet and 1 more",
      items: [
        { productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet", quantity: 1 },
        { productName: "Double Sacred Cubit Copper Tensor Ring Necklace", quantity: 1 },
      ],
    });

    const hidden = await searchOrders(store.id, "Necklace");
    eq("the line item is searchable even though the row does not name it",
      hidden.hits.map((h) => h.id), [multi.id]);
  }

  console.log("\n--- searching is case-insensitive and partial ---\n");
  {
    const store = await makeStore(stamp);
    const target = await order(store.id, stamp, { name: "Gabriel Mendies" });
    eq("lower case finds a capitalised name",
      (await searchOrders(store.id, "gabriel")).hits.map((h) => h.id), [target.id]);
    eq("and a fragment finds it",
      (await searchOrders(store.id, "endie")).hits.map((h) => h.id), [target.id]);
  }

  console.log("\n--- ONE BUSINESS CAN NEVER SEE ANOTHER'S ORDERS ---\n");
  {
    const mine = await makeStore(stamp);
    const theirs = await makeStore(stamp);
    const theirOrder = await order(theirs.id, stamp, {
      buyerEmail: `private-${stamp}@example.test`,
      name: "Somebody Else",
      productName: "A Private Purchase",
      trackingNumber: "9999999999",
    });
    await order(mine.id, stamp, { name: "My Customer" });

    // The obvious attempt: paste the other business's order id.
    eq("their order id finds nothing here",
      (await searchOrders(mine.id, theirOrder.id)).hits, []);
    eq("nor their customer's email",
      (await searchOrders(mine.id, `private-${stamp}@example.test`)).hits, []);
    eq("nor their customer's name",
      (await searchOrders(mine.id, "Somebody Else")).hits, []);
    eq("nor their product",
      (await searchOrders(mine.id, "A Private Purchase")).hits, []);
    eq("nor their tracking number",
      (await searchOrders(mine.id, "9999999999")).hits, []);

    // And the same search from THEIR side does find it, so the emptiness above
    // is scoping rather than a search that matches nothing.
    eq("while their own business finds it",
      (await searchOrders(theirs.id, "Somebody Else")).hits.map((h) => h.id), [theirOrder.id]);
  }

  console.log("\n--- a useless query is not a search ---\n");
  {
    const store = await makeStore(stamp);
    await order(store.id, stamp);
    eq("an empty query returns nothing", (await searchOrders(store.id, "")).hits, []);
    eq("whitespace returns nothing", (await searchOrders(store.id, "   ")).hits, []);
    eq("and one character is below the floor",
      (await searchOrders(store.id, "a")).hits, []);
    assert("the floor is stated rather than magic", MIN_QUERY_LENGTH === 2);
  }

  console.log("\n--- a broad search stays a page ---\n");
  {
    const store = await makeStore(stamp);
    for (let i = 0; i < 7; i++) await order(store.id, stamp, { productName: "Copper Cuff" });
    const capped = await searchOrders(store.id, "Copper Cuff", { limit: 3 });
    eq("it returns the cap", capped.hits.length, 3);
    eq("and says there are more", capped.more, true);

    const uncapped = await searchOrders(store.id, "Copper Cuff", { limit: 50 });
    eq("all of them when there is room", uncapped.hits.length, 7);
    eq("and says there are no more", uncapped.more, false);
  }

  console.log("\n--- why a row matched is decided most-specific first ---\n");
  {
    const row = {
      id: "cm_abc", buyerEmail: "cuff@example.test", productName: "Cuff",
      trackingNumber: "cuff999", externalOrderId: "cs_cuff",
      shippingAddress: { name: "Cuff Person" },
    };
    // Every field contains "cuff". The label must be the most specific one a
    // person could have typed, not whichever branch happened to be checked.
    eq("a tracking number outranks a product name", matchFieldFor("cuff", row), "tracking number");
    eq("an id outranks everything", matchFieldFor("cm_abc", row), "order id");
    eq("and a product is the fallback",
      matchFieldFor("cuff", { ...row, trackingNumber: null, buyerEmail: "x@y.test",
        shippingAddress: null, externalOrderId: "cs_1" }), "product");
  }

  console.log("\n--- the store is not an optional filter ---\n");
  {
    // Source-asserted, apart from the executed evidence above: a statement
    // about a signature that must never grow a default.
    const src = readFileSync("lib/orders/orderSearch.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert("storeId is a required parameter", /searchOrders\(\s*storeId: string,/.test(code));
    assert("and is in the where clause", /storeId,/.test(code));
    assert("the OR never escapes it",
      code.indexOf("storeId,") < code.indexOf("OR: ["), "the scope is inside or after the OR");

    // ============ AND THE RAW QUERY CARRIES ITS OWN =============
    //
    // The name match needs raw SQL, because Prisma's JSON filter cannot be
    // case-insensitive. Its own WHERE is DEFENCE IN DEPTH rather than the
    // load-bearing guard — the outer Prisma where ANDs storeId with the whole
    // OR, so an id from another business could not survive it anyway.
    //
    // Which is exactly why it is asserted here. The sabotage run removed that
    // WHERE and nothing failed: the protection was real but invisible, and an
    // invisible protection is one somebody deletes as redundant. Now deleting
    // it is a failing test rather than a silent narrowing of the margin.
    assert("the raw name query is scoped to the business too",
      /WHERE "storeId" = \$\{storeId\}/.test(src), "the raw query lost its own scope");
    assert("and its parameter is bound, never interpolated",
      /ILIKE \$\{`%\$\{trimmed\}%`\}/.test(src), "the search term reaches SQL unbound");
  }

  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "os-" } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
