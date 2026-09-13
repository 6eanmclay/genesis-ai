import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import { genesisActionLabel } from "@/lib/dashboard/authoritySurface";

// WHAT THE USAGE TABLE CALLS THE WORK AN OWNER PAID FOR:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-growth-points-usage-browser.ts" -OutFile out.txt
//
// ============ THE DEFECT (2026-09-13) ==================================
//
// The column is headed "Action" and printed the raw GenesisActionType:
// "update_seo", "refine_storefront". Implementation identifiers, shown to an
// owner, under a heading promising something they could read — the same rule
// this project already holds elsewhere ("a cuid became a SKU and a primary key
// became a customer's email on screen").
//
// The fix uses the vocabulary that already exists rather than a second one.
// genesisActionLabel is what the authority surface has always named these
// capabilities with; it was module-private and is now exported.
//
// TWO KINDS OF ROW ON PURPOSE. update_seo has an explicit owner-facing name,
// and refine_storefront does not — it takes the documented readable fallback.
// Asserting only the named one would leave the majority of real rows unproven,
// since most GENESIS_ACTIONS entries have no explicit label.

const PASSWORD = "a-real-passphrase-for-this-test";

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

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
        timeout: 12_000,
      });
      break;
    } catch {
      // a submit clicked before hydration is lost
    }
  }
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
    timeout: 30_000,
  });
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const stamp = Date.now();
    const user = await prisma.user.create({
      data: { email: `usage-${stamp}@example.test`, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const spent = await prisma.store.create({
      data: { userId: user.id, name: "Spent Shop", slug: `usage-spent-${stamp}`, currency: "USD" },
    });
    const fresh = await prisma.store.create({
      data: { userId: user.id, name: "Fresh Shop", slug: `usage-fresh-${stamp}`, currency: "USD" },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: spent.id } });

    // Real DEDUCTION rows, which is the only thing the usage table groups.
    // balanceAfter is a real running balance, not a placeholder: the ledger
    // records it on every row, and a fixture that lied about it would be
    // seeding a state the product cannot produce.
    let balance = 20;
    for (const [actionType, amount] of [
      ["update_seo", -2],
      ["update_seo", -2],
      ["refine_storefront", -5],
    ] as const) {
      balance += amount;
      await prisma.growthPointTransaction.create({
        data: {
          storeId: spent.id,
          type: "DEDUCTION",
          amount,
          balanceAfter: balance,
          actionType,
          description: `Invested in ${actionType}`,
        },
      });
    }
    await prisma.store.update({
      where: { id: spent.id },
      data: { growthPointBalance: balance },
    });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, user.email!);

    const usageCells = async (slug: string) => {
      const res = await page.goto(`${server.baseUrl}/b/${slug}/growth-points`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      assert(`/b/${slug}/growth-points renders`, (res?.status() ?? 0) === 200, `status ${res?.status()}`);
      return page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="usage-action"]')].map((el) =>
          (el as HTMLElement).innerText.trim(),
        ),
      );
    };

    // ==================================================================
    console.log("\n1. A business that has invested points\n");
    // ==================================================================
    {
      const cells = await usageCells(spent.slug);
      assert("both actions appear", cells.length === 2, JSON.stringify(cells));

      // THE NAMED ONE, and the name comes from the shared vocabulary rather
      // than from a string written into this suite — a copy here would pass
      // while the page showed something else entirely.
      assert("the named capability reads as the authority surface names it",
        cells.includes(genesisActionLabel("update_seo")),
        `${JSON.stringify(cells)} vs ${genesisActionLabel("update_seo")}`);

      // THE UNNAMED ONE, which most real rows will be.
      assert("and one with no explicit label still reads as words",
        cells.includes(genesisActionLabel("refine_storefront")),
        `${JSON.stringify(cells)} vs ${genesisActionLabel("refine_storefront")}`);

      // THE ACTUAL DEFECT: no cell may be the raw key.
      assert("no cell shows a raw implementation identifier",
        cells.every((c) => !/_/.test(c) && c !== c.toLowerCase()),
        JSON.stringify(cells));

      // AND THE FIGURES BESIDE THEM ARE UNTOUCHED — relabelling a column must
      // not disturb what the row counts. Read from the table's own cells
      // rather than the summary card above it: the card's label is
      // CSS-uppercased, so innerText returns "TOTAL INVESTED" and a check for
      // "Total invested" fails against a perfectly correct page. The per-row
      // figures are the thing this assertion is actually about anyway.
      const invested = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="usage-action"]')].map((cell) => {
          const cells = [...(cell.closest("tr")?.querySelectorAll("td") ?? [])];
          return cells.slice(1).map((td) => (td as HTMLElement).innerText.trim());
        }),
      );
      // BIGGEST SPEND FIRST, which getGrowthPointUsageByAction sorts for
      // explicitly — so refine_storefront (one action, 5 points) leads
      // update_seo (two actions, 4 points). Written the way the page actually
      // orders it rather than the way the fixture was seeded: the first
      // version of this expectation had the two rows the other way round and
      // was wrong about the product, not the other way about.
      assert("each row still carries its own count and points, biggest spend first",
        JSON.stringify(invested) === JSON.stringify([["1", "5"], ["2", "4"]]),
        JSON.stringify(invested));
    }

    // ==================================================================
    console.log("\n2. A business that has invested nothing\n");
    // ==================================================================
    {
      const cells = await usageCells(fresh.slug);
      assert("no action rows at all", cells.length === 0, JSON.stringify(cells));
      const body = (await page.locator("body").innerText()).toLowerCase();
      assert("and the table says so in its own words",
        body.includes("nothing invested yet"), body.slice(0, 300));
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
