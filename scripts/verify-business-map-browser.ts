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
    await page.getByRole("button", { name: /^Commerce:/ }).click();
    await page.waitForSelector("text=/J4 → Commerce/", { timeout: 10_000 });
    const opened = await page.locator("text=/J4 → Commerce/").boundingBox();
    assert("the Commerce branch opens a real panel", opened !== null);
    const panelText = await page.locator('[data-screen="business-map"]').innerText();
    assert("and it names the actual product",
      panelText.includes("Copper Tensor Ring Cuff"), panelText.slice(0, 300));

    // An empty branch opens too, and is honest about being empty.
    await page.getByRole("button", { name: /^Goals:/ }).click();
    await page.waitForSelector("text=/J4 → Goals/", { timeout: 10_000 });
    const goalsText = await page.locator('[data-screen="business-map"]').innerText();
    assert("an empty branch opens and explains itself rather than showing a zero",
      /Nothing here yet/.test(goalsText), goalsText.slice(0, 300));

    // ====================================================================
    console.log("\n=== 5. Zoom controls actually move the drawing ===\n");
    // ====================================================================
    const transformBefore = await page.evaluate(() =>
      document.querySelector('[data-screen="business-map"] svg g')?.getAttribute("transform") ?? "");
    await page.getByRole("button", { name: "Zoom in" }).click();
    const transformAfter = await page.evaluate(() =>
      document.querySelector('[data-screen="business-map"] svg g')?.getAttribute("transform") ?? "");
    assert("zooming changes the drawing", transformBefore !== transformAfter,
      `${transformBefore} vs ${transformAfter}`);

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
    await small.waitForSelector("text=/J4 → Commerce/", { timeout: 10_000 });
    assert("a branch opens on the phone", true);

    const overviewOnPhone = await small.locator("text=/What's happening right now/").boundingBox();
    assert("and the overview is still reachable below",
      overviewOnPhone !== null && overviewOnPhone.y > (smallBox?.y ?? 0),
      JSON.stringify(overviewOnPhone));

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
