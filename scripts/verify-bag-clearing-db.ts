import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  resolvePurchase,
  clearBagOnConfirmedPurchase,
  type PurchaseOutcome,
  type ResolvePurchaseInput,
  type SessionFetcher,
} from "@/lib/bag/purchaseCompletion";
import { readFileSync } from "node:fs";

// A PAID ORDER MUST EMPTY THE BAG IT WAS PAID FOR:
//
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/run-db-suites.ts bag-clearing" \
//     -OutFile "C:/Users/hyper/AppData/Local/Temp/genesis-bag.txt"
//
// ISOLATED DATABASE ONLY, AND NO STRIPE CALL EVER. The SessionFetcher seam
// that purchaseCompletion.ts exposes is injected, so every scoping rule and
// every outcome decision runs for real while the one step that talks to a
// payment provider does not.
//
// ============ THE DEFECT THIS EXISTS FOR (2026-09-24) =================
//
// A real customer paid $285.85 for a twelve-unit order at Cubit & Coil,
// reached the confirmed success page, and her bag still held all twelve items.
//
// `clearBagCookie` had existed for months. Its only occurrence in the entire
// repository was its own definition — nothing called it, ever. Twenty live
// orders were taken with the bag never once emptied.
//
// THE RULE THIS PINS. A bag is emptied when, and only when, a purchase is
// PROVEN complete. Not when somebody visits the success URL, not when an order
// exists, not when a payment is pending, and never for an order belonging to
// a different store.
//
// BOTH PATHS ARE CHECKED SEPARATELY, because they are genuinely different.
// PayPal captures synchronously and clears from its route handler. Stripe's
// order is written by a webhook with no browser attached, so it clears from
// the success page through a server function. Section 5 asserts each one
// actually wires up, since a shared decision function proves nothing if only
// one caller reaches it.

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

/** A fake bag: records whether the clear was asked for, and for which store. */
function makeBag(initialItems: number) {
  const state = { items: initialItems, clears: [] as string[] };
  return {
    state,
    clear: async (slug: string) => {
      state.clears.push(slug);
      state.items = 0;
    },
  };
}

/** Stripe stand-in. No network, and it records that it was consulted. */
function sessionSaying(paymentStatus: string, amount = 28585): SessionFetcher {
  return async () => ({
    amount_total: amount,
    currency: "usd",
    payment_status: paymentStatus,
    firstLineDescription: "Hand-Wound Copper Tensor Ring Cuff Bracelet",
  });
}

async function main() {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const user = await prisma.user.create({ data: { email: `bag-${stamp}@example.test`, name: "O" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Bag Co", slug: `bag-${stamp}`, tagline: "t", description: "d" },
  });
  // A SECOND, UNRELATED SHOP. Without one, "scoped to this store" is a claim
  // no assertion in this file could distinguish from "found any order at all".
  const otherUser = await prisma.user.create({ data: { email: `bag-other-${stamp}@example.test`, name: "X" } });
  const otherStore = await prisma.store.create({
    data: { userId: otherUser.id, name: "Other Co", slug: `bag-other-${stamp}`, tagline: "t", description: "d" },
  });

  let seq = 0;
  async function makeOrder(storeId: string, status: string, quantity = 12) {
    seq++;
    return prisma.order.create({
      data: {
        storeId,
        productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet",
        quantity,
        amountInCents: 28585,
        buyerEmail: `buyer-${stamp}-${seq}@example.test`,
        status,
        paymentProvider: "PAYPAL",
        externalOrderId: `EXT_${stamp}_${seq}`,
      },
    });
  }

  console.log("\n=== 1. CONTROL: the defect, reproduced ===\n");
  {
    // The old world: a purchase completes and NOTHING clears the bag. This is
    // what the customer experienced. If this section ever stops showing a full
    // bag, the rest of the suite is measuring the wrong thing.
    const order = await makeOrder(store.id, "paid");
    const bag = makeBag(12);
    const legacyCompletion = async () => {
      /* what the code did before this slice: nothing at all */
    };
    await legacyCompletion();
    eq("with no clear wired up, a PAID order leaves all 12 items", bag.state.items, 12);
    eq("  and nothing was ever asked to clear", bag.state.clears, []);
    assert("  the order really was paid", order.status === "paid");
  }

  console.log("\n=== 2. PAYPAL PATH: a paid order empties the bag ===\n");
  {
    const order = await makeOrder(store.id, "paid");
    const bag = makeBag(12);
    const result = await clearBagOnConfirmedPurchase(
      { slug: store.slug, orderId: order.id },
      { clear: bag.clear }
    );
    eq("outcome is confirmed", result.outcome, "confirmed");
    assert("the bag was cleared", result.cleared);
    eq("  it is empty", bag.state.items, 0);
    eq("  and it was THIS store's bag", bag.state.clears, [store.slug]);
  }

  console.log("\n=== 3. STRIPE PATH: paid session empties, unpaid does not ===\n");
  {
    const bag = makeBag(12);
    const paid = await clearBagOnConfirmedPurchase(
      { slug: store.slug, sessionId: `cs_test_${stamp}` },
      {
        resolve: (i: ResolvePurchaseInput) => resolvePurchase(i, sessionSaying("paid")),
        clear: bag.clear,
      }
    );
    eq("a paid Stripe session confirms", paid.outcome, "confirmed");
    eq("  and empties the bag", bag.state.items, 0);

    // The ordinary delayed-notification case. Stripe returns "unpaid" at
    // redirect and settles later; clearing here throws away a basket for money
    // that may never arrive.
    const bag2 = makeBag(12);
    const unpaid = await clearBagOnConfirmedPurchase(
      { slug: store.slug, sessionId: `cs_test_unpaid_${stamp}` },
      {
        resolve: (i: ResolvePurchaseInput) => resolvePurchase(i, sessionSaying("unpaid")),
        clear: bag2.clear,
      }
    );
    eq("an UNPAID session is pending, not confirmed", unpaid.outcome, "pending");
    assert("  and the bag is untouched", !unpaid.cleared && bag2.state.items === 12);

    // A session Stripe cannot return at all. They still came back from a
    // checkout, so this is pending rather than "no purchase".
    const bag3 = makeBag(12);
    const broken = await clearBagOnConfirmedPurchase(
      { slug: store.slug, sessionId: `cs_test_gone_${stamp}` },
      {
        resolve: (i: ResolvePurchaseInput) =>
          resolvePurchase(i, async () => {
            throw new Error("No such checkout.session");
          }),
        clear: bag3.clear,
      }
    );
    eq("an unreadable session is pending", broken.outcome, "pending");
    assert("  and the bag survives", bag3.state.items === 12);
  }

  console.log("\n=== 4. WHAT MUST NEVER CLEAR IT ===\n");
  {
    const cases: { label: string; input: ResolvePurchaseInput; expect: PurchaseOutcome }[] = [];

    const pendingOrder = await makeOrder(store.id, "pending");
    cases.push({ label: "a PENDING order", input: { slug: store.slug, orderId: pendingOrder.id }, expect: "pending" });

    const refunded = await makeOrder(store.id, "refunded");
    cases.push({ label: "a REFUNDED order (money already returned)", input: { slug: store.slug, orderId: refunded.id }, expect: "pending" });

    const failed = await makeOrder(store.id, "failed");
    cases.push({ label: "a FAILED order", input: { slug: store.slug, orderId: failed.id }, expect: "pending" });

    const foreign = await makeOrder(otherStore.id, "paid");
    cases.push({ label: "ANOTHER store's paid order id", input: { slug: store.slug, orderId: foreign.id }, expect: "unknown" });

    cases.push({ label: "an order id that does not exist", input: { slug: store.slug, orderId: `cm_nope_${stamp}` }, expect: "unknown" });
    cases.push({ label: "no session and no order at all", input: { slug: store.slug }, expect: "unknown" });

    for (const c of cases) {
      const bag = makeBag(12);
      const r = await clearBagOnConfirmedPurchase(c.input, { clear: bag.clear });
      assert(`${c.label} -> ${r.outcome}, bag untouched`,
        r.outcome === c.expect && !r.cleared && bag.state.items === 12,
        `outcome=${r.outcome} expected=${c.expect} cleared=${r.cleared} items=${bag.state.items}`);
    }

    // Stated as its own assertion because it is the rule, not a consequence.
    let anyCleared = false;
    for (const c of cases) {
      const bag = makeBag(12);
      const r = await clearBagOnConfirmedPurchase(c.input, { clear: bag.clear });
      if (r.cleared) anyCleared = true;
    }
    assert("NOT ONE unproven arrival empties a bag", !anyCleared,
      "a customer must never lose a basket they have not paid for");
  }

  console.log("\n=== 5. BOTH CALLERS ARE ACTUALLY WIRED UP ===\n");
  {
    // A shared decision function proves nothing if only one path reaches it.
    // The original defect was precisely a correct function with no callers.
    const route = readFileSync("app/api/checkout/paypal/return/route.ts", "utf8").replace(/\r\n?/g, "\n");
    const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    assert("PayPal's route handler calls the clear",
      /clearBagOnConfirmedPurchase\(/.test(routeCode),
      "a route handler may set cookies, so this path needs no JavaScript");

    const action = readFileSync("app/store/[slug]/success/clearBagAction.ts", "utf8");
    assert("a server function exists for the Stripe path",
      /clearBagOnConfirmedPurchase\(/.test(action) && /"use server"/.test(action));

    const page = readFileSync("app/store/[slug]/success/page.tsx", "utf8");
    assert("the success page invokes it only when confirmed",
      /outcome === "confirmed" &&[\s\S]{0,200}ClearBagOnConfirmed/.test(page));
    assert("  and the page no longer decides the outcome itself",
      /resolvePurchase\(/.test(page) && !/payment_status === "paid"/.test(page),
      "one owner for the decision, or the two surfaces can disagree");

    const bagStore = readFileSync("lib/bag/bagStore.ts", "utf8");
    assert("CONTROL: clearBagCookie still exists to be called", /export async function clearBagCookie/.test(bagStore));
  }

  console.log("\n=== 6. SABOTAGE: remove the clear and this suite fails ===\n");
  {
    // The whole table from section 2/3, run against a completion that resolves
    // exactly as the real one does but never clears -- which is the code as it
    // shipped to the customer who reported this.
    const sabotaged = async (input: ResolvePurchaseInput, clear: (s: string) => Promise<void>) => {
      const { outcome } = await resolvePurchase(input);
      // the clear, deliberately omitted
      void clear;
      return { cleared: false, outcome };
    };

    const order = await makeOrder(store.id, "paid");
    const realBag = makeBag(12);
    const real = await clearBagOnConfirmedPurchase({ slug: store.slug, orderId: order.id }, { clear: realBag.clear });
    assert("CONTROL: the shipped code clears a paid order", real.cleared && realBag.state.items === 0);

    const sabBag = makeBag(12);
    const sab = await sabotaged({ slug: store.slug, orderId: order.id }, sabBag.clear);
    assert("SABOTAGE CAUGHT: with the clear removed, the bag keeps its 12 items",
      !sab.cleared && sabBag.state.items === 12,
      "and the outcome still says confirmed, which is exactly what the customer saw");
    eq("  the sabotaged version still reports confirmed", sab.outcome, "confirmed");

    // Without this, section 2 could be green and vacuous.
    assert("  so the difference is the clear itself, not the decision",
      real.outcome === sab.outcome && real.cleared !== sab.cleared);
  }

  console.log("\n=== 7. IDEMPOTENT: refreshing the success page is harmless ===\n");
  {
    const order = await makeOrder(store.id, "paid");
    const bag = makeBag(12);
    const first = await clearBagOnConfirmedPurchase({ slug: store.slug, orderId: order.id }, { clear: bag.clear });
    const second = await clearBagOnConfirmedPurchase({ slug: store.slug, orderId: order.id }, { clear: bag.clear });
    assert("both calls confirm", first.cleared && second.cleared);
    eq("  the bag is empty, not negative or resurrected", bag.state.items, 0);
    eq("  and both clears targeted this store", bag.state.clears, [store.slug, store.slug]);
  }

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
