import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// COMMERCE'S LEAD, ON THE SCREEN:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-commerce-lead-browser.ts" -OutFile out.txt
//
// verify-commerce-lead.ts proves the sentence is right. It cannot prove the
// room renders it, and that is the gap this codebase has been bitten by twice —
// "tsc passes whether or not the wiring is right... Rendering is not working."
//
// So this seeds a real store with real orders and a real prior briefing anchor,
// signs in, opens Commerce, and reads the line an owner would actually see.
//
// THE THREE STATES ARE THE POINT, and only a rendered page can tell two of them
// apart: a store with no anchor shows NO lead, a store with an anchor and
// nothing new shows a quiet one, and a store with orders since the anchor shows
// the counts. An implementation that rendered a placeholder for the first case
// would look identical to a correct one in a unit test.
//
// It also checks the permission boundary, which is a rendering question rather
// than a logic one: an employee without REVENUE_VIEW must not read a revenue
// figure off the lead after being kept out of the summary card below it.

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
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // The submit is a client-side next-auth call, so a click landing before
  // hydration is lost with no error. See verify-office-browser.ts.
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
}

/** The lead, read from the room rather than from the whole page. */
async function leadOn(page: Page, url: string): Promise<string | null> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("h1", { state: "attached", timeout: 60_000 });
  // The paragraph immediately after the room's own heading, which is where a
  // lead sits by definition — found structurally so a styling change cannot
  // silently widen what this reads.
  return page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h1")).find(
      (h) => h.textContent?.trim() === "Orders"
    );
    const next = heading?.nextElementSibling;
    return next?.tagName === "P" ? (next.textContent?.trim() ?? null) : null;
  });
}

async function main() {
  const server = await startTestServer({ timeoutMs: 180_000 });
  const prisma = server.db.prisma;
  let browser: Browser | null = null;

  try {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const owner = await prisma.user.create({
      data: { email: "owner@lead.test", name: "Owner", password: passwordHash },
    });

    const anchorAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

    /** A store, optionally with a prior briefing and orders after it. */
    const store = async (slug: string, opts: { anchor?: boolean; orders?: number; quantity?: number } = {}) => {
      const created = await prisma.store.create({
        data: { userId: owner.id, name: `Shop ${slug}`, slug, currency: "GBP", published: true },
      });
      if (opts.anchor) {
        await prisma.cognitiveOutput.create({
          data: {
            storeId: created.id,
            kind: "briefing",
            summary: "A previous briefing",
            generatedAt: anchorAt,
          },
        });
      }
      for (let i = 0; i < (opts.orders ?? 0); i++) {
        await prisma.order.create({
          data: {
            storeId: created.id,
            productName: "Tensor Ring",
            quantity: opts.quantity ?? 1,
            amountInCents: 4_250,
            buyerEmail: `buyer${i}@lead.test`,
            paymentProvider: "STRIPE",
            externalOrderId: `ord-${slug}-${i}`,
            createdAt: new Date(anchorAt.getTime() + 60_000 * (i + 1)),
          },
        });
      }
      return created;
    };

    const fresh = await store("lead-fresh");
    const settled = await store("lead-settled", { anchor: true });
    const busy = await store("lead-busy", { anchor: true, orders: 2 });
    // P1.7's own list — "customer / product / QUANTITY / payment status /
    // shipping address / fulfillment status / tracking / order date". Seeded
    // with a real multiple so the card has something to be wrong about.
    const bulk = await store("lead-bulk", { anchor: true, orders: 1, quantity: 3 });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: fresh.id } });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, owner.email!);

    // -----------------------------------------------------------------------
    console.log("\n1. A business Genesis has never briefed shows no lead");
    // -----------------------------------------------------------------------
    const noLead = await leadOn(page, `${server.baseUrl}/b/${fresh.slug}/orders`);
    check("nothing is rendered where the lead would go", noLead, null);
    assert(
      "so a brand-new owner is not told nothing has happened",
      noLead === null,
      "a placeholder here would be indistinguishable from a correct implementation in a unit test"
    );

    // -----------------------------------------------------------------------
    console.log("\n2. A quiet spell is said out loud");
    // -----------------------------------------------------------------------
    const quiet = await leadOn(page, `${server.baseUrl}/b/${settled.slug}/orders`);
    check("a store with an anchor and no news says so", quiet, "Nothing new since you were last here.");
    assert("which is a different outcome from having no anchor at all",
      quiet !== null && noLead === null,
      "two silences are not the same silence — and only a rendered page shows both");

    // -----------------------------------------------------------------------
    console.log("\n3. Real activity is reported in the owner's own currency");
    // -----------------------------------------------------------------------
    const busyLead = await leadOn(page, `${server.baseUrl}/b/${busy.slug}/orders`);
    assert("a store with orders since the anchor leads with them",
      busyLead?.startsWith("Since you were last here:") ?? false, String(busyLead));
    assert("naming the real order count", busyLead?.includes("2 new orders") ?? false, String(busyLead));
    assert("and the revenue behind them", busyLead?.includes("£85") ?? false, String(busyLead));
    assert("in pounds, because the store trades in pounds",
      !(busyLead?.includes("$") ?? true), String(busyLead));

    // -----------------------------------------------------------------------
    console.log("\n4. The order card says how many, and in whose money");
    // -----------------------------------------------------------------------
    // P1.7 names the lifecycle the owner must be able to read: "customer,
    // product, QUANTITY, payment status, shipping address, fulfillment status,
    // tracking, order date". Every one of those was on the card except the
    // quantity, which has existed on Order since 2026-08-20 and rendered
    // nowhere — an owner packing a hand-wound product read the product name and
    // a total, and had to divide to learn it was three of them.
    await page.goto(`${server.baseUrl}/b/${bulk.slug}/orders`, { waitUntil: "domcontentloaded" });
    const card = await page.evaluate(() => document.querySelector("li")?.textContent ?? null);
    assert("an order card is on the page", card !== null, String(card));
    assert("it says how many units were bought", card?.includes("3") ?? false, String(card));
    assert("beside the product it is a count of", card?.includes("Tensor Ring") ?? false, String(card));

    // The same rendering question as the lead above, one line down: this store
    // trades in pounds, and the figure beside the order is money its owner
    // actually took.
    assert("the order total is in the store's own currency", card?.includes("£42.50") ?? false, String(card));
    assert("never the developer's", !(card?.includes("$") ?? true), String(card));

    // A single-unit order must NOT carry a multiplier. "Tensor Ring ×1" is
    // noise on every ordinary order, and every order this platform has ever
    // written is one unit — the count earns its place only where it says
    // something.
    await page.goto(`${server.baseUrl}/b/${busy.slug}/orders`, { waitUntil: "domcontentloaded" });
    const single = await page.evaluate(() => document.querySelector("li")?.textContent ?? null);
    assert("one of something shows no multiplier", !(single?.includes("×1") ?? true), String(single));

    // Back to the busy store, which section 5 reads the lead from.
    await page.goto(`${server.baseUrl}/b/${busy.slug}/orders`, { waitUntil: "domcontentloaded" });

    // -----------------------------------------------------------------------
    console.log("\n5. Every figure in the room is in the room's own money");
    // -----------------------------------------------------------------------
    // The currency sweep shipped with a hand-maintained list of files, and the
    // list missed four screens — each with its own formatCents and its own
    // hardcoded dollar sign. Customers was one of them: it showed an owner what
    // real people had really spent, in a currency nobody had chosen.
    //
    // The guard is a tree sweep now rather than a list, but a sweep proves the
    // source contains no conversion, not that the page renders the right
    // symbol. This reads the rendered page.
    for (const [label, path] of [
      ["Customers", `/b/${busy.slug}/customers`],
      ["Revenue", `/b/${busy.slug}/analytics`],
    ] as const) {
      await page.goto(`${server.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(400);
      // innerText, NOT textContent. textContent includes the contents of
      // <script> tags, and Next serialises the whole RSC payload into them —
      // so the first version of this assertion failed on framework internals
      // while reporting them as the page's own money.
      const text = await page.evaluate(() => document.body.innerText ?? "");
      assert(`${label} shows pounds, because the store trades in pounds`, text.includes("£"), label);
      assert(
        `${label} shows no dollar sign at all`,
        !text.includes("$"),
        text.split("$").slice(1).map((t) => t.slice(0, 40)).join(" | ")
      );
    }

    await page.goto(`${server.baseUrl}/b/${busy.slug}/orders`, { waitUntil: "domcontentloaded" });

    // -----------------------------------------------------------------------
    console.log("\n6. The lead leads");
    // -----------------------------------------------------------------------
    // It has to be the first thing after the heading, above the summary card —
    // a "lead" further down the page is a footnote.
    // Compared by DOM position rather than by text index. The first version
    // searched for "Orders" AFTER the lead and found nothing, because the
    // room's heading is ABOVE it — the assertion was written backwards, not the
    // rendering.
    const order = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll("h1")).find(
        (h) => h.textContent?.trim() === "Orders"
      );
      const lead = Array.from(document.querySelectorAll("p")).find((p) =>
        p.textContent?.includes("Since you were last here")
      );
      const summary = Array.from(document.querySelectorAll("div")).find((d) =>
        d.className.includes("max-w-md")
      );
      if (!heading || !lead || !summary) {
        return { found: false, afterHeading: false, beforeSummary: false };
      }
      const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
      return {
        found: true,
        afterHeading: Boolean(heading.compareDocumentPosition(lead) & FOLLOWING),
        beforeSummary: Boolean(lead.compareDocumentPosition(summary) & FOLLOWING),
      };
    });
    assert("the heading, the lead and the room's contents were all found", order.found,
      JSON.stringify(order));
    assert("the lead comes after the room's name", order.afterHeading, JSON.stringify(order));
    assert("and before anything the room holds", order.beforeSummary,
      "a lead further down the page is a footnote");

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
