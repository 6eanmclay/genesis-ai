import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";

// THE MONEY SCREEN, IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-finances-browser.ts" -OutFile out.txt
//
// ============ WHICH STATES A BROWSER CAN HONESTLY REACH (2026-09-01) ===
//
// Three of the four, and all three are the ones a real merchant hits:
//
//   not_connected    a business with no payment provider
//   unsupported      a business on PayPal, whose payouts Genesis cannot read
//   provider_error   a connected Stripe whose credentials do not work, so the
//                    REAL Stripe SDK genuinely fails — not a simulated failure
//
// The fourth — a healthy account with balances and payouts — needs a live
// connected Stripe account and stays E20. It is NOT faked here.
//
// scripts/lib/providerDouble.ts says why plainly: a double "must never be
// reachable from production", and wiring one into the running server to make a
// screenshot look complete would break that rule to produce evidence about a
// system nobody ships. The healthy layout is proven where it can be — the
// judgement lives in presentation.ts and is exercised exhaustively by
// verify-finances-screen-db.

const PASSWORD = "correct-horse-battery-staple";
const SHOTS = "verification-screenshots";

let failures = 0;
let passes = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 15_000 });
      break;
    } catch {
      // Hydration, or the request is still in flight.
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  mkdirSync(SHOTS, { recursive: true });

  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const email = `finances-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });

    const make = async (slug: string, connect: "STRIPE" | "PAYPAL" | null) => {
      const store = await prisma.store.create({
        data: { userId: user.id, name: "Cubit & Coil", slug, tagline: "t", description: "d", currency: "USD" },
      });
      if (connect) {
        await prisma.storeIntegration.create({
          data: { storeId: store.id, provider: connect, status: "CONNECTED", externalAccountId: `acct_${slug}` },
        });
      }
      return store;
    };

    const bare = await make(`fin-none-${stamp}`, null);
    const paypal = await make(`fin-paypal-${stamp}`, "PAYPAL");
    const stripe = await make(`fin-stripe-${stamp}`, "STRIPE");
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: bare.id } });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    // ------------------------------------------------------------------
    console.log("\n1. A business with no payment provider");
    await page.goto(`${server.baseUrl}/b/${bare.slug}/finances`, { waitUntil: "domcontentloaded" });
    // ============ THIS SCREEN, NOT THE WHOLE PAGE (2026-09-01) ===
    //
    // The first version read body.innerText and failed on "$0.00" — which was
    // the dashboard SHELL's own thirty-day revenue chip, correctly showing zero
    // for a store with no orders, not this screen inventing a balance. Reading
    // the whole page tested the wrong thing.
    //
    // Waiting for the screen's own container also waits out the arrival
    // animation, which the first run screenshotted instead of the screen.
    const screen = page.locator('[data-screen="finances"]');
    await screen.waitFor({ state: "visible", timeout: 60_000 });
    const none = (await screen.innerText()).replace(/\s+/g, " ");

    assert("the screen renders rather than erroring", /Money/.test(none), none.slice(0, 200));
    assert("it says nothing is connected", /No payment provider is connected/i.test(none), none.slice(0, 300));
    // ============ AND NEVER SHOWS ZERO ========================
    //
    // An empty balance and an unconnected provider look identical in a number,
    // and only one of them means the merchant has no money.
    assert("it does NOT show a zero balance", !/\$0\.00/.test(none), none.slice(0, 300));
    assert("and offers the way to fix it", /Connect a payment provider/i.test(none));
    await page.screenshot({ path: `${SHOTS}/finances-01-not-connected.png`, fullPage: true });

    // ------------------------------------------------------------------
    console.log("\n2. A business on a rail Genesis cannot read");
    await page.goto(`${server.baseUrl}/b/${paypal.slug}/finances`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-screen="finances"]').waitFor({ state: "visible", timeout: 60_000 });
    const unsupported = (await page.locator('[data-screen="finances"]').innerText()).replace(/\s+/g, " ");

    assert("it names the rail the business does have", /PAYPAL/.test(unsupported), unsupported.slice(0, 300));
    assert("and does not call it disconnected",
      !/No payment provider is connected/i.test(unsupported), unsupported.slice(0, 300));
    assert("nor show a zero balance", !/\$0\.00/.test(unsupported), unsupported.slice(0, 300));
    await page.screenshot({ path: `${SHOTS}/finances-02-unsupported.png`, fullPage: true });

    // ------------------------------------------------------------------
    console.log("\n3. Stripe connected, and genuinely unreachable");
    await page.goto(`${server.baseUrl}/b/${stripe.slug}/finances`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-screen="finances"]').waitFor({ state: "visible", timeout: 60_000 });
    const errored = (await page.locator('[data-screen="finances"]').innerText()).replace(/\s+/g, " ");

    // A REAL failure: the integration has no usable credentials, so the live
    // Stripe SDK fails. Nothing about this is simulated.
    assert("it says the figures are missing rather than zero",
      /missing rather than zero/i.test(errored), errored.slice(0, 400));
    assert("and does not render zeroes", !/\$0\.00/.test(errored), errored.slice(0, 300));
    assert("nor claim the account is fine", !/Can receive payouts Yes/i.test(errored));
    await page.screenshot({ path: `${SHOTS}/finances-03-provider-error.png`, fullPage: true });

    // ------------------------------------------------------------------
    console.log("\n4. One business's money is never another's");
    // The same account owns all three. The screen must answer for the business
    // in the URL, not for whichever one was last active.
    await page.goto(`${server.baseUrl}/b/${paypal.slug}/finances`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-screen="finances"]').waitFor({ state: "visible", timeout: 60_000 });
    const scoped = (await page.locator('[data-screen="finances"]').innerText()).replace(/\s+/g, " ");
    assert("the PayPal business does not show the Stripe one's account",
      !scoped.includes(`acct_fin-stripe-${stamp}`), scoped.slice(0, 300));
    assert("and still answers for itself", /PAYPAL/.test(scoped));

    // ------------------------------------------------------------------
    console.log("\n5. Money is its own place, beside Revenue");
    await page.goto(`${server.baseUrl}/b/${bare.slug}/orders`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const nav = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("the nav offers Money", /Money/.test(nav), nav.slice(0, 300));
    assert("and still offers Revenue separately", /Revenue/.test(nav), nav.slice(0, 300));

    // ------------------------------------------------------------------
    console.log("\n6. And a merchant on a phone can actually reach it");
    {
      // ============ IN THE DOM IS NOT ON THE SCREEN ==============
      //
      // The check above passed at 1280px on the day this shipped, and Sean
      // still could not find Money on his phone. The link was present, its
      // href was correctly rebased, and Playwright called it "visible" —
      // because it IS rendered. Its left edge was at x=598 in a 390px
      // viewport: two hundred pixels off the side of a strip that scrolls
      // horizontally and gives no sign that it does.
      //
      // So this asserts geometry rather than presence. A nav item a merchant
      // has to discover by guessing that a strip scrolls is not navigation.
      // The SAME session, in a phone-sized window. Signing in a second time
      // meets the auth attempt throttle — which is the throttle working — and
      // this needs a viewport, not another login.
      const phone = await browser!.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        storageState: await context.storageState(),
      });
      const small = await phone.newPage();
      await small.goto(`${server.baseUrl}/b/${bare.slug}/orders`, { waitUntil: "domcontentloaded" });
      await small.waitForLoadState("networkidle").catch(() => {});

      const money = small.getByRole("link", { name: "Money", exact: true }).first();
      await money.waitFor({ state: "visible", timeout: 30_000 });
      const box = await money.boundingBox();
      assert("Money has a position on a phone screen", box !== null);
      assert("and it is inside the viewport, not past the edge of a scrolling strip",
        !!box && box.x >= 0 && box.x + box.width <= 390,
        `x=${box?.x} width=${box?.width} — viewport is 390px`);

      // And it goes where it should, from the business route.
      await money.click();
      await small.waitForURL(/\/finances$/, { timeout: 30_000 });
      assert("tapping it opens Finances for this business",
        small.url().includes(`/b/${bare.slug}/finances`), small.url());
      await small.locator('[data-screen="finances"]').waitFor({ state: "visible", timeout: 60_000 });
      assert("and the screen renders there", await small.locator('[data-screen="finances"]').isVisible());
      await small.screenshot({ path: `${SHOTS}/finances-04-phone-nav.png`, fullPage: false });

      // ============ AND PAYMENTS IS BESIDE IT ==================
      //
      // Moved out of the account sheet into Commerce. It has to clear the same
      // bar Money just did: on the screen, not merely in the strip.
      const payments = small.getByRole("link", { name: "Payments", exact: true }).first();
      await payments.waitFor({ state: "visible", timeout: 30_000 });
      const payBox = await payments.boundingBox();
      assert("Payments is in Commerce and on the phone screen too",
        !!payBox && payBox.x >= 0 && payBox.x + payBox.width <= 390,
        `x=${payBox?.x} width=${payBox?.width}`);

      // ============ AND THE WAY OUT TO STRIPE ==================
      //
      // A merchant needs Stripe most when Genesis cannot reach it, so the
      // management action is checked where the screen is showing an error.
      await small.goto(`${server.baseUrl}/b/${stripe.slug}/finances`, { waitUntil: "domcontentloaded" });
      await small.locator('[data-screen="finances"]').waitFor({ state: "visible", timeout: 60_000 });
      const manage = small.locator('[data-testid="manage-in-stripe"]');
      if ((await manage.count()) > 0) {
        const href = await manage.getAttribute("href");
        assert("Manage in Stripe points at Stripe's own dashboard",
          !!href && href.startsWith("https://dashboard.stripe.com/"), String(href));
        assert("and carries no account id or credential",
          !!href && !/acct_|sk_|rk_|\?/.test(href), String(href));
      } else {
        // The identity block only renders when Stripe answered. With an
        // unreachable account the screen shows the error state instead, which
        // is correct — recorded rather than asserted away.
        assert("the unreachable state shows an error rather than a management block",
          /missing rather than zero/i.test(
            (await small.locator('[data-screen="finances"]').innerText()).replace(/\s+/g, " "),
          ));
      }

      // Money and Payments point at each other.
      await small.goto(`${server.baseUrl}/b/${bare.slug}/finances`, { waitUntil: "domcontentloaded" });
      await small.locator('[data-screen="finances"]').waitFor({ state: "visible", timeout: 60_000 });
      assert("Money offers a way to Payments",
        (await small.locator('[data-screen="finances"] a[href$="/payments"]').count()) > 0);

      await small.goto(`${server.baseUrl}/b/${bare.slug}/payments`, { waitUntil: "domcontentloaded" });
      await small.getByText("Connect a payment provider", { exact: false }).first()
        .waitFor({ state: "visible", timeout: 60_000 });
      assert("and Payments offers a way to Money",
        (await small.locator('a[href$="/finances"]').count()) > 0);

      await phone.close();
    }

    console.log(`\n${failures} failed, ${passes} passed`);
    console.log("\nNOT PROVEN HERE: a healthy Stripe account with real balances and");
    console.log("payouts. That needs a live connected account and stays E20.\n");
  } finally {
    await browser?.close();
    await server.close();
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
