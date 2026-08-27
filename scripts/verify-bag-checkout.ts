import {
  toStripeLineItems,
  toPaypalItems,
  toPaypalAmount,
  stripeLineItemsTotal,
  paypalItemsTotal,
} from "@/lib/bag/providerLines";
import {
  linesFromDraft,
  linesFromStripe,
  linesFromPaypal,
  noLines,
  primaryNameFor,
  primaryProductId,
  totalQuantity,
} from "@/lib/bag/orderLines";
import { packDraftCustomId, parseDraftCustomId } from "@/lib/bag/checkoutDraft";
import { parsePaypalCustomId } from "@/lib/promotions/checkoutDiscount";
import type { DraftLine } from "@/lib/bag/checkoutDraft";
import { readFileSync } from "fs";
import { join } from "path";

// A BAG, ACROSS THE WIRE AND BACK:
//
//   npx tsx scripts/verify-bag-checkout.ts
//
// Standalone — no database, no network, no provider account.
//
// TWO PROPERTIES CARRY REAL MONEY:
//
//   WHAT WE ASK A PROVIDER TO CHARGE MUST EQUAL THE DRAFT'S TOTAL, EXACTLY.
//   Stripe sums its line items and charges the sum; PayPal refuses an order
//   whose items disagree with its breakdown. A cent of drift is a wrong charge
//   or a failed checkout, and neither shows up in testing with one product.
//
//   LINE ITEMS ARE NEVER INVENTED. A payment always becomes an order, but an
//   order whose contents could not be established says so rather than
//   presenting a guessed basket as fact.

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

const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  productId: "prod_ring",
  productName: "Tensor Ring",
  // Defaults to HAVING one, so the assertions below exercise the path a real
  // product takes. The no-image case is asked for explicitly where it matters.
  imageUrl: "https://images.example.test/ring.png",
  quantity: 1,
  unitPriceInCents: 3500,
  listInCents: 3500,
  discountInCents: 0,
  subtotalInCents: 3500,
  promotionId: null,
  promotionLabel: null,
  ...over,
});

console.log("\n=== 1. Stripe is asked for exactly what was quoted ===\n");

const plain = [line(), line({ productId: "prod_mug", productName: "Copper Mug", unitPriceInCents: 2500, listInCents: 2500, subtotalInCents: 2500 })];
const plainItems = toStripeLineItems(plain, "USD");
eq("one item per line", plainItems.length, 2);
eq("at the line's price", plainItems.map((i) => i.price_data.unit_amount), [3500, 2500]);
eq("in the store's own currency", plainItems[0].price_data.currency, "usd");
eq("and the total is the draft's", stripeLineItemsTotal(plainItems), 6000);

// A DISCOUNT THAT DIVIDES EVENLY keeps the quantity structured.
const evenly = [line({ quantity: 2, listInCents: 7000, discountInCents: 1820, subtotalInCents: 5180, promotionLabel: "Ring Sale" })];
const evenItems = toStripeLineItems(evenly, "USD");
eq("quantity survives when the discount divides", evenItems[0].quantity, 2);
eq("at the discounted unit price", evenItems[0].price_data.unit_amount, 2590);
eq("and the total still matches", stripeLineItemsTotal(evenItems), 5180);
assert("with the sale named where the customer will see it",
  evenItems[0].price_data.product_data.name.includes("Ring Sale"));

// ONE THAT DOES NOT DIVIDE. Stripe multiplies unit_amount by quantity, so a
// per-unit price would be off by the remainder.
const odd = [line({ quantity: 3, listInCents: 10500, discountInCents: 10, subtotalInCents: 10490 })];
const oddItems = toStripeLineItems(odd, "USD");
eq("an indivisible line is sent as one item", oddItems[0].quantity, 1);
eq("priced at the line total", oddItems[0].price_data.unit_amount, 10490);
eq("EXACTLY what was quoted, to the cent", stripeLineItemsTotal(oddItems), 10490);
assert("with the count moved into the name so nothing is lost",
  oddItems[0].price_data.product_data.name.includes("× 3"));
assert("CONTROL: a per-unit price would have been wrong here",
  Math.round(10490 / 3) * 3 !== 10490,
  "3496 x 3 = 10488, two cents short of what the customer agreed to");

// The property, across a mixed bag.
const mixed = [...evenly, ...odd, ...plain];
const mixedTotal = mixed.reduce((s, l) => s + l.subtotalInCents, 0);
eq("a mixed bag still asks for exactly its total",
  stripeLineItemsTotal(toStripeLineItems(mixed, "USD")), mixedTotal);

console.log("\n=== 2. PayPal is told what the goods cost and what came off ===\n");

const ppItems = toPaypalItems(evenly, "USD");
eq("items are sent at LIST price, not discounted", ppItems[0].unit_amount.value, "35.00");
eq("with the real quantity", ppItems[0].quantity, "2");
// THE SKU IS THE RECOVERY PATH. Without it a recovered line is a name and a
// number with no way back to a product.
eq("and the product id in the sku", ppItems[0].sku, "prod_ring");
eq("items total at list", paypalItemsTotal(ppItems), 7000);

const amount = toPaypalAmount({
  currency: "USD", listSubtotalInCents: 7000, discountInCents: 1820,
  shippingInCents: 0, totalInCents: 5180,
});
eq("the breakdown states the goods", amount.breakdown?.item_total.value, "70.00");
eq("and the discount, which PayPal shows the customer", amount.breakdown?.discount?.value, "18.20");
eq("and the value is what will be charged", amount.value, "51.80");
assert("item_total less discount equals value, which PayPal requires",
  paypalItemsTotal(ppItems) - 1820 === 5180);

const withShipping = toPaypalAmount({
  currency: "USD", listSubtotalInCents: 7000, discountInCents: 0,
  shippingInCents: 892, totalInCents: 7892,
});
eq("shipping is its own line", withShipping.breakdown?.shipping?.value, "8.92");
assert("and no discount block is invented when nothing was discounted",
  withShipping.breakdown?.discount === undefined);

console.log("\n=== 3. A bag says so, and cannot be read as a product ===\n");

const custom = packDraftCustomId("store_abc", "draft_xyz");
eq("the store survives", parseDraftCustomId(custom).storeId, "store_abc");
eq("and the draft", parseDraftCustomId(custom).draftId, "draft_xyz");
assert("comfortably inside PayPal's 127 characters", custom.length <= 127, `${custom.length}`);

// THE MARKER IS WHY THIS IS SAFE. Without it, parts[1] would be a product id on
// one path and a draft id on the other, and a wrong guess writes an order
// against the wrong thing.
eq("a single-product custom_id is NOT read as a bag",
  parseDraftCustomId("store_abc:prod_ring").draftId, null);
eq("and a bag's is not read as a product",
  parsePaypalCustomId(custom).productId, "draft_draft_xyz");
assert("which is why the route checks the marker rather than the position",
  parseDraftCustomId("store_abc:prod_ring").draftId === null &&
    parseDraftCustomId(custom).draftId !== null);
eq("nonsense yields nulls rather than throwing", parseDraftCustomId("garbage").draftId, null);
eq("and so does nothing at all", parseDraftCustomId(null).storeId, null);

console.log("\n=== 4. Tier DRAFT: the frozen contract ===\n");

const fromDraft = linesFromDraft(evenly);
eq("the source is the draft", fromDraft.source, "DRAFT");
eq("with the frozen name", fromDraft.lines[0].productName, "Tensor Ring");
eq("the frozen price", fromDraft.lines[0].unitPriceInCents, 3500);
eq("and the discount it carried", fromDraft.lines[0].discountInCents, 1820);
eq("units across the order", totalQuantity(fromDraft), 2);
eq("one product means the order can name it", primaryProductId(linesFromDraft([line()])), "prod_ring");

console.log("\n=== 5. Tier PROVIDER: what the customer was really charged ===\n");

const stripeRecovered = linesFromStripe([
  { description: "Tensor Ring (Ring Sale)", quantity: 2, amount_total: 5180 },
  { description: "Copper Mug", quantity: 1, amount_total: 2500 },
]);
eq("the source is the provider", stripeRecovered.source, "PROVIDER");
eq("both lines come back", stripeRecovered.lines.length, 2);
eq("with what each cost", stripeRecovered.lines.map((l) => l.subtotalInCents), [5180, 2500]);
eq("and the quantity Stripe recorded", stripeRecovered.lines[0].quantity, 2);
// NO DISCOUNT IS ATTRIBUTED. Stripe was sent the discount folded into the
// price, so claiming a separate discount here would be inventing one.
eq("no discount is invented", stripeRecovered.lines[0].discountInCents, 0);

eq("a line with no name is not a line",
  linesFromStripe([{ quantity: 1, amount_total: 500 }]).lines.length, 0);
eq("nor is one with no money",
  linesFromStripe([{ description: "Thing", quantity: 1 }]).lines.length, 0);
eq("and nothing usable falls through to NONE",
  linesFromStripe([]).source, "NONE");

const paypalRecovered = linesFromPaypal([
  { name: "Tensor Ring", sku: "prod_ring", quantity: "2", unit_amount: { value: "35.00" } },
  { name: "Copper Mug", sku: "prod_mug", quantity: "1", unit_amount: { value: "25.00" } },
]);
eq("PayPal's items recover too", paypalRecovered.source, "PROVIDER");
// THE SKU RELINKS THE LINE TO A REAL PRODUCT, which Stripe's items cannot do.
eq("and the sku brings the product id home",
  paypalRecovered.lines.map((l) => l.productId), ["prod_ring", "prod_mug"]);
eq("at list price", paypalRecovered.lines[0].listInCents, 7000);
eq("a malformed quantity drops the line",
  linesFromPaypal([{ name: "X", quantity: "lots", unit_amount: { value: "1.00" } }]).lines.length, 0);
eq("as does a malformed amount",
  linesFromPaypal([{ name: "X", quantity: "1", unit_amount: { value: "free" } }]).lines.length, 0);

console.log("\n=== 6. Tier NONE: the financial record, and nothing invented ===\n");

const nothing = noLines("The checkout draft was unavailable.");
eq("the source says so", nothing.source, "NONE");
eq("and there are no lines at all", nothing.lines, []);
assert("with a reason the owner can act on", (nothing.note ?? "").length > 0);
eq("the order still needs a name, and it is honest",
  primaryNameFor(nothing), "Order contents unavailable");
eq("no product is linked", primaryProductId(nothing), null);
// Order.quantity is a required column read by 154 call sites; it says one
// rather than zero, because zero would read as a sale of nothing.
eq("and the quantity does not claim zero", totalQuantity(nothing), 1);

eq("one line names itself", primaryNameFor(linesFromDraft([line()])), "Tensor Ring");
eq("several are counted", primaryNameFor(fromDraft.lines.length > 1 ? fromDraft : linesFromDraft(plain)),
  "Tensor Ring and 1 more");
// A MULTI-PRODUCT ORDER HAS NO SINGLE PRODUCT. Pointing Order.productId at one
// of four would make every report reading it quietly wrong.
eq("and a multi-product order links none", primaryProductId(linesFromDraft(plain)), null);

console.log("\n=== 7. The single-product path is untouched ===\n");

const actions = read("app", "store", "[slug]", "actions.ts");
assert("createCheckoutSession still exists with its own Stripe call",
  /export async function createCheckoutSession\(/.test(actions) &&
    /createStripeCheckoutSession\(store, product, slug, baseUrl, pricing\)/.test(actions),
  "the path that has been taking real money is not refactored by this work");
assert("and the bag is a separate action",
  /export async function checkoutFromBag\(/.test(actions));
assert("which charges only what the draft quoted",
  /Refusing to charge \$\{asked\} for a bag quoted at/.test(actions),
  "checked before the request leaves, not discovered in a settlement report");

const stripeHook = read("app", "api", "webhooks", "stripe", "route.ts");
assert("the webhook only takes the bag path when there IS a draft",
  /const draftId = session\.metadata\?\.checkoutDraftId/.test(stripeHook) &&
    /bagLines \? primaryProductId\(bagLines\) : \(product\?\.id \?\? null\)/.test(stripeHook),
  "every existing single-product order keeps the productId path exactly");
assert("and reads line items from the CONNECTED account, not the platform",
  /stripeAccount: event\.account/.test(stripeHook),
  "the platform key cannot see a merchant's session; asking it would silently demote every recovery to NONE");
assert("a contents-unknown order is surfaced, not just stored",
  /bagLines\?\.source === "NONE"/.test(stripeHook) && /recordCheckoutProblem/.test(stripeHook));
assert("and so is a charge that does not match the quote",
  /if \(writtenOrderId && bagMismatch\)/.test(stripeHook));

const paypalReturn = read("app", "api", "checkout", "paypal", "return", "route.ts");
assert("the PayPal route distinguishes a bag by its marker",
  /parseDraftCustomId\(customId\)/.test(paypalReturn));
assert("and still accepts a single-product custom_id",
  /\(!productId && !draftRef\.draftId\)/.test(paypalReturn),
  "a bag legitimately has no productId; the old guard would have rejected every one");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
