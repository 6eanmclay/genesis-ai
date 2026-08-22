import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// A FEATURE ISN'T FINISHED JUST BECAUSE IT WORKS ON DESKTOP:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-mobile-reliability.ts" -OutFile out.txt
//
// P1.9 of the Cubit & Coil Live milestone, in Sean's own words: "Mobile
// reliability tested for real across photo/video uploads, product editing,
// descriptions, checkout, the J4 Portal, media handling, navigation, and order
// management — a feature isn't finished just because it works on desktop."
//
// WHAT THIS CAN HONESTLY PROVE, and what it deliberately does not claim. A
// 390x844 Chromium context is a real browser at a real phone's width, so
// everything about LAYOUT is genuinely testable here: whether a page pushes
// sideways, whether a control is reachable, whether the fixed bar covers the
// thing underneath it. Those are exactly the failures that never show up on a
// desktop and are invisible to every unit test in this repo.
//
// It is NOT a real device. Touch behaviour, real network conditions, iOS Safari
// quirks and camera-roll uploads are not covered by it and are not claimed —
// media upload in particular needs the Blob service, which is externally
// blocked here, and mocking it would prove nothing about the thing that breaks.
// Those stay open, named rather than quietly folded into a passing run.
//
// HORIZONTAL OVERFLOW IS THE ASSERTION THAT MATTERS MOST. It is objectively
// true or false, it is invisible at 1280px, and it is the single most common
// way a screen that "works" is unusable on a phone: one wide table, one long
// unbroken string, one fixed width, and the whole page slides under the
// owner's thumb with content off the edge.

let failures = 0;

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const PASSWORD = "a-real-passphrase-for-this-test";
const PHONE = { width: 390, height: 844 };

/** Apple's own minimum, and the one most accessibility guidance settles on. */
const MIN_TAP_TARGET = 44;

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // Submitted repeatedly on purpose: the submit is a client-side next-auth
  // call, so a click landing before hydration is silently lost. Same guard
  // verify-office-browser.ts documents.
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
        timeout: 8_000,
      });
      break;
    } catch {
      // Hydration probably had not finished. Ask again.
    }
  }
}

/**
 * Does this page push sideways?
 *
 * Measured against documentElement.clientWidth rather than the viewport, so a
 * vertical scrollbar does not read as horizontal overflow. A few pixels of
 * slack absorbs sub-pixel rounding, which is real and is not a defect.
 */
async function overflow(page: Page): Promise<{ over: number; widest: string | null }> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const over = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - limit;
    // Name the widest offender, because "this page overflows" is not something
    // anybody can act on.
    let widest: string | null = null;
    let worst = limit;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      if (rect.right > worst) {
        worst = rect.right;
        const cls = typeof el.className === "string" ? el.className.slice(0, 60) : "";
        widest = `<${el.tagName.toLowerCase()} class="${cls}"> right=${Math.round(rect.right)}`;
      }
    }
    return { over, widest };
  });
}

async function main() {
  const server = await startTestServer({ timeoutMs: 180_000 });
  // The SERVER's own client, against the harness database it was started on —
  // not @/lib/prisma, which resolves DATABASE_URL from .env and would point at
  // whatever this machine's environment happens to name.
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const owner = await prisma.user.create({
      data: {
        email: "owner@mobile.test",
        name: "Owner",
        password: await bcrypt.hash(PASSWORD, 10),
      },
    });
    const store = await prisma.store.create({
      data: {
        userId: owner.id,
        name: "Copper & Coil",
        slug: "mobile-shop",
        tagline: "Hand-wound rings",
        description: "A real description.",
        currency: "GBP",
        published: true,
      },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: store.id } });

    // A CONNECTED RAIL, because without one the storefront correctly renders no
    // buy button at all. The first run of this suite failed here and the code
    // was right: an unconnected store must not offer a checkout. The fixture
    // was what was wrong.
    await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_test" },
    });

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: "Tensor Ring",
        // A long unbroken string is the classic overflow cause, and a real
        // product description can genuinely contain one — a URL, a part
        // number. If the storefront cannot wrap it, that is a real defect and
        // this is where it surfaces.
        description:
          "Hand-wound copper. Reference: CC-TENSOR-RING-2026-STANDARD-CUBIT-COPPER-HANDWOUND-EDITION-001",
        priceInCents: 8_500,
        active: true,
      },
    });
    // Real orders, so order management is exercised with content rather than
    // against an empty state that cannot overflow anything.
    for (let i = 0; i < 3; i++) {
      await prisma.order.create({
        data: {
          storeId: store.id,
          productId: product.id,
          productName: product.name,
          quantity: i + 1,
          amountInCents: 8_500 * (i + 1),
          buyerEmail: `a-fairly-long-buyer-address-${i}@customers.example.test`,
          paymentProvider: "STRIPE",
          externalOrderId: `ord-mobile-${i}`,
          shippingAddress: {
            name: "A Buyer",
            line1: "1 Extremely Long Street Name For Testing",
            city: "Hartlepool",
            postalCode: "TS24 0XX",
            country: "GB",
          },
        },
      });
    }

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, owner.email!);

    // -----------------------------------------------------------------------
    console.log("\n1. No screen the owner runs their business from slides sideways");
    // -----------------------------------------------------------------------
    // The owner-facing rooms, by the route an owner actually reaches them by.
    const OWNER_SCREENS: { label: string; path: string }[] = [
      { label: "arrival", path: `/b/${store.slug}` },
      { label: "orders", path: `/b/${store.slug}/orders` },
      { label: "products", path: `/b/${store.slug}/products` },
      { label: "website", path: `/b/${store.slug}/website` },
      { label: "analytics", path: `/b/${store.slug}/analytics` },
      { label: "connections", path: `/b/${store.slug}/connections` },
    ];

    for (const screen of OWNER_SCREENS) {
      await page.goto(`${server.baseUrl}${screen.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(400);
      const { over, widest } = await overflow(page);
      assert(`${screen.label} fits the phone`, over <= 2, `${over}px over — widest ${widest ?? "unknown"}`);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Nor does the storefront a customer buys from");
    // -----------------------------------------------------------------------
    // The one that costs money when it breaks: a customer who cannot reach the
    // buy button does not file a bug, they leave.
    const CUSTOMER_SCREENS: { label: string; path: string }[] = [
      { label: "the shop front", path: `/store/${store.slug}` },
      { label: "a product page", path: `/store/${store.slug}/products/${product.id}` },
    ];
    for (const screen of CUSTOMER_SCREENS) {
      await page.goto(`${server.baseUrl}${screen.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(400);
      const { over, widest } = await overflow(page);
      assert(`${screen.label} fits the phone`, over <= 2, `${over}px over — widest ${widest ?? "unknown"}`);
    }

    // A long unbroken reference in a real description must wrap rather than
    // push the page. This is the seeded cause from above, checked where it
    // actually renders.
    await page.goto(`${server.baseUrl}/store/${store.slug}/products/${product.id}`, {
      waitUntil: "domcontentloaded",
    });
    const descriptionFits = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      return Array.from(document.querySelectorAll("p")).every((p) => p.getBoundingClientRect().right <= limit + 2);
    });
    assert("a long unbroken product reference wraps instead of pushing the page", descriptionFits);

    // -----------------------------------------------------------------------
    console.log("\n3. The buy button is reachable, and big enough to hit");
    // -----------------------------------------------------------------------
    const buy = await page.evaluate((min) => {
      const el = Array.from(document.querySelectorAll("button, a")).find((b) =>
        /buy|add to (cart|bag)|checkout|purchase/i.test(b.textContent ?? "")
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent?.trim().slice(0, 40) ?? "",
        withinViewport: r.left >= 0 && r.right <= document.documentElement.clientWidth + 2,
        tall: r.height >= min,
      };
    }, MIN_TAP_TARGET);
    assert("the storefront offers a way to buy", buy !== null, JSON.stringify(buy));
    if (buy) {
      assert("it is fully on screen", buy.withinViewport, JSON.stringify(buy));
      assert(`it is at least ${MIN_TAP_TARGET}px tall`, buy.tall, JSON.stringify(buy));
    }

    // -----------------------------------------------------------------------
    console.log("\n4. Order management is usable with a thumb");
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/b/${store.slug}/orders`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);

    const orderControls = await page.evaluate((min) => {
      const cards = Array.from(document.querySelectorAll("li"));
      const buttons = cards.flatMap((c) => Array.from(c.querySelectorAll("button")));
      return {
        cards: cards.length,
        buttons: buttons.length,
        offscreen: buttons.filter(
          (b) => b.getBoundingClientRect().right > document.documentElement.clientWidth + 2
        ).length,
        tooSmall: buttons.filter((b) => b.getBoundingClientRect().height < min).map((b) => b.textContent?.trim().slice(0, 30) ?? ""),
      };
    }, MIN_TAP_TARGET);
    assert("the orders are on the page", orderControls.cards >= 3, JSON.stringify(orderControls));
    assert("every order control is fully on screen", orderControls.offscreen === 0, JSON.stringify(orderControls));

    // Reported rather than asserted, deliberately: a button below the tap
    // minimum is a real finding, but this codebase's dense list controls are a
    // deliberate design, and failing the suite over one would be this script
    // overruling a design decision it was not asked to make. Named so it is
    // visible instead of silently absent.
    if (orderControls.tooSmall.length > 0) {
      console.log(
        `NOTE  ${orderControls.tooSmall.length} order control(s) under ${MIN_TAP_TARGET}px tall: ${orderControls.tooSmall.join(", ")}`
      );
    }

    // -----------------------------------------------------------------------
    console.log("\n5. Nothing important hides behind the bar at the bottom");
    // -----------------------------------------------------------------------
    // The mobile shell pins a presence bar to the bottom of the screen. Any
    // content that ends underneath it is content the owner cannot read or tap,
    // and it is invisible on a desktop where the bar does not exist.
    const behindTheBar = await page.evaluate(() => {
      const bars = Array.from(document.querySelectorAll("*")).filter((el) => {
        const s = getComputedStyle(el);
        return s.position === "fixed" && parseFloat(s.bottom || "0") === 0 && el.getBoundingClientRect().height > 0;
      });
      if (bars.length === 0) return { bar: false, covered: 0 };
      const barTop = Math.min(...bars.map((b) => b.getBoundingClientRect().top));
      const doc = document.documentElement;
      // Did the page leave room? Scroll to the very bottom and see whether the
      // last real content still clears the bar.
      window.scrollTo(0, doc.scrollHeight);
      const last = Array.from(document.querySelectorAll("main li, main p, main button")).filter(
        (el) => el.getBoundingClientRect().height > 0
      );
      const covered = last.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > barTop && r.top < barTop;
      }).length;
      return { bar: true, covered };
    });
    assert("the mobile shell really does pin a bar", behindTheBar.bar, JSON.stringify(behindTheBar));
    assert(
      "and the page reserves room so nothing ends underneath it",
      behindTheBar.covered === 0,
      `${behindTheBar.covered} element(s) overlapped — the page needs bottom padding for the bar`
    );

    // -----------------------------------------------------------------------
    console.log("\n6. Every room is reachable from a phone");
    // -----------------------------------------------------------------------
    // Navigation is the one thing that, if it fails on mobile, makes every
    // other screen unreachable regardless of how well it renders.
    await page.goto(`${server.baseUrl}/b/${store.slug}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const visibleHrefs = (p: Page) =>
      p.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .filter((a) => {
            const r = a.getBoundingClientRect();
            return r.height > 0 && r.width > 0 && r.right <= document.documentElement.clientWidth + 2;
          })
          .map((a) => a.getAttribute("href") ?? "")
      );

    const onTheBar = await visibleHrefs(page);
    assert("there are tappable links on screen", onTheBar.length > 0, String(onTheBar.length));
    assert("orders is one tap away", onTheBar.some((h) => h.endsWith("/orders")), onTheBar.join(" "));

    // NO LINK LEAVES THE BUSINESS THE OWNER IS STANDING IN.
    //
    // This suite found the defect that prompted this assertion: /dashboard/*
    // and /b/<slug>/* links side by side on one screen. /dashboard/* is the
    // legacy route, which resolves whichever business the ACCOUNT last made
    // active — so from inside Business A those links are a door into Business
    // B, while the page around them still says Business A's name. With one
    // business it is invisible, which is exactly why it needs a test rather
    // than an eye.
    //
    // Asserted behaviourally rather than by grepping for the string, so it
    // holds for any future leak regardless of which component introduces it.
    const legacy = onTheBar.filter((h) => h.startsWith("/dashboard/"));
    assert(
      "no link on a business page goes to the account-scoped route",
      legacy.length === 0,
      legacy.join(" ")
    );

    // PRODUCTS IS NOT ON THE BAR, AND THAT IS THE DESIGN. The mobile shell
    // carries four tabs plus an overflow sheet; the first run of this suite
    // failed here and the navigation was right — the assertion was, because it
    // never opened the sheet. What matters on a phone is not that everything is
    // one tap away, it is that everything is REACHABLE, so this follows the
    // journey an owner actually takes.
    // Found by NAME, not by position. The first version looked for any
    // aria-expanded control near the bottom of the screen and clicked J4's
    // Office, whose door sits one pixel above this one — it opened something,
    // reported success, and told us nothing about navigation.
    const opened = await page.evaluate(() => {
      const more = Array.from(document.querySelectorAll("button")).find(
        (b) =>
          b.getAttribute("aria-expanded") !== null &&
          (b.textContent ?? "").trim() === "Account" &&
          b.getBoundingClientRect().height > 0
      );
      if (!more) return false;
      (more as HTMLButtonElement).click();
      return true;
    });
    assert("the overflow sheet has a control on the bar", opened);
    await page.waitForTimeout(400);

    const inTheSheet = await visibleHrefs(page);
    assert(
      "and the rooms that live behind it are there",
      inTheSheet.some((h) => h.endsWith("/connections")) && inTheSheet.some((h) => h.endsWith("/settings")),
      inTheSheet.join(" ")
    );

    // The sheet's own rows have to be hittable too — an overflow menu whose
    // rows run off the edge is the same defect one level down.
    const sheetFits = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .filter((a) => a.getBoundingClientRect().height > 0)
        .every((a) => a.getBoundingClientRect().right <= document.documentElement.clientWidth + 2)
    );
    assert("every row in the sheet is fully on screen", sheetFits);

    // -----------------------------------------------------------------------
    console.log("\n7. Inside a room, its own sections are reachable on a phone");
    // -----------------------------------------------------------------------
    // PRODUCTS IS NOT IN THE NAVIGATION, AND THAT IS THE DESIGN. Decision 2 of
    // the locked room architecture puts Products, Customers and Revenue INSIDE
    // Commerce rather than beside it — "Commerce as one room containing both
    // the ledger and catalogue". Two earlier versions of this suite failed
    // here looking for Products on the bar and then in the overflow sheet, and
    // the navigation was right both times.
    //
    // So the real question on a phone is not whether Commerce's sections are
    // in the global nav. It is whether the section row that carries them is
    // usable with a thumb — and that row is a horizontally scrolling rail,
    // which is precisely the control that looks fine at 1280px and strands
    // its last chip off the edge at 390px.
    await page.goto(`${server.baseUrl}/b/${store.slug}/orders`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);

    const room = await page.evaluate((min) => {
      const links = Array.from(document.querySelectorAll("a[href]")).filter(
        (a) => a.getBoundingClientRect().height > 0
      );
      const hrefs = links.map((a) => a.getAttribute("href") ?? "");
      const products = links.find((a) => (a.getAttribute("href") ?? "").endsWith("/products"));
      if (!products) return { found: false, hrefs, scrollable: false, tall: false, reachable: false };
      const rect = products.getBoundingClientRect();
      // The rail scrolls, so a chip past the right edge is reachable by
      // swiping — but only if its container actually scrolls. A chip that is
      // off-screen inside a NON-scrolling container is simply unreachable.
      let scroller: Element | null = products.parentElement;
      let scrollable = false;
      while (scroller) {
        if (scroller.scrollWidth > scroller.clientWidth + 2) {
          scrollable = true;
          break;
        }
        scroller = scroller.parentElement;
      }
      return {
        found: true,
        hrefs,
        scrollable,
        tall: rect.height >= min,
        reachable: rect.right <= document.documentElement.clientWidth + 2 || scrollable,
      };
    }, MIN_TAP_TARGET);

    assert("standing in Commerce, Products is on the page", room.found, room.hrefs.join(" "));
    assert("so is the rest of the ledger",
      room.hrefs.some((h) => h.endsWith("/customers")) && room.hrefs.some((h) => h.endsWith("/analytics")),
      room.hrefs.join(" "));
    assert(
      "and Products can actually be reached with a thumb",
      room.reachable,
      "off the right edge inside a container that does not scroll is unreachable, not merely hidden"
    );

    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
