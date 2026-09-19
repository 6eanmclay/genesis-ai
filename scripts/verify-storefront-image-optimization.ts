import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";
import { DEFAULT_THEME } from "@/lib/theme";

// THE STOREFRONT ASKS FOR THE SIZE IT DRAWS (2026-09-18):
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-storefront-image-optimization.ts" -OutFile out.txt
//
// ============ WHAT WENT WRONG, AND WHY IT WAS INVISIBLE ================
//
// Every storefront image was a raw <img> on the full-size Blob original. A
// 64px thumbnail downloaded the whole 1024x1024 PNG; the homepage rendered
// EVERY active product that way, with no pagination. At ~1.8MB an image that
// is ~20MB for a ten-product shop, per visit, and it put Blob Data Transfer
// at 9.44GB of a 10GB allowance — where exceeding it does not bill, it CUTS
// OFF Blob access for 30 days.
//
// None of it looked wrong. The images rendered perfectly; they were simply
// enormous. That is exactly the shape of defect an assertion has to carry,
// because no screenshot and no reviewer will ever catch it.
//
// Three components explained the raw <img> with the same recorded reason:
// Blob is "an arbitrary per-deployment host". It is not. The subdomain is the
// blob STORE id and is fixed for the store's lifetime, so one remotePatterns
// entry covers it permanently. The config was simply never added.
//
// ============ WHAT THIS SUITE HOLDS ====================================
//
// Two independent things, because they fail independently:
//
//   1. THE POLICY. The optimizer must accept the Blob host and keep refusing
//      everything else. Asserted against the real /_next/image endpoint, not
//      by reading the config, so a config that parses but does not take
//      effect still fails.
//
//   2. THE DRAWN BOX AND THE REQUESTED WIDTH. Converting to next/image must
//      not have moved a single pixel of layout, and must actually request a
//      small variant. The second half is the point of the change: a
//      conversion that kept the dimensions but still asked for w=1024 would
//      look identical, pass any visual review, and save nothing.
//
// WHY A LOCAL IMAGE IN SECTION 2. The seeded product points at a real file in
// public/ rather than a Blob URL, because a Blob URL has no bytes behind it
// in a test and an image that fails to load has no measurable box. Section 1
// is what covers the remote host, against the live endpoint. Neither section
// stands in for the other and both have to pass.

const IMAGE = "/brand/j4-brain-map.png"; // real file, 600x600, square
const BLOB_HOST = "https://abc123xyz.public.blob.vercel-storage.com";

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

/** The rendered box and the URL the browser actually chose, for one element. */
type Drawn = { found: boolean; tag: string; w: number; h: number; url: string };

async function drawn(page: Page, selector: string): Promise<Drawn> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLImageElement | null;
    if (!el) return { found: false, tag: "", w: 0, h: 0, url: "" };
    const r = el.getBoundingClientRect();
    return {
      found: true,
      tag: el.tagName,
      w: Math.round(r.width),
      h: Math.round(r.height),
      // currentSrc is what the browser PICKED out of the srcset. `src` alone
      // would read the fallback and report a width nobody downloaded.
      url: el.currentSrc || el.src || "",
    };
  }, selector);
}

/** The `w=` the optimizer was asked for, or -1 when it was not asked at all. */
function requestedWidth(url: string): number {
  if (!url.includes("/_next/image")) return -1;
  const w = new URL(url, "http://local").searchParams.get("w");
  return w ? Number(w) : -1;
}

async function main() {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    // ================= 1. THE POLICY, AGAINST THE REAL ENDPOINT =========
    //
    // A disallowed host is a 400 from Next itself. An ALLOWED host that has
    // no bytes behind it is anything else (Next gets that far and then fails
    // to fetch). So "not 400" is precisely "the config let this through",
    // which is the only thing section 1 claims.
    const optimizer = (raw: string, w = 64) =>
      `${server.baseUrl}/_next/image?url=${encodeURIComponent(raw)}&w=${w}&q=75`;

    const allowed = await fetch(optimizer(`${BLOB_HOST}/products/x.png`));
    assert(
      "the Blob host is accepted by the optimizer",
      allowed.status !== 400,
      `got 400 - remotePatterns does not cover ${BLOB_HOST}`,
    );

    const foreign = await fetch(optimizer("https://images.example.com/x.png"));
    eq("a host we never allowed is still refused", foreign.status, 400);

    // `search: ""` in the config. Without it a caller can append anything to
    // a Blob path, which is the documented way this turns into an open proxy.
    const withQuery = await fetch(optimizer(`${BLOB_HOST}/products/x.png?v=1`));
    eq("a query string on a Blob URL is refused", withQuery.status, 400);

    // SVG is not exercisable without a real SVG upstream, so this guards the
    // thing that would actually go wrong: somebody switching it on later.
    const config = readFileSync("next.config.ts", "utf8");
    assert(
      "dangerouslyAllowSVG is not enabled",
      !/dangerouslyAllowSVG\s*:\s*true/.test(config),
      "SVG optimization would let a stored file execute script",
    );

    // ================= 2. THE DRAWN BOX AND THE REQUESTED WIDTH =========
    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `img-${stamp}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: "Lantern Goods", slug: `img-${stamp}`, currency: "USD", published: true,
        // `split` DELIBERATELY, not the default. Of the four hero layouts only
        // `split` has an image slot at all (heroLayoutRendersImage), so a
        // default-themed fixture renders no hero image and every assertion
        // about the hero would be measuring an element that is not there. The
        // first version of this suite did exactly that and reported a missing
        // preload as a defect.
        theme: { ...DEFAULT_THEME, composition: { ...DEFAULT_THEME.composition, heroLayout: "split" } },
      },
    });
    await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_img" },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id, name: "Brass Lantern", description: "a", priceInCents: 4200,
        active: true, position: 0, imageUrl: IMAGE,
      },
    });
    // Three, so the detail page renders its thumbnail strip at all.
    for (let i = 0; i < 3; i++) {
      await prisma.productImage.create({ data: { productId: product.id, url: IMAGE, position: i } });
    }

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    const go = (path: string) =>
      page.goto(`${server.baseUrl}${path}`, { waitUntil: "load", timeout: 90_000 });

    // ---- the storefront homepage ----
    await go(`/store/${store.slug}`);
    await page.waitForSelector("img", { timeout: 30_000 });

    const card = await drawn(page, "li img");
    assert("the storefront draws a product card image at all", card.found);
    eq("it is still an <img> element", card.tag, "IMG");
    assert(
      "the storefront image goes through the optimizer",
      card.url.includes("/_next/image"),
      `src was ${card.url.slice(0, 90)}`,
    );
    assert(
      "its box is square, as the aspect-square wrapper always made it",
      card.w > 0 && Math.abs(card.w - card.h) <= 1,
      `${card.w}x${card.h}`,
    );
    // Measured on the unconverted storefront: 302x302 at this viewport.
    eq("the card image box is unchanged at this viewport", card.w, 302);
    // THE SAVING ITSELF. A conversion that kept every dimension but still
    // asked for the 1024 original would pass everything above this line.
    const cardW = requestedWidth(card.url);
    assert(
      "it asks for a variant sized to its slot, not the 1024 original",
      cardW > 0 && cardW < 1024,
      `requested w=${cardW}`,
    );

    // ---- the hero: the one image on the page worth preloading ----
    const hero = await drawn(page, ".design-hero-image img");
    assert("the split hero renders its image", hero.found);
    assert(
      "the hero image goes through the optimizer",
      hero.url.includes("/_next/image"),
      `src was ${hero.url.slice(0, 90)}`,
    );

    // MATCHED TO THE HERO'S OWN SOURCE, not merely `as="image"` present. A
    // page here already carries an unrelated as="image" preload — the very
    // first baseline run showed one on a storefront with no hero image at
    // all — so the loose form of this assertion passes whether or not the
    // hero is preloaded, which makes it worse than no assertion.
    //
    // READ FROM `imagesrcset`, NOT `href`. For a responsive image
    // ReactDOM.preload emits imagesrcset/imagesizes and leaves href empty, so
    // the browser can pick a candidate. Reading href finds "" and reports a
    // working preload as missing; that is what the first version did.
    const preloadedHero = await page.evaluate((heroUrl: string) => {
      const upstream = new URL(heroUrl, location.origin).searchParams.get("url");
      if (!upstream) return false;
      return [...document.querySelectorAll('link[rel="preload"][as="image"]')].some((l) => {
        const candidates = `${l.getAttribute("imagesrcset") ?? ""} ${l.getAttribute("href") ?? ""}`;
        return candidates.includes(encodeURIComponent(upstream)) || candidates.includes(upstream);
      });
    }, hero.url);
    assert(
      "the hero image itself is preloaded from the head",
      preloadedHero,
      "no preload link carries the hero's own upstream URL",
    );

    // ---- the product detail page: 64px thumbnails ----
    await go(`/store/${store.slug}/products/${product.id}`);
    await page.waitForSelector("button img", { timeout: 30_000 });

    const thumb = await drawn(page, "button img");
    assert("the gallery draws a thumbnail", thumb.found);
    // 60, NOT 64, AND THAT IS THE ORIGINAL VALUE. The button is h-16 w-16 with
    // border-2 under Tailwind's border-box sizing, so its CONTENT box is
    // 64 - 2 - 2 = 60 and the image inside fills that. Measured at 60x60 on
    // the unconverted storefront before this change and 60x60 after it.
    //
    // Asserting 64 here — which the class name plainly suggests and which the
    // first version of this suite did — reports a defect that does not exist.
    // Both boxes are pinned below so neither can drift unnoticed.
    eq("the thumbnail image box is unchanged at 60px wide", thumb.w, 60);
    eq("the thumbnail image box is unchanged at 60px tall", thumb.h, 60);
    const thumbButton = await page.evaluate(() => {
      const b = document.querySelector("button:has(img)") as HTMLElement | null;
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    eq("the thumbnail button is still the 64px box it always was", JSON.stringify(thumbButton), JSON.stringify({ w: 64, h: 64 }));
    const thumbW = requestedWidth(thumb.url);
    assert(
      "a 64px thumbnail no longer downloads the 1024px original",
      thumbW > 0 && thumbW <= 128,
      `requested w=${thumbW} for a 64px box`,
    );

    // ---- the bag: 80px line image ----
    await go(`/store/${store.slug}`);
    await page.locator('button:has-text("Add to Bag")').first().click();
    await page.waitForTimeout(1500);
    await go(`/store/${store.slug}/bag`);
    await page.waitForSelector("img", { timeout: 30_000 });

    const line = await drawn(page, "img");
    eq("the bag line image is still exactly 80px wide", line.w, 80);
    eq("the bag line image is still exactly 80px tall", line.h, 80);
    const lineW = requestedWidth(line.url);
    assert(
      "an 80px bag thumbnail asks for a small variant",
      lineW > 0 && lineW <= 256,
      `requested w=${lineW} for an 80px box`,
    );

    // ---- checkout review: 64px ----
    await go(`/store/${store.slug}/checkout/${product.id}`);
    await page.waitForSelector("img", { timeout: 30_000 });
    const review = await drawn(page, "img");
    eq("the checkout thumbnail is still exactly 64px wide", review.w, 64);
    eq("the checkout thumbnail is still exactly 64px tall", review.h, 64);
    const reviewW = requestedWidth(review.url);
    assert(
      "the checkout thumbnail asks for a small variant",
      reviewW > 0 && reviewW <= 128,
      `requested w=${reviewW} for a 64px box`,
    );

    // ================= 3. A HOST WE DO NOT OWN MUST STILL RENDER =======
    //
    // THE REGRESSION THIS SECTION EXISTS FOR. The first cut of this slice
    // pointed next/image at every storefront image, and next/image THROWS on
    // a remote src that remotePatterns does not cover — so a product whose
    // image sits on a supplier's CDN took the whole page down with a 500,
    // where the old raw <img> merely showed a broken thumbnail.
    //
    // That is not hypothetical: lib/sourcing/adopt.ts creates a real Product
    // with `imageUrl: candidate.imageUrl`, straight off the provider (see
    // lib/sourcing/aliexpress.ts's product_main_image_url). Every storefront
    // selling an adopted dropship product would have stopped rendering.
    //
    // So: it renders, and it renders the way it always did.
    const supplier = await prisma.product.create({
      data: {
        storeId: store.id, name: "Adopted Lamp", description: "b", priceInCents: 1900,
        active: true, position: 1, imageUrl: "https://ae01.alicdn.com/kf/adopted-lamp.jpg",
      },
    });

    const home = await fetch(`${server.baseUrl}/store/${store.slug}`);
    eq("a storefront with a supplier-hosted image still returns 200", home.status, 200);

    await go(`/store/${store.slug}`);
    await page.waitForSelector("img", { timeout: 30_000 });
    const supplierImg = await page.evaluate((needle: string) => {
      const el = [...document.querySelectorAll("img")].find((i) =>
        (i.getAttribute("src") ?? "").includes(needle),
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), src: el.getAttribute("src") ?? "" };
    }, "adopted-lamp");

    assert("the supplier-hosted image is still rendered", supplierImg !== null);
    assert(
      "it is left on its original URL rather than handed to the optimizer",
      !!supplierImg && !supplierImg.src.includes("/_next/image"),
      `src was ${supplierImg?.src.slice(0, 90)}`,
    );
    assert(
      "and it still occupies its square card box",
      !!supplierImg && supplierImg.w > 0 && Math.abs(supplierImg.w - supplierImg.h) <= 1,
      `${supplierImg?.w}x${supplierImg?.h}`,
    );

    // The product page for that same product must render too - the gallery is
    // a different component with the same exposure.
    const detail = await fetch(`${server.baseUrl}/store/${store.slug}/products/${supplier.id}`);
    eq("its product page returns 200 as well", detail.status, 200);

    // ---- nothing WE OWN went back to a raw <img> ----
    //
    // Scoped to sources we control, which is the actual rule. "No raw <img>
    // at all" would now be false by design — section 3 requires exactly one —
    // and a suite whose assertion contradicts its own fixture gets weakened
    // rather than fixed the next time it fails.
    const bypassed = await page.evaluate(() =>
      [...document.querySelectorAll("img")]
        .map((i) => i.getAttribute("src") ?? "")
        .filter((s) => {
          if (!s || s.startsWith("data:")) return false;
          if (s.includes("/_next/image")) return false;
          // A remote host that is not Blob is deliberately left alone.
          if (/^https?:\/\//.test(s) && !s.includes(".public.blob.vercel-storage.com")) return false;
          return true; // local or Blob, and it skipped the optimizer
        }),
    );
    eq("every image we control goes through the optimizer", JSON.stringify(bypassed), "[]");
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
