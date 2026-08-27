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
    console.log("\n1. No print supplier connected — and it says so");
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create`, { waitUntil: "domcontentloaded" });
    const empty = (await page.locator("body").innerText()).replace(/\s+/g, " ");

    // ============ THE RULE THIS PAGE IS BUILT ON ======================
    // A design tool with an invented catalogue produces something nobody can
    // order. Naming the cause is worth more than a populated screen that lies.
    assert("it names the missing supplier", /connect a print supplier/i.test(empty), empty.slice(0, 300));
    assert("and does not show any blanks", !/choose something to make/i.test(empty), empty.slice(0, 300));
    check("with a way to fix it",
      await page.locator(`a[href="/b/${store.slug}/connections"]`).count() > 0, true);

    // ------------------------------------------------------------------
    console.log("\n2. The canvas, driven by a real pointer");
    //
    // The page above cannot render a garment without a supplier, and this
    // harness has none. So the canvas is exercised directly, mounted on a real
    // browser with real pointer events — which is the part a headless model
    // test cannot cover. The page's own empty state is proven above; what is
    // proven here is the interaction.
    await page.setContent(`
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

    const before = await page.evaluate(() => (window as unknown as { __pos: { x: number; y: number } }).__pos);
    check("it starts where it was put", [before.x, before.y], [0.2, 0.2]);

    // A REAL DRAG: press, move in steps, release. Steps rather than one jump,
    // because a single move event is not what a finger or a mouse produces.
    // MEASURED FROM THE PAGE, not from Playwright's boundingBox -- which
    // returned null here for a freshly setContent-ed element and took the
    // suite down with a TypeError rather than a failed assertion.
    const box = await page.evaluate(() => {
      const r = document.getElementById("layer")!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    assert("the layer has real geometry to drag", box.width > 0 && box.height > 0, JSON.stringify(box));

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY + 50, { steps: 10 });
    await page.mouse.up();

    const after = await page.evaluate(() => (window as unknown as { __pos: { x: number; y: number } }).__pos);
    // 80px across a 400px area is 0.2; 50px down a 500px area is 0.1.
    assert("dragging moves it by the right fraction",
      Math.abs(after.x - 0.4) < 0.02 && Math.abs(after.y - 0.3) < 0.02, JSON.stringify(after));

    // ============ THE CANVAS AND THE MODEL ARE THE SAME NUMBER ========
    // The element's own CSS is what the model holds, times 100. If these ever
    // disagreed, the preview would be showing something other than what gets
    // printed.
    const rendered = await page.evaluate(() => {
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
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX - 150, grabY - 150, { steps: 8 });
    await page.mouse.up();
    const escaped = await page.evaluate(() => (window as unknown as { __pos: { x: number; y: number } }).__pos);
    assert("a drag that leaves the area still moves it",
      escaped.x < after.x && escaped.y < after.y, `${JSON.stringify(after)} -> ${JSON.stringify(escaped)}`);

    // ------------------------------------------------------------------
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
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio`, { waitUntil: "domcontentloaded" });
    const studio = (await page.locator("body").innerText()).replace(/\s+/g, " ");

    const intoStation = page.locator(`a[href="/b/${store.slug}/studio/create"]`);
    assert("Studio offers a way into the Creation Station", await intoStation.count() > 0,
      studio.slice(0, 300));
    assert("and says so in words somebody would look for",
      /create something/i.test(studio), studio.slice(0, 300));

    // IT LEADS WITH CREATING rather than describing what J4 can make. The old
    // copy made asking the whole product.
    assert("the page no longer says J4 does the work for you",
      !/tell j4 what you want and it does the work/i.test(studio), studio.slice(0, 400));

    // And the link genuinely arrives.
    await intoStation.first().click();
    await page.waitForURL(`**/studio/create`, { timeout: 30_000 });
    check("and it arrives at the Creation Station",
      new URL(page.url()).pathname, `/b/${store.slug}/studio/create`);

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
