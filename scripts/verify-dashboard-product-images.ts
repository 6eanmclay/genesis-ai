import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// BOTH SIDES OF THE OWNERSHIP BOUNDARY, ON A CONVERTED DASHBOARD SURFACE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-dashboard-product-images.ts" -OutFile out.txt
//
// ============ WHAT TIER C CHANGED, AND WHAT COULD GO WRONG =============
//
// Tier C routed ~20 dashboard, studio, J4 and onboarding images through
// StoreImage. The product media gallery is the representative one: an 80px
// tile that used to download the full 1024x1024 original, on a page an owner
// opens constantly.
//
// The failure mode is not a large image, it is a dead page. `next/image`
// THROWS at render on a source remotePatterns does not cover, so the moment a
// converted surface meets a URL we do not own, the whole route 500s. That is
// not hypothetical - it is exactly what verify-checkout-presentation caught
// during Tier A, on a product whose image sat on a supplier host.
//
// So this suite asserts the boundary rather than the optimization:
//
//   1. a source we own   -> optimized, same 80px box
//   2. a supplier source -> raw <img> on its original URL, same 80px box,
//                           and the page still returns 200
//
// Point 2 is the one that matters. An image field in this app is MIXED:
// lib/sourcing/adopt.ts copies `candidate.imageUrl` straight off a provider
// API into a real Product, so "this column is ours" was never true.
//
// THE BOX IS ASSERTED ON BOTH SIDES. A fallback that rendered a different
// size would be a visual regression hiding behind a passing boundary test.

const PASSWORD = "harness-password-not-a-real-one";
const OWNED_IMAGE = "/brand/j4-brain-map.png";
const SUPPLIER_IMAGE = "https://ae01.alicdn.com/kf/adopted-product.jpg";

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
  // Submitted more than once on purpose — the submit is a client-side
  // next-auth call, so a click before hydration is simply lost.
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

/** Every gallery tile that is actually drawn, with the URL the page chose. */
async function tiles(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("img")]
      .filter((i) => i.getBoundingClientRect().width > 0)
      .map((i) => {
        const r = i.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), src: i.getAttribute("src") ?? "" };
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
      data: { email: `prodimg-${stamp}@example.test`, name: "Owner", password: passwordHash },
    });
    const store = await prisma.store.create({
      data: { userId: owner.id, name: "Copper Works", slug: `prodimg-${stamp}`, currency: "USD", published: true },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: store.id } });

    // ONE PRODUCT CARRYING BOTH CASES AT ONCE. Two products would let a page
    // that rendered only the first still pass.
    const product = await prisma.product.create({
      data: {
        storeId: store.id, name: "Brass Lantern", description: "a", priceInCents: 4200,
        active: true, position: 0, imageUrl: OWNED_IMAGE,
      },
    });
    await prisma.productImage.create({ data: { productId: product.id, url: OWNED_IMAGE, position: 0 } });
    await prisma.productImage.create({ data: { productId: product.id, url: SUPPLIER_IMAGE, position: 1 } });

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    await signIn(page, server.baseUrl, owner.email!);

    const res = await page.goto(`${server.baseUrl}/dashboard/products`, { waitUntil: "load", timeout: 90_000 });

    // THE HEADLINE ASSERTION. A converted surface holding a supplier URL used
    // to be a 500, not a broken thumbnail.
    eq("the products page returns 200 with a supplier-hosted image on it", res?.status(), 200);

    await page.waitForFunction(
      () => [...document.querySelectorAll("img")].some((i) => i.getBoundingClientRect().width > 0),
      undefined,
      { timeout: 30_000 },
    );

    const drawn = await tiles(page);

    // SCOPED TO THE GALLERY, by the box the gallery draws. The page carries
    // other images - GenesisAvatar already used next/image before any of this
    // work, and J4Character is deliberately left raw - so "the first optimized
    // image on the page" is not this gallery's tile. It picked up the avatar
    // at 220px the first time this ran.
    const galleryTiles = drawn.filter((t) => t.w === 80 && t.h === 80);
    const owned = galleryTiles.find((t) => t.src.includes("/_next/image"));
    const supplier = galleryTiles.find((t) => t.src === SUPPLIER_IMAGE);

    eq("the gallery drew both tiles at its own 80px box", galleryTiles.length, 2);

    assert("a tile for the image we own is drawn", !!owned, `saw ${JSON.stringify(drawn).slice(0, 200)}`);
    assert(
      "the owned tile goes through the optimizer",
      !!owned && owned.src.includes("/_next/image"),
      `src was ${owned?.src.slice(0, 90)}`,
    );
    eq("and it is drawn at the 80px the wrapper always gave it", owned?.w, 80);
    eq("and 80px tall", owned?.h, 80);

    assert("a tile for the supplier image is drawn too", !!supplier, "the fallback rendered nothing");
    eq("the supplier tile keeps its original URL", supplier?.src, SUPPLIER_IMAGE);
    eq("and is drawn at the same 80px box", supplier?.w, 80);
    eq("and the same 80px tall", supplier?.h, 80);

    // The optimizer asked for a tile-sized variant, not the original. Without
    // this, a conversion that preserved every box and still fetched 1024
    // would pass everything above.
    const w = owned ? Number(new URL(owned.src, "http://local").searchParams.get("w")) : -1;
    assert(
      "the owned tile asks for a tile-sized variant, not the original",
      w > 0 && w <= 256,
      `requested w=${w} for an 80px box`,
    );
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
