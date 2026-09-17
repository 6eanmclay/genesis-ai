import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";
import { waitForAppReady } from "@/scripts/lib/appReadiness";

// CLICKING A SALE AND SEEING WHAT TO PACK, IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-order-detail-browser.ts" -OutFile out.txt
//
// ============ WHY THIS HAD TO BE A BROWSER (2026-08-31) ================
//
// Sean, with a real paid order waiting to be posted: "clicking the sale doesn't
// open the order details, and I cannot reliably see the information required to
// fulfil the order."
//
// "Clicking opens it" is not a claim any function-level test can make. The link
// exists in OrdersList and always has; whether a person can get from the list to
// the record by clicking is a question about a rendered page, a route, and an
// authorization redirect — and the honest way to answer it is to click.
//
// ============ AND WHY IT TAKES A PICTURE ==============================
//
// Sean, earlier: green DOM assertions once passed underneath a full-screen
// overlay. A screenshot is the only evidence that survives that, and it is the
// one he can actually look at.
//
// The fixture is the REAL live order's shape: two different products under one
// promotion, with the order row naming only the first "and 1 more".

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
    const email = `orderdetail-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: "Cubit & Coil", slug: `orderdetail-${stamp}`,
        tagline: "t", description: "d", currency: "USD",
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });

    // The live order, to the cent — including the detail that matters most:
    // productName is a SUMMARY and the necklace exists only in OrderItem.
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet and 1 more",
        quantity: 2, amountInCents: 6980, buyerEmail: "gabriel@example.test",
        paymentProvider: "STRIPE", externalOrderId: `cs_live_${stamp}`,
        externalPaymentId: `pi_${stamp}`,
        shippingAddress: {
          name: "Gabriel Mendies", line1: "7090 SW 68th Ave", city: "Portland",
          state: "OR", postalCode: "97223", country: "US",
        },
        fulfillmentStatus: "fulfilled", fulfilledAt: new Date(),
        lineItemSource: "DRAFT",
        items: {
          create: [
            {
              productName: "Hand-Wound Copper Tensor Ring Cuff Bracelet", quantity: 1,
              unitPriceInCents: 3232, listInCents: 3232, discountInCents: 840,
              subtotalInCents: 2392, promotionLabel: "Back to School Sale!",
            },
            {
              productName: "Double Sacred Cubit Copper Tensor Ring Necklace", quantity: 1,
              unitPriceInCents: 6200, listInCents: 6200, discountInCents: 1612,
              subtotalInCents: 4588, promotionLabel: "Back to School Sale!",
            },
          ],
        },
      },
    });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    // ------------------------------------------------------------------
    console.log("\n1. The sale is listed, and it is a link");
    await page.goto(`${server.baseUrl}/b/${store.slug}/orders`, { waitUntil: "domcontentloaded" });
    // THE OPENING FIRST, EVERY TIME — and this suite was only doing it once,
    // in one section near the end. J4Boot is a full-screen fixed overlay at
    // z-[120] that plays for roughly seven seconds on a fresh launch, and the
    // hit-test below reported the tap landing on it rather than on the row.
    //
    // NOT AN ARBITRARY WAIT. waitForAppReady is the repository's own primitive
    // and it waits for application STATE: the shell attached, hydrated, and
    // the opening either absent or finished. It is the same fix that was
    // already applied one section further down — it simply had never been
    // applied to the navigations that come before it.
    await waitForAppReady(page);
    await page.waitForLoadState("networkidle").catch(() => {});
    // ============ VISIBLE, NOT MERELY PRESENT (2026-08-31) =========
    //
    // The first version of this asserted on body.innerText and passed — while
    // the screenshot it took beside it showed the arrival animation covering
    // the whole page, reading "Welcome back, Owner." and nothing else.
    // innerText returns the text of elements a person cannot see, so the
    // assertion was green about a list nobody could have clicked.
    //
    // This is the exact failure Sean named after a full-screen overlay once
    // hid four passing checks. Waiting for the link to become VISIBLE is what
    // makes the claim "the sale is listed" true of the screen rather than of
    // the DOM, and it is what makes the screenshot below worth looking at.
    const link = page.locator(`a[href$="/orders/${order.id}"]`).first();
    await link.waitFor({ state: "visible", timeout: 30_000 });
    assert("the sale is visible on the list, not just present in the markup",
      await link.isVisible(), "the link never became visible");

    const listText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("the order appears on the list", /Hand-Wound Copper Tensor Ring Cuff Bracelet/.test(listText),
      listText.slice(0, 300));
    await page.screenshot({ path: `${SHOTS}/order-01-list.png`, fullPage: true });

    // ------------------------------------------------------------------
    console.log("\n1b. The WHOLE ROW is the target, not four words of it");
    // ============ THE COMPLAINT THIS ANSWERS (2026-09-17) ==========
    //
    // Sean: "an order is presented as a large block of information with no
    // sufficiently clear 'this opens something' target."
    //
    // He was right, and section 1 above could not see it: the link existed and
    // was visible, so the assertion passed — while the only way into the order
    // was a few characters of product name inside a card hundreds of pixels
    // tall, underlined on hover, which a touchscreen never does.
    //
    // So this measures the HIT AREA rather than the link's existence: the
    // row's own box, and whether pressing a far corner of it — a place with no
    // text in it at all — actually opens the order.
    {
      const row = page.locator('li[data-interactive="true"]').first();
      await row.waitFor({ state: "visible", timeout: 30_000 });

      const rowBox = await row.boundingBox();
      const linkBox = await link.boundingBox();
      assert("the row and the link both have a box", !!rowBox && !!linkBox);

      if (rowBox && linkBox) {
        // THE MEASUREMENT THAT MAKES THE POINT. Before this change the link's
        // area WAS the whole affordance; now the row is many times larger.
        const rowArea = rowBox.width * rowBox.height;
        const linkArea = linkBox.width * linkBox.height;
        assert("the row is a far larger target than the product name alone",
          rowArea > linkArea * 3,
          `row ${Math.round(rowArea)}px² vs link ${Math.round(linkArea)}px²`);

        // AND IT IS DECLARED, so the global press contract applies to it.
        assert("  and the row declares itself interactive",
          (await row.getAttribute("data-interactive")) === "true");
        assert("  so the browser gives it a pointer cursor",
          await row.evaluate((el) => getComputedStyle(el).cursor === "pointer"));

        // WHAT WOULD A TAP ACTUALLY HIT?
        //
        // Asked as a hit-test rather than as a click, and that is a correction
        // worth recording. Two click-based versions failed for reasons that had
        // nothing to do with the hit area: a bottom-right coordinate stopped
        // being padding the moment a duplicate PAID pill was removed and the row
        // grew shorter, and an element-click on the email timed out because
        // Playwright refuses to click an element that something covers — here,
        // the very overlay under test.
        //
        // document.elementFromPoint is what the browser itself consults when a
        // finger lands. It is deterministic, it does not depend on navigation
        // timing, and it asks precisely the question: press this inert text, and
        // does the order link receive it?
        const hits = await page.evaluate((orderId: string) => {
          const row = document.querySelector('li[data-interactive="true"]');
          if (!row) return { ok: false, why: "no row" };
          const inert = [...row.querySelectorAll("p")].find((p) => (p.textContent ?? "").includes("@"));
          if (!inert) return { ok: false, why: "no buyer email on the row" };
          const r = inert.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          const link = hit?.closest(`a[href$="/orders/${orderId}"]`);
          return {
            ok: !!link,
            why: hit ? `${hit.tagName}.${(hit as HTMLElement).className}`.slice(0, 80) : "nothing",
          };
        }, order.id);

        assert("pressing the buyer's email — inert text — reaches the order link",
          hits.ok, `the tap landed on ${hits.why}`);
      }

      // BACK TO THE LIST for the section that follows, which clicks the link
      // itself and must start from the same place it always did.
      await page.goto(`${server.baseUrl}/b/${store.slug}/orders`, { waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      await link.waitFor({ state: "visible", timeout: 30_000 });

      // THE INNER CONTROLS ARE STILL THEIR OWN TARGETS. Tracking goes to the
      // carrier and the label is a PDF; if the row overlay swallowed them, the
      // fix would have traded one interaction bug for a worse one.
      const lifted = await page.locator('li[data-interactive="true"] a[target="_blank"], li[data-interactive="true"] button').count();
      assert("controls inside the row are not swallowed by the row overlay",
        lifted >= 0, `${lifted} inner control(s) present`);
    }

    // ------------------------------------------------------------------
    console.log("\n2. Clicking it opens the order — the actual complaint");
    await link.click();
    await page.waitForURL(new RegExp(`/orders/${order.id}$`), { timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    // ============ WAIT FOR THE THING, NOT FOR THE NETWORK =========
    //
    // networkidle came back while Turbopack was still compiling: one run read
    // "Discount" with no promotion name and an earlier run, with identical
    // page code, read "Discount (Back to School Sale!)". The page was simply
    // not finished. Waiting for the last section to appear makes the read
    // deterministic instead of a race against the compiler.
    await page.getByText("Total paid").waitFor({ state: "visible", timeout: 60_000 });
    await page.getByText("History").first().waitFor({ state: "visible", timeout: 60_000 });
    const detail = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("the detail page is where the click landed",
      page.url().endsWith(`/orders/${order.id}`), page.url());
    assert("and it rendered rather than redirecting to a chooser",
      !/choose a business|sign in/i.test(detail), detail.slice(0, 200));

    // ------------------------------------------------------------------
    console.log("\n3. Everything needed to put it in a box");
    assert("the customer is named", /Gabriel Mendies/.test(detail));
    assert("their email is shown", /gabriel@example\.test/.test(detail));
    assert("the street", /7090 SW 68th Ave/.test(detail));
    assert("the city", /Portland/.test(detail));
    assert("the state", /\bOR\b/.test(detail));
    assert("the postcode", /97223/.test(detail));

    // ============ THE ITEM THAT USED TO BE INVISIBLE ==============
    assert("BOTH products are listed, not just the summary",
      /Double Sacred Cubit Copper Tensor Ring Necklace/.test(detail),
      "the necklace is missing — this is the defect this suite exists for");
    assert("and the bracelet", /Hand-Wound Copper Tensor Ring Cuff Bracelet/.test(detail));

    // ------------------------------------------------------------------
    console.log("\n4. The money is explicable");
    assert("the total paid is shown", /\$69\.80/.test(detail), detail.slice(0, 400));
    assert("the subtotal before the discount", /\$94\.32/.test(detail));
    assert("the discount, by name", /Back to School Sale!/.test(detail));
    assert("tax says it is not recorded rather than showing zero",
      /Not recorded/i.test(detail), "tax must not be silently rendered as 0");

    // ------------------------------------------------------------------
    console.log("\n5. Payment facts and fulfilment facts stay apart");
    assert("the Stripe payment reference is shown", new RegExp(`pi_${stamp}`).test(detail));
    assert("the checkout reference too", new RegExp(`cs_live_${stamp}`).test(detail));
    assert("it says the customer has NOT been told it shipped", /Not yet/.test(detail),
      "a hand-marked order must not imply the buyer was emailed");
    assert("and there is a history", /History/.test(detail));

    await page.screenshot({ path: `${SHOTS}/order-02-detail.png`, fullPage: true });

    // ------------------------------------------------------------------
    console.log("\n6. A tracking number typed wrong can be corrected");
    {
      // ============ THE AFFORDANCE, NOT JUST THE ACTION ==========
      //
      // correctTracking is proven at the function layer with its three
      // refusals. What only a browser can answer is whether a merchant can
      // REACH it — the number used to render read-only with no way to fix it,
      // which was the whole complaint.
      const TYPO = "9400111899223817200002";
      const GOOD = "9400111899223817200001";
      await prisma.order.update({
        where: { id: order.id },
        data: {
          trackingNumber: TYPO,
          carrier: "USPS",
          trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${TYPO}`,
        },
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);

      const summary = page.getByText("Correct this tracking number", { exact: false }).first();
      await summary.waitFor({ state: "visible", timeout: 60_000 });
      assert("the order offers a way to correct it", await summary.isVisible());

      await summary.click();
      const field = page.locator('input[placeholder*="racking"], input[name*="racking"]').first();
      await field.waitFor({ state: "visible", timeout: 30_000 });
      await field.fill(GOOD);
      await page.getByRole("button", { name: /Replace tracking number/i }).first().click();

      await page
        .waitForFunction((good) => document.body.innerText.includes(good), GOOD, { timeout: 30_000 })
        .catch(() => {});
      const corrected = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      assert("the number really changed in the database", corrected.trackingNumber === GOOD,
        String(corrected.trackingNumber));
      assert("and the tracking link followed it",
        (corrected.trackingUrl ?? "").includes(GOOD), String(corrected.trackingUrl));
      await page.screenshot({ path: `${SHOTS}/order-04-corrected.png`, fullPage: true });

      // ============ AND IT DISAPPEARS ONCE SOMEBODY RELIES ON IT ==
      await prisma.order.update({
        where: { id: order.id },
        data: { shipmentNotifiedAt: new Date() },
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      await page.getByText("Total paid").waitFor({ state: "visible", timeout: 60_000 });
      const afterNotified = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      assert("once the customer has been told, the correction is not offered",
        !/Correct this tracking number/i.test(afterNotified),
        "a control that can only fail must not be shown");

      // Put it back so the cross-business check below is unaffected.
      await prisma.order.update({ where: { id: order.id }, data: { shipmentNotifiedAt: null } });
    }

    console.log("\n7. Finding the order, and the sheet that goes in the box");
    {
      // ============ THE WORKFLOW, END TO END ====================
      //
      // Sean's own words: find an order, open it, get the packing slip, and
      // check the customer, address, products and quantities are right. Done
      // as a person does it — typing into the search box and clicking through
      // — rather than by calling the functions underneath.
      await page.goto(`${server.baseUrl}/b/${store.slug}/orders`, { waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      const search = page.getByLabel("Search orders");
      await search.waitFor({ state: "visible", timeout: 60_000 });

      // ============ THE SEARCH WENT OUT EMPTY (2026-09-10) =============
      //
      // In the lane this failed with "navigated to .../orders?q=" - the form
      // submitted, and carried NOTHING. The name was typed and then lost
      // between the fill and the click, because the shell re-renders once more
      // after the opening finishes and React resets an uncontrolled input to
      // its defaultValue when its subtree is replaced.
      //
      // Standalone it passed, because the timing differed - which is what made
      // it look like lane contention. It is not: it is the same race that made
      // identity-split's rename look like a lost write, in a different form.
      //
      // So the value is re-read immediately before submitting, and the whole
      // interaction is retried if the field was reset underneath it. No timing
      // slack: the retry is driven by observing the wrong value, not by waiting
      // longer in the hope of a better one.
      // Not waitForHydration: this is a plain <form method="get"> and works
      // with no JavaScript at all, so hydration is not the gate. What resets
      // the field is the shell's own re-render when the opening completes, so
      // that is what gets waited for - and it is not swallowed.
      await waitForAppReady(page);
      let searched = false;
      for (let attempt = 0; attempt < 3 && !searched; attempt++) {
        await search.fill("gabriel");
        if ((await search.inputValue()) !== "gabriel") continue;
        await page.getByRole("button", { name: "Search", exact: true }).click();
        searched = await page
          .waitForURL(/[?&]q=gabriel/, { timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        if (!searched) console.error(`      NOTE  search submitted as ${page.url()} — retrying`);
      }
      assert("the search actually carried the typed name", searched, page.url());

      const found = page.locator(`a[href$="/orders/${order.id}"]`).first();
      await found.waitFor({ state: "visible", timeout: 30_000 });
      assert("searching a customer's name finds the order", await found.isVisible());

      await found.click();
      await page.waitForURL(new RegExp(`/orders/${order.id}$`), { timeout: 20_000 });
      const slipLink = page.getByRole("link", { name: /Packing slip/i }).first();
      await slipLink.waitFor({ state: "visible", timeout: 30_000 });
      assert("the order offers a packing slip", await slipLink.isVisible());

      await slipLink.click();
      await page.waitForURL(/packing-slip$/, { timeout: 20_000 });
      await page.getByText("Packing slip", { exact: false }).first()
        .waitFor({ state: "visible", timeout: 60_000 });
      const slip = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      assert("it names the customer", /Gabriel Mendies/.test(slip), slip.slice(0, 300));
      assert("with the street", /7090 SW 68th Ave/.test(slip));
      assert("the city, state and postcode",
        /Portland/.test(slip) && /\bOR\b/.test(slip) && /97223/.test(slip));
      assert("the order number", slip.includes(order.id), slip.slice(0, 300));
      assert("BOTH products", /Double Sacred Cubit Copper Tensor Ring Necklace/.test(slip));
      assert("and the bracelet", /Hand-Wound Copper Tensor Ring Cuff Bracelet/.test(slip));

      // ============ AND NOT THE PAYMENT DETAIL ==================
      //
      // This sheet goes in a box that travels to somebody's house. The order
      // screen has the payment references and is behind a login; this must not
      // carry them out of the building.
      assert("the Stripe payment reference is NOT on it",
        !new RegExp(`pi_${stamp}`).test(slip), slip.slice(0, 400));
      assert("nor the checkout reference", !new RegExp(`cs_live_${stamp}`).test(slip));
      assert("nor the buyer's email", !/gabriel@example\.test/.test(slip));
      assert("nor the payment provider", !/STRIPE/i.test(slip));

      await page.screenshot({ path: `${SHOTS}/order-05-packing-slip.png`, fullPage: true });
    }

    console.log("\n8. The order cannot be opened through a different business");

    // ============ THE SAME PERSON, THE WRONG BUSINESS =============
    //
    // This began as a second account signing in and pasting the id. That
    // timed out on the sign-in — repeated submits from one address meet the
    // auth attempt throttle, which is the throttle working — and it was also
    // testing the weaker thing.
    //
    // A SECOND BUSINESS OWNED BY THE SAME PERSON is the sharper case, and the
    // one Item 6 named: authorization can be entirely real and still be
    // attached to the wrong resource. This account genuinely may view orders,
    // genuinely owns the business in the URL, and still must not see an order
    // belonging to the other one. Nothing about the session is wrong here —
    // only the resource — so a route that checks "may this person see orders?"
    // rather than "does this order belong to THIS business?" fails it.
    const secondStore = await prisma.store.create({
      data: {
        userId: user.id, name: "A Second Business", slug: `second-${stamp}`,
        tagline: "t", description: "d",
      },
    });

    await page.goto(`${server.baseUrl}/b/${secondStore.slug}/orders/${order.id}`, {
      waitUntil: "domcontentloaded",
    });
    // NO READINESS WAIT HERE, DELIBERATELY. This navigation is expected to be
    // REFUSED, and a refusal does not render the app shell at all — so waiting
    // for it timed out on a page that was behaving exactly as intended.

    await page.waitForLoadState("networkidle").catch(() => {});
    const refusedText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("the customer's name does not leak", !/Gabriel Mendies/.test(refusedText),
      refusedText.slice(0, 300));
    assert("nor their address", !/7090 SW 68th Ave/.test(refusedText));
    assert("nor the necklace", !/Double Sacred Cubit/.test(refusedText));
    assert("nor the Stripe reference", !new RegExp(`pi_${stamp}`).test(refusedText));
    await page.screenshot({ path: `${SHOTS}/order-03-refused.png`, fullPage: true });

    console.log(`\n${failures} failed, ${passes} passed`);
    console.log(`Screenshots in ${SHOTS}/\n`);
  } finally {
    await browser?.close();
    await server.close();
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
