import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// THE CATALOG, THROUGH A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-catalog-browser.ts" -OutFile out.txt
//
// verify-catalog-live.ts proves the read model against a real database. It
// cannot prove that a page renders it, that a form posts to the right business,
// or that a route exists at all — and the last two times a browser was pointed
// at this codebase it found a real defect each time (J4 answering about the
// wrong business, and a negative assertion passing because nothing rendered).
//
// Read from `page.content()`, not innerText: J4's surface is a fixed layer over
// the workspace, so a section beneath it renders without being visible text, and
// a negative assertion that passes because nothing rendered is worth nothing.

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

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  // ONE RETRY, and it is not papering over a rejected login. A dev server that
  // is still compiling /login answers the submit with nothing at all — the page
  // stays put and shows NO error, which is exactly what a wrong password would
  // not do. Waiting for the page to settle first, then trying once more, is what
  // a person does when a form does not take.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
        timeout: 45_000,
      });
      await page.waitForLoadState("domcontentloaded");
      return;
    } catch {
      if (attempt === 1) {
        // Say WHY rather than timing out into silence. A login that was refused
        // says so on the page; one that never completed says nothing.
        const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
        throw new Error(`still on ${page.url()} after two attempts. Page said: ${body}`);
      }
    }
  }
}

async function main() {
  const server = await startTestServer({ timeoutMs: 180_000 });
  const prisma = server.db.prisma;
  let browser: Browser | null = null;

  try {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const owner = await prisma.user.create({
      data: { email: "owner@catalog.test", name: "Owner", password: passwordHash },
    });

    const gym = await prisma.store.create({
      data: {
        userId: owner.id, name: "Iron Gym", slug: "iron-gym", tagline: "Train at home",
        description: "A fitness and recovery brand for people who train at home.",
        published: true, currency: "USD",
      },
    });
    const coil = await prisma.store.create({
      data: {
        userId: owner.id, name: "Copper & Coil", slug: "copper-and-coil", tagline: "Hand-wound copper",
        description: "Hand-wound copper jewellery, made one at a time.",
        published: true, currency: "USD",
      },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: gym.id } });

    // Distinctive names, so "which business rendered" is unambiguous in markup.
    await prisma.sourcedProduct.create({
      data: {
        storeId: gym.id, sourceKey: "printful", externalProductId: "gym-1",
        kind: "WHOLESALE_DROPSHIP", name: "ZZFOAMROLLER",
        description: "A recovery and training tool for use at home",
        score: 30, status: "SUGGESTED", suggestedRetailInCents: 1_800,
      },
    });
    await prisma.sourcedProduct.create({
      data: {
        storeId: gym.id, sourceKey: "printful", externalProductId: "gym-2",
        kind: "PRINT_ON_DEMAND", name: "ZZTRAININGTEE", customizable: true,
        description: "A training top you can put your own design on",
        score: 24, status: "SUGGESTED", suggestedRetailInCents: 2_800,
      },
    });
    await prisma.sourcedProduct.create({
      data: {
        storeId: coil.id, sourceKey: "printful", externalProductId: "coil-1",
        kind: "WHOLESALE_DROPSHIP", name: "QQCOPPERWIRE",
        description: "Copper wire for hand-wound jewellery",
        score: 25, status: "SUGGESTED",
      },
    });
    // Something Genesis itself ruled out, now durable.
    await prisma.sourcedProduct.create({
      data: {
        storeId: gym.id, sourceKey: "printful", externalProductId: "gym-3",
        kind: "WHOLESALE_DROPSHIP", name: "ZZWEDDINGVEIL", description: "A wedding veil",
        score: 0, status: "RULED_OUT",
        recommendation: { verdict: "does_not_fit", concerns: ["It doesn't fit the brand you've described."] },
      },
    });

    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, server.baseUrl, owner.email!);

    // =====================================================================
    console.log("\n1. The catalog renders for the business in the URL");
    {
      const response = await page.goto(`${server.baseUrl}/b/iron-gym/catalog`, {
        waitUntil: "domcontentloaded",
      });
      check("the route exists", response?.status(), 200);
      const html = await page.content();

      assert("the gym's suggestions are on the page", html.includes("ZZFOAMROLLER"), html.slice(0, 300));
      assert("including the branded one", html.includes("ZZTRAININGTEE"));
      // THE DEFECT A BROWSER FOUND LAST TIME: the wrong business's data on the
      // page. Nothing in the read model can catch it.
      assert("the OTHER business's suggestion is not", !html.includes("QQCOPPERWIRE"), "leaked");

      // Grouped by what it means, in the owner's terms.
      assert("grouped as customizable products", html.includes("Customizable products"));
      assert("and as ready-to-sell", html.includes("Ready-to-sell products"));
      assert("with the move it represents", html.includes("Build your brand"));

      // THE SUPPLIER IS NEVER NAMED in what the owner reads as a recommendation.
      // The blocked-sources list is the deliberate exception, so "Printful" is
      // checked as a group heading rather than by bare substring.
      assert("no supplier heading", !html.includes(">Printful<"), "named");
    }

    // =====================================================================
    console.log("\n2. Genesis's own 'I ruled that out' survived the request");
    {
      const html = await page.content();
      // Persisted as RULED_OUT, so it can be said on a page opened later —
      // which is the whole reason it is now a row rather than a return value.
      assert("the ruled-out product is remembered", html.includes("ZZWEDDINGVEIL"), "not shown");
      assert("with why", html.includes("doesn&#x27;t fit the brand") || html.includes("doesn't fit the brand"));
      // And it is NOT offered as a suggestion.
      const suggestionsSection = html.slice(html.indexOf("Ready-to-sell products"));
      assert("but not as something to add",
        suggestionsSection.indexOf("ZZWEDDINGVEIL") === -1 ||
          suggestionsSection.indexOf("ZZWEDDINGVEIL") > suggestionsSection.indexOf("wouldn"),
        "offered as a suggestion");
    }

    // =====================================================================
    console.log("\n3. Adding one actually adds it, to the right business");
    {
      await page.goto(`${server.baseUrl}/b/iron-gym/catalog`, { waitUntil: "domcontentloaded" });
      // THE ROW FOR A NAMED PRODUCT, not whichever happens to be first. Groups
      // are ordered branded-first, so "first" is the tee, and a test that fills
      // one row's price and reads another's proves nothing.
      // Scoped to the li that actually CARRIES the form. The starting-set
      // section lists the same product name in a plain li with no input, and
      // ":has-text" alone matched that one first.
      const row = page
        .locator('li:has(input[name="priceInCents"])')
        .filter({ hasText: "ZZFOAMROLLER" })
        .first();
      const price = row.locator('input[name="priceInCents"]');
      // TYPED, NOT FILLED. `fill()` sets the value in one step and left this
      // number input empty; typing is what a person does and is what the field
      // has to survive.
      await price.click();
      await price.pressSequentially("2400");
      // Asserted BEFORE submitting: a price that never reached the field would
      // otherwise look identical to a price the server ignored.
      check("the price reached the field", await price.inputValue(), "2400");
      await row.locator('button:text("Add to my store")').click();
      await page.waitForLoadState("networkidle");
      // Re-navigated rather than trusting the in-place revalidation to have
      // painted: what is under test is the server's answer, not React's timing.
      await page.goto(`${server.baseUrl}/b/iron-gym/catalog`, { waitUntil: "domcontentloaded" });

      const product = await prisma.product.findFirst({
        where: { storeId: gym.id },
        orderBy: { createdAt: "desc" },
      });
      assert("a real product now exists", product !== null);
      check("and it is the one whose row was used", product?.name, "ZZFOAMROLLER");
      check("at the price typed into the form", product?.priceInCents, 2_400);
      check("for the business in the URL", product?.storeId, gym.id);
      check("and none for the other business",
        await prisma.product.count({ where: { storeId: coil.id } }), 0);

      // It leaves the suggestions, because it is on the shelf now.
      const html = await page.content();
      const stillSuggested = await prisma.sourcedProduct.count({
        where: { storeId: gym.id, status: "SUGGESTED" },
      });
      check("one suggestion left", stillSuggested, 1);
      assert("and the page no longer offers it", !html.includes("ZZFOAMROLLER"), "still offered");
      assert("while the other one still is", html.includes("ZZTRAININGTEE"));
    }

    // =====================================================================
    console.log("\n4. The other business's catalog is its own");
    {
      const response = await page.goto(`${server.baseUrl}/b/copper-and-coil/catalog`, {
        waitUntil: "domcontentloaded",
      });
      check("its route exists too", response?.status(), 200);
      const html = await page.content();
      assert("it shows its own suggestion", html.includes("QQCOPPERWIRE"), html.slice(0, 300));
      assert("and none of the gym's", !html.includes("ZZFOAMROLLER") && !html.includes("ZZTRAININGTEE"), "leaked");
      // A business with nothing ruled out says nothing about ruling out.
      assert("nor the gym's ruled-out one", !html.includes("ZZWEDDINGVEIL"), "leaked");
    }

    // =====================================================================
    console.log("\n5. Turning one down, and it stays down");
    {
      await page.goto(`${server.baseUrl}/b/iron-gym/catalog`, { waitUntil: "domcontentloaded" });
      await page.locator('button:text("Not for me")').first().click();
      await page.waitForLoadState("networkidle");
      await page.goto(`${server.baseUrl}/b/iron-gym/catalog`, { waitUntil: "domcontentloaded" });

      check("it is recorded as the owner's decision",
        await prisma.sourcedProduct.count({ where: { storeId: gym.id, status: "DISMISSED" } }), 1);
      const html = await page.content();
      assert("and it is off the page", !html.includes("ZZTRAININGTEE"), "still shown");
    }

    // =====================================================================
    console.log("\n6. A business Genesis knows nothing about is told so");
    {
      const quiet = await prisma.store.create({
        data: {
          userId: owner.id, name: "Quiet", slug: "quiet-co", tagline: "",
          description: "", published: true, currency: "USD",
        },
      });
      void quiet;
      await page.goto(`${server.baseUrl}/b/quiet-co/catalog`, { waitUntil: "domcontentloaded" });
      const html = await page.content();
      // "I don't know you yet" is not "nothing fits you", and the page has to
      // say the first rather than looking empty.
      assert("the page says it does not know the business",
        html.includes("don&#x27;t know enough about your business") ||
          html.includes("don't know enough about your business"),
        html.slice(0, 300));
    }

    // =====================================================================
    console.log("\n7. The owner can overrule Genesis from the page");
    {
      await page.goto(`${server.baseUrl}/b/iron-gym/catalog`, { waitUntil: "domcontentloaded" });
      const html = await page.content();
      assert("the page says the verdict is an opinion",
        html.includes("My opinion, not a rule"), "no override offered");

      // OPENED FIRST, because that is what a person does. The ruled-out list
      // sits behind a disclosure — it is reassurance rather than work — so
      // nothing inside it is visible or clickable until the summary is clicked.
      await page.locator(`summary:has-text("wouldn\'t recommend")`).first().click();

      // THE REAL BUTTON, in the real disclosure, on the ruled-out row.
      const declined = page
        .locator('li:has(button:text("Add anyway"))')
        .filter({ hasText: "ZZWEDDINGVEIL" })
        .first();
      const price = declined.locator('input[name="priceInCents"]');
      await price.click();
      await price.pressSequentially("4500");
      check("the price reached the field", await price.inputValue(), "4500");
      await declined.locator('button:text("Add anyway")').click();
      await page.waitForLoadState("networkidle");
      await page.goto(`${server.baseUrl}/b/iron-gym/catalog`, { waitUntil: "domcontentloaded" });

      const overruled = await prisma.product.findFirst({
        where: { storeId: gym.id, name: "ZZWEDDINGVEIL" },
      });
      assert("the product Genesis advised against is now real", overruled !== null);
      check("at the owner's price", overruled?.priceInCents, 4_500);
      check("and for the right business", overruled?.storeId, gym.id);
      check("the row records that they took it",
        (await prisma.sourcedProduct.findFirstOrThrow({
          where: { storeId: gym.id, externalProductId: "gym-3" },
        })).status, "ADOPTED");
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
