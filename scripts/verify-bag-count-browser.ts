import { chromium, type Browser, type Page } from "playwright";
import { startTestServer } from "@/scripts/lib/testServer";

// WHAT THE BAG SAYS IT HOLDS, ON EVERY SURFACE THAT SAYS IT:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-bag-count-browser.ts" -OutFile out.txt
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// resolveBag decides what a bag IS. The cookie is a list of ids the customer
// asked for; resolveBag is what this store still sells, and bagActions already
// said so in as many words — "resolveBag already drops anything that is not an
// active product of this store, so checking twice would be two rules that can
// disagree."
//
// The count was the second rule. Money came from resolveBag everywhere; the
// count came off the cookie at four render sites, so the two agreed only while
// nothing was ever deactivated. Rendered, with one of two products switched
// off while it sat in the bag:
//
//   storefront pill       Bag - 2 items - $50.00
//   bag page badge        Bag, 2 items
//   bag page summary      Subtotal (2 items)   $50.00
//   bag page notice       One item is no longer available and has been removed
//   bag page list         Copper Ring
//
// The summary row contradicted the notice four lines above it.
//
// THIS IS A BROWSER SUITE because the contradiction is not visible anywhere
// else: each number is individually correct about its own source, and only
// putting them on one screen shows they are not about the same bag.
//
// THE MONEY IS ASSERTED UNCHANGED THROUGHOUT. The charge always read the
// resolved lines, so this moved the count and must not have moved the total —
// a "fix" that dropped the deactivated item from the price as well would be
// changing what a customer pays in order to make a label agree.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  assert(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `bagn-${stamp}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Copper Works", slug: `bagn-${stamp}`, currency: "USD", published: true },
    });
    await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_bagn" },
    });
    const ring = await prisma.product.create({
      data: { storeId: store.id, name: "Copper Ring", description: "a", priceInCents: 5000, active: true, position: 0 },
    });
    const mug = await prisma.product.create({
      data: { storeId: store.id, name: "Copper Mug", description: "b", priceInCents: 3000, active: true, position: 1 },
    });

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    const go = (path: string) =>
      page.goto(`${server.baseUrl}${path}`, { waitUntil: "domcontentloaded", timeout: 90_000 });

    // THROUGH THE REAL BUTTON, not by planting a cookie — the add path is what
    // puts ids in there, and a planted cookie could not catch it changing.
    await go(`/store/${store.slug}`);
    for (let i = 0; i < 2; i++) {
      await page.locator('button:has-text("Add to Bag")').nth(i).click();
      await page.waitForTimeout(1500);
    }

    /** The floating pill's own words: the count and the amount, together. */
    const pill = async () => {
      const raw = (await page.locator('a[href$="/bag"]').last().innerText()).replace(/\s+/g, " ").trim();
      // "Bag · 2 items · $80.00 →" -> "2 items · $80.00"
      const parts = raw.split("·").map((p) => p.trim()).filter(Boolean);
      const count = parts[1] ?? "(none)";
      const amount = (parts[2] ?? "(none)").replace(/\s*→\s*$/, "").trim();
      return `${count} · ${amount}`;
    };
    const badge = async () =>
      (await page.locator('a[aria-label^="Bag,"]').first().getAttribute("aria-label")) ?? "(none)";
    const subtotalLabel = async () =>
      (await page.locator('dt:has-text("Subtotal")').first().innerText()).trim();
    const bodyText = async () => page.locator("body").innerText();

    // ==================================================================
    console.log("\n1. Two products, both on sale — the baseline\n");
    // ==================================================================
    {
      await go(`/store/${store.slug}`);
      eq("the storefront pill counts two", await pill(), "2 items · $80.00");
      eq("  and the header badge agrees", await badge(), "Bag, 2 items");

      await go(`/store/${store.slug}/bag`);
      eq("the bag page badge counts two", await badge(), "Bag, 2 items");
      eq("  and the summary row counts two", await subtotalLabel(), "Subtotal (2 items)");
      const body = await bodyText();
      assert("  both products are listed", body.includes("Copper Ring") && body.includes("Copper Mug"));
      assert("  and nothing was dropped", !body.includes("no longer available"), body.slice(0, 160));
    }

    // ==================================================================
    console.log("\n2. One product deactivated while it sits in the bag\n");
    // ==================================================================
    await prisma.product.update({ where: { id: mug.id }, data: { active: false } });
    {
      await go(`/store/${store.slug}`);
      // THE WHOLE DEFECT IN ONE STRING. This read "2 items · $50.00".
      eq("the storefront pill counts what is left, beside its own money",
        await pill(), "1 item · $50.00");
      eq("  and the header badge agrees", await badge(), "Bag, 1 item");

      // THE FOURTH RENDER SITE. A product page carries the same pill.
      await go(`/store/${store.slug}/products/${ring.id}`);
      eq("a product page's pill counts the same", await pill(), "1 item · $50.00");
      eq("  and its badge agrees", await badge(), "Bag, 1 item");

      await go(`/store/${store.slug}/bag`);
      const body = await bodyText();
      eq("the bag page badge counts one", await badge(), "Bag, 1 item");
      // THE CONTRADICTION THIS SUITE EXISTS FOR: this row said "(2 items)"
      // directly beneath the notice asserted on the next line.
      eq("  and the summary row counts one, not the cookie's two",
        await subtotalLabel(), "Subtotal (1 item)");
      assert("  the notice still says an item went away",
        body.includes("One item is no longer available and has been removed from your bag."),
        body.slice(0, 200));
      assert("  only the product still for sale is listed",
        body.includes("Copper Ring") && !body.includes("Copper Mug"), body.slice(0, 200));

      // THE MONEY DID NOT MOVE. $50.00 is the ring alone, which is what the
      // charge has always read from the same resolved lines.
      assert("  and the totals are still the ring's own price",
        (body.match(/\$50\.00/g) ?? []).length >= 2 && !body.includes("$80.00"),
        body.slice(0, 400));
    }

    // ==================================================================
    console.log("\n3. Two of one product — a count is units, not lines\n");
    // ==================================================================
    {
      // The property verify-bag asserts on the cookie must survive the move to
      // resolveBag: one product times two still reads "2 items".
      await go(`/store/${store.slug}`);
      await page.locator('button:has-text("Add to Bag")').first().click();
      await page.waitForTimeout(1500);
      await go(`/store/${store.slug}`);
      eq("two of the ring is two items", await pill(), "2 items · $100.00");
      await go(`/store/${store.slug}/bag`);
      eq("  and the summary says so too", await subtotalLabel(), "Subtotal (2 items)");
    }

    console.log(`\n${failures} failed, ${passes} passed`);
    if (failures > 0) {
      console.log("\nFAILED:");
      for (const line of failed) console.log(`  ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
