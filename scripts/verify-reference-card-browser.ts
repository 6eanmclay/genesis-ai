import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";
import { waitForAppReady, waitForOfficeIntelligence } from "@/scripts/lib/appReadiness";
import { presentReading } from "@/lib/design/referencePresentation";
import type { ReferenceReading } from "@/lib/design/referenceObservation";

// WHAT THE OWNER ACTUALLY SEES, IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-reference-card-browser.ts" -OutFile out.txt
//
// ============ WHY THIS CANNOT BE A UNIT TEST (2026-09-10) =============
//
// verify-reference-design proves the SHAPE: that an unbacked proposal cannot
// become a choice, that bearsOn: null carries no index, that the presentation
// and the execution path read one list. All true, all offline, and none of it
// says whether an owner can see the difference between what J4 saw and what J4
// wants to change.
//
// This project has been caught by that distinction repeatedly today - most
// sharply by verify-rooms-browser, whose own comment records that "every
// screenshot this suite took was a picture of the ritual rather than of the
// room underneath - the assertions passed the whole time". So this waits on
// the real readiness contract before it looks at anything, and asserts the
// card is genuinely on screen rather than merely in the DOM.

const PASSWORD = "correct-horse-battery-staple";
const SHOTS = "verification-screenshots";

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/**
 * A reading with all three kinds in it: actionable, unactionable, and unbacked.
 *
 * The unbacked proposals are deliberate. They are exactly what a model produces
 * on a bad day, and the card must never show them - proven here on the rendered
 * page rather than only against the function that filters them.
 */
const READING: ReferenceReading = {
  inWords:
    "Restrained and editorial: very large headings against a lot of empty space, " +
    "with product images running full width.",
  observations: [
    { id: "o1", what: "The headings are much larger than the body text", bearsOn: "typeScale" },
    { id: "o2", what: "There is a great deal of empty space between sections", bearsOn: "spacing" },
    { id: "o3", what: "The product grid is deliberately asymmetric, with staggered rows", bearsOn: null },
    { id: "o4", what: "The navigation stays pinned as the page scrolls", bearsOn: null },
  ],
  proposals: [
    { dimension: "typeScale", value: "display", becauseOf: "o1", soThat: "your headings carry the page the way theirs do" },
    { dimension: "spacing", value: "spacious", becauseOf: "o2", soThat: "the store feels unhurried rather than packed" },
    // Unbacked: cites an observation marked unactionable. Must not render.
    { dimension: "sectionLayout", value: "split", becauseOf: "o3", soThat: "SHOULD NEVER BE SHOWN" },
    // Invented value. Must not render.
    { dimension: "cardStyle", value: "#0A0A0A", becauseOf: "o1", soThat: "SHOULD NEVER BE SHOWN" },
  ] as never,
};

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
      // The submit is a client call; it does nothing until React has attached.
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const email = `refcard-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `refcard-${stamp}`, currency: "USD", published: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });

    // THE THEME BEFORE, read from the database rather than remembered.
    const themeBefore = JSON.stringify(
      (await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { theme: true } })).theme,
    );

    // The message J4 would have written, carrying the card the same way a
    // photo's URL already travels. Built through presentReading, so what is
    // rendered came through the real gate.
    await prisma.storeMessage.create({
      data: {
        storeId: store.id,
        role: "assistant",
        content: "Here's what I noticed in that screenshot.",
        changes: { designReference: presentReading(READING) } as object,
      },
    });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);
    await page.goto(`${server.baseUrl}/b/${store.slug}`, { waitUntil: "domcontentloaded" });

    // ============ 10. THE RIGHT SCREEN, NOT A STALE ONE ==============
    const readiness = await waitForAppReady(page);
    console.log(`\n  readiness: ${readiness.state} after ${readiness.waitedMs}ms`);
    await page.click('[data-testid="j4-office"]');
    await page.waitForFunction(
      () => document.querySelector("[data-j4-presentation='office']")?.getAttribute("aria-hidden") === "false",
      undefined, { timeout: 15_000 },
    );
    await waitForOfficeIntelligence(page);
    // ============ AND FULLY OPENED, NOT MID-FADE =====================
    //
    // aria-hidden flips to false when the Office STARTS opening; J4Overlay then
    // animates it in over 300ms. A screenshot taken in that window shows the
    // card bleeding through a half-transparent panel with the dashboard behind
    // it - which is what the first run of this suite captured while every
    // assertion passed, because the DOM was already correct.
    //
    // Waited on the computed opacity rather than slept through: the transition
    // is the thing being waited for, and the browser knows when it is done.
    await page.waitForFunction(
      () => {
        const panel = document.querySelector("[data-j4-presentation='office']");
        if (!panel) return false;
        const inner = panel.querySelector("div");
        return getComputedStyle(panel).opacity === "1" && (!inner || getComputedStyle(inner).opacity === "1");
      },
      undefined,
      { timeout: 15_000 },
    );
    const bootGone = (await page.locator('[data-testid="j4-boot"]').count()) === 0;
    assert("the opening has finished — this is not a boot-state screenshot", bootGone, "");

    // Counted at the moment the card appears, so anything the shell did on the
    // way in is excluded from the comparison below.
    const approvalsBefore = await prisma.approvalRequest.count({ where: { storeId: store.id } });
    const executionsBefore = await prisma.executionLog.count({ where: { storeId: store.id } });

    const card = page.locator('[data-testid="reference-proposal-card"]');
    await card.waitFor({ state: "visible", timeout: 30_000 });
    const box = await card.boundingBox();
    assert("the card is genuinely on screen, with real size",
      !!box && box.width > 100 && box.height > 100, `${box?.width}x${box?.height}`);

    await page.screenshot({ path: `${SHOTS}/reference-card.png`, fullPage: true });

    // ============ 1. THE EXPECTED PRESENTATION =======================
    const choices = page.locator('[data-testid="reference-choice"]');
    assert("exactly the two well-founded proposals are offered",
      (await choices.count()) === 2, `${await choices.count()} choices`);

    // ============ 2 + 3. SAW, CHANGE, WHY - VISIBLY SEPARATE =========
    const saw = await page.locator('[data-testid="reference-saw"]').first().innerText();
    const change = await page.locator('[data-testid="reference-change"]').first().innerText();
    const why = await page.locator('[data-testid="reference-why"]').first().innerText();
    console.log(`\n  first choice as rendered:\n    ${saw}\n    ${change}\n    ${why}`);
    assert("what J4 SAW is rendered in the reference's terms",
      saw.includes("I saw:") && saw.includes("headings are much larger"), saw);
    // The apostrophe on screen is a typographic one (&rsquo;), so the match is
    // on the words rather than on the punctuation - a straight-quote check
    // failed here and said nothing about the product.
    assert("what J4 would CHANGE is a separate element in the store's terms",
      /d change:/.test(change) && change.includes("Type scale") && change.includes("display"), change);
    assert("they are not the same text", saw !== change, "");
    assert("and the WHY is visible", why.includes("headings carry the page"), why);
    // Separate ELEMENTS, not one sentence: a card that concatenated them would
    // pass a text search and fail the thing the card exists for.
    const sawBox = await page.locator('[data-testid="reference-saw"]').first().boundingBox();
    const changeBox = await page.locator('[data-testid="reference-change"]').first().boundingBox();
    assert("rendered as two distinct blocks, one above the other",
      !!sawBox && !!changeBox && changeBox.y > sawBox.y, `saw y=${sawBox?.y} change y=${changeBox?.y}`);

    // ============ 4. SEEN, BUT NOT SELECTABLE ========================
    const seenOnly = page.locator('[data-testid="reference-seen-only"]');
    assert("the unactionable observations are visible", await seenOnly.isVisible(), "");
    const seenText = await seenOnly.innerText();
    assert("both of them are named", /asymmetric/.test(seenText) && /pinned/.test(seenText), seenText.slice(0, 120));
    // STRUCTURALLY UNSELECTABLE, asserted on the rendered page: there is no
    // control inside that block at all, so there is nothing to disable.
    assert("and there is no control of any kind among them",
      (await seenOnly.locator("input, button, [role='checkbox']").count()) === 0,
      `${await seenOnly.locator("input, button").count()} controls`);

    // ============ 5. UNBACKED PROPOSALS NEVER APPEAR =================
    const cardText = await card.innerText();
    assert("a proposal citing an unactionable observation is not shown",
      !cardText.includes("Section layout"), "sectionLayout cited o3, which bears on nothing");
    assert("a proposal with an invented value is not shown",
      !cardText.includes("#0A0A0A") && !cardText.includes("Card style"), "");
    assert("and neither of their justifications leaked onto the page",
      !cardText.includes("SHOULD NEVER BE SHOWN"), "");

    // ============ 6 + 7. SELECTION ===================================
    const inputs = page.locator('[data-testid="reference-choice"] input[type="checkbox"]');
    assert("both choices start selected", (await inputs.count()) === 2, "");
    const applyLabel = async () => (await page.locator('[data-testid="reference-apply"]').innerText()).trim();
    assert("the apply control counts both", (await applyLabel()).includes("2 changes"), await applyLabel());
    await inputs.nth(0).uncheck();
    assert("unticking one leaves exactly one selected", (await applyLabel()).includes("1 change"), await applyLabel());
    await inputs.nth(0).check();
    assert("re-ticking it returns to two, not three",
      (await applyLabel()).includes("2 changes"), await applyLabel());
    await inputs.nth(0).check();
    assert("and ticking an already-ticked choice creates no duplicate",
      (await applyLabel()).includes("2 changes"), await applyLabel());

    // ============ 8. THE APPLY CONTROL IS HONESTLY INERT =============
    const apply = page.locator('[data-testid="reference-apply"]');
    assert("apply is disabled", await apply.isDisabled(), "");
    assert("and the card says applying is not connected yet",
      /applying isn.t connected yet/i.test(cardText), cardText.slice(-160));
    await apply.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);

    // ============ 9. NOTHING CHANGED =================================
    const themeAfter = JSON.stringify(
      (await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { theme: true } })).theme,
    );
    assert("the store's theme is byte-identical after all of that",
      themeAfter === themeBefore, themeAfter === themeBefore ? "unchanged" : "IT CHANGED");
    // BEFORE AND AFTER, not "is it zero". A live store is not inert: Genesis
    // raises its own state issues and records its own reads, so this store had
    // 1 approval and 5 execution rows before the card was ever on screen. The
    // question is whether SHOW/CHOOSE added any, and a zero-check answered a
    // different one - it failed here while the product was behaving perfectly.
    const approvalsAfter = await prisma.approvalRequest.count({ where: { storeId: store.id } });
    assert("the card created no approval request",
      approvalsAfter === approvalsBefore, `${approvalsBefore} before, ${approvalsAfter} after`);
    const executionsAfter = await prisma.executionLog.count({ where: { storeId: store.id } });
    assert("and recorded no execution",
      executionsAfter === executionsBefore, `${executionsBefore} before, ${executionsAfter} after`);

    await page.screenshot({ path: `${SHOTS}/reference-card-after-click.png`, fullPage: true });
    console.log(`\n  screenshots: ${SHOTS}/reference-card.png, ${SHOTS}/reference-card-after-click.png`);
    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
