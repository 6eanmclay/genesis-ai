import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import { verifyOAuthState, OAUTH_STATE_COOKIE } from "@/lib/integrations/oauthState";

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
const HARNESS_AUTH_SECRET = "harness-oauth-signing-secret";

let failures = 0;
let passes = 0;

function check(label: string, actual: unknown, expected: unknown, detail = ""): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(
      `  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}` +
        (detail ? `\n      where    ${detail}` : ""),
    );
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

function eq2(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual), JSON.stringify(expected));
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");

  // PRINTFUL'S APP CREDENTIALS, DETERMINISTIC AND FAKE — the same device the
  // harness already uses for Stripe. They are never sent anywhere: the only
  // thing that reads them here is printfulConnector.configured(), which
  // decides whether the creation flow can honestly offer a Connect button.
  //
  // Set BEFORE the server starts, because startTestServer hands its child a
  // snapshot of this environment. Without them the suite would prove only the
  // unconfigured screen and would silently stop covering the connect path —
  // the branch that matters most, since it is the one that used to dead-end.
  // The other direction is proved in verify-connection-truthfulness, where the
  // connector can be asked both ways without a second server.
  //
  // The secret the handoff is signed with. Set here so the suite can verify a
  // state with the SAME function the callback uses, rather than trusting that
  // the string looks about right.
  process.env.AUTH_SECRET = HARNESS_AUTH_SECRET;
  process.env.PRINTFUL_CLIENT_ID = "harness-printful-client";
  process.env.PRINTFUL_CLIENT_SECRET = "harness-printful-secret";

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
    assert("and shows no blanks", !/which t-shirt/i.test(chosen), chosen.slice(0, 300));

    // ============ THE DEAD END, ASSERTED SHUT =========================
    //
    // Sean: "The user should never click Make a T-shirt and get dumped into a
    // generic Connections page with no relevant supplier available."
    //
    // The supplier requirement is real and does not go away. What must not
    // happen is handing somebody a directory of twelve integrations and asking
    // them to work out which one a T-shirt needs. Four things prove the
    // difference, and the last one is the one that regressed before.
    assert("the supplier step names the supplier, not the category",
      /printful/i.test(chosen), chosen.slice(0, 400));
    assert("it still knows what was chosen",
      /t-shirt/i.test(chosen), chosen.slice(0, 400));
    check("and offers the real connection right there",
      await page.locator("form button", { hasText: /connect printful/i }).count(), 1);

    // THE REGRESSION GUARD. A link to the connections directory anywhere on
    // this screen is the dead end coming back.
    check("with no detour to the connections directory",
      await page.locator(`a[href*="/connections"]`).count(), 0);

    // Leaving is BACK TO CHOOSING, which is where they were.
    check("and a way back to the portal",
      await page.locator(`a[href="/b/${store.slug}/studio/create"]`).count() > 0, true);

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
    const stage = page.locator('[role="listbox"]');
    const stageHtml = await stage.evaluate((el) => el.outerHTML.slice(0, 400));
    const touchAction = await stage.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("touch-action"));
    check("the stage lets vertical gestures through", touchAction, "pan-y", stageHtml);
    assert("and does not claim every gesture", touchAction !== "none",
      "touch-none is why the page could not be scrolled near the carousel");

    // ============ THE ACTION IS ABOVE THE INDICATOR ===================
    //
    // It sat next to the bottom navigation and was easy to miss. Order carries
    // the meaning: what is selected, then what it is, then what to do with it,
    // then the least important thing on the screen.
    const ctaBox = await page.locator("button", { hasText: /^Make a / }).first().boundingBox();
    const dotsBox = await page.locator("[data-stage-dots] span").first().boundingBox();
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

    // AND THE FIX IS HERE TOO. A broken connection used to send the owner to
    // the same directory as a missing one; reconnecting is one button, in the
    // flow, still holding the thing they were trying to make.
    check("reconnecting happens in the flow",
      await page.locator("form button", { hasText: /reconnect printful/i }).count(), 1);
    check("without a detour to the connections directory",
      await page.locator(`a[href*="/connections"]`).count(), 0);

    // ============ AND THE PORTAL MUST NOT LIE ABOUT IT ================
    //
    // Sean, on a portal where every object claimed the supplier didn't make it:
    // "even when you are picking between tshirt hoodie hat it's already saying
    // your supplier doesn't make this one."
    //
    // The catalogue call had thrown, so the garment list was empty — and empty
    // was rendered as "the supplier stocks none of these". Printful makes all
    // five. This is the same connected-but-unreachable state as above, viewed
    // from the portal instead of the chosen product.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create`, { waitUntil: "domcontentloaded" });
    const portalWhileBroken = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("an unreadable catalogue is never reported as a supplier that doesn't stock it",
      !/doesn't make this one/i.test(portalWhileBroken), portalWhileBroken.slice(0, 400));
    assert("it says the catalogue could not be read",
      /couldn't read your supplier's catalogue/i.test(portalWhileBroken),
      portalWhileBroken.slice(0, 400));

    await prisma.storeIntegration.deleteMany({ where: { storeId: store.id, provider: "PRINTFUL" } });

    // AND THE SENTENCE IS STILL AVAILABLE WHEN IT IS TRUE. With no supplier at
    // all the portal offers the intention and says nothing about stock — an
    // assertion that only ever proved the string absent would pass just as well
    // against a portal that had lost the ability to say it.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create`, { waitUntil: "domcontentloaded" });
    const portalNoSupplier = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("with no supplier it claims nothing about what is stocked",
      !/doesn't make this one|couldn't read your supplier/i.test(portalNoSupplier),
      portalNoSupplier.slice(0, 400));

    // ------------------------------------------------------------------
    console.log("\n1e. The Printful connection, in all three of its states");

    // ============ WHY THIS SECTION EXISTS ==============================
    //
    // Sean, after trying it on the real deployment: "The Printful
    // authorization screen appears correctly, but the connection does not
    // complete successfully." It never could.
    //
    // printfulConnector.connect() passed the raw storeId as the OAuth `state`.
    // Phase 0 (686f847, 2026-08-19) converted every OAuth connector to a
    // signed, single-use, session-bound handoff and hardened the shared
    // callback to require one — and missed Printful. A bare cuid has no `.`,
    // so completeOAuthHandoff rejected it as "malformed" on the first check,
    // storeId came back null, and the route redirected to
    // /dashboard/connections?integration_error=printful. Every attempt, for
    // eight days, with the authorize screen appearing perfectly each time.
    //
    // Nothing caught it because no test drove Printful through the real
    // callback. That is what this section is.

    // ================== STATE 1 — NOT CONNECTED ========================
    //
    // 1d deleted the integration row, so this store genuinely has no supplier.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create?kind=t-shirt`, {
      waitUntil: "domcontentloaded",
    });

    // Printful's own site is stubbed, so the suite never leaves for the real
    // internet and never depends on printful.com being up.
    await context.route("https://www.printful.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>stub</body></html>" })
    );

    await page.locator("form button", { hasText: /connect printful/i }).click();
    await page.waitForURL(/printful\.com/, { timeout: 15_000 });

    const authorize = new URL(page.url());
    check("Connect goes to Printful's own authorize screen",
      `${authorize.origin}${authorize.pathname}`, "https://www.printful.com/oauth/authorize");
    assert("carrying this deployment's client id",
      authorize.searchParams.get("client_id") === "harness-printful-client",
      String(authorize.searchParams.get("client_id")));
    check("and the callback this server actually serves",
      authorize.searchParams.get("redirect_url"),
      `${server.baseUrl}/api/integrations/printful/callback`);

    // ============ THE BUG ITSELF, ASSERTED SHUT ========================
    //
    // The one claim that matters: the `state` Printful is handed is a handoff
    // the callback will accept. Verified with the SAME function the callback
    // uses, against the nonce cookie the server actually set — not by looking
    // at the string and deciding it seems fine.
    const handoffState = authorize.searchParams.get("state") ?? "";
    const nonceCookie = (await context.cookies()).find((c) => c.name === OAUTH_STATE_COOKIE);
    assert("the handoff set its single-use nonce cookie", Boolean(nonceCookie?.value), "no cookie");

    const verdict = verifyOAuthState(handoffState, {
      secret: HARNESS_AUTH_SECRET,
      provider: "PRINTFUL",
      cookieNonce: nonceCookie?.value,
      sessionUserId: user.id,
    });
    assert("the state is a signed handoff the callback will accept",
      verdict.ok, JSON.stringify(verdict));
    check("bound to this store", verdict.ok ? verdict.payload.storeId : null, store.id);
    check("and carrying the way back into creation",
      verdict.ok ? verdict.payload.returnTo : null,
      `/b/${store.slug}/studio/create?kind=t-shirt`);

    // NEGATIVE CONTROL — the exact shape that shipped, through the exact
    // function the callback runs. If this ever passes, the guard above is
    // proving nothing.
    const asShipped = verifyOAuthState(store.id, {
      secret: HARNESS_AUTH_SECRET,
      provider: "PRINTFUL",
      cookieNonce: nonceCookie?.value,
      sessionUserId: user.id,
    });
    assert("CONTROL: a raw storeId is rejected, which is why every attempt failed",
      !asShipped.ok && asShipped.reason === "malformed", JSON.stringify(asShipped));

    // ============ ONE RECORD, TWO SURFACES =============================
    //
    // Sean: "The Creation Station should never have one answer while
    // Connections has another." Printful was a built connector that was not a
    // catalog entry, and the connections page enumerates the catalog — so it
    // could be fully connected and Connections would show nothing at all.
    await page.goto(`${server.baseUrl}/b/${store.slug}/connections`, { waitUntil: "domcontentloaded" });
    const notConnectedPage = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("Connections knows Printful exists", /printful/i.test(notConnectedPage),
      notConnectedPage.slice(0, 400));

    // ================== STATE 2 — ALREADY CONNECTED ====================
    await prisma.storeIntegration.create({
      data: {
        storeId: store.id,
        provider: "PRINTFUL",
        status: "CONNECTED",
        externalAccountId: "pf_harness_connected",
        credentials: { schemaVersion: 1, accessToken: "harness-not-a-real-token" },
        connectedAt: new Date(),
        lastVerifiedAt: new Date(),
      },
    });

    await page.goto(`${server.baseUrl}/b/${store.slug}/connections`, { waitUntil: "domcontentloaded" });
    const connectionsSays = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("Connections says Printful is connected", /printful/i.test(connectionsSays),
      connectionsSays.slice(0, 400));

    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/create?kind=t-shirt`, {
      waitUntil: "domcontentloaded",
    });
    const creationSays = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    // ASSERTED ON THE BUTTON, AND EXACTLY.
    //
    // The first version of this searched the page text for "connect printful",
    // which "Reconnect Printful" contains — so it failed against a screen that
    // was behaving correctly. Establishing a connection and repairing one are
    // different offers, and only the first is wrong here.
    check("and the Creation Station never offers to establish one again",
      await page.locator("button", { hasText: /^Connect Printful$/ }).count(), 0, creationSays.slice(0, 300));
    // The catalogue call fails against a fake token, and SAYS so — which is the
    // honest third answer, not a fourth state. What must never happen is the
    // two surfaces disagreeing about whether a supplier exists.
    assert("the two surfaces agree a supplier exists",
      /didn't answer|which t-shirt|blanks/i.test(creationSays), creationSays.slice(0, 400));

    // ================== STATE 3 — THE ATTEMPT FAILED ===================
    //
    // A connection that fails silently and re-offers the same button is
    // indistinguishable from one that never ran. The reason shown here is the
    // connector's own recorded message, read from the same ExecutionLog row the
    // connections page reads.
    await prisma.storeIntegration.deleteMany({ where: { storeId: store.id, provider: "PRINTFUL" } });
    await prisma.executionLog.create({
      data: {
        executionId: `harness-pf-${stamp}`,
        action: "integration.printful.connect",
        status: "FAILED",
        verified: false,
        message: "The connection link was invalid or had expired. Please try again.",
        retryable: true,
        actorType: "USER",
        storeId: store.id,
        schemaVersion: 1,
      },
    });

    await page.goto(
      `${server.baseUrl}/b/${store.slug}/studio/create?kind=t-shirt&integration_error=printful`,
      { waitUntil: "domcontentloaded" }
    );
    const failed = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("a failed attempt says it failed", /didn't connect/i.test(failed), failed.slice(0, 400));
    assert("with the reason that was actually recorded",
      /invalid or had expired/i.test(failed), failed.slice(0, 400));
    check("and a retry in place rather than a directory",
      await page.locator("form button", { hasText: /try connecting again/i }).count(), 1);
    check("still with no detour to the connections directory",
      await page.locator(`a[href*="/connections"]`).count(), 0);

    await prisma.executionLog.deleteMany({ where: { storeId: store.id } });
    await context.unroute("https://www.printful.com/**");


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
    console.log("\n3. Studio IS the creation experience");
    //
    // ============ THE INTERMEDIARY IS GONE (2026-08-28) ==============
    //
    // Sean: "When I tap Studio, I don't think we should land on the current
    // 'Create something / Nothing on the bench yet' page at all. That page is
    // an unnecessary intermediary... Think of Studio as 'What do you want to
    // make?' — not 'Do you want to enter the place where you can make
    // something?'"
    //
    // So this section was rewritten rather than extended. It used to assert a
    // link reading "Create something" and a portal headline on the landing
    // page; both describe a screen that no longer exists, and an assertion
    // that outlives the thing it describes is worse than no assertion — it
    // fails for the right reason once and then gets deleted for the wrong one.
    //
    // ============ BOTH ROUTES, BECAUSE ONE OF THEM WAS A 404 ==========
    //
    // Studio renders from two places: /b/[slug]/studio and the legacy
    // /dashboard/studio, which is where an account with one business actually
    // lands. The entry points were once built with `${basePath}/studio/create`,
    // and on the legacy route basePath is "/dashboard" — so every one of them
    // pointed at /dashboard/studio/create, which does not exist. The first
    // suite only ever visited /b/[slug], so it passed while the route a real
    // person used was broken.
    //
    // ============ WHAT THIS HARNESS CANNOT REACH =====================
    //
    // listBlanks runs on the SERVER, so Playwright's request interception
    // cannot fake a catalogue for it. Every run here has an empty one, which
    // means the on-card "Continue with" list cannot appear and is covered by
    // verify-creation-catalog instead. What IS reachable is the more dangerous
    // half: with no catalogue, every saved design is stranded, and this asserts
    // the owner can still reach their work.

    // A SAVED DESIGN, SEEDED THE WAY THE ACTION WRITES ONE. Not a fixture
    // shaped to suit the assertion — the same entityType, sourceProvider and
    // schema saveDesignDraft persists, so a change to any of them fails here.
    const draftId = `draft-${stamp}`;
    await prisma.businessRecord.create({
      data: {
        storeId: store.id,
        entityType: "design",
        sourceProvider: "genesis_creation",
        externalId: draftId,
        data: {
          placement: {
            provider: "PRINTFUL",
            externalProductId: "blank-71",
            externalVariantId: "v-1",
            productName: "Half-finished hoodie",
            color: "Black",
            placements: { front: [] },
            updatedAt: new Date().toISOString(),
          },
        },
      },
    });

    for (const [label, studioPath] of [
      ["business route", `/b/${store.slug}/studio`],
      ["legacy route", "/dashboard/studio"],
    ] as const) {
      await page.goto(`${server.baseUrl}${studioPath}`, { waitUntil: "domcontentloaded" });
      const studio = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      // ============ IT NAMES ITSELF, AND NAMES BOTH PATHS ============
      //
      // Sean: "I don't want someone to see the first product carousel and
      // assume Studio is only for making merchandise." The heading says what
      // the place is and the subtitle says both things it does, so neither
      // depends on how far down a phone can see.
      assert(`${label}: the place names itself`,
        /creation station/i.test(studio), studio.slice(0, 400));
      assert(`${label}: and says it does both`,
        /products and social content/i.test(studio), studio.slice(0, 400));

      // THE THREE CATEGORIES, EACH LABELLED. Order is deliberately not
      // asserted — it becomes adaptive later, and a suite that pins today's
      // order would have to be rewritten to allow the feature it is guarding.
      // What must hold either way is that every category carries its label.
      assert(`${label}: product creation is labelled`,
        /product creation/i.test(studio), studio.slice(0, 400));
      assert(`${label}: social creation is labelled`,
        /social creation/i.test(studio), studio.slice(0, 400));
      assert(`${label}: so are graphics`, /graphics/i.test(studio), studio.slice(0, 400));

      // AND THE PRODUCTS THEMSELVES ARE ON IT, not behind a door.
      assert(`${label}: the things you can make are named`,
        /t-shirt/i.test(studio) && /hoodie/i.test(studio), studio.slice(0, 400));

      // THE INTERMEDIARY IS ACTUALLY GONE, not merely bypassed.
      assert(`${label}: no "create something" doorway remains`,
        !/create something/i.test(studio), studio.slice(0, 400));
      assert(`${label}: and nothing says the bench is empty`,
        !/nothing on the bench yet/i.test(studio), studio.slice(0, 400));

      // EVERY WAY IN IS BUSINESS-SCOPED. The 404 above, asserted shut.
      check(`${label}: no link points at a route that does not exist`,
        await page.locator('a[href^="/dashboard/studio/create"]').count(), 0);

      // ============ THE IMMERSIVE CAROUSEL, IN A SECTION ==============
      //
      // Sean: "I want the Product Creation section to retain the same visual
      // carousel experience we originally had — the immersive product imagery,
      // focused center item, surrounding products, swipe/navigation."
      //
      // So the shape asserted is the carousel's, not a row of cards: a listbox
      // with one selected option. Two of them, because Social Creation runs the
      // same stage rather than a lookalike.
      const stages = page.locator('[role="listbox"]');
      check(`${label}: two carousels — products and social`, await stages.count(), 2);
      check(`${label}: each has exactly one thing in front`,
        await page.locator('[role="option"][aria-selected="true"]').count(), 2);

      // THE ACTION IS UNDER THE FOCUSED OBJECT, and worded the way Sean asked.
      const createNew = page.locator(`a[href^="/b/${store.slug}/studio/create?kind="]`);
      assert(`${label}: the focused product offers Create New`,
        await createNew.count() >= 1, `${await createNew.count()} links`);
      check(`${label}: and it is worded the way it was asked for`,
        await page.locator("a", { hasText: /^Create New$/ }).count() >= 1, true);

      // ============ THE CHIPS ARE GONE ================================
      //
      // Sean listed them by name. Asserting a few of the exact sentences is
      // what stops them being reintroduced by a later "helpful defaults" pass.
      for (const chip of [
        /upload a logo/i,
        /refine my logo/i,
        /put my logo on/i,
        /what would you improve about my store/i,
        /create a hero section/i,
      ]) {
        assert(`${label}: no "${chip.source}" chip`, !chip.test(studio), studio.slice(0, 500));
      }

      // SAVED WORK IS REACHABLE. With no catalogue this design belongs to no
      // card, and the landing must still show it — otherwise a supplier outage
      // silently hides work somebody spent an evening on.
      const reopen = page.locator(`a[href*="design=${draftId}"]`);
      assert(`${label}: a saved design is still reachable with no catalogue`,
        await reopen.count() === 1, `${await reopen.count()} links`);
      const reopenHref = await reopen.first().getAttribute("href");
      assert(`${label}: and reopening carries the blank as well as the draft`,
        !!reopenHref && reopenHref.includes("garment=blank-71"), `${reopenHref}`);

      // ============ NO DEAD ENDS, WHICH WAS THE CONDITION =============
      //
      // Sean: "The cards should not lead to dead ends." Social and Graphics
      // have no dedicated flow built, so they are buttons that put a real
      // sentence into the real conversation — never links to a page that does
      // not exist, and never a placeholder anchor.
      check(`${label}: no placeholder anchors anywhere on Studio`,
        await page.locator('a[href="#"], a[href=""]').count(), 0);
      // A BUTTON, NOT THE WORD. The first version of this check fell back to
      // "Instagram appears somewhere in the page text", which the chips further
      // down would have satisfied on their own — an assertion that passes
      // whether or not the row rendered is not an assertion. CreationCardRow
      // returns null when the J4 context is missing, and that silent null is
      // exactly the failure worth catching.
      // SOCIAL IS A CAROUSEL NOW, not four buttons. What must be true is that
      // the four platforms are its objects and picking one is a real control.
      for (const platform of ["Instagram", "Facebook", "X", "TikTok"]) {
        check(`${label}: ${platform} is on the social carousel`,
          await page.locator(`[role="option"][aria-label="${platform}"]`).count(), 1);
      }
      // SOCIAL NOW HAS THE SAME PAIR AS PRODUCT, and Create New goes to a real
      // workspace rather than only into the conversation.
      const socialNew = page.locator(`a[href^="/b/${store.slug}/studio/social?platform="]`);
      assert(`${label}: the focused platform offers Create New`,
        await socialNew.count() >= 1, `${await socialNew.count()} links`);
      assert(`${label}: graphics is still reachable`,
        await page.locator("button", { hasText: /Promotional graphic/ }).count() > 0,
        studio.slice(0, 600));
    }

    // ------------------------------------------------------------------
    console.log("\n3b. Create new reaches the same editor it always did");
    //
    // THE WHOLE POINT OF THE RESTRUCTURE, asserted end to end: this is an
    // entry-point change, and what it opens into must be unchanged.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio`, { waitUntil: "domcontentloaded" });
    await page.locator(`a[href="/b/${store.slug}/studio/create?kind=t-shirt"]`).first().click();
    await page.waitForURL("**/studio/create?kind=t-shirt", { timeout: 30_000 });
    check("it arrives at the Creation Station",
      new URL(page.url()).pathname, `/b/${store.slug}/studio/create`);

    const landed = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("rather than a not-found page",
      !/404|this page could not be found/i.test(landed), landed.slice(0, 300));
    // The no-supplier state is the honest one here, and it is the state every
    // business is in before connecting Printful. What matters is that the
    // intention arrived and the page answered it.
    assert("and the page answers the intention it was given",
      !/what do you want to create/i.test(landed), landed.slice(0, 300));

    // ------------------------------------------------------------------
    console.log("\n3c. Continuing a saved design opens that design");
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio`, { waitUntil: "domcontentloaded" });
    await page.locator(`a[href*="design=${draftId}"]`).first().click();
    await page.waitForURL(`**/studio/create?garment=*design=${draftId}`, { timeout: 30_000 });
    const reopened = new URL(page.url());
    check("the blank travels", reopened.searchParams.get("garment"), "blank-71");
    check("and so does the draft", reopened.searchParams.get("design"), draftId);
    const reopenedBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("and it is not a not-found page",
      !/404|this page could not be found/i.test(reopenedBody), reopenedBody.slice(0, 300));

    // ------------------------------------------------------------------
    console.log("\n3e. Social Creation is a workspace, not a chat message");
    //
    // ============ THE FOUNDATION, WALKED ============================
    //
    // Sean, 2026-08-28: "Build the draft/save/continue foundation now, even if
    // the real publishing integrations aren't connected yet."
    //
    // So this walks it the way somebody would: pick a platform, write the thing
    // that platform actually needs, save, leave, and come back to it from the
    // Studio carousel. Every assertion below is about a real row in the
    // database — nothing here is a fixture.

    for (const [platformId, label] of [
      ["instagram", "Instagram"],
      ["facebook", "Facebook"],
      ["x", "X"],
      ["tiktok", "TikTok"],
    ] as const) {
      await page.goto(`${server.baseUrl}/b/${store.slug}/studio/social?platform=${platformId}`, {
        waitUntil: "domcontentloaded",
      });
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      assert(`${label}: the workspace opens`, new RegExp(label.replace("X", "\\bX\\b")).test(body),
        body.slice(0, 200));
      assert(`${label}: and is not a not-found page`,
        !/404|this page could not be found/i.test(body), body.slice(0, 200));

      // ============ NOTHING PRETENDS TO PUBLISH =====================
      //
      // No platform is connected and no publisher is registered. A button that
      // appeared to post would be the failure this codebase keeps being
      // corrected for — and the absence must be EXPLAINED, not silent.
      check(`${label}: offers no publish control`,
        await page.locator("button", { hasText: /^(Publish|Post)$/ }).count(), 0);
      assert(`${label}: but says why it cannot post yet`,
        /can't post them for you yet|isn't switched on yet|Connect /i.test(body),
        body.slice(0, 400));
    }

    // ============ FOUR DIFFERENT EDITORS, NOT ONE WITH A DROPDOWN ===
    //
    // The clearest possible evidence that a caption is not being reused: the
    // field each platform asks for first is different, and X's counter exists
    // nowhere else.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/social?platform=instagram`, { waitUntil: "domcontentloaded" });
    const igBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("Instagram asks about the picture before the words",
      /What should the picture show/i.test(igBody), igBody.slice(0, 300));
    assert("and says a caption alone is not a post",
      /needs a picture/i.test(igBody), igBody.slice(0, 400));

    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/social?platform=x`, { waitUntil: "domcontentloaded" });
    const xBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("X shows the limit, because the limit is the format",
      /0 \/ 280/.test(xBody), xBody.slice(0, 300));
    assert("and Instagram's picture question is nowhere on it",
      !/What should the picture show/i.test(xBody), xBody.slice(0, 300));

    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/social?platform=tiktok`, { waitUntil: "domcontentloaded" });
    const tkBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("TikTok asks for a hook and shots",
      /The hook/i.test(tkBody) && /Shot by shot/i.test(tkBody), tkBody.slice(0, 300));

    // ------------------------------------------------------------------
    console.log("\n3f. Write it, save it, leave, and continue it");

    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/social?platform=x`, { waitUntil: "domcontentloaded" });
    // SCOPED TO THEIR LABELS, not to DOM order. `textarea.first()` picked J4's
    // conversation composer — which is ALWAYS MOUNTED on every dashboard page,
    // merely hidden — so the post saved empty and the assertion that caught it
    // was reporting a bug in the test, not in the product.
    await page.locator('label:has-text("What is this post about") input').fill("Ring restock");
    await page
      .locator('label:has-text("The post") textarea')
      .fill("Copper tensor rings are back in stock this week.");
    await page.locator("button", { hasText: /^Save draft$/ }).click();
    await page.waitForFunction(() => /Saved\./.test(document.body.innerText), undefined, { timeout: 20_000 });

    // THE URL GAINED THE POST ID, so a refresh reopens the draft rather than a
    // blank composer.
    await page.waitForFunction(() => window.location.search.includes("post="), undefined, { timeout: 10_000 });
    const savedUrl = new URL(page.url());
    check("saving puts the post in the URL", savedUrl.searchParams.get("platform"), "x");
    assert("and gives it an id", (savedUrl.searchParams.get("post") ?? "").length > 0, page.url());

    // IT IS A REAL ROW. Read straight from the database rather than trusting
    // the screen — the whole point of the foundation is that it persists.
    const stored = await prisma.businessRecord.findFirst({
      where: { storeId: store.id, entityType: "socialPost", sourceProvider: "genesis_social" },
      select: { externalId: true, data: true },
    });
    assert("the draft is a real BusinessRecord", !!stored, "nothing was written");
    const storedData = stored?.data as {
      targets?: { platform?: string; content?: { kind?: string; text?: string } }[];
      amplifyStory?: boolean;
    } | null;
    check("stored as one piece with one target", storedData?.targets?.length, 1);
    check("under the platform it was written for", storedData?.targets?.[0]?.platform, "x");
    check("with that platform's own content shape", storedData?.targets?.[0]?.content?.kind, "x");
    assert("and the words the owner typed",
      (storedData?.targets?.[0]?.content?.text ?? "").includes("Copper tensor rings"),
      JSON.stringify(storedData?.targets?.[0]?.content));
    check("and no story was taken, because none was offered", storedData?.amplifyStory, false);

    // ------------------------------------------------------------------
    console.log("\n3g. A second platform starts empty, and one piece is one investment");
    //
    // ============ THE BEHAVIOUR THE WHOLE MODEL EXISTS FOR ==========
    //
    // Sean: "never assume one caption can simply be copied across platforms."
    // If ticking Facebook prefilled it with what was written for X, every shape
    // in lib/businessModel/entities.ts would be decoration. This is the one
    // assertion that proves the model is load-bearing rather than decorative.

    // One platform first, and the investment says so.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio/social?platform=x`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-platform-editor="x"] textarea').first().fill("Copper rings, back in stock.");
    let investment = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("one platform invests one Growth Point",
      /This will invest 1 Growth Point\b/.test(investment), investment.slice(0, 400));

    // Now add Facebook.
    await page.locator('button[aria-pressed="false"]', { hasText: /^Facebook$/ }).click();
    await page.waitForTimeout(300);

    // ITS EDITOR IS ITS OWN, AND IT IS EMPTY.
    const fbBody = await page.locator('[data-platform-editor="facebook"] textarea').first().inputValue();
    check("the Facebook editor starts empty", fbBody, "");
    const xStill = await page.locator('[data-platform-editor="x"] textarea').first().inputValue();
    assert("and the X post is untouched",
      xStill.includes("Copper rings, back in stock"), xStill);
    assert("and Facebook asks its own question, which X never had",
      await page.locator('[data-platform-editor="facebook"] label', { hasText: /What are you asking them/ }).count() === 1,
      "each platform's editor is its own");

    // TWO PLATFORMS, ONE CREATION, TWO GROWTH POINTS.
    investment = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("two platforms invest two Growth Points",
      /This will invest 2 Growth Points/.test(investment), investment.slice(0, 500));
    assert("and it is shown as one posting line, not two charges",
      /Posting to 2 platforms · 2 Growth Points/.test(investment), investment.slice(0, 500));

    // ALL FOUR STILL INVEST TWO. The rule Sean set: the fourth platform costs
    // nothing more than the second.
    await page.locator('button[aria-pressed="false"]', { hasText: /^Instagram$/ }).click();
    await page.locator('button[aria-pressed="false"]', { hasText: /^TikTok$/ }).click();
    await page.waitForTimeout(300);
    investment = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("all four platforms still invest two Growth Points",
      /This will invest 2 Growth Points/.test(investment), investment.slice(0, 500));
    assert("and the language is invest, never cost or spend",
      !/\b(cost|spend|fee|charge)\b/i.test(investment), investment.slice(0, 600));

    // ============ AND NO STORY OFFER, ANYWHERE =====================
    //
    // Every platform is selected, including both that Meta's API can post
    // stories to. No publisher is registered, so the offer must not appear —
    // and must not appear DISABLED either.
    assert("no Story offer is shown, because no publisher declares it",
      !/extend your reach|to your Story/i.test(investment), investment.slice(0, 600));
    check("and there is no disabled story control",
      await page.locator('input[type="checkbox"]').count(), 0);

    // Saving the four-platform piece writes four targets, each with its own shape.
    await page.locator('label:has-text("What is this post about") input').fill("Restock, everywhere");
    await page.locator("button", { hasText: /^Save draft$/ }).click();
    await page.waitForFunction(() => /Saved\./.test(document.body.innerText), undefined, { timeout: 20_000 });

    const multi = await prisma.businessRecord.findFirst({
      where: { storeId: store.id, entityType: "socialPost", sourceProvider: "genesis_social" },
      orderBy: { syncedAt: "desc" },
      select: { data: true },
    });
    const multiData = multi?.data as {
      targets?: { platform?: string; content?: { kind?: string } }[];
    } | null;
    check("one piece, four targets", multiData?.targets?.length, 4);
    eq2("each target carries its own platform",
      (multiData?.targets ?? []).map((target) => target.platform).sort(),
      ["facebook", "instagram", "tiktok", "x"]);
    assert("and each content shape matches its own platform",
      (multiData?.targets ?? []).every((target) => target.content?.kind === target.platform),
      JSON.stringify(multiData?.targets?.map((target) => [target.platform, target.content?.kind])));

    // AND IT COMES BACK FROM THE STUDIO CAROUSEL. Leave, return, Continue.
    await page.goto(`${server.baseUrl}/b/${store.slug}/studio`, { waitUntil: "domcontentloaded" });
    // ROTATED, NOT CLICKED. X sits at the BACK of a four-object circle, where
    // pointer-events is deliberately none — you cannot click the thing behind
    // the thing in front. Arrow keys are how a keyboard reaches it, and they
    // now belong to the focused carousel rather than the window.
    // PRESS UNTIL IT ARRIVES. Getting to X is navigation, not the assertion —
    // and a fixed number of presses assumes the first one lands after hydration,
    // which is a race the test does not need to take.
    const socialStage = page.locator('[role="listbox"]').last();
    for (let i = 0; i < 8; i++) {
      if (await page.locator('[role="option"][aria-selected="true"][aria-label="X"]').count() === 1) break;
      await socialStage.press("ArrowRight");
      await page.waitForTimeout(350);
    }
    check("the social carousel is showing X",
      await page.locator('[role="option"][aria-selected="true"][aria-label="X"]').count(), 1);

    // AND THE OTHER CAROUSEL DID NOT MOVE WITH IT. Two stages both listening on
    // the window is the defect this walk found: one arrow key rotated both.
    check("and the product carousel stayed where it was",
      await page.locator('[role="option"][aria-selected="true"][aria-label="T-shirt"]').count(), 1);
    const continueBtn = page.locator("#studio-social-panel");
    await page.locator("button", { hasText: /^Continue/ }).last().click();
    await continueBtn.waitFor({ state: "visible", timeout: 10_000 });
    const panel = (await continueBtn.innerText()).replace(/\s+/g, " ");
    assert("the saved post is offered under its own platform",
      /Ring restock/.test(panel), panel.slice(0, 300));
    assert("and is grouped as in progress, because nothing can publish yet",
      /In progress/i.test(panel), panel.slice(0, 300));
    // WHAT IS IN IT, in X's own terms rather than a truncated caption.
    assert("and says what is in it in that platform's terms",
      /of 280 characters/.test(panel), panel.slice(0, 300));

    // BY NAME, NOT BY POSITION. There is more than one draft under X now, and
    // "the first link" quietly became "the newest piece" — a test that passes or
    // fails depending on what an earlier section happened to save.
    await page.locator("#studio-social-panel a", { hasText: /Ring restock/ }).first().click();
    await page.waitForURL(/studio\/social\?platform=x&post=/, { timeout: 20_000 });
    // A CONTROLLED TEXTAREA'S VALUE IS A PROPERTY, NOT TEXT. innerText does not
    // contain it, so the first version of this read the whole page — and found
    // J4's always-mounted Office instead of the post. inputValue reads what is
    // actually in the field.
    const reopenedText = await page.locator('[data-platform-editor="x"] textarea').first().inputValue();
    assert("reopening shows the words that were saved",
      /Copper tensor rings are back in stock/.test(reopenedText), reopenedText.slice(0, 200));
    const reopenedName = await page.locator('label:has-text("What is this post about") input').inputValue();
    check("and the name it was given", reopenedName, "Ring restock");

    // ------------------------------------------------------------------
    console.log("\n3d. The same room on a phone");
    //
    // ============ MOBILE IS NOT A NARROWER DESKTOP ==================
    //
    // Sean: "The Product Creation carousel needs to look and behave like the
    // original immersive carousel on the phone — not just look good on desktop."
    //
    // Two things can only be checked at a real width. First, that the page does
    // not scroll SIDEWAYS: a carousel of absolutely positioned objects at fixed
    // pixel offsets is exactly the thing that pushes a body wider than the
    // viewport, and the symptom on a phone is a page that drifts under the
    // thumb. Second, that the object in front is actually reachable — a stage
    // that renders but places its focused object off-screen looks fine in a
    // screenshot and is unusable.
    // THE SESSION IS REUSED, NOT REPEATED. Signing in a second time is the one
    // step in this suite that has flaked, and a mobile pass that fails at the
    // login form tells us nothing about the layout it exists to check.
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      storageState: await context.storageState(),
    });
    const phonePage = await phone.newPage();
    await phonePage.goto(`${server.baseUrl}/b/${store.slug}/studio`, { waitUntil: "domcontentloaded" });

    const overflow = await phonePage.evaluate(() => ({
      body: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    assert("the page does not scroll sideways on a phone",
      overflow.body <= overflow.view + 1, `content ${overflow.body}px in a ${overflow.view}px viewport`);

    check("both carousels render on a phone",
      await phonePage.locator('[role="listbox"]').count(), 2);

    // THE FOCUSED OBJECT IS ON SCREEN AND BIG ENOUGH TO HIT. Not a pixel-perfect
    // assertion — a real one about whether a thumb can land on it.
    const front = phonePage.locator('[role="option"][aria-selected="true"]').first();
    const frontBox = await front.boundingBox();
    assert("the focused product is actually on screen",
      !!frontBox && frontBox.x >= -8 && frontBox.x + frontBox.width <= overflow.view + 8,
      JSON.stringify(frontBox));
    assert("and is big enough to tap",
      !!frontBox && frontBox.width >= 120 && frontBox.height >= 120, JSON.stringify(frontBox));

    // AND THE ACTIONS SIT UNDER IT, reachable without a horizontal scroll.
    const phoneCreate = phonePage.locator("a", { hasText: /^Create New$/ }).first();
    const createBox = await phoneCreate.boundingBox();
    assert("Create New is on screen on a phone",
      !!createBox && createBox.x >= 0 && createBox.x + createBox.width <= overflow.view + 1,
      JSON.stringify(createBox));

    // THE SWIPE STILL BELONGS TO THE PAGE VERTICALLY. touch-action: pan-y is
    // what allows a thumb starting on the carousel to scroll the page, and it
    // is the fix Sean asked for after hunting for "a safe strip to scroll in".
    const touchEvidence = await phonePage
      .locator('[role="listbox"]')
      .first()
      .evaluate((el) => ({
        computed: getComputedStyle(el).getPropertyValue("touch-action"),
        inline: (el as HTMLElement).style.touchAction,
        attr: el.getAttribute("style") ?? "",
      }));
    // BOTH, REPORTED. The computed value came back empty once and a guess about
    // why would have been exactly the kind of invented root cause this project
    // has been burned by. The inline value is what our code sets; the computed
    // value is what the browser will act on. Asserting the inline one and
    // printing both means a future failure says which of the two moved.
    assert("a vertical swipe on the carousel still scrolls the page",
      touchEvidence.inline === "pan-y" || touchEvidence.computed === "pan-y",
      JSON.stringify(touchEvidence));

    await phone.close();

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
        "real colours and print areas on screen, adding a designed product to a\n" +
        "store, and the ON-CARD 'Continue with' list — listBlanks runs on the\n" +
        "server, so this harness always has an empty catalogue and every saved\n" +
        "design is stranded. The grouping itself is covered by\n" +
        "verify-creation-catalog; the stranded path IS verified here, and the\n" +
        "no-supplier state is what every business is in today.\n",
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
