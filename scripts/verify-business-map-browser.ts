import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";

// THE BUSINESS MAP, IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-business-map-browser.ts" -OutFile out.txt
//
// ============ THE TWO ASSERTIONS THAT MATTER MOST (2026-09-01) =========
//
// Sean's screenshots showed two things every previous green run had missed,
// and both are measured directly here rather than inferred:
//
//   A REAL SCALE CHANGE. Selecting a branch used to move a camera over one
//   fixed layout, which reads as sliding rather than going inside. The world's
//   scale factor is read and compared per level — a transform that merely
//   translated would pass a "did the transform change" check and fails this.
//
//   NO LABEL COLLISION. Deeper levels crowded into the same pixels:
//   "Connections" over "Mailchimp", "Creation / Assets / Designs" stacked. Every
//   pair of rendered labels is compared for overlap at every level. A layout
//   that inherits its parent's coordinates cannot pass this.
//
// isVisible() proves neither of those, and has twice been true in this project
// for something nobody could see. Every claim below is a bounding box, a
// computed transform, or a hit test.

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

const overlayUp = () =>
  Array.from(document.querySelectorAll("div")).some((el) => {
    const s = getComputedStyle(el);
    return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
  });

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
      // hydration, or still in flight
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(overlayUp, undefined, { timeout: 6_000 }).catch(() => {});
  await page
    .waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("div")).some((el) => {
          const s = getComputedStyle(el);
          return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
        }),
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
}

/** The world's actual scale factor, read off the rendered transform. */
async function worldScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-world"]');
    if (!el) return 0;
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return Math.round(m.a * 1000) / 1000;
  });
}

/** Every pair of rendered map labels that overlap. Empty is the pass. */
async function collisions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts = Array.from(
      document.querySelectorAll('[data-screen="business-map"] svg text'),
    ).filter((el) => (el.textContent ?? "").trim().length > 0);
    const boxes = texts.map((el) => ({ label: el.textContent!.trim(), r: el.getBoundingClientRect() }));
    const hits: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        if (a.width === 0 || b.width === 0) continue;
        // A couple of pixels of tolerance: touching is not colliding.
        const overlap =
          a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top + 2;
        if (overlap) hits.push(`${boxes[i].label} × ${boxes[j].label}`);
      }
    }
    return hits;
  });
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  mkdirSync(SHOTS, { recursive: true });

  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const email = `map-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: "Cubit & Coil", slug: `map${stamp}`,
        tagline: "Hand-wound copper, true to the cubit",
        description: "Copper tensor rings wound by hand.", currency: "USD", published: true,
        blueprint: { brandIdentity: { brandStory: "Wound by hand.", targetAudience: "Practitioners." } },
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });

    // Enough products that Commerce genuinely groups, which is the level the
    // hairball used to appear at.
    for (let i = 0; i < 6; i++) {
      const product = await prisma.product.create({
        data: { storeId: store.id, name: `Copper Tensor Ring ${i}`, description: "d", priceInCents: 3232, active: true },
      });
      if (i === 0) {
        await prisma.order.create({
          data: {
            storeId: store.id, productName: product.name, quantity: 1, amountInCents: 3232,
            buyerEmail: `buyer-${stamp}@example.test`, paymentProvider: "STRIPE",
            externalOrderId: `cs_map_${stamp}`, status: "paid", productId: product.id,
          },
        });
      }
    }
    await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: `acct_${stamp}` },
    });
    await prisma.genesisObservation.create({
      data: {
        storeId: store.id, status: "ACTIVE", genesisState: "OPPORTUNITY",
        dedupeKey: `seo-${stamp}`,
        summary: "Your storefront has no SEO title or meta description yet.",
        actionHref: "/dashboard/website",
      },
    });

    const home = `${server.baseUrl}/b/${store.slug}`;
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    // ====================================================================
    console.log("\n=== 1. The welcome plays, and the map is what follows ===\n");
    // ====================================================================
    await page.goto(home, { waitUntil: "domcontentloaded" });
    const arrivalSeen = await page
      .waitForFunction(overlayUp, undefined, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    assert("the Genesis arrival experience still plays", arrivalSeen,
      "no full-screen arrival layer appeared — it must not have been removed");
    await settle(page);

    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    assert("signing in lands on a screen that has the map",
      (await page.locator('[data-screen="business-map"]').count()) === 1);
    await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    assert("/dashboard shows it too", (await page.locator('[data-screen="business-map"]').count()) === 1);

    await page.goto(home, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });

    // ====================================================================
    console.log("\n=== 2. Zoom is real: the world's SCALE changes per level ===\n");
    // ====================================================================
    const scale0 = await worldScale(page);
    assert("the whole business renders at base scale", scale0 > 0.9 && scale0 < 1.1, `${scale0}`);

    await page.getByRole("button", { name: /^Commerce,/ }).click();
    await page.waitForTimeout(500);
    const scale1 = await worldScale(page);
    assert("selecting Commerce genuinely zooms in", scale1 > scale0 + 0.15, `${scale0} -> ${scale1}`);

    const centre1 = ((await page.locator('[data-testid="map-centre"]').textContent()) ?? "").trim();
    assert("and Commerce becomes the centre", centre1 === "Commerce", centre1);

    const branchNodes = page.locator('[data-screen="business-map"] svg g[data-level="child"]');
    assert("its children ring it", (await branchNodes.count()) > 0, `${await branchNodes.count()}`);

    // second level
    await branchNodes.first().click();
    await page.waitForTimeout(500);
    const scale2 = await worldScale(page);
    assert("going a level deeper zooms again", scale2 > scale1 + 0.15, `${scale1} -> ${scale2}`);
    const centre2 = ((await page.locator('[data-testid="map-centre"]').textContent()) ?? "").trim();
    assert("and that node is now the centre", centre2.length > 0 && centre2 !== "Commerce", centre2);

    // ====================================================================
    console.log("\n=== 3. No level is a hairball ===\n");
    // ====================================================================
    const atLeaf = await collisions(page);
    assert("no labels overlap at the deepest level", atLeaf.length === 0, JSON.stringify(atLeaf));
    await page.locator('[data-testid="map-back"]').click();
    await page.waitForTimeout(450);
    const atBranch = await collisions(page);
    assert("nor one level up", atBranch.length === 0, JSON.stringify(atBranch));
    await page.locator('[data-testid="map-back"]').click();
    await page.waitForTimeout(450);
    const atRoot = await collisions(page);
    assert("nor on the whole business", atRoot.length === 0, JSON.stringify(atRoot));

    // ====================================================================
    console.log("\n=== 4. Back and Whole business walk the levels ===\n");
    // ====================================================================
    assert("Back returned to base scale", Math.abs((await worldScale(page)) - scale0) < 0.05,
      `${await worldScale(page)} vs ${scale0}`);
    assert("and J4 is the centre again",
      ((await page.locator('[data-testid="map-centre"]').textContent()) ?? "").trim() === "J4");

    await page.getByRole("button", { name: /^Customers,/ }).click();
    await page.waitForTimeout(450);
    await page.getByRole("button", { name: "Whole business" }).click();
    await page.waitForTimeout(450);
    assert("Whole business returns from any depth",
      ((await page.locator('[data-testid="map-centre"]').textContent()) ?? "").trim() === "J4");

    // ====================================================================
    console.log("\n=== 5. Connections opens a chooser, not a card ===\n");
    // ====================================================================
    await page.getByRole("button", { name: /^Connections,/ }).click();
    await page.waitForSelector('[data-testid="connection-chooser"]', { timeout: 10_000 });
    assert("the chooser opens", (await page.locator('[data-testid="connection-chooser"]').count()) === 1);
    assert("and the old information card does NOT appear",
      (await page.locator('[data-testid="map-card"]').count()) === 0);

    const chooser = page.locator('[data-testid="connection-chooser"]');
    const chooserText = await chooser.innerText();
    for (const service of ["Instagram", "Mailchimp", "Printful"]) {
      assert(`${service} is offered`, chooserText.includes(service), chooserText.slice(0, 200));
    }
    assert("connected services are shown as connected",
      /Connected/.test(chooserText), chooserText.slice(0, 200));

    // Icons: the provider's OWN favicon, never a third-party service.
    const icons = await chooser.locator("img").evaluateAll((els) =>
      els.map((el) => (el as HTMLImageElement).getAttribute("src") ?? ""));
    assert("service icons are present", icons.length > 0, `${icons.length}`);
    // EVERY ROW HAS AN ICON SLOT, whether or not the network cooperates. The
    // monogram renders first and the favicon replaces it only once decoded, so
    // an unreachable provider can never leave a blank square.
    const iconless = await chooser.evaluate((el) =>
      Array.from(el.querySelectorAll("li")).filter((li) => {
        const slot = li.querySelector("span.relative");
        return !slot || (slot.textContent ?? "").trim().length === 0 && !slot.querySelector("img");
      }).length);
    assert("and every row shows one, monogram or favicon", iconless === 0, `${iconless} rows without`);
    assert("every icon comes from the provider's own domain",
      icons.every((src) => /^https:\/\/[^/]+\/favicon\.ico$/.test(src)), JSON.stringify(icons.slice(0, 4)));
    assert("and none from a third-party favicon service",
      !icons.some((src) => /google\.com\/s2|duckduckgo|favicon\.im|icon\.horse/i.test(src)),
      JSON.stringify(icons.slice(0, 4)));

    // Connect and Create.
    assert("Connect is offered", (await chooser.getByRole("link", { name: "Connect" }).count()) > 0);
    const create = chooser.getByRole("link", { name: "Create account" });
    assert("Create account is offered", (await create.count()) > 0);
    const createHref = await create.first().getAttribute("href");
    assert("Create account goes straight to the provider",
      !!createHref && createHref.startsWith("https://") && !createHref.includes("localhost"), String(createHref));
    assert("in a new tab", (await create.first().getAttribute("target")) === "_blank");
    assert("and nothing tells the owner to go and search",
      !/search|google it|find it online/i.test(chooserText), chooserText.slice(0, 300));

    // Scrollable rather than crowded.
    const scrollable = await chooser.evaluate((el) => {
      const list = el.querySelector("div.overflow-y-auto");
      return list ? { can: list.scrollHeight >= list.clientHeight, h: list.clientHeight } : null;
    });
    assert("the list scrolls rather than crowding", scrollable !== null, JSON.stringify(scrollable));

    await page.locator('[data-testid="connection-chooser-close"]').click();
    await page.waitForTimeout(350);
    assert("closing the chooser returns to the whole business",
      ((await page.locator('[data-testid="map-centre"]').textContent()) ?? "").trim() === "J4");

    await page.screenshot({ path: `${SHOTS}/business-map-desktop-firstscreen.png`, fullPage: false });

    // ====================================================================
    console.log("\n=== 6. The narrative is below the map, the greeting above ===\n");
    // ====================================================================
    {
      const mapY = (await page.locator('[data-screen="business-map"]').boundingBox())?.y ?? 0;
      const welcomeY = (await page.locator("h1").first().boundingBox())?.y ?? 0;
      assert("the greeting is above the map", welcomeY < mapY, `greeting ${welcomeY}, map ${mapY}`);
      assert("and it is the welcome",
        /Welcome back/.test((await page.locator("h1").first().innerText()).trim()));

      const body = await page.locator("body").innerText();
      assert("J4's notice reaches the arrival experience",
        /no SEO title or meta description/.test(body), body.slice(0, 160));
    }

    // ====================================================================
    console.log("\n=== 7. The overview is still underneath ===\n");
    // ====================================================================
    {
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      assert("the snapshot survived", /order/i.test(body) && /storefront/i.test(body));
      assert("J4 Noticed survived", /J4 Noticed|Nothing needs you right now/.test(body));
      const mapY = (await page.locator('[data-screen="business-map"]').boundingBox())?.y ?? 0;
      const overviewY = (await page.locator("text=/What's happening right now/").boundingBox())?.y ?? 0;
      assert("and sits below the map", overviewY > mapY, `map ${mapY}, overview ${overviewY}`);
    }

    // ====================================================================
    console.log("\n=== 8. On a 390px phone ===\n");
    // ====================================================================
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: await context.storageState(),
    });
    const small = await phone.newPage();
    await small.goto(home, { waitUntil: "domcontentloaded" });
    await settle(small);
    await small.waitForSelector('[data-screen="business-map"] .map-stage', { timeout: 30_000 });

    const smallBox = await small.locator('[data-screen="business-map"]').boundingBox();
    assert("the map is inside the viewport",
      !!smallBox && smallBox.x >= 0 && smallBox.x + smallBox.width <= 390,
      `x=${smallBox?.x} w=${smallBox?.width}`);

    // THE NARRATIVE NO LONGER PUSHES IT DOWN. This is the measurement Sean's
    // screenshot made: the map began most of a screen below the fold.
    assert("and starts within the first screen", !!smallBox && smallBox.y < 620, `y=${smallBox?.y}`);

    const stage = await small.locator('[data-screen="business-map"] .map-stage').boundingBox();
    assert("the drawing does not fill the phone",
      !!stage && stage.height <= 380, `height=${stage?.height}`);

    assert("no labels collide at 390px", (await collisions(small)).length === 0,
      JSON.stringify(await collisions(small)));

    const clipped = await small.evaluate(() => {
      const st = document.querySelector('[data-screen="business-map"] .map-stage');
      if (!st) return ["no stage"];
      const box = st.getBoundingClientRect();
      return Array.from(st.querySelectorAll("svg text"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
        })
        .map((el) => el.textContent ?? "");
    });
    assert("and none is cut off", clipped.length === 0, JSON.stringify(clipped));

    // zoom works on touch too
    const s0 = await worldScale(small);
    await small.getByRole("button", { name: /^Commerce,/ }).click();
    await small.waitForTimeout(500);
    assert("tapping a branch zooms on a phone", (await worldScale(small)) > s0 + 0.15,
      `${s0} -> ${await worldScale(small)}`);
    assert("with no collision at that level", (await collisions(small)).length === 0,
      JSON.stringify(await collisions(small)));
    await small.locator('[data-testid="map-back"]').click();
    await small.waitForTimeout(400);

    // the chooser on a phone
    await small.getByRole("button", { name: /^Connections,/ }).click();
    await small.waitForSelector('[data-testid="connection-chooser"]', { timeout: 10_000 });
    const chooserBox = await small.locator('[data-testid="connection-chooser"]').boundingBox();
    assert("the chooser fits the phone",
      !!chooserBox && chooserBox.x >= 0 && chooserBox.x + chooserBox.width <= 390,
      JSON.stringify(chooserBox));
    const overflowX = await small.evaluate(() => ({
      doc: document.documentElement.scrollWidth, win: window.innerWidth,
    }));
    assert("and the page still does not scroll sideways",
      overflowX.doc <= overflowX.win + 1, JSON.stringify(overflowX));
    await small.screenshot({ path: `${SHOTS}/business-map-chooser-mobile.png`, fullPage: false });
    // Whether a favicon actually resolved is a network fact, not a code fact —
    // reported rather than asserted, because a provider being unreachable from
    // this machine is not a defect in the chooser.
    const loaded = await small.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="connection-chooser"] img'))
        .filter((el) => (el as HTMLImageElement).naturalWidth > 0).length);
    console.log(`  NOTE  ${loaded} provider favicons resolved from this machine (the rest show monograms)`);
    await small.locator('[data-testid="connection-chooser-close"]').click();
    await small.waitForTimeout(300);

    // every room survived the bar
    const bar = await small.evaluate(() =>
      Array.from(document.querySelectorAll("nav a, nav button"))
        .map((el) => (el.textContent ?? "").trim())
        .filter((s) => s.length > 0 && s.length < 20));
    for (const room of ["Business", "Storefront", "Studio", "Commerce", "Account"]) {
      assert(`${room} is still in the mobile bar`, bar.some((l) => l.includes(room)), JSON.stringify(bar));
    }

    await small.screenshot({ path: `${SHOTS}/business-map-mobile-firstscreen.png`, fullPage: false });
    await small.screenshot({ path: `${SHOTS}/business-map-mobile.png`, fullPage: true });

    // ====================================================================
    console.log("\n=== 9. Reduced motion still gives a usable map ===\n");
    // ====================================================================
    {
      const still = await browser.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        storageState: await context.storageState(), reducedMotion: "reduce",
      });
      const p2 = await still.newPage();
      await p2.goto(home, { waitUntil: "domcontentloaded" });
      await settle(p2);
      await p2.waitForSelector('[data-screen="business-map"] .map-stage', { timeout: 30_000 });

      const labels = await p2.evaluate(() =>
        document.querySelectorAll('[data-screen="business-map"] svg text').length);
      assert("the map still renders with motion reduced", labels > 8, `${labels}`);

      const before = await worldScale(p2);
      await p2.getByRole("button", { name: /^Commerce,/ }).click();
      await p2.waitForTimeout(400);
      assert("and still zooms", (await worldScale(p2)) > before + 0.15,
        `${before} -> ${await worldScale(p2)}`);
      assert("with no collision", (await collisions(p2)).length === 0,
        JSON.stringify(await collisions(p2)));

      const frame = () =>
        p2.evaluate(() =>
          (document.querySelector('[data-testid="map-data-stream"]') as HTMLCanvasElement).toDataURL());
      await p2.waitForTimeout(600);
      const a = await frame();
      await p2.waitForTimeout(700);
      assert("and the network field holds still", a === (await frame()),
        "the canvas redrew itself between frames");
      assert("while still drawing something", a.length > 5000, `${a.length} bytes`);

      await p2.screenshot({ path: `${SHOTS}/business-map-reduced-motion.png`, fullPage: false });
      await still.close();
    }

    // ====================================================================
    console.log("\n=== 10. Website and Identity still work ===\n");
    // ====================================================================
    for (const [path, marker] of [
      [`/b/${store.slug}/website`, /Storefront|Website/i],
      [`/b/${store.slug}/brand`, /Business identity/i],
    ] as const) {
      const res = await page.goto(`${server.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      assert(`${path} loads`, (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      assert(`${path} renders its own screen`,
        marker.test(await page.locator("body").innerText()));
    }
    await page.waitForSelector('input[name="name"]', { timeout: 30_000 });
    for (const field of ["name", "tagline"]) {
      assert(`Identity still edits ${field}`, (await page.locator(`input[name="${field}"]`).count()) === 1);
    }
    assert("and description", (await page.locator('textarea[name="description"]').count()) === 1);

    // RENDERED TEXT, not the raw response. The first version read the HTTP
    // body, where the phrase survives inside the RSC payload for other screens
    // even though nothing on this page shows it — a true assertion failing on
    // bytes nobody sees.
    await page.goto(`${server.baseUrl}/b/${store.slug}/website`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");
    const siteText = await page.locator("body").innerText();
    assert("the Storefront editor still has no Genesis noticed section",
      !/Genesis noticed/.test(siteText), siteText.slice(-200));

    await page.goto(home, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    assert("the home screen has no second business-name field",
      (await page.locator('input[name="name"]').count()) === 0);

    await phone.close();
    console.log(`\n${failures} failed, ${passes} passed`);
    console.log(`Screenshots in ${SHOTS}/`);
  } finally {
    await browser?.close();
    await server.close();
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
