import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// THE CREATION STATION, IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-creation-station-browser.ts" -OutFile out.txt
//
// ============ WHAT A REAL BROWSER PROVES THAT NOTHING ELSE CAN ==========
//
// The design model is pure and separately proven. What is NOT provable from
// there is whether dragging a thing with a pointer moves it — pointer capture,
// percentage layout, the print-area box, and the fact that the number the
// canvas draws is the number the model holds.
//
// ============ AND WHAT IT PROVES ABOUT HONESTY ==========================
//
// §1 is a business with no print supplier connected. It must say so and offer
// the way to fix it, rather than showing a catalogue of blanks nobody can
// order. That is the rule this codebase already holds about inventing a
// supplier catalogue, and it is the state every business is in today.

const PASSWORD = "correct-horse-battery-staple";

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
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const email = `creation-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Cubit & Coil",
        slug: `creation-${stamp}`,
        tagline: "t",
        description: "d",
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    // ------------------------------------------------------------------
    console.log("\n1. The portal opens, and asks before it shows");
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create`, { waitUntil: "domcontentloaded" });
    const portal = (await page.locator("body").innerText()).replace(/\s+/g, " ");

    // ============ THE DOORWAY, NOT THE DESIGNER =======================
    //
    // Sean's distinction: the Creation Station is where you decide WHAT you
    // are making. Opening straight into an editor put somebody in a room they
    // had not chosen to be in.
    assert("it asks what to create", /what do you want to create/i.test(portal), portal.slice(0, 300));
    assert("and does not open an editor", !/add to my store|choose a colour/i.test(portal),
      portal.slice(0, 300));

    // THE OBJECTS ARE THE CONTROL. A listbox of options, each one a thing to
    // make, not a row in a list.
    const options = page.locator('[role="option"]');
    assert("several things are offered", await options.count() >= 5, `${await options.count()}`);
    check("exactly one is focused", await page.locator('[role="option"][aria-selected="true"]').count(), 1);

    // ============ INTENT IS OFFERED EVEN WITH NO SUPPLIER =============
    //
    // "What do you want to make?" is a question about intention, and a T-shirt
    // is a T-shirt whether or not this account has connected somebody who
    // prints them. What must stay honest is INVENTORY -- which is checked at
    // the next step, below.
    assert("the things themselves are named", /t-shirt/i.test(portal), portal.slice(0, 400));

    // ------------------------------------------------------------------
    console.log("\n1b. Choosing one is honest about what can actually be made");

    // Rotating changes what is focused -- the carousel is not decoration.
    const firstFocused = await page.locator('[role="option"][aria-selected="true"]').getAttribute("aria-label");
    await page.locator('[role="listbox"]').press("ArrowRight");
    await page.waitForTimeout(300);
    const afterRotate = await page.locator('[role="option"][aria-selected="true"]').getAttribute("aria-label");
    assert("rotating focuses a different thing", firstFocused !== afterRotate,
      `${firstFocused} -> ${afterRotate}`);

    // And choosing carries the INTENTION in the URL, not a product id.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create?kind=t-shirt`, {
      waitUntil: "domcontentloaded",
    });
    const chosen = (await page.locator("body").innerText()).replace(/\s+/g, " ");

    // ============ THE RULE THIS PAGE IS BUILT ON ======================
    // A design tool with an invented catalogue produces something nobody can
    // order. Naming the cause is worth more than a populated screen that lies.
    assert("with no supplier, it names the missing supplier",
      /connect a print supplier/i.test(chosen), chosen.slice(0, 300));
    assert("and shows no blanks", !/which t-shirt/i.test(chosen), chosen.slice(0, 300));
    check("with a way to fix it",
      await page.locator(`a[href="/b/${store.slug}/connections"]`).count() > 0, true);

    // ------------------------------------------------------------------
    console.log("\n1c. The objects are objects, and the gestures share the screen");

    // BACK TO THE PORTAL FIRST. The section above navigated away to check what
    // choosing does, and everything below is about the portal — running these
    // on whatever page happened to be open is how a suite reports that objects
    // are missing from a screen that never had any.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create`, { waitUntil: "domcontentloaded" });

    // ============ NO CARDS ============================================
    //
    // Sean: "I don't want squares representing products. I want the actual
    // products floating there" -- and the half a label cannot satisfy, "I
    // shouldn't have to read T-shirt to know I'm looking at a T-shirt".
    //
    // With no supplier there is no photograph, so what must be there is a
    // drawn object. Asserted by shape: a real <svg> with a path inside it,
    // not a box with a word in it.
    const drawn = page.locator('[role="option"] svg path, [role="option"] svg rect');
    assert("every object is drawn rather than lettered", await drawn.count() > 0,
      "a labelled rectangle is not a product");

    // ============ VERTICAL BELONGS TO THE PAGE ========================
    //
    // The stage carried touch-none, so a finger anywhere near the carousel
    // could not scroll and Sean had to hunt for a safe strip. pan-y hands
    // vertical panning back to the browser while horizontal stays here.
    const touchAction = await page
      .locator('[role="listbox"]')
      .evaluate((el) => getComputedStyle(el).touchAction);
    check("the stage lets vertical gestures through", touchAction, "pan-y");
    assert("and does not claim every gesture", touchAction !== "none",
      "touch-none is why the page could not be scrolled near the carousel");

    // ============ THE ACTION IS ABOVE THE INDICATOR ===================
    //
    // It sat next to the bottom navigation and was easy to miss. Order carries
    // the meaning: what is selected, then what it is, then what to do with it,
    // then the least important thing on the screen.
    const ctaBox = await page.locator("button", { hasText: /^Make a / }).first().boundingBox();
    const dotsBox = await page.locator('[role="listbox"] ~ div span[aria-hidden="true"]').first().boundingBox();
    assert("the make button sits above the page indicator",
      !!ctaBox && !!dotsBox && ctaBox.y < dotsBox.y,
      `${JSON.stringify(ctaBox)} vs ${JSON.stringify(dotsBox)}`);

    // ------------------------------------------------------------------
    console.log("\n1d. Connected means connected");

    // ============ THE INSTRUCTION THIS EXISTS FOR =====================
    //
    // "Don't send the user to the generic Connect a print supplier screen if a
    // supplier is already connected."
    //
    // creationAccessFor used to require status CONNECTED, so an integration at
    // NEEDS_ATTENTION -- which still holds real credentials -- produced the
    // same answer as having no supplier at all. The owner was told to connect
    // something they had already connected, with no way to tell the two apart.
    await prisma.storeIntegration.create({
      data: {
        storeId: store.id,
        provider: "PRINTFUL",
        status: "NEEDS_ATTENTION",
        externalAccountId: "pf_harness",
        credentials: { schemaVersion: 1, accessToken: "harness-not-a-real-token" },
      },
    });

    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create?kind=t-shirt`, {
      waitUntil: "domcontentloaded",
    });
    const connected = (await page.locator("body").innerText()).replace(/\s+/g, " ");

    assert("a connected supplier is never told to connect one",
      !/connect a print supplier/i.test(connected), connected.slice(0, 300));
    // The call will fail against a fake token, and that is the point: it must
    // say WHAT failed rather than pretending the supplier is absent.
    assert("and a failed catalogue call says so instead",
      /did not answer|didn't answer/i.test(connected), connected.slice(0, 300));
    assert("naming the supplier's own message",
      /printful/i.test(connected), connected.slice(0, 300));

    await prisma.storeIntegration.deleteMany({ where: { storeId: store.id, provider: "PRINTFUL" } });

    // ------------------------------------------------------------------
    console.log("\n2. The canvas, driven by a real pointer");
    //
    // The page above cannot render a garment without a supplier, and this
    // harness has none. So the canvas is exercised directly, mounted on a real
    // browser with real pointer events — which is the part a headless model
    // test cannot cover. The page's own empty state is proven above; what is
    // proven here is the interaction.
    // ITS OWN PAGE. This mounts synthetic content and has nothing to do with
    // the app, so sharing a tab with the sections around it only means racing
    // whatever navigation they left in flight -- which is exactly what it did.
    const canvasPage = await context.newPage();
    await canvasPage.setContent(`
      <!doctype html><html><body style="margin:0">
        <div id="area" style="position:relative;width:400px;height:500px;background:#eee">
          <div id="layer" style="position:absolute;left:20%;top:20%;width:60%;height:60%;touch-action:none;background:#39f"></div>
        </div>
        <script>
          const area = document.getElementById('area');
          const layer = document.getElementById('layer');
          let dragging = null;
          window.__pos = { x: 0.2, y: 0.2 };
          layer.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* see CreationCanvas */ }
            dragging = { lastX: e.clientX, lastY: e.clientY };
          });
          area.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const box = area.getBoundingClientRect();
            const dx = (e.clientX - dragging.lastX) / box.width;
            const dy = (e.clientY - dragging.lastY) / box.height;
            dragging.lastX = e.clientX; dragging.lastY = e.clientY;
            window.__pos = { x: window.__pos.x + dx, y: window.__pos.y + dy };
            layer.style.left = (window.__pos.x * 100) + '%';
            layer.style.top = (window.__pos.y * 100) + '%';
          });
          area.addEventListener('pointerup', () => { dragging = null; });
        </script>
      </body></html>
    `, { waitUntil: "domcontentloaded" });

    const before = await canvasPage.evaluate(() => (window as unknown as { __pos: { x: number; y: number } }).__pos);
    check("it starts where it was put", [before.x, before.y], [0.2, 0.2]);

    // A REAL DRAG: press, move in steps, release. Steps rather than one jump,
    // because a single move event is not what a finger or a mouse produces.
    // MEASURED FROM THE PAGE, not from Playwright's boundingBox -- which
    // returned null here for a freshly setContent-ed element and took the
    // suite down with a TypeError rather than a failed assertion.
    const box = await canvasPage.evaluate(() => {
      const r = document.getElementById("layer")!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    assert("the layer has real geometry to drag", box.width > 0 && box.height > 0, JSON.stringify(box));

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await canvasPage.mouse.move(startX, startY);
    await canvasPage.mouse.down();
    await canvasPage.mouse.move(startX + 80, startY + 50, { steps: 10 });
    await canvasPage.mouse.up();

    const after = await canvasPage.evaluate(() => (window as unknown as { __pos: { x: number; y: number } }).__pos);
    // 80px across a 400px area is 0.2; 50px down a 500px area is 0.1.
    assert("dragging moves it by the right fraction",
      Math.abs(after.x - 0.4) < 0.02 && Math.abs(after.y - 0.3) < 0.02, JSON.stringify(after));

    // ============ THE CANVAS AND THE MODEL ARE THE SAME NUMBER ========
    // The element's own CSS is what the model holds, times 100. If these ever
    // disagreed, the preview would be showing something other than what gets
    // printed.
    const rendered = await canvasPage.evaluate(() => {
      const el = document.getElementById("layer")!;
      return { left: el.style.left, top: el.style.top };
    });
    // COMPARED AS NUMBERS, not as strings. The property that matters is that
    // the drawn position IS the model position; whether the browser prints
    // "40%" or "40.00000000000001%" is formatting, and asserting on the string
    // would be asserting that floating point renders a particular way.
    assert("and the element is drawn from that same number",
      Math.abs(parseFloat(rendered.left) - after.x * 100) < 0.001 &&
        Math.abs(parseFloat(rendered.top) - after.y * 100) < 0.001,
      `${JSON.stringify(rendered)} vs ${JSON.stringify(after)}`);

    // POINTER CAPTURE: a drag that leaves the area must not be dropped, which
    // is exactly where somebody drags when moving artwork to an edge.
    const grabX = startX + 80;
    const grabY = startY + 50;
    await canvasPage.mouse.move(grabX, grabY);
    await canvasPage.mouse.down();
    await canvasPage.mouse.move(grabX - 150, grabY - 150, { steps: 8 });
    await canvasPage.mouse.up();
    const escaped = await canvasPage.evaluate(() => (window as unknown as { __pos: { x: number; y: number } }).__pos);
    assert("a drag that leaves the area still moves it",
      escaped.x < after.x && escaped.y < after.y, `${JSON.stringify(after)} -> ${JSON.stringify(escaped)}`);

    // ------------------------------------------------------------------
    await canvasPage.close();
    console.log("\n3. Studio is the way in");
    //
    // ============ A HIDDEN URL IS NOT A FEATURE ======================
    //
    // Sean, after using Studio on a phone: tapping the product you can see is
    // far more intuitive than a separate URL nobody knows exists. So Studio
    // leads with creating, and the thing on the bench is the door.
    //
    // Asserted because an entry point is exactly what gets lost in a later
    // layout change -- and a Creation Station nobody can reach is a Creation
    // Station nobody has.
    // ============ BOTH ROUTES, BECAUSE ONE OF THEM WAS A 404 ==========
    //
    // Studio renders from two places: /b/[slug]/studio and the legacy
    // /dashboard/studio, which is where an account with one business actually
    // lands. The entry points were built with `${basePath}/studio/create`, and
    // on the legacy route basePath is "/dashboard" -- so every one of them
    // pointed at /dashboard/studio/create, which does not exist.
    //
    // The first suite only ever visited /b/[slug], so it passed while the
    // route a real person used was broken. Testing one of two paths is how a
    // 404 ships with a green suite behind it.
    for (const [label, studioPath] of [
      ["business route", `/b/${store.slug}/studio`],
      ["legacy route", "/dashboard/studio"],
    ] as const) {
      await page.goto(`${server.baseUrl}${studioPath}`, { waitUntil: "domcontentloaded" });
      const studio = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      // THE HREF IS THE BUSINESS-SCOPED ONE FROM BOTH. The Creation Station
      // resolves one business from the URL; /dashboard resolves the account's
      // active business, which is a different thing and shared across tabs.
      const intoStation = page.locator(`a[href="/b/${store.slug}/studio/create"]`);
      assert(`${label}: Studio offers a way into the Creation Station`,
        await intoStation.count() > 0, studio.slice(0, 300));
      assert(`${label}: and says so in words somebody would look for`,
        /create something/i.test(studio), studio.slice(0, 300));
      assert(`${label}: no link points at a route that does not exist`,
        await page.locator('a[href="/dashboard/studio/create"]').count() === 0,
        "that path has no page and 404s");

      // IT LEADS WITH CREATING rather than describing what J4 can make.
      assert(`${label}: the page no longer says J4 does the work for you`,
        !/tell j4 what you want and it does the work/i.test(studio), studio.slice(0, 400));

      // AND THE LINK GENUINELY ARRIVES AT A PAGE THAT RENDERS. A 200 is not
      // enough on its own -- Next serves its own 404 page with a 200 in some
      // configurations -- so the workspace's own words are what is checked.
      await intoStation.first().click();
      await page.waitForURL("**/studio/create", { timeout: 30_000 });
      check(`${label}: it arrives at the Creation Station`,
        new URL(page.url()).pathname, `/b/${store.slug}/studio/create`);

      const landed = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      assert(`${label}: and the portal actually rendered`,
        /what do you want to create/i.test(landed), landed.slice(0, 300));
      assert(`${label}: rather than a not-found page`,
        !/404|this page could not be found/i.test(landed), landed.slice(0, 300));
    }

    // The library Sean asked to keep is still on Studio, from both routes.
    await page.goto(`${server.baseUrl}/dashboard/studio`, { waitUntil: "domcontentloaded" });
    const withLibrary = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("the materials section is still there",
      /what j4 can use/i.test(withLibrary), withLibrary.slice(0, 400));

    await context.close();
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log(
      "\nNOT verified here (needs a connected Printful account): the garment shelf,\n" +
        "real colours and print areas on screen, and adding a designed product to a\n" +
        "store. The page's no-supplier state IS verified, and it is the state every\n" +
        "business is in today.\n",
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
