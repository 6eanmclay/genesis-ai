import Stripe from "stripe";
import { startTestServer } from "@/scripts/lib/testServer";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { priceOrder, discountAmountFor, type DiscountCandidate } from "@/lib/pricing/orderPricing";
import {
  eligibilityOf,
  normalizeCode,
  candidateFrom,
  codeRejectionMessage,
  type PromotionLike,
} from "@/lib/promotions/eligibility";
import {
  toDiscountMetadata,
  parseDiscountMetadata,
  packPaypalCustomId,
  parsePaypalCustomId,
} from "@/lib/promotions/checkoutDiscount";
import { readFileSync } from "fs";
import { join } from "path";

// PROMOTIONS AND DISCOUNT CODES:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-promotions.ts" -OutFile out.txt
//
// WHAT THIS EXISTS TO PROVE. Before this milestone there was no such thing as a
// merchandise subtotal in Genesis: the price was `product.priceInCents`, read
// raw and handed to a provider at two call sites in two different shapes, with
// Stripe doing the addition and PayPal charging no shipping at all. A discount
// had nowhere to be applied that both rails would honour.
//
// So the assertions below are not really about discounts. They are about
// whether ONE function now decides what an order costs, whether the customer
// can influence it with anything other than a code, and whether the record of
// what somebody paid survives the merchant changing their mind afterwards.
//
// RUNS A REAL NEXT SERVER, because the order-creation branch of the merchant
// webhook ends in Next's `after()`, which throws outside a request scope — so
// importing the exported POST can never reach the write. That is not a detail:
// the write is the assertion, and the foreign-key defect this suite found lives
// exactly there. See scripts/lib/testServer.ts.
//
// It therefore brings its own Postgres and is NOT in the shared runner — the
// same arrangement verify-packaged-weight and verify-attach-tracking use, for
// the same measured reason: the shared lane sits at 42 suites and a 43rd kills
// the harness outright with ECONNRESET. A green shared count does not include
// this file, so it has to be run.

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
const read = (...p: string[]) => codeOnly(readFileSync(join(process.cwd(), ...p), "utf8"));
const uniq = () => Math.random().toString(36).slice(2, 10);

// The secret startTestServer injects into the server it spawns.
const MERCHANT_SECRET = "whsec_harness_merchant";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const basePromotion: PromotionLike = {
  id: "promo_1",
  name: "Spring Sale",
  kind: "SALE",
  code: null,
  discountType: "PERCENTAGE",
  percentOff: 15,
  amountOffInCents: null,
  scope: "ALL_PRODUCTS",
  active: true,
  startsAt: null,
  endsAt: null,
};

async function main() {
  const server = await startTestServer();
  const db = server.db;
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
  process.env.STRIPE_WEBHOOK_SECRET = MERCHANT_SECRET;

  // Imported after the database is pointed at, so every client binds to it.
  const { prisma, prismaSystem } = await import("@/lib/prisma");
  const { priceCheckout, resolveDiscounts } = await import("@/lib/promotions/resolve");
  const { createPromotionExecutable, updatePromotionExecutable, deletePromotionExecutable } =
    await import("@/lib/execution/executables/promotions");
  const { previewCheckoutPrice } = await import("@/app/store/[slug]/actions");

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  /** Over real HTTP to the real route, so `after()` has the scope it needs. */
  const stripeWebhook = async (event: unknown): Promise<Response> => {
    const payload = JSON.stringify(event);
    return fetch(`${server.baseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: MERCHANT_SECRET }),
        "content-type": "application/json",
      },
      body: payload,
    });
  };

  // ==========================================================================
  console.log("\n=== 1. The arithmetic, before any of it touches a database ===\n");
  // ==========================================================================

  const pct = (percentOff: number): DiscountCandidate => ({
    kind: "SALE", promotionId: "p", label: "Sale", code: null,
    discountType: "PERCENTAGE", percentOff, amountOffInCents: null,
  });
  const flat = (amountOffInCents: number): DiscountCandidate => ({
    kind: "CODE", promotionId: "p", label: "SAVE", code: "SAVE",
    discountType: "FIXED_AMOUNT", percentOff: null, amountOffInCents,
  });

  eq("no discounts means the list price, unchanged",
    priceOrder({ unitPriceInCents: 2400 }).totalInCents, 2400);
  eq("and records no discount at all", priceOrder({ unitPriceInCents: 2400 }).discount, null);

  eq("15% off $24.00 is $20.40", priceOrder({ unitPriceInCents: 2400, candidates: [pct(15)] }).totalInCents, 2040);
  eq("$5.00 off $24.00 is $19.00", priceOrder({ unitPriceInCents: 2400, candidates: [flat(500)] }).totalInCents, 1900);

  // ROUNDED, CONSISTENTLY. Half a cent has to go somewhere, and it has to go to
  // the same place on the review screen as at the charge.
  eq("a half-cent rounds rather than truncating", discountAmountFor(pct(15), 2499), 375);

  // BEST SINGLE WINS. Two well-meant 20% offers give away 20%, not 36%.
  const both = priceOrder({ unitPriceInCents: 2400, candidates: [pct(15), flat(240)] });
  eq("the better discount wins", both.discount?.amountInCents, 360);
  eq("and it is the only one applied", both.merchandiseSubtotalInCents, 2040);
  assert("discounts never compound",
    both.merchandiseSubtotalInCents === 2400 - 360,
    "stacking 15% and $2.40 would have charged 1836");

  // Deterministic tie-break, so the outcome does not depend on query order.
  const tie = priceOrder({ unitPriceInCents: 2400, candidates: [flat(360), pct(15)] });
  eq("a tie goes to the standing sale", tie.discount?.kind, "SALE");
  eq("CONTROL: and it is still worth the same", tie.discount?.amountInCents, 360);

  // NEVER NEGATIVE, structurally.
  const over = priceOrder({ unitPriceInCents: 2000, candidates: [flat(5000)] });
  eq("a $50 code on a $20 product takes off exactly $20", over.discount?.amountInCents, 2000);
  eq("and the subtotal is zero, never below", over.merchandiseSubtotalInCents, 0);
  eq("CONTROL: so is the total", over.totalInCents, 0);
  eq("a 100% discount is allowed and lands on zero",
    priceOrder({ unitPriceInCents: 2000, candidates: [pct(100)] }).totalInCents, 0);

  // A malformed promotion charges the NORMAL price, never nothing.
  const broken: DiscountCandidate = {
    kind: "SALE", promotionId: "p", label: "Broken", code: null,
    discountType: "PERCENTAGE", percentOff: null, amountOffInCents: null,
  };
  eq("a promotion with no value takes nothing off", discountAmountFor(broken, 2400), 0);
  eq("and is not recorded as applied", priceOrder({ unitPriceInCents: 2400, candidates: [broken] }).discount, null);
  assert("because the safe reading of an unknown discount is full price",
    priceOrder({ unitPriceInCents: 2400, candidates: [broken] }).totalInCents === 2400);

  // A zero-value discount is not "applied" — recording it would make a
  // promotion look used when it changed no money.
  eq("a discount worth nothing is not recorded",
    priceOrder({ unitPriceInCents: 2400, candidates: [flat(0)] }).discount, null);

  // ==========================================================================
  console.log("\n=== 2. Shipping is untouched by every one of them ===\n");
  // ==========================================================================

  const shipped = priceOrder({ unitPriceInCents: 2400, candidates: [pct(15)], shippingInCents: 892 });
  eq("shipping is carried through at full price", shipped.shippingInCents, 892);
  eq("the discount comes off the goods only", shipped.discount?.amountInCents, 360);
  eq("and the total is discounted goods plus full shipping", shipped.totalInCents, 2040 + 892);
  assert("CONTROL: the percentage never reached the shipping",
    shipped.shippingInCents === 892,
    "15% of 892 is 134; a total of 2932 rather than 2798 is what proves it did not");

  // Even a discount larger than the goods leaves shipping standing.
  const wiped = priceOrder({ unitPriceInCents: 2000, candidates: [flat(9999)], shippingInCents: 892 });
  eq("goods can go to zero", wiped.merchandiseSubtotalInCents, 0);
  eq("and shipping is still owed", wiped.totalInCents, 892);

  // ==========================================================================
  console.log("\n=== 3. Eligibility, and why a code was refused ===\n");
  // ==========================================================================

  const check = (over: Partial<PromotionLike>, productId = "prod_1", covered: string[] = []) =>
    eligibilityOf({ ...basePromotion, ...over }, { productId, coveredProductIds: covered, now: NOW });

  assert("a live promotion applies", check({}).eligible);
  eq("a switched-off one says so", check({ active: false }), { eligible: false, reason: "inactive" });
  eq("one scheduled for later is not started",
    check({ startsAt: new Date("2026-09-01T00:00:00Z") }), { eligible: false, reason: "not_started" });
  eq("one whose window closed is expired",
    check({ endsAt: new Date("2026-08-01T00:00:00Z") }), { eligible: false, reason: "expired" });
  assert("CONTROL: and one inside its window applies",
    check({ startsAt: new Date("2026-08-01T00:00:00Z"), endsAt: new Date("2026-09-01T00:00:00Z") }).eligible);

  // The switch beats the window, because that is the reason a merchant needs.
  eq("a paused promotion inside its dates reports the pause, not the dates",
    check({ active: false, endsAt: new Date("2026-08-01T00:00:00Z") }).eligible === false
      ? check({ active: false, endsAt: new Date("2026-08-01T00:00:00Z") })
      : null,
    { eligible: false, reason: "inactive" });

  eq("a selective promotion refuses a product it does not cover",
    check({ scope: "SELECTED_PRODUCTS" }, "prod_1", ["prod_2"]),
    { eligible: false, reason: "not_eligible_for_product" });
  assert("and accepts one it does",
    check({ scope: "SELECTED_PRODUCTS" }, "prod_1", ["prod_2", "prod_1"]).eligible);

  eq("case and spacing do not make a different code", normalizeCode("  save 10 "), "SAVE10");
  eq("CONTROL: and a genuinely different code stays different", normalizeCode("save11"), "SAVE11");

  // Four situations, four sentences. Telling all of them "invalid code" is how
  // a customer holding a real code from a real email abandons a real purchase.
  const messages = (["unknown", "inactive", "not_started", "expired", "not_eligible_for_product"] as const)
    .map((reason) => codeRejectionMessage(reason, "SAVE10"));
  eq("every rejection has its own wording", new Set(messages).size, messages.length);
  assert("and each names the code the customer typed", messages.every((m) => m.includes("SAVE10")));

  eq("a code's label is the code itself",
    candidateFrom({ ...basePromotion, kind: "CODE", code: "SAVE10" }).label, "SAVE10");
  eq("and a sale's label is its name", candidateFrom(basePromotion).label, "Spring Sale");

  // ==========================================================================
  console.log("\n=== 4. Real rows, real store ===\n");
  // ==========================================================================

  const owner = await prisma.user.create({ data: { email: `promo-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Cubit & Coil", slug: `promo-${uniq()}`, published: true },
  });
  const ring = await prisma.product.create({
    data: { storeId: store.id, name: "Tensor Ring", priceInCents: 2400, active: true },
  });
  const coil = await prisma.product.create({
    data: { storeId: store.id, name: "Copper Coil", priceInCents: 5000, active: true },
  });
  const ctx = { storeId: store.id } as never;

  const priceOf = async (productId: string, unitPriceInCents: number, code?: string) =>
    (await priceCheckout({ storeId: store.id, productId, unitPriceInCents, code, now: NOW })).pricing;

  // --- 1. NORMAL PURCHASE --------------------------------------------------
  eq("with no promotions, a purchase is the list price", (await priceOf(ring.id, 2400)).totalInCents, 2400);
  eq("and carries no discount", (await priceOf(ring.id, 2400)).discount, null);

  // --- 2. STORE-WIDE PERCENTAGE SALE --------------------------------------
  const saleResult = await createPromotionExecutable.run(
    { name: "Spring Sale", kind: "SALE", discountType: "PERCENTAGE", percentOff: 15, scope: "ALL_PRODUCTS" },
    ctx
  );
  const saleId = saleResult.metadata!.promotionId;
  eq("the create verifies against the stored row",
    (await createPromotionExecutable.verify(
      { name: "Spring Sale", kind: "SALE", discountType: "PERCENTAGE", percentOff: 15, scope: "ALL_PRODUCTS" },
      ctx, saleResult.metadata
    )).state, "verified");

  eq("a store-wide sale reaches one product", (await priceOf(ring.id, 2400)).totalInCents, 2040);
  eq("and every other one too", (await priceOf(coil.id, 5000)).totalInCents, 4250);
  eq("shown under the sale's own name", (await priceOf(ring.id, 2400)).discount?.label, "Spring Sale");

  // --- 3. SELECTED-PRODUCT SALE -------------------------------------------
  await updatePromotionExecutable.run({ promotionId: saleId, active: false }, ctx);
  const selectiveResult = await createPromotionExecutable.run(
    {
      name: "Coil Clearance", kind: "SALE", discountType: "PERCENTAGE", percentOff: 20,
      scope: "SELECTED_PRODUCTS", productIds: [coil.id],
    },
    ctx
  );
  eq("a selective sale applies to the product it names", (await priceOf(coil.id, 5000)).totalInCents, 4000);
  eq("and leaves every other product at full price", (await priceOf(ring.id, 2400)).totalInCents, 2400);
  eq("the create verified the product links, not just the row",
    (await createPromotionExecutable.verify(
      {
        name: "Coil Clearance", kind: "SALE", discountType: "PERCENTAGE", percentOff: 20,
        scope: "SELECTED_PRODUCTS", productIds: [coil.id],
      },
      ctx, selectiveResult.metadata
    )).state, "verified");
  // COUNTED, not merely present: a verify asserting that SOME links existed
  // would pass on a promotion that saved one of two.
  const miscounted = await createPromotionExecutable.verify(
    {
      name: "Coil Clearance", kind: "SALE", discountType: "PERCENTAGE", percentOff: 20,
      scope: "SELECTED_PRODUCTS", productIds: [coil.id, ring.id],
    },
    ctx, selectiveResult.metadata
  );
  assert("CONTROL: and would have caught a missing product link",
    miscounted.state !== "verified",
    "one of two links stored must not verify against two");

  await updatePromotionExecutable.run({ promotionId: selectiveResult.metadata!.promotionId, active: false }, ctx);

  // --- 4. FIXED-DOLLAR DISCOUNT -------------------------------------------
  await createPromotionExecutable.run(
    { name: "Five Off", kind: "SALE", discountType: "FIXED_AMOUNT", amountOffInCents: 500, scope: "ALL_PRODUCTS" },
    ctx
  );
  eq("a fixed-dollar sale takes off exactly that", (await priceOf(ring.id, 2400)).totalInCents, 1900);
  eq("regardless of the product's price", (await priceOf(coil.id, 5000)).totalInCents, 4500);

  const fiveOff = await prisma.promotion.findFirstOrThrow({ where: { storeId: store.id, name: "Five Off" } });
  await updatePromotionExecutable.run({ promotionId: fiveOff.id, active: false }, ctx);

  // ==========================================================================
  console.log("\n=== 5. Codes: valid, invalid, expired, switched off ===\n");
  // ==========================================================================

  await createPromotionExecutable.run(
    {
      name: "Email campaign", kind: "CODE", code: "save10",
      discountType: "PERCENTAGE", percentOff: 10, scope: "ALL_PRODUCTS",
    },
    ctx
  );

  // --- 5. VALID CODE -------------------------------------------------------
  eq("a valid code discounts the order", (await priceOf(ring.id, 2400, "SAVE10")).totalInCents, 2160);
  eq("typed in any case", (await priceOf(ring.id, 2400, " save 10 ")).totalInCents, 2160);
  eq("and is recorded as a code, not a sale", (await priceOf(ring.id, 2400, "SAVE10")).discount?.kind, "CODE");
  eq("labelled with the code itself", (await priceOf(ring.id, 2400, "SAVE10")).discount?.label, "SAVE10");

  // A code that is never typed does nothing. This is the whole difference
  // between the two kinds, and it is asserted rather than assumed.
  eq("but does nothing at all until it is entered", (await priceOf(ring.id, 2400)).totalInCents, 2400);

  // --- 6. INVALID CODE -----------------------------------------------------
  const unknown = await resolveDiscounts({ storeId: store.id, productId: ring.id, code: "NOPE", now: NOW });
  eq("an unknown code is refused", unknown.code?.applied, false);
  eq("as unknown, specifically",
    unknown.code && !unknown.code.applied ? unknown.code.reason : null, "unknown");
  eq("and changes no money", (await priceOf(ring.id, 2400, "NOPE")).totalInCents, 2400);
  eq("CONTROL: no discount is recorded either", (await priceOf(ring.id, 2400, "NOPE")).discount, null);

  // --- 7. EXPIRED AND INACTIVE CODES --------------------------------------
  await createPromotionExecutable.run(
    {
      name: "Last month", kind: "CODE", code: "EXPIRED",
      discountType: "PERCENTAGE", percentOff: 50, scope: "ALL_PRODUCTS",
      endsAt: new Date("2026-08-01T00:00:00Z"),
    },
    ctx
  );
  const expired = await resolveDiscounts({ storeId: store.id, productId: ring.id, code: "EXPIRED", now: NOW });
  eq("an expired code is refused", expired.code && !expired.code.applied ? expired.code.reason : null, "expired");
  eq("and charges full price", (await priceOf(ring.id, 2400, "EXPIRED")).totalInCents, 2400);

  await createPromotionExecutable.run(
    {
      name: "Paused", kind: "CODE", code: "PAUSED",
      discountType: "PERCENTAGE", percentOff: 50, scope: "ALL_PRODUCTS", active: false,
    },
    ctx
  );
  const paused = await resolveDiscounts({ storeId: store.id, productId: ring.id, code: "PAUSED", now: NOW });
  eq("a switched-off code is refused", paused.code && !paused.code.applied ? paused.code.reason : null, "inactive");
  eq("and charges full price", (await priceOf(ring.id, 2400, "PAUSED")).totalInCents, 2400);

  await createPromotionExecutable.run(
    {
      name: "Next month", kind: "CODE", code: "SOON",
      discountType: "PERCENTAGE", percentOff: 50, scope: "ALL_PRODUCTS",
      startsAt: new Date("2026-09-01T00:00:00Z"),
    },
    ctx
  );
  const soon = await resolveDiscounts({ storeId: store.id, productId: ring.id, code: "SOON", now: NOW });
  eq("a code that has not started is refused",
    soon.code && !soon.code.applied ? soon.code.reason : null, "not_started");

  await createPromotionExecutable.run(
    {
      name: "Coil only", kind: "CODE", code: "COILONLY",
      discountType: "PERCENTAGE", percentOff: 25, scope: "SELECTED_PRODUCTS", productIds: [coil.id],
    },
    ctx
  );
  const wrongProduct = await resolveDiscounts({ storeId: store.id, productId: ring.id, code: "COILONLY", now: NOW });
  eq("a code for another product is refused",
    wrongProduct.code && !wrongProduct.code.applied ? wrongProduct.code.reason : null,
    "not_eligible_for_product");
  eq("CONTROL: and works on the product it is for", (await priceOf(coil.id, 5000, "COILONLY")).totalInCents, 3750);

  // ANOTHER STORE'S CODE IS SIMPLY UNKNOWN HERE.
  const other = await prisma.store.create({
    data: { userId: owner.id, name: "Somebody else", slug: `other-${uniq()}` },
  });
  await createPromotionExecutable.run(
    { name: "Theirs", kind: "CODE", code: "THEIRS", discountType: "PERCENTAGE", percentOff: 90, scope: "ALL_PRODUCTS" },
    { storeId: other.id } as never
  );
  const theirsId = (await prisma.promotion.findFirstOrThrow({
    where: { storeId: other.id, code: "THEIRS" },
    select: { id: true },
  })).id;
  const foreign = await resolveDiscounts({ storeId: store.id, productId: ring.id, code: "THEIRS", now: NOW });
  eq("a code belonging to another business does not work here",
    foreign.code && !foreign.code.applied ? foreign.code.reason : null, "unknown");
  eq("CONTROL: and it really does work in its own", (await priceCheckout({
    storeId: other.id, productId: "any", unitPriceInCents: 1000, code: "THEIRS", now: NOW,
  })).pricing.totalInCents, 100);

  // ==========================================================================
  console.log("\n=== 6. Sale and code together: the better one, never both ===\n");
  // ==========================================================================

  const bigSale = await createPromotionExecutable.run(
    { name: "Big Sale", kind: "SALE", discountType: "PERCENTAGE", percentOff: 15, scope: "ALL_PRODUCTS" },
    ctx
  );
  // 15% of 2400 = 360; SAVE10 is 10% = 240. The sale is better.
  eq("the sale wins when it is better", (await priceOf(ring.id, 2400, "SAVE10")).discount?.kind, "SALE");
  eq("and the customer pays the sale price", (await priceOf(ring.id, 2400, "SAVE10")).totalInCents, 2040);
  assert("never both",
    (await priceOf(ring.id, 2400, "SAVE10")).totalInCents === 2040,
    "stacking would have charged 1836");

  await createPromotionExecutable.run(
    { name: "Half", kind: "CODE", code: "HALF", discountType: "PERCENTAGE", percentOff: 50, scope: "ALL_PRODUCTS" },
    ctx
  );
  eq("and the code wins when IT is better", (await priceOf(ring.id, 2400, "HALF")).discount?.kind, "CODE");
  eq("at the code's price", (await priceOf(ring.id, 2400, "HALF")).totalInCents, 1200);

  await updatePromotionExecutable.run({ promotionId: bigSale.metadata!.promotionId, active: false }, ctx);
  const half = await prisma.promotion.findFirstOrThrow({ where: { storeId: store.id, code: "HALF" } });
  await updatePromotionExecutable.run({ promotionId: half.id, active: false }, ctx);

  // ==========================================================================
  console.log("\n=== 7. Across the wire to the order, on both rails ===\n");
  // ==========================================================================

  const save10 = await prisma.promotion.findFirstOrThrow({
    where: { storeId: store.id, code: "SAVE10" },
    select: { id: true },
  });
  const priced = priceOrder({
    unitPriceInCents: 2400,
    candidates: [{
      kind: "CODE", promotionId: save10.id, label: "SAVE10", code: "SAVE10",
      discountType: "PERCENTAGE", percentOff: 10, amountOffInCents: null,
    }],
    shippingInCents: 892,
  });

  const metadata = toDiscountMetadata(priced);
  const parsed = parseDiscountMetadata(metadata);
  eq("the amount taken off survives the round trip", parsed.discountInCents, 240);
  eq("so does the list subtotal", parsed.listSubtotalInCents, 2400);
  eq("and which promotion it was", parsed.promotionId, save10.id);
  eq("and the code the customer typed", parsed.promotionCode, "SAVE10");
  eq("and whether it was a sale or a code", parsed.promotionKind, "CODE");
  assert("every Stripe metadata value is a string",
    Object.values(metadata).every((v) => typeof v === "string"));
  assert("and fits Stripe's 500-character limit",
    Object.values(metadata).every((v) => v.length <= 500));

  eq("an undiscounted checkout writes no discount keys at all",
    toDiscountMetadata(priceOrder({ unitPriceInCents: 2400 })), {});
  eq("and parses to nothing, exactly as an order predating promotions does",
    parseDiscountMetadata({ storeId: "s", productId: "p" }).discountInCents, null);
  eq("a promotion kind we did not write is discarded",
    parseDiscountMetadata({ discountInCents: "240", promotionKind: "SOMETHING" }).promotionKind, null);
  eq("and a zero discount is treated as none",
    parseDiscountMetadata({ discountInCents: "0", promotionId: "p" }).promotionId, null);

  // PayPal gets one 127-character string and no metadata.
  const packed = packPaypalCustomId({ storeId: store.id, productId: ring.id, pricing: priced });
  assert("the PayPal field fits inside PayPal's limit", packed.length <= 127, `${packed.length} chars`);
  const unpacked = parsePaypalCustomId(packed);
  eq("the store survives", unpacked.storeId, store.id);
  eq("the product survives", unpacked.productId, ring.id);
  eq("the amount taken off survives", unpacked.discountInCents, 240);
  eq("and the list subtotal", unpacked.listSubtotalInCents, 2400);

  // BACKWARD COMPATIBLE: a checkout already in flight when this shipped was
  // packed with the old two-part format and must still parse.
  const legacy = parsePaypalCustomId(`${store.id}:${ring.id}`);
  eq("an old two-part custom_id still yields its store", legacy.storeId, store.id);
  eq("and its product", legacy.productId, ring.id);
  eq("with no discount, which is what it had", legacy.discountInCents, null);
  eq("a malformed field loses attribution, not the order",
    parsePaypalCustomId("garbage").productId, null);

  // ==========================================================================
  console.log("\n=== 8. The order keeps its own record, and keeps it forever ===\n");
  // ==========================================================================
  // Driven through the REAL webhook route with a genuinely signed payload —
  // not by calling prisma.order.create with the fields this suite would like
  // to see.

  const discountedSession = {
    id: `evt_${uniq()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_discounted_${uniq()}`,
        mode: "payment",
        // 2400 - 240 + 892. Stripe's own settled total, as it would arrive.
        amount_total: 3052,
        currency: "usd",
        customer_details: { email: "buyer@test.local" },
        metadata: {
          storeId: store.id,
          productId: ring.id,
          ...toDiscountMetadata(priced),
        },
      },
    },
  };
  const response = await stripeWebhook((discountedSession));
  eq("the webhook accepted the event", response.status, 200);

  const written = await prismaSystem.order.findFirst({
    where: { storeId: store.id, externalOrderId: discountedSession.data.object.id },
  });
  assert("an order was written", written !== null);
  eq("its total is what the provider settled", written?.amountInCents, 3052);
  eq("the discount is recorded", written?.discountInCents, 240);
  eq("with the list subtotal it came off", written?.listSubtotalInCents, 2400);
  eq("and which promotion did it", written?.appliedPromotionLabel, "SAVE10");
  eq("and the code as typed", written?.appliedPromotionCode, "SAVE10");
  eq("and its kind", written?.appliedPromotionKind, "CODE");

  // THE POINT OF FREEZING IT. The label and code were COPIED onto the order,
  // not read through a relation, so the merchant can now do their worst.
  const live = await createPromotionExecutable.run(
    {
      name: "Renamed later", kind: "CODE", code: "TEMP",
      discountType: "PERCENTAGE", percentOff: 10, scope: "ALL_PRODUCTS",
    },
    ctx
  );
  const livePromoId = live.metadata!.promotionId;
  const linkedSession = {
    id: `evt_${uniq()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_linked_${uniq()}`,
        mode: "payment",
        amount_total: 2160,
        currency: "usd",
        customer_details: { email: "buyer2@test.local" },
        metadata: {
          storeId: store.id, productId: ring.id,
          listSubtotalInCents: "2400", discountInCents: "240",
          promotionId: livePromoId, promotionLabel: "TEMP", promotionCode: "TEMP", promotionKind: "CODE",
        },
      },
    },
  };
  eq("a second order lands", (await stripeWebhook((linkedSession))).status, 200);

  const before = await prismaSystem.order.findFirstOrThrow({
    where: { externalOrderId: linkedSession.data.object.id },
  });
  eq("linked to the live promotion", before.appliedPromotionId, livePromoId);

  // Rename it, change its value, switch it off, then delete it outright.
  await updatePromotionExecutable.run({ promotionId: livePromoId, name: "Something else", percentOff: 90 }, ctx);
  await updatePromotionExecutable.run({ promotionId: livePromoId, active: false }, ctx);
  await deletePromotionExecutable.run({ promotionId: livePromoId }, ctx);
  eq("the delete verifies the promotion is gone",
    (await deletePromotionExecutable.verify({ promotionId: livePromoId }, ctx, undefined as never)).state,
    "verified");

  const after = await prismaSystem.order.findFirstOrThrow({
    where: { externalOrderId: linkedSession.data.object.id },
  });
  eq("the order survives the promotion being deleted", after.amountInCents, 2160);
  eq("what was taken off is unchanged", after.discountInCents, 240);
  eq("the label it was bought under is unchanged", after.appliedPromotionLabel, "TEMP");
  eq("and the code is unchanged", after.appliedPromotionCode, "TEMP");
  eq("only the link is gone, which is what SET NULL is for", after.appliedPromotionId, null);
  assert("so a historical order cannot be rewritten by editing a promotion",
    after.discountInCents === before.discountInCents && after.appliedPromotionLabel === before.appliedPromotionLabel);

  // ------------------------------------------------------------------------
  // THE DEFECT THIS SUITE FOUND, AND THE REASON IT IS WORTH THE RUNTIME.
  //
  // Order.appliedPromotionId is a foreign key. Writing it straight from
  // metadata meant that a merchant deleting a promotion between a customer
  // paying and Stripe delivering the event made order.create violate the
  // constraint — and the ENTIRE order was lost. Money taken, nothing recorded,
  // and Stripe retrying for days against something that could never succeed.
  //
  // That is the identical defect this same route already carries two fixed
  // instances of, for Order.productId, both found the same way. A new foreign
  // key on this table is a new copy of it until proven otherwise.
  const orphanSession = {
    id: `evt_${uniq()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_orphan_${uniq()}`, mode: "payment", amount_total: 2160, currency: "usd",
        customer_details: { email: "buyer4@test.local" },
        metadata: {
          storeId: store.id, productId: ring.id,
          listSubtotalInCents: "2400", discountInCents: "240",
          // Deleted moments ago, above.
          promotionId: livePromoId, promotionLabel: "TEMP", promotionCode: "TEMP", promotionKind: "CODE",
        },
      },
    },
  };
  eq("a checkout whose promotion was deleted mid-flight still becomes an order",
    (await stripeWebhook((orphanSession))).status, 200);
  const orphan = await prismaSystem.order.findFirst({
    where: { externalOrderId: orphanSession.data.object.id },
  });
  assert("the order exists at all, which is the whole point", orphan !== null,
    "money moved; losing the record of it is the worst outcome available");
  eq("and still says what was taken off", orphan?.discountInCents, 240);
  eq("and under what name", orphan?.appliedPromotionLabel, "TEMP");
  eq("with only the link absent", orphan?.appliedPromotionId, null);

  // TENANT SCOPING, on the same lookup. An id arriving in metadata is not proof
  // of ownership, and linking another store's promotion would leak it.
  const foreignSession = {
    id: `evt_${uniq()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_foreign_${uniq()}`, mode: "payment", amount_total: 100, currency: "usd",
        customer_details: { email: "buyer5@test.local" },
        metadata: {
          storeId: store.id, productId: ring.id,
          listSubtotalInCents: "1000", discountInCents: "900",
          promotionId: theirsId, promotionLabel: "Theirs", promotionKind: "CODE",
        },
      },
    },
  };
  eq("an order naming another business's promotion still lands",
    (await stripeWebhook((foreignSession))).status, 200);
  const foreignOrder = await prismaSystem.order.findFirstOrThrow({
    where: { externalOrderId: foreignSession.data.object.id },
  });
  eq("but is not linked to it", foreignOrder.appliedPromotionId, null);
  eq("CONTROL: and the other business's promotion is untouched",
    (await prismaSystem.promotion.findUniqueOrThrow({ where: { id: theirsId } })).storeId, other.id);

  // An order that used no promotion is byte-identical to a pre-promotions one.
  const plainSession = {
    id: `evt_${uniq()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_plain_${uniq()}`, mode: "payment", amount_total: 2400, currency: "usd",
        customer_details: { email: "buyer3@test.local" },
        metadata: { storeId: store.id, productId: ring.id },
      },
    },
  };
  eq("an undiscounted order still lands", (await stripeWebhook((plainSession))).status, 200);
  const plain = await prismaSystem.order.findFirstOrThrow({
    where: { externalOrderId: plainSession.data.object.id },
  });
  eq("with no discount recorded", plain.discountInCents, null);
  eq("no promotion", plain.appliedPromotionId, null);
  eq("no label", plain.appliedPromotionLabel, null);
  eq("and its total untouched", plain.amountInCents, 2400);

  // ==========================================================================
  console.log("\n=== 9. Nothing the customer sends is arithmetic ===\n");
  // ==========================================================================
  // The strongest version of this is not a source assertion — it is submitting
  // the tampered form and watching the price refuse to move.

  const tampered = new FormData();
  tampered.set("discountCode", "");
  // Everything an attacker would try.
  tampered.set("discountInCents", "9999");
  tampered.set("listSubtotalInCents", "1");
  tampered.set("merchandiseSubtotalInCents", "1");
  tampered.set("totalInCents", "1");
  tampered.set("promotionId", "promo_abc");
  tampered.set("percentOff", "100");

  const forged = await previewCheckoutPrice(store.slug, ring.id, { ok: true } as never, tampered);
  assert("a forged price is ignored outright", forged.ok);
  eq("the customer is quoted the real price", forged.ok ? forged.pricing.totalInCents : null, 2400);
  eq("and no discount is invented", forged.ok ? forged.pricing.discount : null, null);

  // A REAL code still works through the same door, so the refusal above is the
  // tampering being ignored rather than the whole path being dead.
  const honest = new FormData();
  honest.set("discountCode", "SAVE10");
  const quoted = await previewCheckoutPrice(store.slug, ring.id, { ok: true } as never, honest);
  eq("CONTROL: a genuine code is still honoured", quoted.ok ? quoted.pricing.totalInCents : null, 2160);

  // And a forged SHIPPING amount cannot be discounted into existence either.
  const forgedShipping = new FormData();
  forgedShipping.set("discountCode", "SAVE10");
  forgedShipping.set("shippingInCents", "99999");
  const noRate = await previewCheckoutPrice(store.slug, ring.id, { ok: true } as never, forgedShipping);
  eq("a shipping amount with no chosen rate is ignored",
    noRate.ok ? noRate.pricing.shippingInCents : null, 0);

  // The checkout actions read ONE field from the form, and it is the code.
  const actions = read("app", "store", "[slug]", "actions.ts");
  assert("checkout re-derives the price rather than reading one",
    /const \{ pricing \} = await priceCheckout\(\{/.test(actions));
  assert("and the only money-shaped thing it takes from the form is a code",
    !/formData\.get\("(discountInCents|listSubtotalInCents|totalInCents|promotionId|percentOff)"\)/.test(actions));
  assert("Stripe is charged the derived subtotal",
    /unit_amount: pricing\.merchandiseSubtotalInCents/.test(actions),
    "not product.priceInCents, and not a Stripe coupon");
  assert("and PayPal is charged the same number from the same function",
    /value: \(pricing\.merchandiseSubtotalInCents \/ 100\)\.toFixed\(2\)/.test(actions),
    "a Stripe-only discount would silently no-op on this rail");
  assert("both rails are handed the pricing rather than computing one",
    !/unit_amount: product\.priceInCents/.test(actions) &&
      !/value: \(product\.priceInCents \/ 100\)/.test(actions),
    "the old inline arithmetic must be gone, not merely bypassed");

  // ==========================================================================
  console.log("\n=== 10. The merchant's own controls ===\n");
  // ==========================================================================

  const toggled = await createPromotionExecutable.run(
    { name: "Toggle me", kind: "SALE", discountType: "PERCENTAGE", percentOff: 5, scope: "ALL_PRODUCTS" },
    ctx
  );
  const toggleId = toggled.metadata!.promotionId;
  eq("a new promotion is active", (await priceOf(ring.id, 2400)).discount?.label, "Toggle me");

  await updatePromotionExecutable.run({ promotionId: toggleId, active: false }, ctx);
  eq("switching it off stops it reaching checkout", (await priceOf(ring.id, 2400)).discount, null);
  eq("the update verifies the switch",
    (await updatePromotionExecutable.verify({ promotionId: toggleId, active: false }, ctx, undefined as never)).state,
    "verified");

  await updatePromotionExecutable.run({ promotionId: toggleId, active: true }, ctx);
  eq("and switching it back on resumes it", (await priceOf(ring.id, 2400)).discount?.label, "Toggle me");

  // `active: false` is exactly the value a truthiness check would drop.
  await updatePromotionExecutable.run({ promotionId: toggleId, active: false, name: "Renamed" }, ctx);
  const both2 = await prisma.promotion.findUniqueOrThrow({ where: { id: toggleId } });
  eq("a rename and a switch-off in one edit both land", both2.active, false);
  eq("CONTROL: including the rename", both2.name, "Renamed");

  // A promotion belonging to another store cannot be touched from this one.
  let refused = false;
  try {
    await updatePromotionExecutable.run({ promotionId: theirsId, active: false }, ctx);
  } catch {
    refused = true;
  }
  assert("another business's promotion cannot be edited from this one", refused);
  eq("CONTROL: and it is genuinely untouched",
    (await prismaSystem.promotion.findUniqueOrThrow({ where: { id: theirsId } })).active, true);

  // ==========================================================================
  console.log("\n=== 11. What the customer is shown ===\n");
  // ==========================================================================

  const breakdown = read("app", "store", "[slug]", "checkout", "PriceBreakdown.tsx");
  assert("the breakdown shows what was taken off",
    /pricing\.discount &&/.test(breakdown) && /pricing\.discount\.label/.test(breakdown));
  assert("shipping is shown as its own line",
    /label="Shipping"/.test(breakdown));
  assert("and the total comes from the server, not from adding up the rows",
    /value=\{formatMoney\(pricing\.totalInCents, currency\)\}/.test(breakdown) &&
      !/listSubtotalInCents\s*[-+]\s*/.test(breakdown),
    "a second implementation of the total is a second thing that can disagree with the charge");

  const review = read("app", "store", "[slug]", "checkout", "[productId]", "CheckoutReview.tsx");
  assert("the payment form submits the code and nothing else",
    /name="discountCode"/.test(review) &&
      !/name="(discountInCents|totalInCents|promotionId)"/.test(review));
  assert("and it submits the code the SERVER accepted",
    /preview\.code\?\.applied \? preview\.code\.candidate\.code : null/.test(review),
    "a rejected code sitting in the input must not travel to checkout");

  const buyButton = read("app", "store", "[slug]", "page.tsx");
  assert("every product now reaches a review step before paying",
    /\/checkout\/\$\{product\.id\}/.test(buyButton),
    "there was previously nowhere to enter a code on a product without live shipping");

  const step = read("app", "store", "[slug]", "ship", "[productId]", "ShippingStep.tsx");
  assert("the shipping step has the code field too",
    /DiscountCodeField/.test(step) && /name="discountCode"/.test(step));
  assert("and shows the same breakdown component",
    /PriceBreakdown/.test(step),
    "two breakdowns would be two chances to disagree with the charge");

  const list = read("app", "dashboard", "promotions", "page.tsx");
  assert("the merchant list judges rows with the checkout's own rule",
    /eligibilityOf\(/.test(list),
    "a page with its own idea of 'running' would tell a merchant a sale is live that no customer can use");

  await prisma.store.delete({ where: { id: store.id } });
  await prisma.store.delete({ where: { id: other.id } });
  await prisma.user.delete({ where: { id: owner.id } });
  await server.close();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
