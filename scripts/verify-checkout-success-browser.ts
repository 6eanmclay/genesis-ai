import { chromium, type Browser, type Page } from "playwright";
import { startTestServer } from "@/scripts/lib/testServer";

// WHAT THE CHECKOUT SUCCESS PAGE CLAIMS, AND ON WHAT EVIDENCE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-checkout-success-browser.ts" -OutFile out.txt
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// The provider's redirect establishes that somebody came back from a checkout.
// Only persisted state establishes that they paid. This is the rule already set
// for Billing's own return states, applied to the customer's side of the same
// transaction — and Sean's standing constraint underneath both: Genesis must
// never infer the money was received simply because an order exists.
//
// The webhook is the authority. For Stripe it is what creates the paid Order
// row at all (lib/payments/stripeEvent.ts's tx.order.create), so at redirect
// time that row may legitimately not exist yet.
//
//   confirmed  Stripe reports payment_status "paid", or an Order for THIS
//              store is already recorded as paid.
//   pending    they came back from a checkout and nothing confirms it yet.
//   unknown    nothing identifies a purchase. Not a thank-you.
//
// THIS PAGE IS PUBLIC, which is why "unknown" matters: the URL can simply be
// visited. Before this, every one of the five arrivals below produced
// "Thank you for your purchase!" and "Your order is confirmed."

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

const CONFIRMED = "Your order is confirmed.";

async function main() {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `cks-${stamp}@example.test` } });
    const mine = await prisma.store.create({
      data: { userId: user.id, name: "My Shop", slug: `cks-mine-${stamp}`, currency: "USD", published: true },
    });
    const other = await prisma.store.create({
      data: { userId: user.id, name: "Other Shop", slug: `cks-other-${stamp}`, currency: "USD", published: true },
    });

    const order = (storeId: string, name: string, status: string, ref: string) =>
      prisma.order.create({
        data: {
          storeId, productName: name, quantity: 1, amountInCents: 5000,
          buyerEmail: `b-${ref}@example.test`, paymentProvider: "PAYPAL",
          externalOrderId: `pp_${ref}`, status,
        },
      });

    const paid = await order(mine.id, "Copper Ring", "paid", `a${stamp}`);
    const refunded = await order(mine.id, "Returned Ring", "refunded", `b${stamp}`);
    const strangers = await order(other.id, "Someone Else's Thing", "paid", `c${stamp}`);

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();

    const read = async (query: string) => {
      const res = await page.goto(`${server.baseUrl}/store/${mine.slug}/success${query}`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      assert(`success${query || " (no query)"} renders`, (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      return {
        heading: (await page.locator('[data-testid="success-heading"]').innerText()).trim(),
        status: (await page.locator('[data-testid="success-status"]').innerText()).trim(),
        body: await page.locator("body").innerText(),
      };
    };

    // ==================================================================
    console.log("\n1. A real paid order — the one case with evidence\n");
    // ==================================================================
    {
      const seen = await read(`?order_id=${paid.id}`);
      assert("it is confirmed", seen.status === CONFIRMED, seen.status);
      assert("  and thanks them for the purchase",
        /Thank you for your purchase/.test(seen.heading), seen.heading);
      // THE DETAILS MUST SURVIVE. A fix that stopped confirming by showing
      // nothing would pass every negative assertion below.
      assert("  and still names what they bought, for how much",
        seen.body.includes("Copper Ring") && seen.body.includes("$50.00"), seen.body.slice(0, 200));
    }

    // ==================================================================
    console.log("\n2. A refunded order is not a confirmed purchase\n");
    // ==================================================================
    {
      const seen = await read(`?order_id=${refunded.id}`);
      // Before this, the page read "Returned Ring — $50.00 · Your order is
      // confirmed." for money the customer had already had back.
      assert("it does NOT claim confirmation", seen.status !== CONFIRMED, seen.status);
      assert("  it says the payment is still being confirmed",
        /confirming your payment/i.test(seen.status), seen.status);
    }

    // ==================================================================
    console.log("\n3. Nothing identifies a purchase\n");
    // ==================================================================
    {
      for (const [label, query] of [
        ["no query string at all", ""],
        ["another store's order id", `?order_id=${strangers.id}`],
      ] as const) {
        const seen = await read(query);
        assert(`${label}: no confirmation is claimed`, seen.status !== CONFIRMED, seen.status);
        // AND NO THANK-YOU EITHER. "Thank you for your purchase!" is itself a
        // claim that a purchase happened.
        assert(`  ${label}: and no purchase is claimed in the heading`,
          !/Thank you for your purchase/.test(seen.heading), seen.heading);
        assert(`  ${label}: nothing of another shop's is shown`,
          !seen.body.includes("Someone Else's Thing"), seen.body.slice(0, 200));
      }
    }

    // ==================================================================
    console.log("\n4. A checkout we cannot read is pending, not confirmed\n");
    // ==================================================================
    {
      // A session id that cannot be retrieved. They plainly came from a
      // checkout, so this is not "no purchase" — but nothing confirms it.
      const seen = await read("?session_id=cs_test_nonexistent");
      assert("it does NOT claim confirmation", seen.status !== CONFIRMED, seen.status);
      assert("  and still thanks them, because they did check out",
        /Thank you for your purchase/.test(seen.heading), seen.heading);
      assert("  saying the payment is being confirmed",
        /confirming your payment/i.test(seen.status), seen.status);
    }

    console.log(`\n${failures} failed, ${passes} passed`);
    if (failures > 0) {
      console.log("\nFAILED:");
      for (const line of failed) console.log(`  ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
