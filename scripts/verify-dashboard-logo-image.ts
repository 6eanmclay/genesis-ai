import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// THE BUSINESS LOGO KEEPS ITS 20px MARK, WHOEVER HOSTS IT:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-dashboard-logo-image.ts" -OutFile out.txt
//
// ============ WHAT THIS PROTECTS (2026-09-19) ==========================
//
// Tier B routed the dashboard's business logo through StoreImage. The logo is
// the one image on EVERY dashboard page, so it is also the one with the widest
// blast radius: `next/image` throws at render on a host remotePatterns does
// not cover, and a throw here does not break a 20px circle, it breaks every
// screen an owner has.
//
// And `Store.logoUrl` genuinely can hold a host we do not own.
// `update_brand_logo` takes `imageUrl: z.string()` with no URL validation and
// no ownership resolution — updateHero's resolveOwnedImageUrl has no
// counterpart on the logo path — so an owner-approved external logo is a
// legitimate stored value, guarded by authorization (always_ask) rather than
// by format or host.
//
// So the same logo is rendered twice here, from two different hosts, and the
// drawn box is asserted to be identical both times. The rendered mark must not
// depend on who hosts it; only whether it is optimized may.
//
// WHY THE PURE RULE IS NOT TESTED HERE. isOptimizableImageSrc is exhaustively
// covered in verify-store-image-host-rule.ts, in the code lane, because it is
// a pure function and a browser proves nothing extra about it. This suite
// exists for the two things only a real page can answer: the box, and whether
// the page renders at all.

const PASSWORD = "harness-password-not-a-real-one";
const OWNED_LOGO = "/brand/j4-brain-map.png";
const FOREIGN_LOGO = "https://ae01.alicdn.com/kf/owner-approved-logo.jpg";

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

/** Sign in through the real login form — same mechanics as verify-office-browser. */
async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // Submitted more than once on purpose: the submit is a client-side next-auth
  // call, so a click landing before React attaches its handler is simply lost.
  // Re-clicking a submit that already worked is harmless — the form is gone.
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
        timeout: 8_000,
      });
      break;
    } catch {
      // Still on /login — hydration had probably not finished. Try again.
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
    timeout: 30_000,
  });
}

/**
 * The logo mark beside the business name, as actually drawn.
 *
 * THE VISIBLE ONE, deliberately. `primaryNavRow` is mounted in two homes (see
 * DashboardShell's own note about "primaryNavRow's two mounted homes"), so the
 * selector always matches two logos and only one is shown at a given viewport.
 * Taking the first match measures whichever the markup happens to list first,
 * which at 1400px wide is the hidden one - a zero box that would fail every
 * dimension assertion here for a reason that has nothing to do with images.
 */
async function logoMark(page: Page, storeName: string) {
  return page.evaluate((name) => {
    const el = [...document.querySelectorAll(`img[alt="${name} icon"]`)].find(
      (i) => i.getBoundingClientRect().width > 0,
    ) as HTMLImageElement | undefined;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      // The ATTRIBUTE, not currentSrc: this asks which URL the page chose to
      // point at, which is the decision under test. currentSrc would also
      // report a resolved absolute URL for the raw case and blur the two.
      src: el.getAttribute("src") ?? "",
      radius: getComputedStyle(el).borderTopLeftRadius,
    };
  }, storeName);
}

/** Waits for a logo that is actually shown, not merely present in the markup. */
async function waitForVisibleLogo(page: Page, storeName: string): Promise<void> {
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll(`img[alt="${name} icon"]`)].some(
        (i) => i.getBoundingClientRect().width > 0,
      ),
    storeName,
    { timeout: 30_000 },
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
      data: { email: `logo-${stamp}@example.test`, name: "Owner", password: passwordHash },
    });
    const store = await prisma.store.create({
      data: {
        userId: owner.id,
        name: "Copper Works",
        slug: `logo-${stamp}`,
        currency: "USD",
        published: true,
        logoUrl: OWNED_LOGO,
      },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: store.id } });

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

    await signIn(page, server.baseUrl, owner.email!);

    // ================= 1. A LOGO WE HOST =================================
    await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "load", timeout: 90_000 });
    await waitForVisibleLogo(page, store.name);

    const ours = await logoMark(page, store.name);
    assert("the business logo renders on the dashboard", ours !== null);
    eq("it is drawn 20px wide, as h-5 w-5 always made it", ours?.w, 20);
    eq("and 20px tall", ours?.h, 20);
    assert(
      "a logo we host goes through the optimizer",
      !!ours && ours.src.includes("/_next/image"),
      `src was ${ours?.src.slice(0, 90)}`,
    );

    // ================= 2. AN OWNER-APPROVED FOREIGN LOGO =================
    //
    // The case that would have taken every dashboard page down. Same store,
    // same markup, only the host changes.
    await prisma.store.update({ where: { id: store.id }, data: { logoUrl: FOREIGN_LOGO } });

    const res = await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "load", timeout: 90_000 });
    eq("the dashboard still returns 200 with a foreign-hosted logo", res?.status(), 200);
    await waitForVisibleLogo(page, store.name);

    const foreign = await logoMark(page, store.name);
    assert("the foreign logo still renders", foreign !== null);
    assert(
      "it is left on its original URL rather than handed to the optimizer",
      !!foreign && !foreign.src.includes("/_next/image"),
      `src was ${foreign?.src.slice(0, 90)}`,
    );
    eq("its src is exactly what was stored", foreign?.src, FOREIGN_LOGO);

    // THE POINT OF THE WHOLE SLICE: who hosts it changes whether it is
    // optimized, and nothing else. A fallback that rendered a different box
    // would be a visual regression hiding behind a correct-looking test.
    eq("the drawn box is unchanged at 20px wide", foreign?.w, 20);
    eq("and unchanged at 20px tall", foreign?.h, 20);
    eq("and it is still the same circular mark", foreign?.radius, ours?.radius);

    // ================= 3. SVG IS STILL REFUSED BY THE OPTIMIZER ==========
    //
    // No SVG can reach Store.logoUrl today — every writer is constrained to
    // png/jpeg/webp and "svg" appears nowhere in lib/ or app/api — so this
    // asserts the floor rather than a live path: if one ever did arrive, the
    // optimizer must refuse it rather than process a file that can carry
    // script. `/next.svg` ships in public/, so this is a real local SVG that
    // the host rule DOES consider ours; only dangerouslyAllowSVG being off
    // stops it.
    const svg = await fetch(`${server.baseUrl}/_next/image?url=%2Fnext.svg&w=64&q=75`);
    eq("an SVG is refused by the optimizer", svg.status, 400);

    // And the control: the same request for a raster local asset succeeds, so
    // the 400 above is about SVG and not about local assets generally.
    const png = await fetch(`${server.baseUrl}/_next/image?url=%2Fbrand%2Fj4-brain-map.png&w=64&q=75`);
    eq("while a local raster asset optimizes normally", png.status, 200);
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
