import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";

// THE FRONT DOOR, IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-business-map-browser.ts" -OutFile out.txt
//
// ============ WHAT THIS LANE HAS TO SETTLE (2026-09-01) ================
//
// Sean: "I specifically want the first-screen experience verified on both
// desktop and a 390px mobile viewport... the map is actually visible, the map
// is usable/interactable, the first screen isn't overwhelmed by the
// visualization, the original overview remains accessible underneath."
//
// Those are geometry and interaction questions, and no source assertion can
// answer any of them. `isVisible()` cannot either — it has twice been true in
// this project for something off the side of the viewport or under a
// full-screen overlay, so every visibility claim below is a bounding box or an
// elementFromPoint hit test.
//
// AND THE ARRIVAL RITUAL MUST STILL PLAY. Sean, mid-build: "do NOT remove or
// replace the existing Genesis welcome experience." It is asserted present
// BEFORE it is waited out, so a change that quietly deleted it would fail here
// rather than pass unnoticed.

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

    // REAL MATERIAL on some branches and genuinely nothing on others, which is
    // the state every real business is in and the one the map must render
    // honestly.
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Copper Tensor Ring Cuff", description: "d", priceInCents: 3232, active: true },
    });
    await prisma.order.create({
      data: {
        storeId: store.id, productName: product.name, quantity: 1, amountInCents: 3232,
        buyerEmail: `buyer-${stamp}@example.test`, paymentProvider: "STRIPE",
        externalOrderId: `cs_map_${stamp}`, status: "paid", productId: product.id,
      },
    });
    await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: `acct_${stamp}` },
    });

    const home = `${server.baseUrl}/b/${store.slug}`;

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    // ====================================================================
    console.log("\n=== 1. The Genesis welcome still plays, then clears ===\n");
    // ====================================================================
    await page.goto(home, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({
      content: `window.overlayUpInline = ${overlayUp.toString()};`,
    }).catch(() => {});

    const arrivalSeen = await page
      .waitForFunction(overlayUp, undefined, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    assert("the Genesis arrival experience still plays", arrivalSeen,
      "no full-screen arrival layer appeared — it must not have been removed");

    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("div")).some((el) => {
          const s = getComputedStyle(el);
          return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
        }),
      undefined,
      { timeout: 30_000 },
    ).catch(() => {});

    // ====================================================================
    console.log("\n=== 1b. Where an owner actually LANDS, and how they get back ===\n");
    // ====================================================================
    //
    // THE CHECK THAT WAS MISSING, and it is why the map was invisible in
    // production. Every earlier assertion navigated straight to /b/<slug> and
    // proved the map renders THERE. None asked where an owner arrives, or
    // whether the navigation can reach it — and it could not: the rooms were
    // Storefront, Studio, Office, Commerce, Account, with no entry for home at
    // all. A screen with no door can be reached once, by arriving, and never
    // again.
    {
      // Signing in lands somewhere. That somewhere must be the map.
      const landed = page.url();
      await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 }).catch(() => {});
      assert("signing in lands on a screen that has the Business Map",
        (await page.locator('[data-screen="business-map"]').count()) === 1, `landed at ${landed}`);

      // The legacy entry point too — production sends a signed-in owner to
      // /dashboard from the root, and that path was never exercised.
      await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
      assert("/dashboard shows the map as well as /b/<slug>",
        (await page.locator('[data-screen="business-map"]').count()) === 1);

      // AND IT IS REACHABLE FROM ANYWHERE. Go into the Storefront room, then
      // find the way home. This is the assertion whose absence let a screen
      // with no navigation entry ship.
      await page.goto(`${server.baseUrl}/b/${store.slug}/website`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("domcontentloaded");
      assert("the Storefront room does not show the map",
        (await page.locator('[data-screen="business-map"]').count()) === 0);

      // THE VISIBLE ONE. Both the desktop rail and the mobile bar are in the
      // DOM at every width; only one is on screen, and clicking the other
      // waits for ever.
      const homeLinks = page.locator(`a[href="/b/${store.slug}"]:visible`);
      assert("the navigation offers a way back to the business",
        (await homeLinks.count()) > 0, "no visible nav entry points at the business home");
      const homeLink = homeLinks.first();
      await homeLink.click();
      await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
      assert("and following it returns to the map",
        (await page.locator('[data-screen="business-map"]').count()) === 1);
    }

    // ====================================================================
    console.log("\n=== 1c. J4's notices live in the arrival, not in the editor ===\n");
    // ====================================================================
    {
      // Sean, from production: the SEO notice was sitting at the foot of the
      // Storefront page. It is the same row, read the same way; only where it
      // is shown changed, and it must not be shown twice.
      await prisma.genesisObservation.create({
        data: {
          storeId: store.id,
          status: "ACTIVE",
          genesisState: "OPPORTUNITY",
          dedupeKey: `seo-${stamp}`,
          summary: "Your storefront has no SEO title or meta description yet.",
          actionHref: "/dashboard/website",
        },
      });

      await page.goto(`${server.baseUrl}/b/${store.slug}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
      const homeText = await page.locator("body").innerText();
      assert("J4's notice reaches the arrival experience",
        /no SEO title or meta description/.test(homeText), homeText.slice(0, 200));

      await page.goto(`${server.baseUrl}/b/${store.slug}/website`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("domcontentloaded");
      const siteText = await page.locator("body").innerText();
      assert("and is NOT duplicated at the foot of the Storefront editor",
        !/no SEO title or meta description/.test(siteText), siteText.slice(-260));
      assert("the Storefront editor no longer has a Genesis noticed section",
        !/Genesis noticed/.test(siteText), siteText.slice(-260));

      await page.goto(`${server.baseUrl}/b/${store.slug}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    }

    // ====================================================================
    console.log("\n=== 2. The map is the first thing under it, and is really drawn ===\n");
    // ====================================================================
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    const map = page.locator('[data-screen="business-map"]');
    const mapBox = await map.boundingBox();
    assert("the map is on the page", mapBox !== null);
    assert("and inside the viewport horizontally",
      !!mapBox && mapBox.x >= 0 && mapBox.x + mapBox.width <= 1280,
      `x=${mapBox?.x} w=${mapBox?.width}`);
    assert("it starts within the first screen, not below the fold",
      !!mapBox && mapBox.y < 900, `y=${mapBox?.y}`);

    // THE LANDING SCREEN AS AN OWNER MEETS IT — captured before this suite
    // opens anything. The end-of-run screenshot shows a scrolled page with the
    // connections panel expanded, which is evidence of the test rather than of
    // the experience.
    await page.screenshot({ path: `${SHOTS}/business-map-desktop-firstscreen.png`, fullPage: false });

    const welcome = (await page.locator("h1").first().innerText()).trim();
    assert("the greeting names the owner", /Welcome back, Sean/.test(welcome), welcome);

    // Nine branches, all of them, including the empty ones.
    const branches = await page.evaluate(() => {
      const labels = ["Business", "Commerce", "Customers", "Financials", "Goals",
        "Social", "Connections", "Creation", "Learned"];
      const texts = Array.from(document.querySelectorAll('[data-screen="business-map"] svg text'))
        .map((t) => t.textContent?.trim() ?? "");
      return labels.filter((l) => texts.includes(l));
    });
    assert("all nine branches are drawn", branches.length === 9, JSON.stringify(branches));

    const j4 = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-screen="business-map"] svg text'))
        .some((t) => t.textContent?.trim() === "J4"));
    assert("J4 is at the centre", j4);

    // THE MAP MUST NOT SWALLOW THE SCREEN. It is the front door, not the
    // whole house.
    const stage = await page.locator('[data-screen="business-map"] .map-stage').boundingBox();
    assert("the drawing is bounded, not full-height",
      !!stage && stage.height <= 520, `height=${stage?.height}`);

    // ====================================================================
    console.log("\n=== 3. Empty branches say so rather than disappearing ===\n");
    // ====================================================================
    const emptyLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-screen="business-map"] svg text'))
        .filter((t) => t.textContent?.trim() === "not known yet").length);
    assert("branches with nothing behind them still render, saying so",
      emptyLabels >= 3, `${emptyLabels} branches marked not known yet`);

    // ====================================================================
    console.log("\n=== 4. Tapping a branch opens what sits behind it ===\n");
    // ====================================================================
    // THE MAP RESPONDS, and the information arrives in a bubble anchored to
    // the selection rather than a panel below the diagram.
    await page.getByRole("button", { name: /^Commerce:/ }).click();
    await page.waitForSelector('[data-testid="map-card"]', { timeout: 10_000 });
    const commerceCard = await page.locator('[data-testid="map-card"]').innerText();
    assert("the Commerce branch opens a contextual card", commerceCard.includes("Commerce"),
      commerceCard.slice(0, 200));

    // Its children are now ON THE MAP, not in a list underneath.
    const commerceChildren = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-screen="business-map"] svg g.node-in[role="button"] text'))
        .map((el) => el.textContent?.trim()));
    assert("and the real product appears as a node on the map",
      commerceChildren.some((l) => (l ?? "").startsWith("Copper Tensor")),
      JSON.stringify(commerceChildren));

    // An empty branch focuses too, and is honest about being empty.
    await page.getByRole("button", { name: /^Goals:/ }).click();
    await page.waitForSelector('[data-testid="map-card"]', { timeout: 10_000 });
    const goalsCard = await page.locator('[data-testid="map-card"]').innerText();
    assert("an empty branch says it is not yet known rather than showing a zero",
      /Not yet known/i.test(goalsCard), goalsCard.slice(0, 200));
    assert("and names what would fill it, in the owner's terms",
      /working towards/i.test(goalsCard), goalsCard.slice(0, 200));

    // A domain with a real screen behind it offers the way in; one without
    // offers nothing rather than a link to somewhere approximate.
    await page.getByRole("button", { name: /^Commerce:/ }).click();
    await page.waitForSelector('[data-testid="map-view-link"]', { timeout: 10_000 });
    const commerceView = await page.locator('[data-testid="map-view-link"]').first().innerText();
    assert("Commerce offers a way into the full screen", /View Commerce/.test(commerceView), commerceView);
    await page.getByRole("button", { name: /^Goals:/ }).click();
    await page.waitForTimeout(200);
    assert("Goals offers none, because no Goals screen exists",
      (await page.locator('[data-testid="map-view-link"]').count()) === 0);
    await page.getByRole("button", { name: /^Goals:/ }).click();
    await page.waitForTimeout(200);

    // ====================================================================
    console.log("\n=== 5. Zoom controls actually move the drawing ===\n");
    // ====================================================================
    // ZOOM IS THE NAVIGATION NOW, not a pair of viewer buttons beside it.
    // Selecting a branch moves the world; "Whole business" brings it back.
    await page.getByRole("button", { name: "Whole business" }).click();
    await page.waitForTimeout(300);
    const atWhole = await page.locator('[data-testid="map-world"]').getAttribute("transform");
    await page.getByRole("button", { name: /^Customers:/ }).click();
    await page.waitForTimeout(350);
    const atCustomers = await page.locator('[data-testid="map-world"]').getAttribute("transform");
    assert("selecting a branch moves the world", atWhole !== atCustomers,
      `${atWhole} vs ${atCustomers}`);
    await page.getByRole("button", { name: "Whole business" }).click();
    await page.waitForTimeout(350);
    assert("and stepping all the way out restores it",
      (await page.locator('[data-testid="map-world"]').getAttribute("transform")) === atWhole);

    // ====================================================================
    console.log("\n=== 6. The original overview is still underneath ===\n");
    // ====================================================================
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("the revenue/orders snapshot survived", /order/i.test(body) && /storefront/i.test(body));
    assert("J4 Noticed survived", /J4 Noticed|Nothing needs you right now/.test(body), body.slice(0, 200));
    assert("and the map is introduced as sitting above it",
      /What's happening right now|What&apos;s happening right now/.test(body));

    const mapY = (await map.boundingBox())?.y ?? 0;
    const overviewY = (await page.locator("text=/What's happening right now/").boundingBox())?.y ?? 0;
    assert("the map is ABOVE the overview, not instead of it",
      overviewY > mapY, `map y=${mapY}, overview y=${overviewY}`);

    // ====================================================================
    console.log("\n=== 7. Connections explain themselves without inventing capability ===\n");
    // ====================================================================
    await page.getByText(/What could J4 know next/).click();
    await page.waitForSelector("text=/Would let J4 understand/", { timeout: 10_000 });
    // THE RIGHT <details>. The first version selected `.last()` of a combined
    // selector and read J4NoticedDisclosure's own disclosure instead, whose
    // text is the single word "Details" — three assertions failed on the wrong
    // element rather than on the thing under test.
    const services = await page
      .locator("details", { has: page.getByText(/What could J4 know next/) })
      .first()
      .innerText();
    assert("services are listed", /Instagram|Printful|QuickBooks/.test(services), services.slice(0, 200));
    assert("each says which branch it would feed",
      /Would let J4 understand your (Social|Financials|Commerce|Customers)/.test(services),
      services.slice(0, 400));
    assert("an unbuilt connector is not offered as connectable",
      /Not something Genesis can connect yet/.test(services), services.slice(0, 400));
    for (const invented of ["followers", "engagement", "impressions", "post history"]) {
      assert(`nothing promises ${invented}`, !new RegExp(invented, "i").test(services));
    }
    assert("and the data ownership is stated plainly",
      /This is your business data/.test(await map.innerText()));

    // ---- Connect or Create ---------------------------------------------
    //
    // Sean: "Have an account? -> Connect. Don't have one? -> Create." Both
    // doors, and the Create door only where a destination was verified.
    const panel = page.locator("details", { has: page.getByText(/What could J4 know next/) }).first();
    assert("every offerable service has a Connect door",
      (await panel.getByRole("link", { name: "Connect" }).count()) > 0);
    assert("and a Create door where we verified a signup page",
      (await panel.getByRole("link", { name: "Create" }).count()) > 0);

    // The Create link must leave for the provider's own site, in a new tab,
    // and never point back into Genesis.
    const createHref = await panel.getByRole("link", { name: "Create" }).first().getAttribute("href");
    assert("Create goes to the provider, not to us",
      !!createHref && createHref.startsWith("https://") && !createHref.includes("localhost"),
      String(createHref));
    assert("and opens in a new tab so Genesis is not lost",
      (await panel.getByRole("link", { name: "Create" }).first().getAttribute("target")) === "_blank");

    // Connect stays inside this business.
    const connectHref = await panel.getByRole("link", { name: "Connect" }).first().getAttribute("href");
    assert("Connect stays in this business",
      !!connectHref && connectHref.includes(`/b/${store.slug}/connections`), String(connectHref));

    // AND THE HONEST GAP IS SHOWN AS A GAP. QuickBooks and Facebook have no
    // verified signup destination, so they must say so rather than link
    // somewhere plausible.
    assert("a service with no verified signup link says so",
      /No signup link we could verify/.test(services), services.slice(0, 600));

    // Connected services offer neither door — they are done.
    assert("a connected service reads as connected",
      /✓ Connected/.test(services) || !/Stripe/.test(services), services.slice(0, 200));

    await page.screenshot({ path: `${SHOTS}/business-map-desktop.png`, fullPage: false });

    // ====================================================================
    console.log("\n=== 8. On a 390px phone it is visible, bounded and usable ===\n");
    // ====================================================================
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: await context.storageState(),
    });
    const small = await phone.newPage();
    await small.goto(home, { waitUntil: "domcontentloaded" });
    await small.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    // APPEAR, THEN GO. Waiting only for absence is trivially true before the
    // ritual mounts, so it returned instantly, the overlay then played, and
    // every geometry reading below was taken through it — `.map-stage`
    // measured null and the centre of the map was "covered by DIV". Exactly
    // the race already fixed once in verify-identity-split-browser.
    await small.waitForFunction(overlayUp, undefined, { timeout: 8_000 }).catch(() => {});
    await small.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("div")).some((el) => {
          const s = getComputedStyle(el);
          return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
        }),
      undefined,
      { timeout: 30_000 },
    ).catch(() => {});
    await small.waitForSelector('[data-screen="business-map"] .map-stage', { timeout: 15_000 });

    const smallMap = small.locator('[data-screen="business-map"]');
    const smallBox = await smallMap.boundingBox();
    assert("the map is inside the 390px viewport",
      !!smallBox && smallBox.x >= 0 && smallBox.x + smallBox.width <= 390,
      `x=${smallBox?.x} w=${smallBox?.width}`);

    const smallStage = await small.locator('[data-screen="business-map"] .map-stage').boundingBox();
    assert("and the drawing does not fill the phone screen",
      !!smallStage && smallStage.height <= 360, `height=${smallStage?.height}`);
    assert("leaving room for the overview beneath it",
      !!smallStage && smallStage.height < 844 * 0.55, `height=${smallStage?.height} of 844`);

    // ============ NOTHING IS CLIPPED =============================
    //
    // The assertion the first phone screenshot needed and did not have. Every
    // geometry check passed while "Connections" rendered as "onnections" and
    // "Customers" as "Custome", because containment of the MAP says nothing
    // about containment of the TEXT INSIDE it. Each label is measured against
    // the drawing's own box.
    const clipped = await small.evaluate(() => {
      const stage = document.querySelector('[data-screen="business-map"] .map-stage');
      if (!stage) return ["no stage"];
      const box = stage.getBoundingClientRect();
      return Array.from(stage.querySelectorAll("svg text"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0) return false;
          return r.left < box.left - 0.5 || r.right > box.right + 0.5;
        })
        .map((el) => `${el.textContent} (${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)} vs ${Math.round(box.left)}..${Math.round(box.right)})`);
    });
    assert("no branch label is cut off at 390px", clipped.length === 0, JSON.stringify(clipped));

    // NOTHING PAINTED OVER IT — the failure mode this project has hit twice.
    const covered = await small.evaluate(() => {
      const el = document.querySelector('[data-screen="business-map"] .map-stage');
      if (!el) return "missing";
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el.contains(top) || top?.contains(el) ? "clear" : (top?.tagName ?? "unknown");
    });
    assert("with nothing covering the map", covered === "clear", `covered by ${covered}`);

    // Interactable on touch.
    await small.getByRole("button", { name: /^Commerce:/ }).click();
    await small.waitForSelector('[data-testid="map-card"]', { timeout: 10_000 });
    assert("a branch opens on the phone",
      (await small.locator('[data-testid="map-card"]').count()) === 1);
    // Back to the whole map before the next section starts from a clean state.
    await small.locator('[data-testid="map-card-close"]').click();
    await small.waitForTimeout(200);

    const overviewOnPhone = await small.locator("text=/What's happening right now/").boundingBox();
    assert("and the overview is still reachable below",
      overviewOnPhone !== null && overviewOnPhone.y > (smallBox?.y ?? 0),
      JSON.stringify(overviewOnPhone));

    // ====================================================================
    console.log("\n=== 8b. Selection changes the MAP, not a panel underneath ===\n");
    // ====================================================================
    //
    // Sean's ten mobile requirements. Every one is a geometry or an interaction
    // question, which is why they live in this lane and nowhere else.
    {
      // (4) tapping a branch changes the state of the DRAWING
      const before = await small.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg line'))
          .map((l) => l.getAttribute("stroke-width")).join(","));
      await small.getByRole("button", { name: /^Connections:/ }).click();
      await small.waitForSelector('[data-testid="map-card"]', { timeout: 10_000 });
      const after = await small.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg line'))
          .map((l) => l.getAttribute("stroke-width")).join(","));
      assert("tapping a branch changes the drawing itself", before !== after,
        `${before.slice(0, 50)} vs ${after.slice(0, 50)}`);

      const dimmed = await small.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg g[role="button"]'))
          .filter((g) => Number(g.getAttribute("opacity") ?? "1") < 0.5).length);
      assert("and the other branches recede", dimmed >= 5, `${dimmed} dimmed`);

      // (5) children appear on the map and reveal contextual information
      const childCount = await small.evaluate(() =>
        document.querySelectorAll('[data-screen="business-map"] svg g[data-level="branch"]').length);
      assert("children of the focused branch appear on the map", childCount > 0, `${childCount}`);

      await small.locator('[data-screen="business-map"] svg g[data-level="branch"]').first().click();
      await small.waitForTimeout(250);
      const cardText = await small.locator('[data-testid="map-card"]').innerText();
      assert("tapping a child reveals what J4 knows about it", cardText.length > 12, cardText.slice(0, 120));
      // CASE-INSENSITIVE, because innerText applies text-transform. The state
      // line is `uppercase` in CSS, so the DOM says "Not connected" and
      // innerText says "NOT CONNECTED" -- the first version of this assertion
      // failed on a card that was entirely correct.
      assert("and an unconnected service says so rather than claiming data",
        /not connected|connected|cannot connect/i.test(cardText), JSON.stringify(cardText));

      // (6) readable, and not covering the map
      const stageBox = await small.locator('[data-screen="business-map"] .map-stage').boundingBox();
      const cardBox = await small.locator('[data-testid="map-card"]').boundingBox();
      assert("the card sits inside the stage",
        !!cardBox && !!stageBox && cardBox.x >= stageBox.x - 1 &&
        cardBox.x + cardBox.width <= stageBox.x + stageBox.width + 1,
        JSON.stringify({ cardBox, stageBox }));
      const coverage = (cardBox!.width * cardBox!.height) / (stageBox!.width * stageBox!.height);
      assert("and covers well under half the drawing", coverage < 0.45, `${(coverage * 100).toFixed(0)}%`);
      assert("the J4 hub is never behind it", await small.evaluate(() => {
        const cardEl = document.querySelector('[data-testid="map-card"]');
        const hubEl = Array.from(document.querySelectorAll('[data-screen="business-map"] svg text'))
          .find((el) => el.textContent?.trim() === "J4");
        if (!cardEl || !hubEl) return false;
        const card = cardEl.getBoundingClientRect();
        const hub = hubEl.getBoundingClientRect();
        return card.right < hub.left || card.left > hub.right || card.bottom < hub.top || card.top > hub.bottom;
      }), "the card overlaps J4");

      // (8, first half) closing steps back to the branch
      await small.locator('[data-testid="map-card-close"]').click();
      await small.waitForTimeout(200);
      const stillFocused = await small.evaluate(() =>
        document.querySelectorAll('[data-screen="business-map"] svg g[data-level="branch"]').length);
      assert("closing the child card keeps the branch open", stillFocused > 0, `${stillFocused}`);

      // (7) a deeper View action reaches a real screen.
      //
      // Read from the DOMAIN card. A service card deliberately does not carry
      // one: its Connect button already goes where View Connections would, and
      // the duplicate wrapped the bubble onto an extra line until it reached
      // the hub.
      const viewHref = await small.locator('[data-testid="map-view-link"]').first().getAttribute("href");
      assert("the branch offers a way into its full screen",
        !!viewHref && viewHref.includes(`/b/${store.slug}/`), String(viewHref));
      const probe = await small.request.get(`${server.baseUrl}${viewHref}`);
      assert("and that screen really exists", probe.status() === 200, `status ${probe.status()}`);
      await small.locator('[data-testid="map-card-close"]').click();
      await small.waitForTimeout(200);
      assert("closing again returns to the whole map",
        (await small.locator('[data-testid="map-card"]').count()) === 0);
      const restored = await small.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg g[role="button"]'))
          .filter((g) => Number(g.getAttribute("opacity") ?? "1") < 0.5).length);
      assert("with every branch back at full strength", restored === 0, `${restored} still dimmed`);

      // EVERY ROOM SURVIVES THE BAR. Adding Business as a room pushed Account
      // straight out of it, and only a screenshot showed that. The bar is
      // counted and measured now.
      const bar = await small.evaluate(() => {
        const links = Array.from(document.querySelectorAll("nav a, nav button"));
        const seen = links
          .map((el) => (el.textContent ?? "").trim())
          .filter((s) => s.length > 0 && s.length < 20);
        return { labels: seen, width: window.innerWidth };
      });
      for (const room of ["Business", "Storefront", "Studio", "Commerce", "Account"]) {
        assert(`${room} is still in the mobile bar`,
          bar.labels.some((l) => l.includes(room)), JSON.stringify(bar.labels));
      }
      const offscreen = await small.evaluate(() =>
        Array.from(document.querySelectorAll("nav a, nav button"))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && (r.left < -1 || r.right > window.innerWidth + 1)).length);
      assert("and no nav item is pushed off the side at 390px", offscreen === 0, `${offscreen} offscreen`);

      // (9) no horizontal overflow
      const overflow = await small.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        win: window.innerWidth,
      }));
      assert("the page does not scroll sideways at 390px",
        overflow.doc <= overflow.win + 1, JSON.stringify(overflow));
    }

    // ====================================================================
    console.log("\n=== 8d. Every action fits the provider's actual state ===\n");
    // ====================================================================
    //
    // Sean, before deployment: "don't offer an action that doesn't make sense
    // for the current provider state."
    //
    // Four states, and each has exactly one sensible set of controls. This
    // walks every service the Connections branch offers and checks the card it
    // produces, rather than checking the one service that happens to be first.
    {
      // THE STICKY HEADER IS REAL AND SO IS THIS. On a phone the shell's
      // header is fixed to the top, and a node scrolled under it cannot be
      // tapped -- by this suite or by an owner. The map is brought fully into
      // view first, which is what a person does before tapping anything.
      await small.locator('[data-screen="business-map"] .map-stage').scrollIntoViewIfNeeded();
      await small.waitForTimeout(200);
      await small.getByRole("button", { name: /^Connections:/ }).click();
      await small.waitForSelector('[data-testid="map-card"]', { timeout: 10_000 });

      // BRANCHES ONLY. `.node-in[role=button]` matches leaves too now, and
      // selecting a branch reveals leaves that join the selector -- so the
      // loop's indices drifted onto nodes it had never meant to click.
      const nodes = small.locator('[data-screen="business-map"] svg g[data-level="branch"]');
      const count = await nodes.count();
      assert("the Connections branch offers services to inspect", count > 0, `${count}`);

      let checked = 0;
      let sawConnected = false;
      let sawConnectable = false;
      for (let i = 0; i < count; i++) {
        await nodes.nth(i).click();
        await small.waitForTimeout(220);
        const card = small.locator('[data-testid="map-card"]');
        const text = (await card.innerText()).replace(/\s+/g, " ");
        const connect = await card.getByRole("link", { name: "Connect" }).count();
        const create = await card.getByRole("link", { name: "Create" }).count();
        const view = await card.locator('[data-testid="map-view-link"]').count();

        if (/connected/i.test(text) && !/not connected/i.test(text)) {
          // CONNECTED: nothing to connect, nothing to create.
          sawConnected = true;
          assert(`a connected service offers no Connect (${text.slice(0, 24)})`, connect === 0, text.slice(0, 90));
          assert(`nor Create (${text.slice(0, 24)})`, create === 0, text.slice(0, 90));
          assert(`but does offer somewhere to manage it (${text.slice(0, 24)})`, view === 1, text.slice(0, 90));
        } else if (/cannot connect/i.test(text)) {
          // COMING SOON: no Connect and no Create -- creating an account
          // Genesis cannot connect afterwards is the homework being removed.
          assert(`an unbuildable connector offers no Connect (${text.slice(0, 24)})`, connect === 0, text.slice(0, 90));
          assert(`and no Create (${text.slice(0, 24)})`, create === 0, text.slice(0, 90));
        } else {
          // CONNECTABLE, NOT CONNECTED: Connect always; Create only where a
          // signup destination was actually verified.
          sawConnectable = true;
          assert(`a connectable service offers Connect (${text.slice(0, 24)})`, connect === 1, text.slice(0, 90));
          assert(`and either Create or an honest gap (${text.slice(0, 24)})`,
            create === 1 || /no signup link we could verify/i.test(text), text.slice(0, 120));
          assert(`and never both a Create and a missing-link note (${text.slice(0, 24)})`,
            !(create === 1 && /no signup link we could verify/i.test(text)), text.slice(0, 120));
        }
        checked++;
        // Back to the branch level, so the next index means what it meant.
        if (await small.locator('[data-testid="map-back"]').isEnabled()) {
          const trail = await small.locator('[data-screen="business-map"]').innerText();
          if (/›[^›]*›/.test(trail)) {
            await small.locator('[data-testid="map-back"]').click();
            await small.waitForTimeout(200);
          }
        }
      }
      assert("every offered service was checked", checked === count, `${checked}/${count}`);
      assert("including at least one already connected", sawConnected);
      assert("and at least one still to connect", sawConnectable);

      // AND THE BRANCH COUNT MATCHES WHAT TAPPING SHOWS. The count said three
      // connected systems while the children were built from a catalogue that
      // contains neither payment rail, so the branch said three and showed one.
      const branchCount = await small.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('[data-screen="business-map"] svg g[role="button"]'));
        const g = labels.find((el) => (el.getAttribute("aria-label") ?? "").startsWith("Connections:"));
        const texts = Array.from(g?.querySelectorAll("text") ?? []).map((n) => n.textContent?.trim());
        return texts[1] ?? "";
      });
      // A branch's own state line is the label now: "Connected" for something
      // that is, "Not connected" for something that is not.
      const connectedOnMap = await small.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg g.node-in[role="button"]'))
          .map((g) => g.getAttribute("aria-label") ?? "")
          .filter((l) => /,\s*Connected$/.test(l)).length);
      assert("every connected system the branch counts is reachable on it",
        Number(branchCount) <= connectedOnMap || Number.isNaN(Number(branchCount)),
        `branch says ${branchCount}, children show ${connectedOnMap} connected`);

      // IDEMPOTENT RESET. The loop already steps back after each service, so
      // closing a card twice here waited on one that was not open.
      await small.getByRole("button", { name: "Whole business" }).click();
      await small.waitForTimeout(250);
    }

    // ====================================================================
    console.log("\n=== 8e. Going inside the business, one level at a time ===\n");
    // ====================================================================
    //
    // Sean: "Zoomed out: J4 + the whole business. One level in: J4 + one
    // business domain. Another level in: entities within that domain... The map
    // should feel like the user is exploring their business from the inside."
    //
    // So the test is that the WORLD TRANSFORM changes at each level, and that
    // stepping back restores it. A focus state that only dimmed things would
    // pass a "did something change" check and fail this one.
    {
      await small.locator('[data-screen="business-map"] .map-stage').scrollIntoViewIfNeeded();
      await small.waitForTimeout(200);

      const worldAt = () =>
        small.locator('[data-testid="map-world"]').getAttribute("transform");

      const atRoot = await worldAt();
      assert("the map starts on the whole business", (await small.locator('[data-testid="map-card"]').count()) === 0);

      // level 1 — one domain
      await small.getByRole("button", { name: /^Commerce:/ }).click();
      await small.waitForSelector('[data-testid="map-card"]', { timeout: 10_000 });
      const atDomain = await worldAt();
      assert("selecting a domain zooms the map toward it", atDomain !== atRoot,
        `${atRoot} vs ${atDomain}`);
      assert("and the trail says where you are",
        /J4[\s\S]*Commerce/.test(await small.locator('[data-screen="business-map"]').innerText()));

      // level 2 — the middle layer, grouped
      const branches = small.locator('[data-screen="business-map"] svg g.node-in[role="button"]');
      assert("the domain reveals a middle layer", (await branches.count()) > 0);
      const firstBranchLabel = (await branches.first().getAttribute("aria-label")) ?? "";
      await branches.first().click();
      await small.waitForTimeout(300);
      const atBranch = await worldAt();
      assert("selecting a branch zooms in again", atBranch !== atDomain, `${atDomain} vs ${atBranch}`);
      assert("and the card describes it",
        (await small.locator('[data-testid="map-card"]').innerText()).length > 5, firstBranchLabel);

      // level 3 — individual things, when the branch is a group
      const leaves = await small.evaluate(() =>
        document.querySelectorAll('[data-screen="business-map"] svg g.node-in[role="button"]').length);
      assert("a group reveals the things inside it", leaves > 0, `${leaves}`);

      // BACK STEPS OUT ONE LEVEL AT A TIME, and returns the view.
      await small.locator('[data-testid="map-back"]').click();
      await small.waitForTimeout(300);
      assert("Back steps out one level", (await worldAt()) === atDomain,
        `${await worldAt()} vs ${atDomain}`);
      await small.locator('[data-testid="map-back"]').click();
      await small.waitForTimeout(350);
      assert("and again returns to the whole business", (await worldAt()) === atRoot,
        `${await worldAt()} vs ${atRoot}`);
      assert("with no card left open", (await small.locator('[data-testid="map-card"]').count()) === 0);
    }

    // ====================================================================
    console.log("\n=== 8f. Social shows the platforms, and claims nothing ===\n");
    // ====================================================================
    {
      await small.getByRole("button", { name: /^Social:/ }).click();
      await small.waitForSelector('[data-testid="map-card"]', { timeout: 10_000 });

      const labels = await small.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg g.node-in[role="button"]'))
          .map((g) => (g.getAttribute("aria-label") ?? "").split(",")[0]));
      for (const platform of ["Instagram", "Facebook", "TikTok", "X"]) {
        assert(`${platform} appears under Social`, labels.includes(platform), JSON.stringify(labels));
      }

      // X has no connector at all, and says so rather than offering Connect.
      const xNode = small.locator('[data-screen="business-map"] svg g.node-in[role="button"]')
        .filter({ has: small.locator('text="X"') }).first();
      await xNode.click();
      await small.waitForTimeout(250);
      const xCard = await small.locator('[data-testid="map-card"]').innerText();
      assert("X says Genesis cannot connect it", /cannot connect/i.test(xCard), xCard.slice(0, 140));
      assert("and offers no Connect button",
        (await small.locator('[data-testid="map-card"]').getByRole("link", { name: "Connect" }).count()) === 0);

      // AND NOTHING UNDER AN UNCONNECTED PLATFORM. No Content, no Engagement,
      // no Traffic -- those appear when rows exist and not before.
      const under = await small.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg text'))
          .map((n) => n.textContent?.trim() ?? ""));
      for (const invented of ["Content", "Engagement", "Traffic", "Followers"]) {
        assert(`the map never draws ${invented} for an unconnected account`,
          !under.includes(invented), JSON.stringify(under.filter((u) => u === invented)));
      }

      await small.locator('[data-testid="map-back"]').click();
      await small.waitForTimeout(200);
      await small.locator('[data-testid="map-back"]').click();
      await small.waitForTimeout(200);
    }

    // ====================================================================
    console.log("\n=== 8c. Reduced motion still gives a useful map ===\n");
    // ====================================================================
    {
      const still = await browser.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        storageState: await context.storageState(),
        reducedMotion: "reduce",
      });
      const p2 = await still.newPage();
      await p2.goto(home, { waitUntil: "domcontentloaded" });
      await p2.waitForSelector('[data-screen="business-map"] .map-stage', { timeout: 30_000 });
      await p2.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll("div")).some((el) => {
            const s = getComputedStyle(el);
            return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
          }),
        undefined,
        { timeout: 30_000 },
      ).catch(() => {});

      // NOT DEGRADED. Same nine branches, same interaction, no motion.
      const labels = await p2.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg text'))
          .map((el) => el.textContent?.trim()).filter(Boolean).length);
      assert("the map still renders with motion reduced", labels > 10, `${labels} labels`);
      await p2.getByRole("button", { name: /^Commerce:/ }).click();
      await p2.waitForSelector('[data-testid="map-card"]', { timeout: 10_000 });
      assert("and is still explorable", (await p2.locator('[data-testid="map-card"]').count()) === 1);

      // The backdrop is present and HOLDS STILL: two frames apart must match.
      // THE CANVAS ITSELF, read out of its own backing store. An element
      // screenshot captures whatever is painted OVER that region too -- the
      // map, the card, the shell -- so it compares the composite rather than
      // the thing under test. toDataURL asks the canvas what it is holding.
      await p2.waitForTimeout(600);
      const frame = () =>
        p2.evaluate(() =>
          (document.querySelector('[data-testid="map-data-stream"]') as HTMLCanvasElement).toDataURL());
      const a = await frame();
      await p2.waitForTimeout(700);
      const b = await frame();
      assert("the data stream does not animate when motion is reduced", a === b,
        "the canvas redrew itself between frames");
      assert("and it is drawing something rather than sitting blank",
        a.length > 5000, `${a.length} bytes of image data`);

      await p2.screenshot({ path: `${SHOTS}/business-map-reduced-motion.png`, fullPage: false });
      await still.close();
    }

    await small.screenshot({ path: `${SHOTS}/business-map-mobile.png`, fullPage: true });
    await small.screenshot({ path: `${SHOTS}/business-map-mobile-firstscreen.png`, fullPage: false });

    // ====================================================================
    console.log("\n=== 9. Website and Identity are still there and still work ===\n");
    // ====================================================================
    for (const [path, marker] of [
      [`/b/${store.slug}/website`, /Storefront|Website/i],
      [`/b/${store.slug}/brand`, /Business identity/i],
    ] as const) {
      const res = await page.goto(`${server.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      assert(`${path} still loads`, (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      const text = await page.locator("body").innerText();
      assert(`${path} renders its own screen`, marker.test(text), text.slice(0, 160));
    }

    // Identity's three fields are still editable, and still only here.
    await page.goto(`${server.baseUrl}/b/${store.slug}/brand`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="name"]', { timeout: 30_000 });
    for (const field of ["name", "tagline"]) {
      assert(`Identity still edits ${field}`,
        (await page.locator(`input[name="${field}"]`).count()) === 1);
    }
    assert("and description too", (await page.locator('textarea[name="description"]').count()) === 1);

    // NOT DUPLICATED ON HOME. Sean: "Do not duplicate those fields elsewhere."
    await page.goto(home, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    assert("the home screen does not offer a second business-name field",
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
