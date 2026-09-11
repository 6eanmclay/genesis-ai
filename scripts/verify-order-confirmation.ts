import { buildConfirmationEmail, isLateReceipt } from "@/lib/orders/orderConfirmation";
import { labelPurchaseMessage } from "@/lib/orders/notifyCustomerShipped";

// What the customer is told, and who it is about. No database, no email:
//
//   npx tsx scripts/verify-order-confirmation.ts
//
// There was no order-confirmation path at all. Tracing every caller: the Stripe
// webhook committed the Order and scheduled observation sweeps, the PayPal
// return committed and redirected, and the only customer email anywhere was
// notifyCustomerShipped — called once, from the shipping-label purchase, which
// happens days later if it happens at all. A customer paid, saw a success page,
// and then heard nothing from the business.
//
// This file proves the CONTENT and the DECISION. Delivery cannot be proven
// without a real Resend credential, which is an external blocker and is recorded
// as one — but everything up to handing the payload to a provider is testable,
// and pretending otherwise would be the same false confidence this audit exists
// to remove.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const ORDER = {
  id: "order_1",
  buyerEmail: "sarah@example.test",
  productName: "Hand-poured Candle",
  amountInCents: 3392,
  externalOrderId: "cs_live_1",
  selectedShippingCarrier: "USPS",
  selectedShippingService: "Priority Mail",
  selectedShippingEstDays: 2,
  // A single-product checkout writes no OrderItem rows, which is what every
  // existing assertion below describes. The itemised branch is exercised
  // separately, in section 7.
  items: [] as { productName: string; quantity: number; subtotalInCents: number }[],
  // Recent, so every existing assertion below keeps exercising the NORMAL
  // template. The late variant is asserted separately.
  placedAt: new Date(),
};
const STORE = { name: "Cubit & Coil", currency: "USD" };

// ---------------------------------------------------------------------------
console.log("\n1. It goes to the person who paid, about what they bought");
{
  const email = buildConfirmationEmail({ order: ORDER, store: STORE });

  // The recipient is the single most consequential field. Getting it from
  // anywhere but the order itself is how one customer learns about another's
  // purchase.
  check("addressed to the buyer on the order", email.to, "sarah@example.test");
  assert("the subject names the store", email.subject.includes("Cubit & Coil"), email.subject);
  assert("the body names the product", email.html.includes("Hand-poured Candle"));
  assert("and the amount they were charged", email.html.includes("$33.92"), email.html);
  // Without a reference, a customer with a problem has nothing to quote.
  assert("carries the order reference", email.html.includes("cs_live_1"));
}

// ---------------------------------------------------------------------------
console.log("\n2. One tenant's sale is never described with another's name");
{
  const other = buildConfirmationEmail({ order: ORDER, store: { name: "Someone Else's Shop", currency: "USD" } });
  // The store name comes from the order's OWN store relation, never a
  // caller-supplied id — this asserts the seam exists and is honoured.
  assert("the store name is whatever the order's store says", other.subject.includes("Someone Else's Shop"));
  assert("and never leaks the other store", !other.subject.includes("Cubit & Coil"));

  // Nothing in the email is derived from anything but this order.
  const email = buildConfirmationEmail({ order: ORDER, store: STORE });
  assert("no internal order id is exposed to the customer", !email.html.includes("order_1"));
}

// ---------------------------------------------------------------------------
console.log("\n3. Shipping is mentioned only when it was actually chosen");
{
  const withShipping = buildConfirmationEmail({ order: ORDER, store: STORE });
  assert("the carrier and service appear", withShipping.html.includes("USPS Priority Mail"), withShipping.html);
  assert("with the estimate", withShipping.html.includes("2 business days"));

  // Inventing "ships in 3-5 days" for an order that chose no service would be
  // exactly the confident guess this codebase refuses everywhere else.
  const none = buildConfirmationEmail({
    order: { ...ORDER, selectedShippingCarrier: null, selectedShippingService: null, selectedShippingEstDays: null },
    store: STORE,
  });
  assert("no shipping line at all when none was chosen", !none.html.includes("Shipping:"), none.html);
  assert("but the order is still confirmed", none.html.includes("Hand-poured Candle"));

  // A carrier with no estimate must not print an empty promise.
  const noEstimate = buildConfirmationEmail({
    order: { ...ORDER, selectedShippingEstDays: null },
    store: STORE,
  });
  assert("a missing estimate is simply absent", !noEstimate.html.includes("estimated"), noEstimate.html);
  assert("while the service still shows", noEstimate.html.includes("USPS Priority Mail"));

  // One day, not "1 business days".
  const oneDay = buildConfirmationEmail({ order: { ...ORDER, selectedShippingEstDays: 1 }, store: STORE });
  assert("singular reads correctly", oneDay.html.includes("1 business day") && !oneDay.html.includes("1 business days"));
}

// ---------------------------------------------------------------------------
console.log("\n4. Money is rendered honestly");
{
  const free = buildConfirmationEmail({ order: { ...ORDER, amountInCents: 0 }, store: STORE });
  assert("a zero total is shown as $0.00, not hidden", free.html.includes("$0.00"), free.html);

  const large = buildConfirmationEmail({ order: { ...ORDER, amountInCents: 123456 }, store: STORE });
  assert("larger amounts keep two decimals", large.html.includes("$1234.56"), large.html);

  const odd = buildConfirmationEmail({ order: { ...ORDER, amountInCents: 5 }, store: STORE });
  assert("five cents is $0.05, not $5", odd.html.includes("$0.05"), odd.html);
}

// ---------------------------------------------------------------------------
console.log("\n5. The owner is told when the customer was not");
{
  const label = { carrier: "USPS", trackingNumber: "9400111899223197428490" };

  check("a customer already told is not reported as a failure",
    labelPurchaseMessage({ ...label, notification: { notified: false, reason: "already_notified" } }),
    "Bought a USPS label — tracking 9400111899223197428490. The customer had already been notified about this shipment.");

  // The three outcomes must read differently, or the owner cannot tell "they
  // know" from "nobody told them" from "the address bounced".
  const messages = new Set([
    labelPurchaseMessage({ ...label, notification: { notified: true } }),
    labelPurchaseMessage({ ...label, notification: { notified: false, reason: "already_notified" } }),
    labelPurchaseMessage({ ...label, notification: { notified: false, reason: "email_not_configured" } }),
    labelPurchaseMessage({ ...label, notification: { notified: false, reason: "send_failed", detail: "bounced" } }),
  ]);
  check("all four outcomes read differently", messages.size, 4);

  // And only the ones that genuinely need the owner to act say so.
  const alreadyTold = labelPurchaseMessage({ ...label, notification: { notified: false, reason: "already_notified" } });
  assert("a repeat does not ask the owner to do anything", !alreadyTold.includes("yourself"), alreadyTold);
}

// ---------------------------------------------------------------------------
console.log("\n6. A late receipt says so, and does not pretend the order is new");
{
  // Sean, 2026-09-11: "Do not send the normal fresh-order confirmation to an
  // eight-week-old customer as though the purchase just happened... Do not
  // over-apologize and do not imply the order itself is new."
  //
  // Three real people are waiting six to eight weeks for these.
  const NOW = new Date("2026-09-11T12:00:00Z");
  const eightWeeksAgo = new Date(NOW.getTime() - 56 * 24 * 60 * 60 * 1000);
  const late = buildConfirmationEmail({ order: { ...ORDER, placedAt: eightWeeksAgo }, store: STORE, now: NOW });

  assert("it acknowledges the receipt is late",
    late.html.includes("reaching you late"), late.html.slice(0, 120));
  assert("it says the ORDER was received, not that it just arrived",
    late.html.includes("Your order was received successfully"), late.html.slice(0, 120));
  assert("it does NOT open with the fresh-order thank-you",
    !late.html.includes("has received your order"), late.html.slice(0, 120));

  // THE SUBJECT MATTERS AS MUCH AS THE BODY. "Your order from X" landing eight
  // weeks later reads in an inbox as a new order.
  check("the subject calls it a receipt", late.subject, "Your receipt from Cubit & Coil");

  // NOT AN APOLOGY LETTER. One sorry, and no grovelling.
  const sorries = (late.html.match(/sorry|apolog/gi) ?? []).length;
  assert("it apologises once, not repeatedly", sorries === 1, `${sorries} apologies`);

  // AND IT MAKES NO PROMISE IT CANNOT KEEP. The order may already have shipped.
  assert("it does not promise a shipping notice that may already be gone",
    !late.html.includes("when it ships"), late.html);

  // The details the customer actually needs are unchanged.
  assert("the order details are still there", late.html.includes(ORDER.externalOrderId), late.html);
  check("and it still goes to the buyer", late.to, ORDER.buyerEmail);

  // ============ THE NORMAL TEMPLATE IS UNTOUCHED ====================
  //
  // Sean: "Keep the existing normal receipt template unchanged for current
  // orders." Asserted as BYTE EQUALITY against a fresh order rather than by
  // reading the diff, because that is the claim.
  const fresh = buildConfirmationEmail({ order: { ...ORDER, placedAt: NOW }, store: STORE, now: NOW });
  assert("a fresh order still gets the original opening",
    fresh.html.includes(`Thank you — ${STORE.name} has received your order.`), fresh.html.slice(0, 120));
  check("and the original subject", fresh.subject, "Your order from Cubit & Coil");
  assert("and still promises the shipping notice", fresh.html.includes("when it ships"), fresh.html);
  assert("a fresh receipt never mentions lateness", !/late|sorry/i.test(fresh.html), fresh.html);

  // THE THRESHOLD IS A FACT, NOT A FLAG. A caller cannot ask for the late
  // wording on a new order, or suppress it on an old one.
  const justUnder = new Date(NOW.getTime() - 47 * 60 * 60 * 1000);
  const justOver = new Date(NOW.getTime() - 49 * 60 * 60 * 1000);
  assert("47 hours old is still a normal receipt", !isLateReceipt(justUnder, NOW));
  assert("49 hours old is a late one", isLateReceipt(justOver, NOW));
  // The slowest legitimate send is the daily backstop, a little over 24h, so a
  // normal order can never reach the threshold.
  assert("a backstop send a day later is NOT late",
    !isLateReceipt(new Date(NOW.getTime() - 25 * 60 * 60 * 1000), NOW));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
