import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";

// SHOW J4, at a desktop width. NOT A SUITE - deliberately named outside the
// `verify-` prefix so suite discovery does not pick it up. It asserts nothing;
// it exists to produce screenshots of the real thing so the person who has to
// critique it can see it.
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/shoot-j4.ts" -OutFile out.txt

const PASSWORD = "harness-password-not-a-real-one";
const SHOTS = "verification-screenshots";

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

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser;

  try {
    const stamp = Date.now();
    const email = `j4shot-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Cubit & Coil",
        slug: `j4shot${stamp}`,
        tagline: "Hand-wound copper, true to the cubit",
        description: "Copper tensor rings, wound by hand.",
        published: true,
      },
    });
    for (const [i, name] of [
      "Sacred Cubit Copper Tensor Ring",
      "Copper Tensor Ring Cuff Bracelet",
      "177Hz Copper Tensor Ring Pyramid",
      "Copper Mug",
    ].entries()) {
      await prisma.product.create({
        data: { storeId: store.id, name, priceInCents: 2200 + i * 900, active: true, position: i },
      });
    }

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 60_000 });
    // WAIT FOR THE ARRIVAL EXPERIENCE TO CLEAR. It is a full-screen fixed
    // layer at z-100, and four seconds was not enough - the first attempt
    // photographed the overlay and concluded nothing was there.
    await page
      .waitForFunction(
        () =>
          !Array.from(document.querySelectorAll("div")).some((el) => {
            const st = getComputedStyle(el);
            return st.position === "fixed" && st.zIndex === "100" && parseFloat(st.opacity) > 0.01;
          }),
        undefined,
        { timeout: 45_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1_500);

    // AND REMOVE NEXT'S DEV OVERLAY, which lives in the bottom-left corner -
    // the same corner as J4 - so in `next dev` its badge sits directly on top
    // of him. Dev-only: a production build renders no such element.
    await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());

    const dock = page.locator('[data-testid="j4-dock"]');
    const count = await dock.count();
    console.log(`j4-dock present: ${count}`);
    if (count > 0) {
      const box = await dock.boundingBox();
      console.log(`j4-dock box: ${JSON.stringify(box)}`);
      const visible = await dock.isVisible();
      console.log(`j4-dock visible: ${visible}`);
    }

    await page.screenshot({ path: `${SHOTS}/j4-desktop-compact.png` });
    if (count > 0) {
      await dock.screenshot({ path: `${SHOTS}/j4-character-closeup.png` }).catch(() => {});
    }

    // ---- THE LOOP: click him, and the real conversation opens ----------
    //
    // Not a second chat. The dock asks the shell for the same surface the orb
    // opened, so this is checking an entry point, not an implementation.
    const open = page.locator('[data-testid="j4-open"]');
    console.log(`j4-open control: ${await open.count()}`);
    await open.click();
    await page.waitForTimeout(1_500);

    // A composer is the proof the conversation is really there.
    const composer = page
      .locator('[role="dialog"] textarea, [role="dialog"] input[type="text"]')
      .filter({ hasNot: page.locator('[type="email"]') })
      .last();
    const hasComposer = (await composer.count()) > 0;
    console.log(`composer after clicking J4: ${hasComposer}`);
    await page.screenshot({ path: `${SHOTS}/j4-loop-1-opened.png` });

    if (hasComposer) {
      // TYPING SHOULD SHOW AS LISTENING. The state comes from the activity
      // store the real composer already drives - the dock only reads it.
      await composer.click();
      await composer.type("What is selling best this month?", { delay: 25 });
      await page.waitForTimeout(400);
      const listening = await page
        .locator('[data-j4-state="listening"]')
        .count();
      console.log(`J4 shows listening while typing: ${listening > 0}`);
      await page.screenshot({ path: `${SHOTS}/j4-loop-2-listening.png` });

      // SEND, then look for thinking. No model key here, so the reply itself
      // may fail - the state transition is what this can honestly check.
      // THE SEND BUTTON, not Enter. The first attempt pressed Enter and
      // reported no thinking state - but the screenshot showed the message
      // still sitting in the composer, so nothing had been sent at all. The
      // composer's own send control is the arrow beside it.
      // SCOPED TO THE DIALOG. The first selector matched a button on the page
      // BEHIND the overlay, which the overlay then intercepted - the error
      // named it: role=dialog, aria-modal=true, aria-label="J4's Office".
      const dialog = page.locator('[role="dialog"]');
      const send = dialog.locator('form button').last();
      await send.click();
      await page.waitForTimeout(700);
      const thinking = await page.locator('[data-j4-state="thinking"]').count();
      console.log(`J4 shows thinking after send: ${thinking > 0}`);
      await page.screenshot({ path: `${SHOTS}/j4-loop-3-thinking.png` });

      await page.waitForTimeout(6_000);
      const stillThere = (await composer.count()) > 0;
      console.log(`conversation still open afterwards: ${stillThere}`);
      await page.screenshot({ path: `${SHOTS}/j4-loop-4-after.png` });
    }

    // ---- THE PANEL IS NOT A MODAL --------------------------------------
    const panel = page.locator('[data-j4-presentation="panel"]');
    console.log(`opened as a panel: ${(await panel.count()) > 0}`);
    console.log(`and not as a modal: ${(await panel.getAttribute("aria-modal")) === null}`);

    // The workspace has to still be there, and still be usable.
    const map = page.locator('[data-screen="business-map"]');
    console.log(`business map still visible: ${await map.isVisible()}`);
    console.log(`page not scroll-locked: ${await page.evaluate(() => document.body.style.overflow !== "hidden")}`);

    // A real navigation target, clicked while J4 is open.
    const navLink = page.locator('nav a, header a').first();
    const navName = (await navLink.textContent().catch(() => "")) || "(none)";
    let navClickable = false;
    try {
      await navLink.click({ trial: true, timeout: 4_000 });
      navClickable = true;
    } catch {
      navClickable = false;
    }
    console.log(`navigation still clickable while open (${navName.trim().slice(0, 24)}): ${navClickable}`);

    // ---- MINIMISE AND REOPEN KEEPS THE CONVERSATION --------------------
    const typed = await composer.inputValue().catch(() => "");
    console.log(`composer content before minimise: ${JSON.stringify(typed.slice(0, 40))}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    console.log(`panel closed: ${(await page.locator('[data-j4-presentation="panel"]').count()) === 0 || !(await page.locator('[data-j4-presentation="panel"]').isVisible())}`);
    await open.click();
    await page.waitForTimeout(900);
    const messages = await page.locator('[role="dialog"]').innerText().catch(() => "");
    console.log(`conversation survived reopen: ${messages.includes("selling best")}`);
    await page.screenshot({ path: `${SHOTS}/j4-panel-reopened.png` });

    // ---- ONE COMPOSER, NOT TWO -----------------------------------------
    const composers = await page.locator('textarea').count();
    console.log(`composers on the page: ${composers}`);

    // Expanded.
    const expand = page.locator('[data-testid="j4-expand"]');
    if (await expand.count()) {
      await expand.click();
      await page.waitForTimeout(600);
      console.log(`j4-expanded present: ${await page.locator('[data-testid="j4-expanded"]').count()}`);
      await page.screenshot({ path: `${SHOTS}/j4-desktop-expanded.png` });
    } else {
      console.log("expand control not found");
    }

    await context.close();
    console.log("screenshots written to " + SHOTS);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
