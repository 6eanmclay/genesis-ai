import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// THE ROOMS, AS THEY ACTUALLY RENDER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-rooms-browser.ts" -OutFile out.txt
//
// verify-rooms.ts proves the room resolver and the token set are right. It
// cannot prove the shell applies them, and that gap is exactly where this
// codebase has been bitten twice — the category rail rendered, highlighted on
// tap, and changed nothing, because one line upstream still pinned the view.
// A ground that resolves correctly and is never painted looks identical to no
// ground at all from a unit test.
//
// So this walks a real browser between the three rooms and reads the COMPUTED
// background of <main> each time. Computed, not the class list: a class that
// loses the cascade is the failure worth catching, and `className.includes`
// would pass right through it.
//
// It also screenshots each room, because "the rooms feel different" is a claim
// only a person can settle, and Sean cannot see anything this suite merely
// asserts.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const PASSWORD = "a-real-passphrase-for-this-test";
const SHOTS = process.env.ROOM_SHOT_DIR ?? null;

/** Sign in through the real login form, retrying the pre-hydration click. */
async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // The submit is a client-side next-auth call, so a click that lands before
  // React attaches its handler is simply lost. See verify-office-browser.ts.
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 8_000 });
      break;
    } catch {
      // Still on /login — hydration had probably not finished.
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
}

/** The colour <main> is actually painted, as the browser resolved it. */
async function mainBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? getComputedStyle(main).backgroundColor : "(no main)";
  });
}

/** Whether figures in this room are set in tabular figures. */
async function mainFontVariant(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? getComputedStyle(main).fontVariantNumeric : "(no main)";
  });
}

async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main", { state: "attached", timeout: 60_000 });
  // The ground is server-rendered onto <main>, but the shell is a client
  // component — wait for it to settle rather than reading mid-hydration.
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function main() {
  const server = await startTestServer({ timeoutMs: 180_000 });
  const prisma = server.db.prisma;
  let browser: Browser | null = null;

  try {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const owner = await prisma.user.create({
      data: { email: "owner@rooms.test", name: "Owner", password: passwordHash },
    });
    const store = await prisma.store.create({
      data: {
        userId: owner.id,
        name: "Copper & Coil",
        slug: "copper-and-coil-rooms",
        tagline: "Hand-wound copper",
        description: "Tensor rings, wound by hand.",
        published: true,
      },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: store.id } });
    await prisma.product.create({
      data: { storeId: store.id, name: "Tensor Ring", description: "d", priceInCents: 8500, active: true },
    });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, owner.email!);

    const base = `${server.baseUrl}/b/${store.slug}`;
    const ground: Record<string, string> = {};

    // -----------------------------------------------------------------------
    console.log("\n1. Each room paints its own ground");
    // -----------------------------------------------------------------------
    for (const [room, path] of [
      ["arrival", ""],
      ["storefront", "/website"],
      ["studio", "/studio"],
      ["commerce", "/orders"],
    ] as const) {
      await visit(page, `${base}${path}`);
      ground[room] = await mainBackground(page);
      // Any resolved colour, in whatever notation the browser reports it.
      // Chromium returns lab(...) for Tailwind's oklch palette and rgb(...) for
      // plain white, so matching /^rgb/ tested the colour space rather than the
      // product — which is what the first run of this suite actually did.
      assert(`${room} paints a real colour`,
        ground[room].length > 0 && ground[room] !== "(no main)" && !ground[room].includes("transparent"),
        ground[room]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${room}.png`, fullPage: false });
    }

    // -----------------------------------------------------------------------
    console.log("\n2. The rooms are visibly different from one another");
    // -----------------------------------------------------------------------
    // THE ASSERTION THAT MATTERS. Level B is "the ground changes per room"; if
    // two rooms resolve to the same painted colour the level has silently
    // slipped back to A, and no unit test would say so.
    const rooms = ["storefront", "studio", "commerce"] as const;
    const painted = rooms.map((r) => ground[r]);
    check("no two rooms paint the same ground", new Set(painted).size, painted.length);
    for (const room of rooms) {
      assert(`${room} differs from arrival`, ground[room] !== ground.arrival,
        `${room} ${ground[room]} vs arrival ${ground.arrival}`);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Commerce is a ledger");
    // -----------------------------------------------------------------------
    await visit(page, `${base}/orders`);
    check("its figures are tabular", await mainFontVariant(page), "tabular-nums");
    assert("and no other room's are",
      (await (async () => { await visit(page, `${base}/website`); return mainFontVariant(page); })()) !== "tabular-nums",
      "tabular figures are the ledger's, not a global");
    assert("its ground is the paper itself, not a tint",
      ground.commerce === "rgb(255, 255, 255)" || ground.commerce === "rgb(24, 24, 27)",
      ground.commerce);

    // Every section of Commerce is the same room — the ledger and the catalogue
    // were merged deliberately (decision 2), so they must not look like two.
    for (const section of ["/products", "/customers", "/analytics", "/catalog"]) {
      await visit(page, `${base}${section}`);
      check(`${section} is the same room as Orders`, await mainBackground(page), ground.commerce);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. The navigation did not change");
    // -----------------------------------------------------------------------
    // "The user should never have to learn a new navigation system just to
    // understand where they are." The bar is identical in every room.
    //
    // THE ROOM BAR and the section row are two different things, and the first
    // run of this suite conflated them: it read every nav control on the page,
    // found Commerce's five sections where Storefront has two, and called the
    // navigation changed. It had not — the sections are SUPPOSED to differ per
    // room, and that is a separate property worth asserting on its own.
    const roomLabels = async (path: string) => {
      await visit(page, `${base}${path}`);
      // Read only the bars that carry ALL FOUR rooms. The Storefront room's
      // first section is also called "Storefront", so filtering the whole page
      // by label counted that section as a fifth room control — which is a real
      // naming overlap in the product, not a navigation change.
      return page.evaluate(() => {
        const wanted = ["Storefront", "Studio", "Commerce", "Account"];
        return Array.from(document.querySelectorAll("nav"))
          .map((nav) =>
            Array.from(nav.querySelectorAll("a, button"))
              .map((el) => el.textContent?.trim() ?? "")
              .filter((t) => wanted.includes(t))
          )
          .filter((labels) => wanted.every((w) => labels.includes(w)))
          .flat();
      });
    };
    const inStorefront = await roomLabels("/website");
    const inCommerce = await roomLabels("/orders");
    const inStudio = await roomLabels("/studio");
    assert("the four rooms read the same in Storefront and Commerce",
      JSON.stringify(inStorefront) === JSON.stringify(inCommerce),
      `${JSON.stringify(inStorefront)} vs ${JSON.stringify(inCommerce)}`);
    assert("and the same in Studio",
      JSON.stringify(inStorefront) === JSON.stringify(inStudio),
      JSON.stringify(inStudio));
    assert("every room bar carries all four rooms",
      ["Storefront", "Studio", "Commerce", "Account"].every((l) => inCommerce.includes(l)),
      JSON.stringify(inCommerce));

    // And the sections DO differ, which is the room carrying its own contents
    // rather than the navigation changing.
    const sectionsIn = async (path: string) => {
      await visit(page, `${base}${path}`);
      return page.evaluate(() => {
        const rooms = ["Storefront", "Studio", "Commerce", "Account"];
        return Array.from(new Set(
          Array.from(document.querySelectorAll("nav a, nav button"))
            .map((el) => el.textContent?.replace(/\d+$/, "").trim() ?? "")
            .filter((t) => t.length > 0 && !rooms.includes(t))
        ));
      });
    };
    const commerceSections = await sectionsIn("/orders");
    assert("Commerce shows its own five sections",
      ["Orders", "Products", "What you could sell", "Customers", "Revenue"].every((s) => commerceSections.includes(s)),
      JSON.stringify(commerceSections));
    assert("Studio shows none, because a room with one section needs no row",
      (await sectionsIn("/studio")).length === 0,
      JSON.stringify(await sectionsIn("/studio")));

    // -----------------------------------------------------------------------
    console.log("\n5. The Office looks the same over every room");
    // -----------------------------------------------------------------------
    // Decision 3, asserted rather than trusted: the Office renders ON TOP of a
    // room, so a ground that varied with what is underneath would read as
    // belonging to the room — which is how it becomes a fifth room.
    const officeGroundIn = async (path: string) => {
      await visit(page, `${base}${path}`);
      await page.click('button:has-text("J4 Portal")');
      await page.waitForFunction(
        () => document.querySelector(`[aria-label="J4's Office"]`)?.getAttribute("aria-hidden") === "false",
        undefined,
        { timeout: 15_000 }
      );
      const bg = await page.evaluate(() => {
        const tab = Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Understanding"
        );
        const form = tab?.closest("form");
        return form ? getComputedStyle(form).backgroundColor : "(no office)";
      });
      await page.keyboard.press("Escape");
      return bg;
    };
    const overCommerce = await officeGroundIn("/orders");
    const overStorefront = await officeGroundIn("/website");
    const overStudio = await officeGroundIn("/studio");
    check("the Office is identical over Commerce and Storefront", overStorefront, overCommerce);
    check("and over Studio", overStudio, overCommerce);
    assert("so the Office is J4's space rather than the room's",
      overCommerce !== ground.commerce,
      "it must not inherit the room it is opened from");

    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
