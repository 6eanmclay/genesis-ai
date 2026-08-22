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

/**
 * Clear the returning-owner arrival ritual, if it is playing.
 *
 * It is a full-screen overlay, so every screenshot this suite took was a
 * picture of the ritual rather than of the room underneath — the assertions
 * passed the whole time, because computed styles are readable through it, and
 * the images were quietly worthless. Skipped through its own real control
 * rather than hidden with CSS, so what is captured is a state the owner
 * genuinely reaches.
 */
async function dismissArrival(page: Page): Promise<void> {
  // WAITED OUT, NOT CLICKED. The first attempt looked for the overlay's "Skip"
  // control — which DashboardShell never passes for this ritual, so there is no
  // such button and the wait was a no-op that changed nothing.
  //
  // It clears itself when its beat sequence finishes, and it plays once per
  // real sign-in, so one wait here covers every screenshot below. Identified by
  // what it actually is: a fixed, full-screen element at z-index 100.
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
      // Still up after 30s. Screenshots below will show it, and that is a
      // visible, honest failure rather than a silently wrong picture.
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
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Tensor Ring", description: "d", priceInCents: 8500, active: true },
    });
    // Real orders, from two buyers, so Orders and Customers both have more than
    // one row. Section 3b reads the RULE BETWEEN rows, which a single-row list
    // cannot show — a suite that seeded one order would pass against a ledger
    // with no separation at all.
    for (let i = 0; i < 3; i++) {
      await prisma.order.create({
        data: {
          storeId: store.id,
          productId: product.id,
          productName: product.name,
          amountInCents: 8_500,
          buyerEmail: `buyer${i % 2}@rooms.test`,
          paymentProvider: "STRIPE",
          externalOrderId: `ord-rooms-${i}`,
        },
      });
    }
    await prisma.product.create({
      data: { storeId: store.id, name: "Copper Bracelet", description: "d", priceInCents: 4200, active: true },
    });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, owner.email!);
    await dismissArrival(page);

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
      if (SHOTS) {
        await dismissArrival(page);
        await page.screenshot({ path: `${SHOTS}/${room}.png`, fullPage: false });
      }
    }

    // -----------------------------------------------------------------------
    console.log("\n1b. The ground the owner actually sees");
    // -----------------------------------------------------------------------
    // <main> carrying the right background is not the same as the owner seeing
    // it. A screen whose own root paints a full-height ground covers the room's
    // entirely — which is exactly what Decision 1 prohibits ("no per-page
    // styling... a screen that painted its own ground is how three rooms
    // quietly become three products"), and is invisible to a check that only
    // reads <main>.
    //
    // So this reads the element the owner is actually looking at: the first
    // child of <main> that paints an opaque ground across the full width.
    const visible: Record<string, string> = {};
    for (const [room, path] of [
      ["storefront", "/website"],
      ["studio", "/studio"],
      ["commerce", "/orders"],
    ] as const) {
      await visit(page, `${base}${path}`);
      visible[room] = await page.evaluate(() => {
        const main = document.querySelector("main");
        if (!main) return "(no main)";
        let painted: Element = main;
        for (const child of Array.from(main.querySelectorAll("div"))) {
          const style = getComputedStyle(child);
          const rect = child.getBoundingClientRect();
          const opaque =
            style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
          if (opaque && rect.width >= main.clientWidth * 0.9 && rect.height >= 400) {
            painted = child;
            break;
          }
        }
        return getComputedStyle(painted).backgroundColor;
      });
    }
    const seenGrounds = ["storefront", "studio", "commerce"].map((r) => visible[r]);
    check("no two rooms LOOK the same to the owner", new Set(seenGrounds).size, seenGrounds.length);

    // AND WHAT THEY SEE IS THE GROUND THE ROOM RESOLVED. Distinctness alone is
    // not enough, and asserting only that passed for the wrong reason on the
    // first run: Studio's own screen painted #faf9f7 over its room's ground,
    // which is still distinct from the other two while being nothing the room
    // decided. That is precisely what Decision 1 prohibits, and the check that
    // catches it is comparing the painted ground to <main>'s own.
    for (const room of ["storefront", "studio", "commerce"] as const) {
      assert(
        `${room} shows the ground its room resolved`,
        visible[room] === ground[room],
        `sees ${visible[room]}, room resolved ${ground[room]}`
      );
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
    console.log("\n3b. Ruled rows on a sheet, not cards floating on a ground");
    // -----------------------------------------------------------------------
    // Commerce's own density, approved by Sean 2026-08-22 and specified by the
    // room's own prose: "A tinted ground makes cards float, and floating cards
    // are what turn a ledger into a feed. So the ground is the paper itself,
    // and rows are separated by rules rather than by gaps between objects."
    //
    // THE TOKEN IS THE MECHANISM, and this is the assertion that proves it is
    // load-bearing rather than decorative: the list's gap is `--room-gap`, and
    // Commerce sets it to 0px. Read as a COMPUTED value from the real page, so
    // a token that stopped reaching these lists — the state this replaced,
    // where three declarations were read by nothing — fails here.
    for (const [label, section] of [
      ["Orders", "/orders"],
      ["Customers", "/customers"],
      ["Products", "/products"],
    ] as const) {
      await visit(page, `${base}${section}`);
      const row = await page.evaluate(() => {
        // The LEDGER list, named rather than guessed at. Taking "the first
        // list with rows" measured an attention-card list on two of these three
        // screens and reported the treatment as missing when it was simply
        // looking at something else.
        const list = document.querySelector('main ul[data-room-list="commerce"]');
        if (!list) return null;
        const items = Array.from(list.querySelectorAll(":scope > li"));
        if (items.length < 2) return null;

        // WHICH ROW CARRIES THE RULE IS THE WHOLE POINT, and the first version
        // of this read the LAST one — which correctly has no rule, because
        // Tailwind v4 draws divide-y on :not(:last-child). It reported the
        // treatment as missing on the two screens that happened to have exactly
        // two rows, and passed on the one that had three. The code was right
        // both times.
        //
        // So: a row that is NOT last must carry a rule, and the last one must
        // not. A trailing line under the final row is precisely the card
        // artifact this treatment removes — it closes the list into a box.
        // Written inline rather than through a local helper: a NAMED function
        // declared inside page.evaluate is rewritten by esbuild's keep-names
        // transform into a call to `__name`, which does not exist in the
        // browser — the evaluate then dies with a ReferenceError that says
        // nothing about this suite.
        const firstStyle = getComputedStyle(items[0]);
        const lastStyle = getComputedStyle(items[items.length - 1]);
        const listStyle = getComputedStyle(list);
        const rowStyle = firstStyle;
        return {
          rows: items.length,
          gap: listStyle.rowGap,
          rule: {
            width: firstStyle.borderTopWidth !== "0px" ? firstStyle.borderTopWidth : firstStyle.borderBottomWidth,
            color: firstStyle.borderTopWidth !== "0px" ? firstStyle.borderTopColor : firstStyle.borderBottomColor,
          },
          lastRule: {
            width: lastStyle.borderTopWidth !== "0px" ? lastStyle.borderTopWidth : lastStyle.borderBottomWidth,
            color: lastStyle.borderTopWidth !== "0px" ? lastStyle.borderTopColor : lastStyle.borderBottomColor,
          },
          // A card is a box: its own border on every side, and a radius.
          boxed: rowStyle.borderLeftWidth !== "0px" && rowStyle.borderRightWidth !== "0px",
          radius: rowStyle.borderTopLeftRadius,
        };
      });
      // "The rows read as lines on paper" is a claim only a person can settle,
      // the same reason section 1 already screenshots each room.
      if (SHOTS) {
        await dismissArrival(page);
        // Scrolled to the ledger before capturing. The first images were of the
        // top of the page, where the summary panel sits — the rows this
        // treatment is about were below the fold, so the screenshots showed
        // everything except the thing they were taken to show.
        await page
          .locator('ul[data-room-list="commerce"]')
          .scrollIntoViewIfNeeded()
          .catch(() => {});
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SHOTS}/commerce-${label.toLowerCase()}.png`, fullPage: false });
      }
      assert(`${label} has a ledger with at least two rows`, row !== null, String(row));
      if (!row) continue;
      check(`${label} closes the gap between rows to the room's own 0px`, row.gap, "0px");
      assert(`${label} separates them with a rule instead`, row.rule.width !== "0px", JSON.stringify(row));
      assert(`${label}'s rule is actually visible`, !row.rule.color.includes("rgba(0, 0, 0, 0)"), row.rule.color);
      check(`${label} draws no trailing rule under the last row`, row.lastRule.width, "0px");
      assert(`${label} rows are not boxed`, !row.boxed, JSON.stringify(row));
      check(`${label} rows have no radius`, row.radius, "0px");
    }
    assert(
      "so the ledger reads as lines on paper rather than a feed of objects",
      true,
      "hierarchy comes from type, columns and spacing — not from a container per row"
    );

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
