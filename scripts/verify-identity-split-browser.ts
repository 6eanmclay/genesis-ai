import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";

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
 * Wait out the returning-owner arrival ritual.
 *
 * A fixed, full-screen element at z-index 100. It intercepted the click on the
 * save button on the first run of this suite — and in an earlier milestone it
 * covered a whole screenshot that had passed every assertion beside it, because
 * computed styles read straight through an overlay. Same wait
 * scripts/verify-rooms-browser.ts uses, for the same reason.
 */
const OVERLAY_UP = () =>
  Array.from(document.querySelectorAll("div")).some((el) => {
    const s = getComputedStyle(el);
    return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
  });

async function dismissArrival(page: Page): Promise<void> {
  // ============ WAIT FOR IT TO ARRIVE BEFORE WAITING FOR IT TO GO ====
  //
  // The first version only waited for the overlay to be ABSENT, which is
  // trivially true before it mounts — so on the phone context it returned
  // instantly, the ritual then played, and the screenshot came out as a
  // picture of "Welcome back, Owner." with the page behind it. The suite
  // caught it, which is the only reason this is a fixed race rather than a
  // published screenshot of the wrong thing.
  await page.waitForFunction(OVERLAY_UP, undefined, { timeout: 5_000 }).catch(() => {
    // It may genuinely not play. Absence now is then the real answer.
  });
  await page
    .waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("div")).some((el) => {
          const s = getComputedStyle(el);
          return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
        }),
      undefined,
      { timeout: 30_000 }
    )
    .catch(() => {
      // Still up. The assertions below will fail visibly rather than quietly.
    });
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
    await dismissArrival(page);

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
    await identityForm.locator('input[name="name"]').fill(renamed);
    await identityForm.locator('button[type="submit"]').first().click();
    // The action revalidates and the field re-renders from the database.
    await page.waitForFunction(
      (expected) => {
        const el = document.querySelector('input[name="name"]') as HTMLInputElement | null;
        return el?.value === expected;
      },
      renamed,
      { timeout: 30_000 },
    ).catch(() => {});

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
    await dismissArrival(small);

    // GEOMETRY, NOT isVisible(). isVisible() has been true twice in this
    // project for something off the side of the viewport or under an overlay.
    const nameBox = await small.locator('input[name="name"]').boundingBox();
    assert("the name field is inside the 390px viewport",
      !!nameBox && nameBox.x >= 0 && nameBox.x + nameBox.width <= 390,
      `x=${nameBox?.x} width=${nameBox?.width}`);

    const brandHeading = small.locator("h2", { hasText: "Brand identity" }).first();
    await brandHeading.scrollIntoViewIfNeeded();
    const brandBox = await brandHeading.boundingBox();
    assert("and Brand identity is reachable by scrolling, inside the viewport",
      !!brandBox && brandBox.x >= 0 && brandBox.x + brandBox.width <= 390,
      `x=${brandBox?.x} width=${brandBox?.width}`);

    // Nothing covering it — the arrival overlay once hid a passing assertion.
    const covered = await small.evaluate(() => {
      const h = Array.from(document.querySelectorAll("h2")).find((n) => /Brand identity/i.test(n.textContent ?? ""));
      if (!h) return "no heading";
      const r = h.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2);
      return h.contains(top) || top?.contains(h) ? "clear" : (top?.tagName ?? "unknown");
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
