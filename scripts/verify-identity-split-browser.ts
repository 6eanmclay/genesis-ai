import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";
import { waitForAppReady, waitForHydration } from "@/scripts/lib/appReadiness";

// THE IDENTITY SCREEN, IN A REAL BROWSER, WITH THE WRONG BUSINESS ACTIVE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-identity-split-browser.ts" -OutFile out.txt
//
// ============ THE ONE THING ONLY THIS LANE CAN PROVE (2026-09-01) ======
//
// `EditStoreForm` binds a slug into its action so a form on one business's page
// writes to THAT business. The brand screen never passed it, so `editStore`
// fell through to the ACTIVE business — the screen showed one business's name
// and would have renamed another.
//
// That is a defect in RESOLUTION, and resolution needs a session. The database
// lane can only prove the executable writes where it is told; proving the
// screen tells it the right thing needs a real sign-in, two real businesses,
// and the wrong one active. That is exactly what this sets up.
//
// It also renders the split itself, because a heading that says whose an
// identity is has to be READ, and because this project has twice had a green
// assertion pass for something nobody could see.

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

/**
 * Wait out the returning-owner opening.
 *
 * ============ WHY THIS IS NOW ONE LINE (2026-09-10) =================
 *
 * It used to look for "a fixed, full-screen div at z-index 100 with opacity
 * above 0.01", with a 5s window for it to appear and a `.catch` on both waits.
 * Every part of that was an inference about how the overlay happened to be
 * drawn, and on 2026-09-04 the opening became J4Boot at z-[120].
 *
 * So the wait matched nothing, both catches swallowed it, and this suite went
 * on to test a page with a full-screen overlay across it. The Save click
 * landed on the boot sequence, the rename never happened, and the suite
 * reported "the business in the URL was renamed — got Cubit & Coil" as though
 * the product had lost the write. It had not; the click never reached it.
 *
 * waitForAppReady asks the lifecycle instead: the shell, then j4-boot's own
 * existence. It does not catch — a readiness failure here means nothing below
 * was tested, and that must stop the run rather than colour it.
 */

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
    const email = `identity-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });

    const make = (slug: string, name: string) =>
      prisma.store.create({
        data: {
          userId: user.id, name, slug, tagline: "Hand-wound copper, true to the cubit",
          description: "Copper tensor rings wound by hand.", currency: "USD",
          blueprint: {
            brandIdentity: {
              brandStory: "Wound by hand in a small workshop.",
              missionStatement: "Make the old measure usable again.",
              targetAudience: "Practitioners of meditation and energy work.",
            },
          },
        },
      });

    // The business being LOOKED AT, and a different one the account is ON.
    // This is the state the defect needed and nothing had ever set up.
    const target = await make(`ident-target-${stamp}`, "Cubit & Coil");
    const other = await make(`ident-other-${stamp}`, "Iron Gym");
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: other.id } });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    // ====================================================================
    console.log("\n=== 1. The screen shows the business named in the URL ===\n");
    // ====================================================================
    await page.goto(`${server.baseUrl}/b/${target.slug}/brand`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="name"]', { timeout: 30_000 });
    await waitForAppReady(page);

    const shown = await page.inputValue('input[name="name"]');
    assert("the name field holds the business in the URL, not the active one",
      shown === "Cubit & Coil", `showed "${shown}"`);

    // ====================================================================
    console.log("\n=== 2. Both kinds of identity are on the screen, and say whose they are ===\n");
    // ====================================================================
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("business identity is named as the owner's own",
      /What your business says it is/.test(body), body.slice(0, 200));
    assert("brand identity is named as J4's interpretation",
      /What J4 has made of your business/.test(body), "interpretation sentence missing");
    assert("the storefront address is stated where the name is edited",
      body.includes(`/store/${target.slug}`), "address line missing");
    assert("and the conversation-first principle is still on the screen",
      /Talk with J4 first/.test(body), "the talk-with-J4 line is gone");

    // Brand identity is read only, asserted against the RENDERED page rather
    // than the source: what matters is that no control reached the browser.
    const brandInputs = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll("h2"));
      const brand = headings.find((h) => /Brand identity/i.test(h.textContent ?? ""));
      if (!brand) return -1;
      let count = 0;
      let node: Element | null = brand.nextElementSibling;
      while (node) {
        count += node.querySelectorAll("input, textarea, select").length;
        node = node.nextElementSibling;
      }
      return count;
    });
    assert("no editable control exists anywhere below Brand identity",
      brandInputs === 0, `found ${brandInputs}`);

    // ====================================================================
    console.log("\n=== 3. Saving writes to that business and not the active one ===\n");
    // ====================================================================
    const renamed = `Cubit & Coil ${stamp}`;
    // THE IDENTITY FORM'S OWN BUTTON. `form button[type="submit"]` matched
    // FOUR controls on this page and the first was J4's composer send button —
    // the suite was clicking the chat box. Scoped through the form that holds
    // the name field, which is the only form that can be the right one.
    const identityForm = page.locator('form:has(input[name="name"])');
    // The form's action is a function React attaches at hydration. Clicking
    // before that does nothing at all - no error, no request - and the suite
    // then reports the unchanged name as a lost write.
    await waitForHydration(page, 'form:has(input[name="name"])');

    // ============ FILL AND SUBMIT AS ONE INTERACTION ==================
    //
    // EditStoreForm is `<form key={resetKey}>`, and the shell re-renders again
    // after the opening finishes (DashboardShell sets `justArrived`, then
    // clears it). A remount between the fill and the click resets the input to
    // its defaultValue, so the submit carries the ORIGINAL name - the write
    // succeeds, changes nothing, and the suite reports a lost rename. That is
    // why this check passed on one run and failed on the next.
    //
    // So the value is re-read immediately before clicking, and the whole
    // interaction is retried if the form was replaced underneath it.
    for (let attempt = 0; attempt < 3; attempt++) {
      await identityForm.locator('input[name="name"]').fill(renamed);
      if ((await identityForm.locator('input[name="name"]').inputValue()) !== renamed) {
        console.error("      NOTE  the form remounted mid-edit; retrying the interaction");
        continue;
      }
      await identityForm.locator('button[type="submit"]').first().click();
      // POLL THE FACT BEING ASSERTED. The old wait watched the input's own
      // value for the string we had just typed into it, which is true the
      // instant fill() returns and proves nothing whatsoever.
      let renamedInDb = false;
      for (let poll = 0; poll < 30 && !renamedInDb; poll++) {
        const row = await prisma.store.findUnique({ where: { id: target.id }, select: { name: true } });
        renamedInDb = row?.name === renamed;
        if (!renamedInDb) await page.waitForTimeout(500);
      }
      if (renamedInDb) break;
      console.error("      NOTE  submit landed but the name has not changed; retrying");
    }
    const submitBlockedBy = await page.evaluate(() => {
      const form = document.querySelector('form:has(input[name="name"])');
      const btn = form?.querySelector('button[type="submit"]') as HTMLElement | null;
      if (!btn) return "no submit button";
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top) return "nothing at the point";
      if (btn.contains(top) || top.contains(btn)) return "clear";
      const id = top.getAttribute("data-testid");
      const cls = (top.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
      const st = getComputedStyle(top);
      return `${top.tagName.toLowerCase()}${id ? `[${id}]` : ""}${cls ? `.${cls}` : ""} pe=${st.pointerEvents} z=${st.zIndex}`;
    });
    console.log(`      NOTE  what sits over the identity form's submit button: ${submitBlockedBy}`);
    // WHAT THE FORM SAID. editStore runs through execute(), which can refuse
    // for reasons that have nothing to do with the click landing - and the
    // suite used to report only "the name is still the old one", which reads
    // like a lost write rather than a refused one.
    const formSaid = await page.evaluate(() => {
      const form = document.querySelector('form:has(input[name="name"])');
      const scope = (form?.parentElement ?? document.body) as HTMLElement;
      const text = (scope.innerText ?? "").replace(/\s+/g, " ").trim();
      const alerts = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"], [aria-live]'))
        .map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 0);
      return { alerts: alerts.slice(0, 4), around: text.slice(0, 300) };
    });
    console.log(`      NOTE  alerts on the page: ${JSON.stringify(formSaid.alerts)}`);


    const [targetRow, otherRow] = await Promise.all([
      prisma.store.findUnique({ where: { id: target.id }, select: { name: true, slug: true } }),
      prisma.store.findUnique({ where: { id: other.id }, select: { name: true } }),
    ]);
    assert("the business in the URL was renamed",
      targetRow?.name === renamed, `got "${targetRow?.name}"`);
    assert("THE ACTIVE BUSINESS WAS NOT TOUCHED",
      otherRow?.name === "Iron Gym", `got "${otherRow?.name}" — this is the defect`);
    assert("and the storefront address did not move",
      targetRow?.slug === target.slug, `got "${targetRow?.slug}"`);

    await page.screenshot({ path: `${SHOTS}/identity-split-desktop.png`, fullPage: true });

    // ====================================================================
    console.log("\n=== 4. On a phone, both sections are actually on the screen ===\n");
    // ====================================================================
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: await context.storageState(),
    });
    const small = await phone.newPage();
    await small.goto(`${server.baseUrl}/b/${target.slug}/brand`, { waitUntil: "domcontentloaded" });
    await small.waitForSelector('input[name="name"]', { timeout: 30_000 });
    await waitForAppReady(small);

    // GEOMETRY, NOT isVisible(). isVisible() has been true twice in this
    // project for something off the side of the viewport or under an overlay.
    const nameBox = await small.locator('input[name="name"]').boundingBox();
    assert("the name field is inside the 390px viewport",
      !!nameBox && nameBox.x >= 0 && nameBox.x + nameBox.width <= 390,
      `x=${nameBox?.x} width=${nameBox?.width}`);

    // RE-RESOLVED, NOT HELD. The shell re-renders once more after the opening
    // finishes — DashboardShell sets `justArrived` when J4Boot completes and
    // clears it again a few seconds later — so a handle taken the instant the
    // boot detaches can be pointing at a node React has already replaced, and
    // the action fails with "Element is not attached to the DOM".
    //
    // Waiting a fixed number of seconds for that to pass would be exactly the
    // guess this whole exercise removed. Re-resolving the locator is the fix:
    // it asks the page again rather than assuming the first answer survived.
    // The second failure is thrown, never swallowed.
    const brandHeadingFor = () => small.locator("h2", { hasText: "Brand identity" }).first();
    let brandBox: { x: number; y: number; width: number; height: number } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const h = brandHeadingFor();
        await h.scrollIntoViewIfNeeded();
        brandBox = await h.boundingBox();
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await brandHeadingFor().waitFor({ state: "attached", timeout: 10_000 });
      }
    }
    assert("and Brand identity is reachable by scrolling, inside the viewport",
      !!brandBox && brandBox.x >= 0 && brandBox.x + brandBox.width <= 390,
      `x=${brandBox?.x} width=${brandBox?.width}`);

    // Nothing covering it — the arrival overlay once hid a passing assertion.
    const covered = await small.evaluate(() => {
      const h = Array.from(document.querySelectorAll("h2")).find((n) => /Brand identity/i.test(n.textContent ?? ""));
      if (!h) return "no heading";
      const r = h.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2);
      if (h.contains(top) || top?.contains(h)) return "clear";
      if (!top) return "unknown";
      // NAME THE THING. "covered by DIV" is not a finding anybody can act on;
      // the testid, classes and pointer-events are what say whether this is a
      // real obstruction or a pass-through layer.
      const id = top.getAttribute("data-testid");
      const cls = (top.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
      const s = getComputedStyle(top);
      return `${top.tagName.toLowerCase()}${id ? `[${id}]` : ""}${cls ? `.${cls}` : ""} pe=${s.pointerEvents} z=${s.zIndex} pos=${s.position}`;
    });
    assert("with nothing painted over it", covered === "clear", `covered by ${covered}`);

    await small.screenshot({ path: `${SHOTS}/identity-split-mobile.png`, fullPage: true });
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
