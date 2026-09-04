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

    // ---- THE DOCK IS A PAIR --------------------------------------------
    //
    // J4 and the Office are two ways into the same partnership, so they sit
    // together and a divider separates them from the business destinations.
    // What matters behaviourally is that they are NOT two assistants: one
    // conversation, two presentations of the same overlay.
    // NESTING, NOT ADJACENCY. Two buttons side by side would satisfy any
    // check that only counted them, which is why this asserts CONTAINMENT
    // both ways: the Office is a descendant of J4's corner in the DOM, and
    // its box sits inside his. It is J4 -> Office, not J4 | Office.
    const pair = page.locator('[data-testid="j4-corner"]');
    console.log(`J4 owns a corner: ${(await pair.count()) > 0}`);
    const nested = await page.evaluate(() => {
      const corner = document.querySelector('[data-testid="j4-corner"]');
      const office = document.querySelector('[data-testid="j4-office"]');
      if (!corner || !office) return null;
      const c = corner.getBoundingClientRect();
      const o = office.getBoundingClientRect();
      return {
        inDom: corner.contains(office),
        inBox: o.left >= c.left - 1 && o.right <= c.right + 1 && o.top >= c.top - 1 && o.bottom <= c.bottom + 1,
        smaller: o.width * o.height < c.width * c.height * 0.36,
      };
    });
    console.log(`the Office door is inside his corner (DOM): ${nested?.inDom}`);
    console.log(`and inside it geometrically: ${nested?.inBox}`);
    console.log(`and subordinate in size: ${nested?.smaller}`);
    // CLAMPED TO THE VIEWPORT. The first version of this asked for 32px of
    // padding below a dock that already sits on the bottom edge, and
    // Playwright returned the part of the clip that existed - which was black.
    const box = await pair.boundingBox();
    const view = page.viewportSize();
    if (box && view) {
      const x = Math.max(0, box.x - 14);
      const y = Math.max(0, box.y - 18);
      await page.screenshot({
        path: `${SHOTS}/j4-dock-pair.png`,
        clip: {
          x,
          y,
          width: Math.min(view.width - x, box.width + 110),
          height: Math.min(view.height - y, box.height + 26),
        },
      });
      console.log(`dock pair captured at ${Math.round(box.width)}x${Math.round(box.height)} CSS px`);
    }

    // AND A TIGHT CROP OF THE PAIR ITSELF. A second browser context at
    // deviceScaleFactor 3 was tried first and photographed the arrival
    // overlay's black backdrop: the element existed, so it had a bounding box,
    // so the check reported a successful capture of nothing. An element
    // screenshot in the context that is already past arrival cannot do that.
    await pair.screenshot({ path: `${SHOTS}/j4-dock-pair-tight.png` }).catch(() => {});
    await page.locator('[data-testid="j4-open"]').screenshot({
      path: `${SHOTS}/j4-character-actual-size.png`,
    }).catch(() => {});
    console.log("character captured at its real rendered size");
    // THE OFFICE OPENS THE OFFICE, unchanged and still full-screen.
    await page.locator('[data-testid="j4-office"]').click();
    await page.waitForTimeout(1_200);
    const asOffice = page.locator('[data-j4-presentation="office"]');
    console.log(`the Office square opens the Office: ${(await asOffice.count()) > 0}`);
    console.log(`and it is still the full-screen one: ${(await asOffice.getAttribute("aria-modal")) === "true"}`);
    await page.screenshot({ path: `${SHOTS}/j4-office-from-dock.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);

    // ---- ONE J4, AND THE OLD ONE IS ACTUALLY GONE ----------------------
    //
    // Removing a component is easy to believe and easy to get wrong: the orb
    // lived in four places, and only two of them represented J4. This asserts
    // the outcome rather than the edit - no J4 representation anywhere on the
    // main workspace except the corner.
    const j4s = await page.evaluate(() => {
      const corner = document.querySelectorAll('[data-testid="j4-corner"]').length;
      // The old orb draws itself into a canvas inside .map-orb or the summon.
      const centre = document.querySelector('[data-testid="map-centre"]');
      const centreHasCanvas = !!centre?.querySelector("canvas, img");
      return { corner, centreHasCanvas };
    });
    console.log(`J4 corners on the page: ${j4s.corner}`);
    console.log(`the map centre is no longer an avatar: ${!j4s.centreHasCanvas}`);
    console.log(`talk control lives in his corner: ${(await page.locator('[data-testid="j4-talk-toggle"]').count()) > 0}`);

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
    // ---- THE MAP CAN STILL BE FOCUSED WHILE HE IS OPEN -----------------
    //
    // J4 asking the map to focus something is driven by a streamed model
    // event (J4Workspace -> setJ4Focus -> BusinessMapCanvas), so the round
    // trip needs a real model and is production-only, exactly like the reply.
    // verify-j4-focus.ts already proves the store -> plan -> nodeIds path
    // headlessly.
    //
    // WHAT THE PANEL CHANGES is whether the owner can SEE it. In the Office a
    // focused card was highlighted behind a full-screen overlay - correct, and
    // invisible. So what is checked here is the precondition the panel exists
    // to create: the consumer is mounted and on screen at the same moment the
    // conversation is.
    const cards = await page.locator('[data-screen="business-map"] [data-entity-id], [data-screen="business-map"] [data-focused]').count();
    const anyCard = cards > 0
      ? cards
      : await page.locator('[data-screen="business-map"] button, [data-screen="business-map"] article').count();
    console.log(`map is live behind the open panel (focusable elements): ${anyCard}`);
    console.log(`nothing is focused yet, correctly: ${(await page.locator('[data-focused="true"]').count()) === 0}`);

    // ---- MINIMISE AND REOPEN KEEPS THE CONVERSATION --------------------
    const typed = await composer.inputValue().catch(() => "");
    console.log(`composer content before minimise: ${JSON.stringify(typed.slice(0, 40))}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    // NOT REMOVAL. J4Overlay keeps the conversation mounted on purpose - Talk
    // Mode sends a spoken turn through its composer without ever expanding it,
    // so unmounting would break voice, and the file says so. The intended
    // closed state is therefore hidden and non-interactive, not gone. The
    // first version of this check asserted removal and reported a failure that
    // was entirely my own.
    const closedPanel = page.locator('[data-j4-presentation="panel"]');
    console.log(`panel hidden after Escape: ${(await closedPanel.getAttribute("aria-hidden")) === "true"}`);
    console.log(`and the conversation is still mounted: ${(await page.locator('textarea').count()) > 0}`);
    await open.click();
    await page.waitForTimeout(900);
    const messages = await page.locator('[role="dialog"]').innerText().catch(() => "");
    console.log(`conversation survived reopen: ${messages.includes("selling best")}`);
    await page.screenshot({ path: `${SHOTS}/j4-panel-reopened.png` });

    // ---- ONE COMPOSER, NOT TWO -----------------------------------------
    const composers = await page.locator('textarea').count();
    console.log(`composers on the page: ${composers}`);

    // ---- DOES THE PANEL BLOCK NAVIGATION? ------------------------------
    //
    // LAST, deliberately. This one leaves the page, and /create-business
    // sits outside the dashboard layout, so the shell - dock, panel and all
    // - unmounts on arrival. Running it earlier left every later check
    // inspecting a page that no longer had a J4 on it.
    //
    // The first probe answered 'not clickable' and stopped, which is not an
    // answer. A link can be unclickable because something covers it, or
    // because the probe aimed at a link that was never on screen. Those need
    // different fixes, so the check has to tell them apart.
    //
    // hitTest reports, for each visible link, what actually sits at its centre
    // and how that element is related to the link. Playwright refuses a click
    // unless the hit is the link itself or something inside it - an ANCESTOR
    // means the link does not own its own centre point.
    const hitTest = async () =>
      page.evaluate(() => {
        const links = Array.from(document.querySelectorAll("a[href]"));
        return links
          .map((a) => {
            const r = a.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            const rel = !hit
              ? "nothing"
              : hit === a
                ? "self"
                : a.contains(hit)
                  ? "descendant"
                  : hit.contains(a)
                    ? "ancestor"
                    : "OTHER";
            const inPanel = hit?.closest('[data-j4-presentation="panel"]') ? " IN-PANEL" : "";
            return {
              text: (a.textContent || "").trim().slice(0, 20),
              href: a.getAttribute("href") || "",
              rel: rel + inPanel,
            };
          })
          .filter(Boolean)
          .slice(0, 6);
      });

    const openHits = await hitTest();
    for (const h of openHits as { text: string; href: string; rel: string }[]) {
      console.log(`  link ${JSON.stringify(h.text)} -> ${h.href} : ${h.rel}`);
    }
    console.log(`links intercepted BY THE PANEL: ${(openHits as { rel: string }[]).filter((h) => h.rel.includes("IN-PANEL")).length}`);

    // THE REAL CLICK. Aim at a link that owns its own centre, so a failure is
    // about reachability rather than about a link that is merely a flex child.
    const target = (openHits as { text: string; href: string; rel: string }[]).find(
      (h) => (h.rel === "self" || h.rel === "descendant") && h.href.startsWith("/"),
    );
    console.log(`clicking ${JSON.stringify(target?.text ?? "(none)")} -> ${target?.href ?? "-"}`);
    let navigated = false;
    if (target) {
      const before = page.url();
      try {
        // :visible, because the same href also exists in the mobile bar that
        // is md:hidden at this width. Resolving it without that filter picks
        // the offscreen twin and times out against a link nobody can see -
        // which is the whole reason this check reported a failure twice.
        await page.locator(`a[href="${target.href}"]:visible`).first().click({ timeout: 8_000 });
        // WAIT FOR THE DESTINATION, not for a fixed guess. This is a dev
        // server compiling the route on demand, so a couple of seconds is
        // sometimes not enough and the arrival looks like a refusal.
        await page.waitForURL((u) => u.pathname !== new URL(before).pathname, {
          timeout: 30_000,
        });
        navigated = page.url() !== before;
      } catch (error) {
        console.log(`  click threw: ${String(error).split("\n")[0].slice(0, 90)}`);
      }
    }
    console.log(`navigated while J4 was open: ${navigated} (now ${page.url().replace(server.baseUrl, "")})`);
    await page.screenshot({ path: `${SHOTS}/j4-panel-after-nav.png` });


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
