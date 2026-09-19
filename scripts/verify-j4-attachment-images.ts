import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// WHAT A CHAT ATTACHMENT IS DRAWN AT, BEFORE AND AFTER TIER C:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-j4-attachment-images.ts" -OutFile out.txt
//
// ============ WHY THIS SUITE EXISTS (2026-09-19) =======================
//
// Tier C converted J4's two chat-attachment images, and they were the one pair
// whose settled box could not be argued from the markup. Both size themselves
// from the image's OWN aspect ratio - `w-auto` with a capped height - so
// adding width/height attributes could have imposed a shape.
//
// The reasoning says it does not: width/height give `aspect-ratio: auto W/H`,
// and that `auto` keyword prefers the natural ratio once the image loads. This
// measures it instead of trusting that.
//
// ============ THE FIXTURE IS THE REAL ONE ==============================
//
// Attachments live on StoreMessage.changes, read by extractImageUrl /
// extractImageUrls in app/j4/messageChanges.ts:
//
//     changes: { imageUrls: [...] }  -> the square photo grid
//     changes: { imageUrl: "..." }   -> the single inline attachment
//
// That is the production shape, and scripts/verify-conversation-vision.ts
// already seeds exactly it. Nothing here is invented for the test.
//
// ============ HOW TO READ A FAILURE ===================================
//
// The dimensions below were MEASURED on the unconverted app (c564730) and are
// pinned here. A mismatch means the conversion moved a box, which is the whole
// thing it was not allowed to do. It does not mean the number should be
// updated to match.
//
// This suite reaches J4 through the Office, which is the only path that
// renders J4Workspace, so it inherits verify-office-browser's known
// intermittent sign-in/open timeouts (VERIFICATION_LANES.md). A timeout here
// is the machine, not the boxes; a dimension mismatch is real.

const PASSWORD = "harness-password-not-a-real-one";

/**
 * A local public asset: real bytes, and a source the host rule calls ours.
 *
 * DELIBERATELY j4-rear-map, which nothing in the app renders. The first
 * version used j4-brain-map and the selector then also matched the Business
 * Map's own centre artwork, which uses that exact file and is deliberately
 * excluded from optimization - so the suite reported a correctly-raw image
 * as an unconverted attachment.
 */
const OWNED = "/brand/j4-rear-map.png";

/**
 * MEASURED on c564730, before the conversion, with this same fixture:
 * the single inline attachment at max-h-64 settles at 256, the two grid
 * tiles at 81 each, and the Office carries one more 104px rendering of the
 * same asset. All four were raw <img> then; all four must keep these boxes
 * now. A mismatch means the conversion moved something.
 */
/**
 * MEASURED on c564730, before the conversion, with this same fixture: the
 * single inline attachment capped at max-h-64 settles at 269x256, and the two
 * grid tiles at 81 each. All were raw <img> then.
 *
 * THE NON-SQUARE NUMBERS ARE THE POINT. This asset is 1.05:1, so if the
 * width/height attributes had imposed their own ratio these would come back
 * square. They are what proves `aspect-ratio: auto W/H` defers to the
 * natural ratio once the image loads.
 */
const OFFICE_BASELINE = "[[269,256],[81,81],[81,81]]";

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  - ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  - ${detail}` : ""}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  assert(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 8_000 });
      break;
    } catch {
      /* not hydrated yet */
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
}

/** Every drawn image whose source resolves to our seeded attachment. */
async function attachments(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("img")]
      .filter((i) => {
        const s = i.getAttribute("src") ?? "";
        return i.getBoundingClientRect().width > 0 && s.includes("j4-rear-map");
      })
      .map((i) => {
        const r = i.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          optimized: (i.getAttribute("src") ?? "").includes("/_next/image"),
        };
      }),
  );
}

async function main() {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const owner = await prisma.user.create({
      data: { email: `j4img-${stamp}@example.test`, name: "Owner", password: passwordHash },
    });
    const store = await prisma.store.create({
      data: { userId: owner.id, name: "Copper Works", slug: `j4img-${stamp}`, currency: "USD", published: true },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: store.id } });

    // The real shapes, exactly as messageChanges.ts reads them.
    await prisma.storeMessage.create({
      data: { storeId: store.id, role: "user", content: "Uploaded 1 photos", changes: { imageUrl: OWNED } },
    });

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    await signIn(page, server.baseUrl, owner.email!);

    // ---- the single inline attachment, in the Room (a real route) --------
    await page.goto(`${server.baseUrl}/j4/room`, { waitUntil: "load", timeout: 90_000 });
    await page.waitForFunction(
      () => [...document.querySelectorAll("img")].some((i) => (i.getAttribute("src") ?? "").includes("j4-rear-map")),
      undefined,
      { timeout: 30_000 },
    );
    // The image has to have LOADED before its box means anything: the whole
    // question is whether the natural ratio wins over the attribute ratio,
    // and before load only the attribute ratio exists.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("img")]
          .filter((i) => (i.getAttribute("src") ?? "").includes("j4-rear-map"))
          .every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0),
      undefined,
      { timeout: 30_000 },
    );

    const room = await attachments(page);
    console.log(`    room attachments: ${JSON.stringify(room)}`);
    assert("the Room draws the seeded attachment", room.length > 0);

    // MEASURED ON c564730, BEFORE THE CONVERSION. 202x192, NOT square: the
    // asset is 1.05:1 and max-h-48 caps the height, so the width follows the
    // image's own ratio. That is exactly what the attributes could have
    // broken, and the number is here to catch it if they ever do.
    eq("the Room attachment is still 202px wide", room[0]?.w, 202);
    eq("and still 192px tall", room[0]?.h, 192);
    assert("and it goes through the optimizer", room[0]?.optimized === true);

    // ---- the Office, which is the only path that renders J4Workspace -----
    //
    // Two more attachment shapes live there: the square photo GRID
    // (changes.imageUrls) and the single inline attachment
    // (changes.imageUrl). Seeded now so the Room section above stays a
    // single-image case.
    await prisma.storeMessage.create({
      data: {
        storeId: store.id,
        role: "user",
        content: "Uploaded 2 photos",
        changes: { imageUrls: [OWNED, OWNED] },
      },
    });

    await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "load", timeout: 90_000 });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.click('[data-testid="j4-office"]');
    await page.waitForFunction(
      () => document.querySelector("[data-j4-presentation='office']")?.getAttribute("aria-hidden") === "false",
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("img")]
          .filter((i) => (i.getAttribute("src") ?? "").includes("j4-rear-map"))
          .filter((i) => i.getBoundingClientRect().width > 0)
          .every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0),
      undefined,
      { timeout: 30_000 },
    );

    const office = await attachments(page);
    console.log(`    office attachments: ${JSON.stringify(office)}`);
    assert("the Office draws the seeded attachments", office.length > 0);
    assert(
      "every attachment the Office draws goes through the optimizer",
      office.every((a) => a.optimized),
      JSON.stringify(office),
    );

    // MEASURED ON c564730. Whatever the conversion did, it must not have
    // moved these; the numbers are pinned from the unconverted app.
    eq("the Office attachment boxes are unchanged", JSON.stringify(office.map((a) => [a.w, a.h])), OFFICE_BASELINE);
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
