import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import {
  decodeBag,
  encodeBag,
  addToBag,
  setQuantity,
  removeFromBag,
  setBagCode,
  bagCount,
  bagCookieName,
  EMPTY_BAG,
  MAX_LINES,
  MAX_QUANTITY,
} from "@/lib/bag/bagCookie";
import { readFileSync } from "fs";
import { join } from "path";

// THE SHOPPING BAG:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-bag.ts" -OutFile out.txt
//
// BRINGS ITS OWN POSTGRES, so it is not in the shared runner — the same
// arrangement verify-promotions and verify-packaged-weight use, for the same
// measured reason: the shared lane sits at 42 suites and a 43rd kills the
// harness with ECONNRESET.
//
// TWO PROPERTIES MATTER MORE THAN THE REST:
//
//   BROWSING WRITES NOTHING. Adding, removing and re-counting a bag must not
//   create a single database row, for anonymous visitors or signed-in ones.
//   Asserted by counting rows before and after, not by reading the code.
//
//   THE COOKIE CARRIES NO AUTHORITY. It holds product ids and quantities, and
//   every price is derived server-side — so a tampered cookie can change what
//   is bought, which the customer could do with a button anyway, and nothing
//   else. Asserted by tampering with it.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const uniq = () => Math.random().toString(36).slice(2, 10);

const NOW = new Date("2026-08-26T12:00:00.000Z");

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const { resolveBag } = await import("@/lib/bag/resolveBag");
  const { createCheckoutDraft, markPaymentStarted, loadDraft, freezeLines, draftTotalMismatch, DRAFT_TTL_HOURS } =
    await import("@/lib/bag/checkoutDraft");
  const { createPromotionExecutable } = await import("@/lib/execution/executables/promotions");

  // ========================================================================
  console.log("\n=== 1. The cookie holds intent and nothing else ===\n");
  // ========================================================================

  let bag = EMPTY_BAG;
  bag = addToBag(bag, "ring");
  bag = addToBag(bag, "mug", 2);
  eq("two products, one of them twice", bag.items, [{ p: "ring", q: 1 }, { p: "mug", q: 2 }]);
  eq("the header counts units, not lines", bagCount(bag), 3);

  // ADDING THE SAME THING AGAIN IS NOT A SECOND LINE.
  bag = addToBag(bag, "ring", 2);
  eq("adding again increases the quantity", bag.items, [{ p: "ring", q: 3 }, { p: "mug", q: 2 }]);

  bag = setQuantity(bag, "mug", 5);
  eq("a quantity can be set outright", bag.items[1].q, 5);
  bag = setQuantity(bag, "mug", 0);
  eq("setting it to zero removes the line", bag.items.map((i) => i.p), ["ring"]);
  bag = removeFromBag(bag, "ring");
  eq("and removing the last one empties it", bag.items, []);

  const round = decodeBag(encodeBag(addToBag(setBagCode(EMPTY_BAG, "save10"), "ring", 2)));
  eq("a bag survives the round trip", round.items, [{ p: "ring", q: 2 }]);
  eq("and so does the typed code", round.code, "save10");
  eq("clearing the code clears it", setBagCode(round, "  ").code, null);

  // THE COOKIE CONTAINS NO MONEY. That is what makes it safe unsigned.
  const encoded = encodeBag(round);
  assert("nothing price-shaped is in the cookie",
    !/price|amount|total|cents|discountInCents/i.test(encoded), encoded);

  // ========================================================================
  console.log("\n=== 2. A broken cookie is an empty bag, never an error page ===\n");
  // ========================================================================

  eq("no cookie", decodeBag(null), EMPTY_BAG);
  eq("empty string", decodeBag(""), EMPTY_BAG);
  eq("not JSON", decodeBag("{not json"), EMPTY_BAG);
  eq("JSON that is not an object", decodeBag("[1,2,3]"), EMPTY_BAG);
  eq("an object with no items", decodeBag('{"code":"X"}').items, []);
  eq("items that are not objects", decodeBag('{"items":[1,"two",null]}').items, []);
  eq("an item with no product", decodeBag('{"items":[{"q":2}]}').items, []);
  eq("a quantity that is not a number", decodeBag('{"items":[{"p":"a","q":"lots"}]}').items, []);
  eq("a zero quantity drops the line", decodeBag('{"items":[{"p":"a","q":0}]}').items, []);
  eq("a negative quantity drops the line", decodeBag('{"items":[{"p":"a","q":-5}]}').items, []);
  eq("a fractional quantity is floored", decodeBag('{"items":[{"p":"a","q":2.7}]}').items, [{ p: "a", q: 2 }]);
  eq("a duplicated product is merged", decodeBag('{"items":[{"p":"a","q":1},{"p":"a","q":2}]}').items,
    [{ p: "a", q: 3 }]);
  assert("a customer never meets an error because of a stale cookie",
    decodeBag('{"items":"nonsense","code":42}').items.length === 0);

  // CAPS, so a cookie can never grow past what a browser carries.
  const huge = { items: Array.from({ length: 200 }, (_, i) => ({ p: `p${i}`, q: 999 })) };
  const capped = decodeBag(JSON.stringify(huge));
  eq(`no more than ${MAX_LINES} lines`, capped.items.length, MAX_LINES);
  eq(`and no more than ${MAX_QUANTITY} of anything`, capped.items[0].q, MAX_QUANTITY);
  assert("the encoded cookie stays well inside a browser's limit",
    encodeBag(capped).length < 4096, `${encodeBag(capped).length} bytes`);
  let full = EMPTY_BAG;
  for (let i = 0; i < MAX_LINES + 5; i++) full = addToBag(full, `p${i}`);
  eq("a full bag refuses quietly rather than dropping something already in it",
    full.items.length, MAX_LINES);

  eq("the cookie is scoped per store", bagCookieName("cubit-coil"), "genesis_bag_cubit-coil");
  eq("and a hostile slug cannot forge a cookie name",
    bagCookieName("a; Path=/; evil=1"), "genesis_bag_aPathevil1");

  // ========================================================================
  console.log("\n=== 3. Browsing writes nothing to the database ===\n");
  // ========================================================================

  const owner = await prisma.user.create({ data: { email: `bag-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Cubit & Coil", slug: `bag-${uniq()}`, published: true },
  });
  const ring = await prisma.product.create({
    data: { storeId: store.id, name: "Tensor Ring", priceInCents: 3500, active: true },
  });
  const mug = await prisma.product.create({
    data: { storeId: store.id, name: "Copper Mug", priceInCents: 2500, active: true },
  });
  const ctx = { storeId: store.id } as never;

  const countDrafts = () => prisma.checkoutDraft.count({ where: { storeId: store.id } });
  const countOrders = () => prisma.order.count({ where: { storeId: store.id } });
  const draftsBefore = await countDrafts();
  const ordersBefore = await countOrders();

  let shopping = EMPTY_BAG;
  shopping = addToBag(shopping, ring.id, 2);
  shopping = addToBag(shopping, mug.id);
  await resolveBag({ storeId: store.id, bag: shopping, now: NOW });
  shopping = setQuantity(shopping, ring.id, 1);
  await resolveBag({ storeId: store.id, bag: shopping, now: NOW });
  shopping = removeFromBag(shopping, mug.id);
  await resolveBag({ storeId: store.id, bag: shopping, now: NOW });

  eq("no draft was created by shopping", await countDrafts(), draftsBefore);
  eq("and no order", await countOrders(), ordersBefore);
  assert("browsing is a cookie and nothing else",
    (await countDrafts()) === 0,
    "an anonymous visitor must not leave a row behind for looking");

  // ========================================================================
  console.log("\n=== 4. The bag is resolved against real products ===\n");
  // ========================================================================

  const twoThings = addToBag(addToBag(EMPTY_BAG, ring.id, 2), mug.id, 1);
  const resolved = await resolveBag({ storeId: store.id, bag: twoThings, now: NOW });
  eq("both lines resolve", resolved.lines.map((l) => l.name), ["Tensor Ring", "Copper Mug"]);
  eq("with real prices from the products", resolved.lines.map((l) => l.unitPriceInCents), [3500, 2500]);
  eq("the subtotal is theirs", resolved.pricing.listSubtotalInCents, 3500 * 2 + 2500);
  eq("nothing discounted yet", resolved.pricing.discountInCents, 0);

  // A COOKIE FROM ANOTHER STORE RESOLVES TO NOTHING. This is why it needs no
  // signature: the id carries no authority.
  const other = await prisma.store.create({
    data: { userId: owner.id, name: "Somebody else", slug: `other-${uniq()}` },
  });
  const theirs = await prisma.product.create({
    data: { storeId: other.id, name: "Not yours", priceInCents: 99999, active: true },
  });
  const foreign = await resolveBag({
    storeId: store.id, bag: addToBag(EMPTY_BAG, theirs.id), now: NOW,
  });
  eq("another store's product is not in this bag", foreign.lines, []);
  eq("it is reported as dropped", foreign.droppedProductIds, [theirs.id]);
  eq("and it buys nothing", foreign.pricing.totalInCents, 0);

  // A PRODUCT THAT WENT AWAY WHILE IT SAT IN A BAG.
  await prisma.product.update({ where: { id: mug.id, storeId: store.id }, data: { active: false } });
  const withGone = await resolveBag({ storeId: store.id, bag: twoThings, now: NOW });
  eq("a deactivated product leaves the bag", withGone.lines.map((l) => l.name), ["Tensor Ring"]);
  eq("and is named so the page can say so", withGone.droppedProductIds, [mug.id]);
  eq("CONTROL: the rest of the bag still prices", withGone.pricing.totalInCents, 7000);
  await prisma.product.update({ where: { id: mug.id, storeId: store.id }, data: { active: true } });

  eq("an empty bag prices to zero without touching anything",
    (await resolveBag({ storeId: store.id, bag: EMPTY_BAG, now: NOW })).pricing.totalInCents, 0);

  // ========================================================================
  console.log("\n=== 5. Sales reach the bag, per line ===\n");
  // ========================================================================

  await createPromotionExecutable.run(
    {
      name: "Ring Sale", kind: "SALE", discountType: "PERCENTAGE", percentOff: 26,
      scope: "SELECTED_PRODUCTS", productIds: [ring.id],
    },
    ctx
  );

  const onSale = await resolveBag({ storeId: store.id, bag: twoThings, now: NOW });
  eq("the covered line is discounted", onSale.pricing.lines[0].discountInCents, Math.round(7000 * 0.26));
  eq("the uncovered line is not", onSale.pricing.lines[1].discountInCents, 0);
  eq("and the sale is named on the order", onSale.pricing.discount?.label, "Ring Sale");
  eq("CONTROL: the mug still costs what it costs", onSale.pricing.lines[1].subtotalInCents, 2500);

  // ========================================================================
  console.log("\n=== 6. A code is judged against the bag ===\n");
  // ========================================================================

  await createPromotionExecutable.run(
    { name: "Ten off", kind: "CODE", code: "SAVE10", discountType: "PERCENTAGE", percentOff: 10, scope: "ALL_PRODUCTS" },
    ctx
  );

  const withCode = await resolveBag({
    storeId: store.id, bag: setBagCode(twoThings, "save10"), now: NOW,
  });
  eq("a valid code is applied", withCode.code?.applied, true);
  // Ring sale = 1820 on 7000; code = 10% of 9500 = 950. The sale is better.
  eq("and the better of the two still wins", withCode.pricing.discountInCents, 1820);
  assert("a code never stacks on a sale",
    withCode.pricing.discountInCents === 1820,
    "stacking would have taken 1820 + 950");

  const unknown = await resolveBag({
    storeId: store.id, bag: setBagCode(twoThings, "NOPE"), now: NOW,
  });
  eq("an unknown code is refused", unknown.code?.applied, false);
  eq("as unknown, specifically",
    unknown.code && !unknown.code.applied ? unknown.code.reason : null, "unknown");
  eq("and changes no money", unknown.pricing.discountInCents, 1820);

  // A CODE FOR PRODUCTS THIS BAG DOES NOT HOLD.
  await createPromotionExecutable.run(
    {
      name: "Mug code", kind: "CODE", code: "MUGONLY", discountType: "PERCENTAGE", percentOff: 50,
      scope: "SELECTED_PRODUCTS", productIds: [mug.id],
    },
    ctx
  );
  const ringOnly = addToBag(EMPTY_BAG, ring.id, 1);
  const wrongBag = await resolveBag({
    storeId: store.id, bag: setBagCode(ringOnly, "MUGONLY"), now: NOW,
  });
  eq("a code covering nothing in the bag is refused",
    wrongBag.code && !wrongBag.code.applied ? wrongBag.code.reason : null, "not_eligible_for_product");
  // AND WHEN THE BAG DOES HOLD ONE, it discounts only that line.
  const mixedBag = await resolveBag({
    storeId: store.id, bag: setBagCode(twoThings, "MUGONLY"), now: NOW,
  });
  eq("a selective code applies", mixedBag.code?.applied, true);
  eq("to the line it covers", mixedBag.pricing.lines[1].discountInCents, 1250);
  eq("while the ring keeps its own sale", mixedBag.pricing.lines[0].discountInCents, 1820);

  // ========================================================================
  console.log("\n=== 7. The draft is written once, and frozen ===\n");
  // ========================================================================

  const forCheckout = await resolveBag({ storeId: store.id, bag: twoThings, now: NOW });
  const draftId = await createCheckoutDraft({
    storeId: store.id,
    lines: forCheckout.lines,
    pricing: forCheckout.pricing,
    now: NOW,
  });
  eq("continuing to payment writes exactly one row", await countDrafts(), 1);

  const loaded = await loadDraft(store.id, draftId);
  eq("it opens OPEN", loaded?.status, "OPEN");
  eq("with both lines", loaded?.lines.length, 2);
  eq("each carrying the product's NAME, not a reference",
    loaded?.lines.map((l) => l.productName), ["Tensor Ring", "Copper Mug"]);
  eq("and the totals it was quoted", loaded?.totalInCents, forCheckout.pricing.totalInCents);
  eq("expiring 48 hours out",
    loaded && (await prisma.checkoutDraft.findFirstOrThrow({ where: { id: draftId, storeId: store.id } })).expiresAt.getTime(),
    NOW.getTime() + DRAFT_TTL_HOURS * 3600 * 1000);

  // FROZEN. The merchant can now do their worst.
  await prisma.product.update({
    where: { id: ring.id, storeId: store.id },
    data: { priceInCents: 9999, name: "Renamed Ring" },
  });
  const stillFrozen = await loadDraft(store.id, draftId);
  eq("a price change does not reach a quoted draft",
    stillFrozen?.lines[0].unitPriceInCents, 3500);
  eq("nor does a rename", stillFrozen?.lines[0].productName, "Tensor Ring");
  eq("and the total is unchanged", stillFrozen?.totalInCents, forCheckout.pricing.totalInCents);
  assert("because the money moves at the figure the customer agreed to",
    stillFrozen?.totalInCents === forCheckout.pricing.totalInCents);
  await prisma.product.update({
    where: { id: ring.id, storeId: store.id },
    data: { priceInCents: 3500, name: "Tensor Ring" },
  });

  // STORE-SCOPED. A draft id in a URL is not proof of ownership.
  eq("another store cannot load this draft", await loadDraft(other.id, draftId), null);
  eq("nor can a made-up id", await loadDraft(store.id, "draft_nonexistent"), null);
  eq("nor no id at all", await loadDraft(store.id, null), null);

  // ========================================================================
  console.log("\n=== 8. Payment started is a one-way door ===\n");
  // ========================================================================

  await markPaymentStarted({
    storeId: store.id, draftId, provider: "STRIPE", externalSessionId: "cs_test_1",
  });
  const started = await loadDraft(store.id, draftId);
  eq("the draft records which rail it went to", started?.status, "PAYMENT_STARTED");

  // A REDELIVERED REDIRECT MUST NOT DRAG IT BACKWARDS.
  await markPaymentStarted({
    storeId: store.id, draftId, provider: "PAYPAL", externalSessionId: "second_attempt",
  });
  const afterSecond = await prisma.checkoutDraft.findFirstOrThrow({ where: { id: draftId, storeId: store.id } });
  eq("a second start does not overwrite the first", afterSecond.externalSessionId, "cs_test_1");
  eq("and the provider is unchanged", afterSecond.paymentProvider, "STRIPE");

  // Another store cannot advance it either.
  await markPaymentStarted({
    storeId: other.id, draftId, provider: "PAYPAL", externalSessionId: "hostile",
  });
  eq("CONTROL: and neither can another store",
    (await prisma.checkoutDraft.findFirstOrThrow({ where: { id: draftId, storeId: store.id } })).externalSessionId, "cs_test_1");

  // A NEW ATTEMPT IS A NEW ROW, never an edit racing a provider.
  const second = await createCheckoutDraft({
    storeId: store.id, lines: forCheckout.lines, pricing: forCheckout.pricing, now: NOW,
  });
  assert("trying again writes a fresh draft", second !== draftId);
  eq("leaving the first exactly as it was",
    (await loadDraft(store.id, draftId))?.status, "PAYMENT_STARTED");

  // ========================================================================
  console.log("\n=== 9. The frozen lines are checked, not trusted ===\n");
  // ========================================================================

  // A bag and a pricing that disagree would put one product's name against
  // another's price on a real receipt.
  let threw = false;
  try {
    freezeLines(forCheckout.lines, { ...forCheckout.pricing, lines: [forCheckout.pricing.lines[0]] });
  } catch {
    threw = true;
  }
  assert("a bag and a pricing of different lengths is refused", threw);

  let mismatched = false;
  try {
    freezeLines([...forCheckout.lines].reverse(), forCheckout.pricing);
  } catch {
    mismatched = true;
  }
  assert("and so is one whose lines are in a different order", mismatched);

  // The database enforces the arithmetic too, so a bug in code cannot store an
  // impossible contract.
  let refused = false;
  try {
    await prisma.checkoutDraft.create({
      data: {
        storeId: store.id, lines: [] as unknown as object,
        listSubtotalInCents: 1000, discountInCents: 200, shippingInCents: 0,
        totalInCents: 999, // should be 800
        expiresAt: new Date(NOW.getTime() + 3600_000),
      },
    });
  } catch {
    refused = true;
  }
  assert("a draft whose total does not follow from its parts is refused by Postgres", refused);

  let overDiscount = false;
  try {
    await prisma.checkoutDraft.create({
      data: {
        storeId: store.id, lines: [] as unknown as object,
        listSubtotalInCents: 1000, discountInCents: 2000, shippingInCents: 0, totalInCents: 0,
        expiresAt: new Date(NOW.getTime() + 3600_000),
      },
    });
  } catch {
    overDiscount = true;
  }
  assert("and so is one discounting more than the goods cost", overDiscount);

  // ========================================================================
  console.log("\n=== 10. What was charged versus what was promised ===\n");
  // ========================================================================

  eq("agreement is not a mismatch", draftTotalMismatch(9500, 9500), null);
  eq("a provider that did not say is not a mismatch", draftTotalMismatch(9500, null), null);
  eq("and a real difference is reported rather than reconciled",
    draftTotalMismatch(9500, 9000), { draft: 9500, settled: 9000 });
  assert("because silently trusting either number is how a wrong charge hides",
    draftTotalMismatch(9500, 9000) !== null);

  // ========================================================================
  console.log("\n=== 11. Nothing here writes a row for browsing ===\n");
  // ========================================================================

  const store2 = codeOnly(readFileSync(join(process.cwd(), "lib", "bag", "bagStore.ts"), "utf8"));
  assert("the cookie is not readable from the page's scripts", /httpOnly: true/.test(store2));
  assert("and survives the return trip from a payment provider",
    /sameSite: "lax"/.test(store2),
    "under strict the bag would appear to empty itself on the way back from Stripe");

  const resolveSrc = codeOnly(readFileSync(join(process.cwd(), "lib", "bag", "resolveBag.ts"), "utf8"));
  assert("resolving a bag never creates anything",
    !/prisma\.[a-zA-Z]+\.(create|update|upsert|delete)/.test(resolveSrc),
    "browsing must stay database-free");

  // THE STORE SCOPE IS ENFORCED ONE LEVEL BELOW THIS FILE, and that is worth
  // recording. Removing `storeId` from the product lookup does not leak another
  // store's product into a bag — the tenant-isolation Prisma extension refuses
  // the query outright and the whole request throws. Verified by deleting the
  // scope and watching this suite abort rather than report a wrong bag.
  //
  // Asserted here anyway, because a crash is a worse way to learn it than a
  // failing line, and because the next person to edit that query should see
  // the requirement stated where they are working.
  assert("the bag is resolved against THIS store only",
    /storeId: params\.storeId/.test(resolveSrc),
    "an id in a cookie carries no authority; the scope is what makes that true");
  assert("and only against products still on sale",
    /active: true/.test(resolveSrc));

  const cookieSrc = codeOnly(readFileSync(join(process.cwd(), "lib", "bag", "bagCookie.ts"), "utf8"));
  assert("and the cookie module touches neither database nor framework",
    !/prisma|next\/headers/.test(cookieSrc),
    "which is what makes every rule above provable without a browser");

  await prisma.store.delete({ where: { id: store.id } });
  await prisma.store.delete({ where: { id: other.id } });
  await prisma.user.delete({ where: { id: owner.id } });
  await db.close();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
