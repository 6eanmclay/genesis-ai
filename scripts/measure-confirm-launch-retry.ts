import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";

// THE ONE RETRY PATH THAT DOES NOT RELOAD THE PAGE.
//
// INVESTIGATION ONLY. No production code is changed.
//
// The /dashboard "Confirm & Create Store" route re-derives on every load, so a
// retry there cannot reach the button once a store exists — measured in
// measure-confirm-failure-matrix.ts, where no scenario produced a duplicate.
//
// The Launch screen's building beat is different. It calls launchConfirmStore
// -> confirmStoreDraftCore directly, from a client component, and on failure it
// sets the beat back to "commitment" WITHOUT navigating. Pressing the button
// again re-invokes the action against a page that still believes no store
// exists. launchConfirmStore checks only for a draft:
//
//     const draft = await prisma.storeDraft.findUnique(...);
//     if (!draft) throw new Error("No store draft to confirm.");
//
// and confirmStoreDraftCore has no store-existence guard of its own — the only
// store lookup in it is the slug-uniqueness loop.
//
// So this asks the question the other harness could not: with a draft still on
// file after a partial failure, does a second press create a SECOND store?

const PASSWORD = "harness-password-1";
const STAMP = Date.now();

async function main() {
  const { startTestServer } = await import("@/scripts/lib/testServer");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  try {
    const email = `clr-${STAMP}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Owner", password: await bcrypt.hash(PASSWORD, 10) },
    });

    // The state app/onboarding/launch/page.tsx requires for the commitment
    // beat: no Store, and a draft whose guided flow genuinely finished.
    const draft = await prisma.storeDraft.create({
      data: {
        userId: user.id,
        name: "Copper Launch",
        description: "Hand-wound copper things.",
        status: "ready",
        version: 1,
        inputVision: "copper rings",
        productsDraft: [],
        blueprint: {},
        onboardingState: {
          step: "ready_to_publish",
          // THE REAL CANDIDATE SHAPE. A first pass omitted `variant`, which is
          // required on FulfillmentCandidate, and confirmStoreDraftCore threw
          // reading variant.externalVariantId BEFORE store.create — so the
          // injected failure was never reached and the experiment measured
          // nothing. The fixture was wrong, not the code.
          selectedCandidate: {
            provider: "PRINTFUL",
            externalProductId: "71",
            name: "Copper Ring",
            description: "A hand-wound copper ring.",
            imageUrl: "https://blob.test/ring.png",
            variant: { externalVariantId: "4012", name: "Ash / 2XL" },
          },
          pricing: { retailPriceInCents: 3500, profitInCents: 2300, marginPct: 0.66 },
        },
      },
    });
    await prisma.storeGeneration.create({
      data: { storeDraftId: draft.id, version: 1, generatedOutput: { name: "Copper Launch" }, milestone: "original" },
    });

    const snapshot = async () => {
      const stores = await prisma.store.findMany({ where: { userId: user.id }, select: { slug: true, name: true } });
      const d = await prisma.storeDraft.findUnique({ where: { userId: user.id }, select: { id: true } });
      const u = await prisma.user.findUnique({ where: { id: user.id }, select: { activeStoreId: true } });
      return {
        stores: stores.length,
        slugs: stores.map((s) => s.slug),
        draft: !!d,
        active: u?.activeStoreId ? "set" : "NULL",
      };
    };
    const show = async (label: string) => {
      const s = await snapshot();
      console.log(
        `    ${label.padEnd(20)} stores=${s.stores}${s.stores > 1 ? "  <<< DUPLICATE" : ""} draft=${s.draft ? "present" : "gone"} active=${s.active}` +
          (s.stores ? `  slugs=${s.slugs.join(", ")}` : ""),
      );
    };

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();

    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    for (let i = 0; i < 5; i++) {
      await page.click('button[type="submit"]').catch(() => {});
      try {
        await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 8_000 });
        break;
      } catch { /* hydration */ }
    }
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });

    // The failure: the draft cannot be deleted, so store.create has already
    // happened and the draft survives — matrix row F2.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION inj_ld_fn() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'INJECTED_FAILURE_launch_draft_delete'; END;
      $$ LANGUAGE plpgsql;`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER inj_ld BEFORE DELETE ON "StoreDraft" FOR EACH ROW EXECUTE FUNCTION inj_ld_fn();`,
    );

    await page.goto(`${server.baseUrl}/onboarding/launch`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForTimeout(3000);
    console.log("\n  commitment beat:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 120));
    await show("before");

    const press = async (label: string) => {
      const button = page.locator('button:has-text("Let’s launch it")');
      if ((await button.count()) === 0) {
        console.log(`    ${label}: no launch button — ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 120)}`);
        return false;
      }
      await button.first().click();
      // The building beat resolves to an error and drops back to commitment.
      await page.waitForTimeout(12_000);
      console.log(`    ${label}: ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 140)}`);
      return true;
    };

    console.log("\n=== PRESS 1 (failure injected) ===\n");
    await press("press 1");
    await show("after press 1");

    console.log("\n=== PRESS 2 — same page, no reload ===\n");
    await press("press 2");
    await show("after press 2");

    console.log("\n=== PRESS 3 ===\n");
    await press("press 3");
    await show("after press 3");

    // And with the injection removed, what a fresh page load now offers.
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS inj_ld ON "StoreDraft";`).catch(() => {});
    await page.goto(`${server.baseUrl}/onboarding/launch`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForTimeout(3000);
    console.log("\n=== A FRESH LOAD, INJECTION REMOVED ===\n");
    console.log("    page:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160));
    await show("final");

    // What /create-business makes of the leftover draft.
    await page.goto(`${server.baseUrl}/create-business`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForTimeout(2500);
    console.log("\n=== /create-business, WITH THE ORPHANED DRAFT ===\n");
    console.log("    page:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300));
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
