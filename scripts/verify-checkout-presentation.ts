import { chromium, type Browser, type Page } from "playwright";
import { startTestServer } from "@/scripts/lib/testServer";
import { bagCookieName, encodeBag } from "@/lib/bag/bagCookie";

// WHAT THE CUSTOMER ACTUALLY SEES, ON A DESKTOP AND ON A PHONE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-checkout-presentation.ts" -OutFile out.txt
//
// Two fixes, checked where they are supposed to appear rather than where they
// were written:
//
//   1. The product image reaches the bag and the checkout review, so a
//      customer can see what they are buying.
//   2. PayPal is offered as a choice when it is connected. Before this it was
//      connected and unreachable — selectProvider preferred Stripe and
//      returned one provider, so the rail existed and no customer could pick
//      it. A source assertion could not have caught that; only rendering the
//      page with both connected and looking for the control can.
//
// BOTH VIEWPORTS, because the two fixes have different risks on each. The
// payment choice is a row on a desktop and a stack on a phone; the image is
// small enough to be safe on a desktop and is exactly the sort of thing that
// pushes a narrow layout sideways.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

let failures = 0;
let passes = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

/**
 * Does this page push sideways?
 *
 * Measured against documentElement.clientWidth so a vertical scrollbar does
 * not read as horizontal overflow, with a couple of pixels of slack for
 * sub-pixel rounding — which is real and is not a defect. Same rule as
 * verify-mobile-reliability.ts.
 */
async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - limit;
  });
}

const UNIT_IN_CENTS = 3232;
const QUANTITY = 2;
const PERCENT_OFF = 26;
const IMAGE = "https://images.example.test/ring.png";

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const slug = `presentation-${Date.now()}`;
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug, tagline: "t", description: "d", currency: "USD" },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: "Copper tensor ring",
        description: "Hand-wound",
        priceInCents: UNIT_IN_CENTS,
        imageUrl: IMAGE,
      },
    });
    const promotion = await prisma.promotion.create({
      data: {
        storeId: store.id,
        name: `${PERCENT_OFF}% off`,
        kind: "SALE",
        discountType: "PERCENTAGE",
        percentOff: PERCENT_OFF,
        scope: "SELECTED_PRODUCTS",
        active: true,
      },
    });
    await prisma.promotionProduct.create({ data: { promotionId: promotion.id, productId: product.id } });

    // BOTH CONNECTED — the exact situation in which PayPal used to disappear.
    await prisma.storeIntegration.createMany({
      data: [
        { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_1" },
        { storeId: store.id, provider: "PAYPAL", status: "CONNECTED", externalAccountId: "pp_1" },
      ],
    });

    browser = await chromium.launch();

    /** A browser context with this bag already in the cookie jar. */
    async function contextWithBag(viewport: { width: number; height: number }, isMobile: boolean) {
      const context = await browser!.newContext({
        viewport,
        ...(isMobile ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}),
      });
      await context.addCookies([
        {
          name: bagCookieName(slug),
          value: encodeURIComponent(encodeBag({ items: [{ p: product.id, q: QUANTITY }], code: null })),
          url: server.baseUrl,
        },
      ]);
      return context;
    }

    for (const [label, viewport, isMobile] of [
      ["desktop", DESKTOP, false],
      ["mobile", PHONE, true],
    ] as const) {
      console.log(`\n${label} — the bag`);
      const context = await contextWithBag(viewport, isMobile);
      const page = await context.newPage();
      await page.goto(`${server.baseUrl}/store/${slug}/bag`, { waitUntil: "networkidle" });

      // THE PRODUCT IS VISIBLE AS A PICTURE, not only as a name.
      const bagImage = page.locator(`img[src="${IMAGE}"]`).first();
      assert(`${label}: the bag shows the product image`, await bagImage.count() > 0);
      if (await bagImage.count() > 0) {
        const box = await bagImage.boundingBox();
        assert(`${label}: and it is actually laid out, not zero-sized`,
          !!box && box.width > 8 && box.height > 8, JSON.stringify(box));
      }

      // The discounted total the customer is about to agree to.
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      assert(`${label}: the discounted total is shown`, body.includes("47.83"), body.slice(0, 300));

      // ============ THE FIX, WHERE IT MATTERS =========================
      // Both connected means both offered. This is the assertion that would
      // have failed before selectProvider stopped being the only answer.
      const paypalRadio = page.locator('input[name="paymentMethod"][value="PAYPAL"]');
      const cardRadio = page.locator('input[name="paymentMethod"][value="STRIPE"]');
      check(`${label}: PayPal is offered as a payment method`, await paypalRadio.count(), 1);
      check(`${label}: and so is card`, await cardRadio.count(), 1);
      assert(`${label}: PayPal is named in words, not as an enum value`,
        body.includes("PayPal") && !body.includes("PAYPAL"), body.slice(0, 300));

      // AND IT IS SELECTABLE. A control that renders and cannot be chosen is
      // the same problem in a new place.
      await paypalRadio.check();
      assert(`${label}: and the customer can actually select it`, await paypalRadio.isChecked());
      assert(`${label}: which deselects card, being one choice`, !(await cardRadio.isChecked()));

      if (isMobile) {
        const over = await overflow(page);
        assert(`${label}: the bag does not scroll sideways`, over <= 2, `${over}px over`);
      }

      console.log(`\n${label} — the checkout review`);
      await page.goto(`${server.baseUrl}/store/${slug}/checkout/${product.id}`, { waitUntil: "networkidle" });
      const reviewBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      const reviewImage = page.locator(`img[src="${IMAGE}"]`).first();
      assert(`${label}: the review shows the product image`, await reviewImage.count() > 0);
      if (await reviewImage.count() > 0) {
        const box = await reviewImage.boundingBox();
        // PROPORTIONAL, NOT HUGE — Sean's own words. A thumbnail beside the
        // name, not a hero. The ceiling is what makes this an assertion rather
        // than a hope.
        assert(`${label}: sized as a thumbnail, not a hero`,
          !!box && box.width >= 40 && box.width <= 160, JSON.stringify(box));
      }

      check(`${label}: PayPal is offered here too`,
        await page.locator('input[name="paymentMethod"][value="PAYPAL"]').count(), 1);
      assert(`${label}: and the product is named`,
        reviewBody.includes("Copper tensor ring"), reviewBody.slice(0, 200));

      if (isMobile) {
        const over = await overflow(page);
        assert(`${label}: the review does not scroll sideways`, over <= 2, `${over}px over`);
      }

      await context.close();
    }

    // ============ ONE PROVIDER MEANS NO CHOICE TO MAKE ==================
    // A radio group with a single option is a decision the customer does not
    // have. Most stores are this case, so it is the one that must not regress.
    console.log("\nwith only Stripe connected");
    await prisma.storeIntegration.updateMany({
      where: { storeId: store.id, provider: "PAYPAL" },
      data: { status: "DISCONNECTED" },
    });
    const soloContext = await contextWithBag(DESKTOP, false);
    const soloPage = await soloContext.newPage();
    await soloPage.goto(`${server.baseUrl}/store/${slug}/bag`, { waitUntil: "networkidle" });
    check("no payment-method control is rendered at all",
      await soloPage.locator('input[name="paymentMethod"]').count(), 0);
    const soloBody = (await soloPage.locator("body").innerText()).replace(/\s+/g, " ");
    assert("and checkout is still offered", soloBody.includes("Continue to payment"), soloBody.slice(0, 200));
    await soloContext.close();
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
