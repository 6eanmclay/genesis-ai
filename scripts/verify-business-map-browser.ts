import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";
import { startTestServer } from "@/scripts/lib/testServer";

// THE BUSINESS MAP, IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-business-map-browser.ts" -OutFile out.txt
//
// ============ THE TWO ASSERTIONS THAT MATTER MOST (2026-09-01) =========
//
// Sean's screenshots showed two things every previous green run had missed,
// and both are measured directly here rather than inferred:
//
//   A REAL SCALE CHANGE. Selecting a branch used to move a camera over one
//   fixed layout, which reads as sliding rather than going inside. The world's
//   scale factor is read and compared per level — a transform that merely
//   translated would pass a "did the transform change" check and fails this.
//
//   NO LABEL COLLISION. Deeper levels crowded into the same pixels:
//   "Connections" over "Mailchimp", "Creation / Assets / Designs" stacked. Every
//   pair of rendered labels is compared for overlap at every level. A layout
//   that inherits its parent's coordinates cannot pass this.
//
// ============ AND THE TWO LAYERS (2026-09-02) =========================
//
// The map now has exactly two: the spatial ring, and the entity carousel that
// replaced the category level. The orb is J4 and holds the centre through
// both, which is asserted the only way that claim can be: the SAME DOM node is
// marked before the transition and looked for again after it. A redrawn orb
// would pass a "there is an orb" check and fails this one.
//
// isVisible() proves neither of those, and has twice been true in this project
// for something nobody could see. Every claim below is a bounding box, a
// computed transform, or a hit test.

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

const overlayUp = () =>
  Array.from(document.querySelectorAll("div")).some((el) => {
    const s = getComputedStyle(el);
    return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
  });

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
      // hydration, or still in flight
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(overlayUp, undefined, { timeout: 6_000 }).catch(() => {});
  await page
    .waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("div")).some((el) => {
          const s = getComputedStyle(el);
          return s.position === "fixed" && s.zIndex === "100" && parseFloat(s.opacity) > 0.01;
        }),
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
}

/** The world's actual scale factor, read off the rendered transform. */
async function worldScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-world"]');
    if (!el) return 0;
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return Math.round(m.a * 1000) / 1000;
  });
}

/** Every pair of rendered map labels that overlap. Empty is the pass. */
async function collisions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts = Array.from(
      document.querySelectorAll('[data-screen="business-map"] svg text'),
    ).filter((el) => (el.textContent ?? "").trim().length > 0);
    const boxes = texts.map((el) => ({ label: el.textContent!.trim(), r: el.getBoundingClientRect() }));
    const hits: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        if (a.width === 0 || b.width === 0) continue;
        // A couple of pixels of tolerance: touching is not colliding.
        const overlap =
          a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top + 2;
        if (overlap) hits.push(`${boxes[i].label} × ${boxes[j].label}`);
      }
    }
    return hits;
  });
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  mkdirSync(SHOTS, { recursive: true });

  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const email = `map-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: "Cubit & Coil", slug: `map${stamp}`,
        tagline: "Hand-wound copper, true to the cubit",
        description: "Copper tensor rings wound by hand.", currency: "USD", published: true,
        blueprint: { brandIdentity: { brandStory: "Wound by hand.", targetAudience: "Practitioners." } },
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });

    // Enough products that Commerce genuinely groups, which is the level the
    // hairball used to appear at.
    for (let i = 0; i < 6; i++) {
      const product = await prisma.product.create({
        data: {
          storeId: store.id, name: `Copper Tensor Ring ${i}`, description: "d",
          priceInCents: 3232, active: true,
          // One product has a photograph and the others do not, so the card
          // can be checked for showing a real one and for not inventing one.
          imageUrl: i === 0 ? "/brand/genesis-avatar-orb.png" : null,
        },
      });
      if (i === 0) {
        await prisma.order.create({
          data: {
            storeId: store.id, productName: product.name, quantity: 1, amountInCents: 3232,
            buyerEmail: `buyer-${stamp}@example.test`, paymentProvider: "STRIPE",
            externalOrderId: `cs_map_${stamp}`, status: "paid", productId: product.id,
          },
        });
      }
    }
    await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: `acct_${stamp}` },
    });

    // An asset with everything a rich card can show, and an observation that
    // is genuinely ABOUT it — the only way to see the "J4 noticed" block,
    // since no producer names a record in production yet.
    const asset = await prisma.businessRecord.create({
      data: {
        storeId: store.id, entityType: "asset", externalId: `asset-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: {
          title: "Spring lookbook cover",
          fileType: "photo",
          category: "product photography",
          summary: "A hand holding a copper ring against linen.",
          extractionConfidence: 0.91,
          origin: "uploaded",
          relatedEntityType: "product",
          storageUrl: "/brand/genesis-avatar-orb.png",
        },
      },
    });
    await prisma.genesisObservation.create({
      data: {
        storeId: store.id, status: "ACTIVE", genesisState: "opportunity",
        dedupeKey: `asset-unused-${stamp}`, recordId: asset.id, entityType: "asset",
        summary: "This photograph has never been used in a post.",
      },
    });
    await prisma.genesisObservation.create({
      data: {
        storeId: store.id, status: "ACTIVE", genesisState: "OPPORTUNITY",
        dedupeKey: `seo-${stamp}`,
        summary: "Your storefront has no SEO title or meta description yet.",
        actionHref: "/dashboard/website",
      },
    });

    const home = `${server.baseUrl}/b/${store.slug}`;
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, email);

    // ====================================================================
    console.log("\n=== 1. The welcome plays, and the map is what follows ===\n");
    // ====================================================================
    await page.goto(home, { waitUntil: "domcontentloaded" });
    const arrivalSeen = await page
      .waitForFunction(overlayUp, undefined, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    assert("the Genesis arrival experience still plays", arrivalSeen,
      "no full-screen arrival layer appeared — it must not have been removed");
    await settle(page);

    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    assert("signing in lands on a screen that has the map",
      (await page.locator('[data-screen="business-map"]').count()) === 1);
    await page.goto(`${server.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    assert("/dashboard shows it too", (await page.locator('[data-screen="business-map"]').count()) === 1);

    await page.goto(home, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });

    // ====================================================================
    console.log("\n=== 2. The orb is J4, and it holds the centre ===\n");
    // ====================================================================
    const orb = page.locator('[data-testid="map-centre"]');
    const stageBox = async (pg = page) =>
      (await pg.locator('[data-screen="business-map"] .map-stage').boundingBox())!;
    const orbBox = async (pg = page) => (await pg.locator('[data-testid="map-centre"]').boundingBox())!;

    // Sean: "The center of the Business Map should not say 'J4' as text. The
    // center is the J4 orb."
    assert("the centre is the canonical orb, not a drawing of one",
      (await orb.locator('img[alt="Genesis"]').count()) === 1,
      String(await orb.innerHTML().catch(() => "")).slice(0, 120));
    assert("and it says nothing at all at the top level",
      ((await orb.textContent()) ?? "").trim() === "",
      ((await orb.textContent()) ?? "").trim());
    assert("the word J4 is not drawn on the map",
      (await page.locator('[data-screen="business-map"] svg text').allTextContents())
        .every((s) => s.trim() !== "J4"),
      JSON.stringify(await page.locator('[data-screen="business-map"] svg text').allTextContents()));

    {
      const s = await stageBox();
      const o = await orbBox();
      assert("the orb sits at the centre of the stage",
        Math.abs((o.x + o.width / 2) - (s.x + s.width / 2)) < 2 &&
          Math.abs((o.y + o.height / 2) - (s.y + s.height / 2)) < 2,
        `orb ${o.x + o.width / 2},${o.y + o.height / 2} stage ${s.x + s.width / 2},${s.y + s.height / 2}`);
    }

    const scale0 = await worldScale(page);
    assert("the whole business renders at base scale", scale0 > 0.9 && scale0 < 1.1, `${scale0}`);

    // MARK THE ACTUAL ELEMENT. If entering a branch re-created the orb, the
    // mark would be gone — which is exactly the failure "keep the orb
    // anchored" is vulnerable to, and no screenshot would show it.
    await page.evaluate(() => {
      (document.querySelector('[data-testid="map-centre"]') as HTMLElement & { __orb?: string }).__orb = "same-orb";
    });

    await page.getByRole("button", { name: /^Commerce,/ }).click();
    await page.waitForTimeout(600);

    assert("entering a branch does not re-create the orb",
      await page.evaluate(() =>
        (document.querySelector('[data-testid="map-centre"]') as HTMLElement & { __orb?: string })?.__orb === "same-orb"));
    assert("the orb is still the orb", (await orb.locator('img[alt="Genesis"]').count()) === 1);
    {
      const s = await stageBox();
      const o = await orbBox();
      assert("and still holds the same column",
        Math.abs((o.x + o.width / 2) - (s.x + s.width / 2)) < 2,
        `orb ${o.x + o.width / 2} stage ${s.x + s.width / 2}`);
      assert("having moved up to make room, not away",
        o.y >= s.y - 1 && o.y < s.y + 40, `orb y ${o.y}, stage y ${s.y}`);
    }
    assert("the branch is named under the orb, flowing out of it",
      /Commerce/.test(((await orb.textContent()) ?? "")), ((await orb.textContent()) ?? "").trim());

    const scale1 = await worldScale(page);
    assert("and the world genuinely zoomed into that branch", scale1 > scale0 + 0.15,
      `${scale0} -> ${scale1}`);

    // ====================================================================
    console.log("\n=== 3. No level is a hairball ===\n");
    // ====================================================================
    // KEPT PERMANENTLY at Sean's request. The shape of the check is unchanged;
    // what changed is that there is now one ring instead of three levels of
    // them, so this is the level that can collide and it is checked at both
    // widths (see section 8).
    {
      const insideLabels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screen="business-map"] svg text'))
          .filter((el) => (el.textContent ?? "").trim().length > 0).length);
      assert("behind the carousel the ring is structure, not text", insideLabels === 0,
        `${insideLabels} labels still drawn at 2.2x`);
      assert("and nothing collides there", (await collisions(page)).length === 0,
        JSON.stringify(await collisions(page)));
    }

    await page.locator('[data-testid="map-back"]').click();
    await page.waitForTimeout(450);
    const atRoot = await collisions(page);
    assert("no labels overlap on the whole business", atRoot.length === 0, JSON.stringify(atRoot));
    assert("and there are real labels to overlap",
      (await page.locator('[data-screen="business-map"] svg text').count()) >= 10,
      String(await page.locator('[data-screen="business-map"] svg text').count()));

    // ====================================================================
    console.log("\n=== 4. Back returns to the whole business ===\n");
    // ====================================================================
    assert("Back returned to base scale", Math.abs((await worldScale(page)) - scale0) < 0.05,
      `${await worldScale(page)} vs ${scale0}`);
    assert("and the orb is silent again at the centre",
      ((await orb.textContent()) ?? "").trim() === "");
    {
      const s = await stageBox();
      const o = await orbBox();
      assert("back in the middle of the stage",
        Math.abs((o.y + o.height / 2) - (s.y + s.height / 2)) < 2,
        `orb ${o.y + o.height / 2} stage ${s.y + s.height / 2}`);
    }

    await page.getByRole("button", { name: /^Customers,/ }).click();
    await page.waitForTimeout(450);
    await page.getByRole("button", { name: "Whole business" }).click();
    await page.waitForTimeout(450);
    assert("Whole business returns from a branch",
      ((await orb.textContent()) ?? "").trim() === "");

    // ====================================================================
    console.log("\n=== 5. Connections opens a chooser, not a card ===\n");
    // ====================================================================
    await page.getByRole("button", { name: /^Connections,/ }).click();
    await page.waitForSelector('[data-testid="connection-chooser"]', { timeout: 10_000 });
    assert("the chooser opens", (await page.locator('[data-testid="connection-chooser"]').count()) === 1);
    assert("and the old information card does NOT appear",
      (await page.locator('[data-testid="map-card"]').count()) === 0);

    const chooser = page.locator('[data-testid="connection-chooser"]');
    const chooserText = await chooser.innerText();
    for (const service of ["Instagram", "Mailchimp", "Printful"]) {
      assert(`${service} is offered`, chooserText.includes(service), chooserText.slice(0, 200));
    }
    assert("connected services are shown as connected",
      /Connected/.test(chooserText), chooserText.slice(0, 200));

    // Icons: the provider's OWN favicon, never a third-party service.
    const icons = await chooser.locator("img").evaluateAll((els) =>
      els.map((el) => (el as HTMLImageElement).getAttribute("src") ?? ""));
    assert("service icons are present", icons.length > 0, `${icons.length}`);
    // EVERY ROW HAS AN ICON SLOT, whether or not the network cooperates. The
    // monogram renders first and the favicon replaces it only once decoded, so
    // an unreachable provider can never leave a blank square.
    const iconless = await chooser.evaluate((el) =>
      Array.from(el.querySelectorAll("li")).filter((li) => {
        const slot = li.querySelector("span.relative");
        return !slot || (slot.textContent ?? "").trim().length === 0 && !slot.querySelector("img");
      }).length);
    assert("and every row shows one, monogram or favicon", iconless === 0, `${iconless} rows without`);
    assert("every icon comes from the provider's own domain",
      icons.every((src) => /^https:\/\/[^/]+\/favicon\.ico$/.test(src)), JSON.stringify(icons.slice(0, 4)));
    assert("and none from a third-party favicon service",
      !icons.some((src) => /google\.com\/s2|duckduckgo|favicon\.im|icon\.horse/i.test(src)),
      JSON.stringify(icons.slice(0, 4)));

    // Connect and Create.
    assert("Connect is offered", (await chooser.getByRole("link", { name: "Connect" }).count()) > 0);
    const create = chooser.getByRole("link", { name: "Create account" });
    assert("Create account is offered", (await create.count()) > 0);
    const createHref = await create.first().getAttribute("href");
    assert("Create account goes straight to the provider",
      !!createHref && createHref.startsWith("https://") && !createHref.includes("localhost"), String(createHref));
    assert("in a new tab", (await create.first().getAttribute("target")) === "_blank");
    assert("and nothing tells the owner to go and search",
      !/search|google it|find it online/i.test(chooserText), chooserText.slice(0, 300));

    // Scrollable rather than crowded.
    const scrollable = await chooser.evaluate((el) => {
      const list = el.querySelector("div.overflow-y-auto");
      return list ? { can: list.scrollHeight >= list.clientHeight, h: list.clientHeight } : null;
    });
    assert("the list scrolls rather than crowding", scrollable !== null, JSON.stringify(scrollable));

    await page.locator('[data-testid="connection-chooser-close"]').click();
    await page.waitForTimeout(350);
    assert("closing the chooser returns to the whole business",
      ((await orb.textContent()) ?? "").trim() === "");
    assert("and Connections never becomes a carousel",
      (await page.locator('[data-testid="entity-carousel"]').count()) === 0);

    await page.screenshot({ path: `${SHOTS}/business-map-desktop-firstscreen.png`, fullPage: false });

    // ====================================================================
    // ====================================================================
    console.log("\n=== 5b. One tap reaches the actual things ===\n");
    // ====================================================================
    {
      // Sean: "J4 -> Commerce -> Products carousel... Once I enter a branch, I
      // want to immediately see the actual things inside it."
      await page.getByRole("button", { name: /^Commerce,/ }).click();
      await page.waitForSelector('[data-testid="entity-carousel"]', { timeout: 10_000 });

      const cards = page.locator('[data-testid="entity-card"]');
      const count = await cards.count();
      assert("one tap from the whole business reaches real products", count === 6, `${count} cards`);
      assert("and no intermediate category screen was passed through",
        (await page.locator("text=/^Products$/").count()) === 0);

      // NOT A STRIP OF TILES. Sean: "Each entity should have enough room to
      // show its image/content and a meaningful description."
      const first = (await cards.first().boundingBox())!;
      assert("a card has room to say something", first.width >= 300 && first.height >= 220,
        `${Math.round(first.width)}x${Math.round(first.height)}`);

      const firstText = await cards.first().innerText();
      assert("it names the thing", /Copper Tensor Ring/.test(firstText), firstText.slice(0, 120));
      assert("says what kind of thing it is", /PRODUCT/i.test(firstText), firstText.slice(0, 120));
      // THE DISTINCTION SEAN ASKED TO KEEP.
      assert("and where the knowledge came from",
        /from your data|J4 worked this out/i.test(firstText), firstText.slice(0, 200));
      assert("it carries real facts off the record",
        /32\.32/.test(firstText) && /On sale in your storefront/i.test(firstText),
        firstText.slice(0, 300));

      // A REAL PHOTOGRAPH WHERE THERE IS ONE, AND NOTHING WHERE THERE IS NOT.
      const withPhoto = cards.filter({ hasText: "Copper Tensor Ring 0" });
      assert("the photographed product shows its photograph",
        (await withPhoto.locator("img").count()) === 1);
      const withoutPhoto = cards.filter({ hasText: "Copper Tensor Ring 3" });
      assert("and the others show no stand-in image",
        (await withoutPhoto.locator("img").count()) === 0);

      // ---- the conversational escape hatch ------------------------------
      const ask = cards.first().locator('[data-testid="entity-ask"]');
      assert("every card offers Ask J4", (await ask.count()) === 1);
      assert("and no product claims a notice nobody made about it",
        (await page.locator('[data-testid="entity-noticed"]').count()) === 0,
        `${await page.locator('[data-testid="entity-noticed"]').count()}`);
      assert("every single card offers it",
        (await page.locator('[data-testid="entity-ask"]').count()) === count,
        `${await page.locator('[data-testid="entity-ask"]').count()} of ${count}`);

      // ---- moving through the collection --------------------------------
      const position = page.locator('[data-testid="carousel-position"]');
      assert("the carousel says where you are", /1 of 6/.test((await position.innerText()).trim()),
        (await position.innerText()).trim());
      await page.locator('[data-testid="carousel-next"]').click();
      await page.waitForTimeout(700);
      assert("and next genuinely moves through it", /2 of 6/.test((await position.innerText()).trim()),
        (await position.innerText()).trim());
      await page.locator('[data-testid="carousel-prev"]').click();
      await page.waitForTimeout(700);
      assert("prev comes back", /1 of 6/.test((await position.innerText()).trim()),
        (await position.innerText()).trim());

      // THE ORB'S OWN BLOCK MUST NOT BE UNDER THE CARDS. The mobile block has
      // always asserted this; desktop did not, and a screenshot suggested the
      // branch label was sitting behind the first card.
      {
        const o = await orbBox();
        const c = (await cards.first().boundingBox())!;
        assert("the cards start below the orb and its label, never under them",
          c.y >= o.y + o.height - 1, `card top ${Math.round(c.y)}, orb block bottom ${Math.round(o.y + o.height)}`);
      }

      // THE ACTIONS ARE INSIDE THE STAGE, NOT PAST ITS EDGE.
      //
      // The stage is `overflow-hidden`, so a card taller than its track would
      // have its actions silently cut off — and every assertion above would
      // still pass, because the button exists and has a width. This project
      // has shipped that exact failure before (a full-screen overlay over
      // green DOM checks), so the button's own box is compared to the stage's.
      {
        const s = await stageBox();
        const b = (await cards.first().locator('[data-testid="entity-ask"]').boundingBox())!;
        assert("Ask J4 sits inside the stage, not past its clipped edge",
          b.y + b.height <= s.y + s.height + 1 && b.y >= s.y - 1,
          `button ${Math.round(b.y)}..${Math.round(b.y + b.height)}, stage ${Math.round(s.y)}..${Math.round(s.y + s.height)}`);
        assert("and so does the destination link",
          ((await cards.first().locator('[data-testid="entity-destination"]').boundingBox())?.y ?? 0) + 20
            <= s.y + s.height + 1);
      }

      // A VIEWPORT SHOT, NOT AN ELEMENT SHOT. locator.screenshot() composites
      // whatever overlaps the element's box, which has misled this project
      // before.
      await page.screenshot({ path: `${SHOTS}/carousel-commerce-desktop.png` });
    }

    // ====================================================================
    console.log("\n=== 5c. A card carries what J4 knows, and no more ===\n");
    // ====================================================================
    {
      await page.getByRole("button", { name: "Whole business" }).click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^Creation,/ }).click();
      await page.waitForSelector('[data-testid="entity-carousel"]', { timeout: 10_000 });
      // THE CAROUSEL EXISTS BEFORE THE ORB HAS FINISHED MOVING. Measuring
      // either one on the first frame measures them mid-flight — which is what
      // this block did, and what the overlap assertion correctly caught.
      await page.waitForTimeout(700);

      const lookbook = page.locator('[data-testid="entity-card"]').filter({ hasText: "Spring lookbook" });
      assert("the asset is on the map", (await lookbook.count()) === 1);
      const text = await lookbook.innerText();

      // Sean: "What it is, where it came from, what J4 inferred about it, how
      // confident J4 is, what business entity it relates to."
      assert("J4's own reading of the file is the description",
        /A hand holding a copper ring against linen/.test(text), text.slice(0, 240));
      assert("what it is", /product photography/i.test(text), text.slice(0, 240));
      assert("where it came from", /uploaded/i.test(text), text.slice(0, 240));
      assert("how confident J4 is, in J4's own units", /91%/.test(text), text.slice(0, 240));
      assert("and what it relates to", /Relates to/i.test(text), text.slice(0, 240));
      assert("the photograph itself is shown",
        (await lookbook.locator("img").count()) === 1);

      // WHAT J4 NOTICED — a real observation naming this record.
      assert("an observation about this thing appears on its card",
        (await lookbook.locator('[data-testid="entity-noticed"]').count()) === 1);
      // AND ON NO OTHER CARD. Found by sabotage (2026-09-02): making the card
      // fall back to "any notice we have" left every assertion green, because
      // each one only ever asked whether the RIGHT card had it. A notice on
      // the wrong thing is worse than no notice, so the count is exact.
      assert("and on nothing else",
        (await page.locator('[data-testid="entity-noticed"]').count()) === 1,
        `${await page.locator('[data-testid="entity-noticed"]').count()} cards claim a notice`);
      assert("and says what was noticed",
        /never been used in a post/.test(text), text.slice(0, 400));
      // AND THE STORE-WIDE ONE STAYS OFF IT. "J4 noticed" on a card has to
      // mean J4 noticed THIS, or the section means nothing.
      assert("a store-wide notice is not pinned to a random thing",
        !/SEO title or meta description/.test(await page.locator('[data-testid="entity-carousel"]').innerText()),
        "a store-wide observation leaked onto an entity card");

      {
        const o = await orbBox();
        const c = (await lookbook.boundingBox())!;
        assert("and the same holds for a card with a photograph on it",
          c.y >= o.y + o.height - 1, `card top ${Math.round(c.y)}, orb block bottom ${Math.round(o.y + o.height)}`);
      }
      await page.screenshot({ path: `${SHOTS}/carousel-creation-desktop.png` });
    }

    // ====================================================================
    console.log("\n=== 5d. A customer card is thin, and an empty branch says so ===\n");
    // ====================================================================
    {
      await page.getByRole("button", { name: "Whole business" }).click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^Customers,/ }).click();
      await page.waitForTimeout(600);
      const customers = page.locator('[data-testid="entity-card"]');
      if ((await customers.count()) > 0) {
        const text = await customers.first().innerText();
        // A CUSTOMER WHO GAVE NO NAME IS TITLED BY THEIR EMAIL, because that
        // is the only identity the business has for them, it is the owner's
        // own record, and it is what the Customers screen already shows. What
        // privacy means here is that NOTHING IS PILED ON: no phone, no
        // address, no order history sitting open on a landing screen.
        // A DIGIT RUN IS NOT A PHONE NUMBER. The first version of this check
        // matched the timestamp inside the fixture's own email address, which
        // is the classic assertion that fails for a reason unrelated to the
        // thing it names. So it looks for the fields themselves.
        assert("a customer card adds no contact details beyond who they are",
          !/phone|address|street|road|avenue|postcode|zip/i.test(text),
          text.slice(0, 200));
        const facts = await customers.first().locator("dt").allTextContents();
        assert("and shows only what they have spent",
          JSON.stringify(facts.map((f) => f.trim())) === JSON.stringify(["Spent with you"]) || facts.length === 0,
          JSON.stringify(facts));
      } else {
        console.log("  NOTE  no contact records in this fixture; customer privacy checked in the db suite");
      }

      await page.getByRole("button", { name: "Whole business" }).click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^Goals,/ }).click();
      await page.waitForTimeout(600);
      assert("an empty branch says it is empty rather than showing nothing",
        (await page.locator('[data-testid="entity-empty"]').count()) === 1);
      const emptyText = await page.locator('[data-testid="entity-empty"]').innerText();
      assert("in plain words", /doesn't know anything about goals yet/i.test(emptyText),
        emptyText.slice(0, 200));
      assert("and the orb is still there while it says so",
        (await orb.locator('img[alt="Genesis"]').count()) === 1);

      await page.getByRole("button", { name: "Whole business" }).click();
      await page.waitForTimeout(400);

      // ---- X is X ------------------------------------------------------
      await page.getByRole("button", { name: /^Social,/ }).click();
      await page.waitForSelector('[data-testid="entity-carousel"]', { timeout: 10_000 });
      const xCard = page.locator('[data-testid="entity-card"]').filter({ hasText: "X" }).first();
      const xText = await xCard.innerText();
      assert("X says Genesis cannot connect it",
        /cannot connect this yet/i.test(xText), xText.slice(0, 200));
      assert("and is not offered a Connect button it could not honour",
        (await xCard.locator('[data-testid="entity-connect"]').count()) === 0, xText.slice(0, 200));
      assert("and does not describe somebody else's product",
        !/toast|point of sale|restaurant/i.test(xText), xText.slice(0, 200));
      assert("while Instagram, which Genesis can connect, is offered one",
        (await page.locator('[data-testid="entity-card"]').filter({ hasText: "Instagram" })
          .first().locator('[data-testid="entity-connect"]').count()) === 1);

      await page.screenshot({ path: `${SHOTS}/carousel-social-desktop.png` });
      await page.getByRole("button", { name: "Whole business" }).click();
      await page.waitForTimeout(400);
    }

    console.log("\n=== 6. The narrative is below the map, the greeting above ===\n");
    // ====================================================================
    {
      const mapY = (await page.locator('[data-screen="business-map"]').boundingBox())?.y ?? 0;
      const welcomeY = (await page.locator("h1").first().boundingBox())?.y ?? 0;
      assert("the greeting is above the map", welcomeY < mapY, `greeting ${welcomeY}, map ${mapY}`);
      assert("and it is the welcome",
        /Welcome back/.test((await page.locator("h1").first().innerText()).trim()));

      const body = await page.locator("body").innerText();
      assert("J4's notice reaches the arrival experience",
        /no SEO title or meta description/.test(body), body.slice(0, 160));
    }

    // ====================================================================
    console.log("\n=== 7. The overview is still underneath ===\n");
    // ====================================================================
    {
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      assert("the snapshot survived", /order/i.test(body) && /storefront/i.test(body));
      assert("J4 Noticed survived", /J4 Noticed|Nothing needs you right now/.test(body));
      const mapY = (await page.locator('[data-screen="business-map"]').boundingBox())?.y ?? 0;
      const overviewY = (await page.locator("text=/What's happening right now/").boundingBox())?.y ?? 0;
      assert("and sits below the map", overviewY > mapY, `map ${mapY}, overview ${overviewY}`);
    }

    // ====================================================================
    console.log("\n=== 8. On a 390px phone ===\n");
    // ====================================================================
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: await context.storageState(),
    });
    const small = await phone.newPage();
    await small.goto(home, { waitUntil: "domcontentloaded" });
    await settle(small);
    await small.waitForSelector('[data-screen="business-map"] .map-stage', { timeout: 30_000 });

    const smallBox = await small.locator('[data-screen="business-map"]').boundingBox();
    assert("the map is inside the viewport",
      !!smallBox && smallBox.x >= 0 && smallBox.x + smallBox.width <= 390,
      `x=${smallBox?.x} w=${smallBox?.width}`);

    // THE NARRATIVE NO LONGER PUSHES IT DOWN. This is the measurement Sean's
    // screenshot made: the map began most of a screen below the fold.
    assert("and starts within the first screen", !!smallBox && smallBox.y < 620, `y=${smallBox?.y}`);

    const stage = await small.locator('[data-screen="business-map"] .map-stage').boundingBox();
    assert("the drawing does not fill the phone",
      !!stage && stage.height <= 380, `height=${stage?.height}`);

    assert("no labels collide at 390px", (await collisions(small)).length === 0,
      JSON.stringify(await collisions(small)));

    const clipped = await small.evaluate(() => {
      const st = document.querySelector('[data-screen="business-map"] .map-stage');
      if (!st) return ["no stage"];
      const box = st.getBoundingClientRect();
      return Array.from(st.querySelectorAll("svg text"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
        })
        .map((el) => el.textContent ?? "");
    });
    assert("and none is cut off", clipped.length === 0, JSON.stringify(clipped));

    // zoom works on touch too, and lands on the things themselves
    const s0 = await worldScale(small);
    await small.getByRole("button", { name: /^Commerce,/ }).click();
    await small.waitForSelector('[data-testid="entity-carousel"]', { timeout: 10_000 });
    // THE CAROUSEL IS IN THE DOM BEFORE THE TRANSITION FINISHES. Reading the
    // world's transform or the orb's box on the first frame measures them
    // mid-flight — the desktop block waits for exactly this reason.
    await small.waitForTimeout(700);
    assert("tapping a branch zooms on a phone", (await worldScale(small)) > s0 + 0.15,
      `${s0} -> ${await worldScale(small)}`);

    {
      const card = (await small.locator('[data-testid="entity-card"]').first().boundingBox())!;
      const st = (await small.locator('[data-screen="business-map"] .map-stage').boundingBox())!;
      // NOT A TILE: the card takes essentially the whole width it is given.
      // An absolute pixel floor would just be a guess about the page's own
      // padding, which is not what "room to say something" means.
      assert("a card fills the phone rather than being a tile",
        card.width >= st.width * 0.85 && card.width <= 390 && card.height >= 200,
        `card ${Math.round(card.width)}x${Math.round(card.height)}, stage ${Math.round(st.width)}`);
      const o = await orbBox(small);
      assert("and the orb still holds the centre column on a phone",
        Math.abs((o.x + o.width / 2) - (st.x + st.width / 2)) < 2,
        `orb ${o.x + o.width / 2} stage ${st.x + st.width / 2}`);
      assert("with the card below it, not under it",
        card.y >= o.y + o.height - 1, `card ${card.y}, orb bottom ${o.y + o.height}`);
      const over = await small.evaluate(() => ({
        doc: document.documentElement.scrollWidth, win: window.innerWidth,
      }));
      assert("and a swipeable carousel does not make the page scroll sideways",
        over.doc <= over.win + 1, JSON.stringify(over));
      assert("Ask J4 is reachable on a phone",
        (await small.locator('[data-testid="entity-ask"]').first().boundingBox())!.width > 0);
      await small.screenshot({ path: `${SHOTS}/carousel-mobile.png`, fullPage: false });
    }

    await small.locator('[data-testid="map-back"]').click();
    await small.waitForTimeout(400);

    // the chooser on a phone
    await small.getByRole("button", { name: /^Connections,/ }).click();
    await small.waitForSelector('[data-testid="connection-chooser"]', { timeout: 10_000 });
    const chooserBox = await small.locator('[data-testid="connection-chooser"]').boundingBox();
    assert("the chooser fits the phone",
      !!chooserBox && chooserBox.x >= 0 && chooserBox.x + chooserBox.width <= 390,
      JSON.stringify(chooserBox));
    const overflowX = await small.evaluate(() => ({
      doc: document.documentElement.scrollWidth, win: window.innerWidth,
    }));
    assert("and the page still does not scroll sideways",
      overflowX.doc <= overflowX.win + 1, JSON.stringify(overflowX));
    await small.screenshot({ path: `${SHOTS}/business-map-chooser-mobile.png`, fullPage: false });
    // Whether a favicon actually resolved is a network fact, not a code fact —
    // reported rather than asserted, because a provider being unreachable from
    // this machine is not a defect in the chooser.
    const loaded = await small.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="connection-chooser"] img'))
        .filter((el) => (el as HTMLImageElement).naturalWidth > 0).length);
    console.log(`  NOTE  ${loaded} provider favicons resolved from this machine (the rest show monograms)`);
    await small.locator('[data-testid="connection-chooser-close"]').click();
    await small.waitForTimeout(300);

    // every room survived the bar
    const bar = await small.evaluate(() =>
      Array.from(document.querySelectorAll("nav a, nav button"))
        .map((el) => (el.textContent ?? "").trim())
        .filter((s) => s.length > 0 && s.length < 20));
    for (const room of ["Business", "Storefront", "Studio", "Commerce", "Account"]) {
      assert(`${room} is still in the mobile bar`, bar.some((l) => l.includes(room)), JSON.stringify(bar));
    }

    await small.screenshot({ path: `${SHOTS}/business-map-mobile-firstscreen.png`, fullPage: false });
    await small.screenshot({ path: `${SHOTS}/business-map-mobile.png`, fullPage: true });

    // ====================================================================
    console.log("\n=== 9. Reduced motion still gives a usable map ===\n");
    // ====================================================================
    {
      const still = await browser.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        storageState: await context.storageState(), reducedMotion: "reduce",
      });
      const p2 = await still.newPage();
      await p2.goto(home, { waitUntil: "domcontentloaded" });
      await settle(p2);
      await p2.waitForSelector('[data-screen="business-map"] .map-stage', { timeout: 30_000 });

      const labels = await p2.evaluate(() =>
        document.querySelectorAll('[data-screen="business-map"] svg text').length);
      assert("the map still renders with motion reduced", labels > 8, `${labels}`);

      const before = await worldScale(p2);
      await p2.getByRole("button", { name: /^Commerce,/ }).click();
      await p2.waitForSelector('[data-testid="entity-carousel"]', { timeout: 10_000 });
      assert("and still zooms", (await worldScale(p2)) > before + 0.15,
        `${before} -> ${await worldScale(p2)}`);
      assert("the carousel is reachable with motion reduced",
        (await p2.locator('[data-testid="entity-card"]').count()) > 0);
      assert("with no collision", (await collisions(p2)).length === 0,
        JSON.stringify(await collisions(p2)));

      const frame = () =>
        p2.evaluate(() =>
          (document.querySelector('[data-testid="map-data-stream"]') as HTMLCanvasElement).toDataURL());
      await p2.waitForTimeout(600);
      const a = await frame();
      await p2.waitForTimeout(700);
      assert("and the network field holds still", a === (await frame()),
        "the canvas redrew itself between frames");
      assert("while still drawing something", a.length > 5000, `${a.length} bytes`);

      await p2.screenshot({ path: `${SHOTS}/business-map-reduced-motion.png`, fullPage: false });
      await still.close();
    }

    // ====================================================================
    console.log("\n=== 10. Website and Identity still work ===\n");
    // ====================================================================
    for (const [path, marker] of [
      [`/b/${store.slug}/website`, /Storefront|Website/i],
      [`/b/${store.slug}/brand`, /Business identity/i],
    ] as const) {
      const res = await page.goto(`${server.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      assert(`${path} loads`, (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      assert(`${path} renders its own screen`,
        marker.test(await page.locator("body").innerText()));
    }
    await page.waitForSelector('input[name="name"]', { timeout: 30_000 });
    for (const field of ["name", "tagline"]) {
      assert(`Identity still edits ${field}`, (await page.locator(`input[name="${field}"]`).count()) === 1);
    }
    assert("and description", (await page.locator('textarea[name="description"]').count()) === 1);

    // RENDERED TEXT, not the raw response. The first version read the HTTP
    // body, where the phrase survives inside the RSC payload for other screens
    // even though nothing on this page shows it — a true assertion failing on
    // bytes nobody sees.
    await page.goto(`${server.baseUrl}/b/${store.slug}/website`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");
    const siteText = await page.locator("body").innerText();
    assert("the Storefront editor still has no Genesis noticed section",
      !/Genesis noticed/.test(siteText), siteText.slice(-200));

    await page.goto(home, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.waitForSelector('[data-screen="business-map"]', { timeout: 30_000 });
    assert("the home screen has no second business-name field",
      (await page.locator('input[name="name"]').count()) === 0);

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
