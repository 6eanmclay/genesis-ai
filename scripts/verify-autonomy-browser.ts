import { chromium } from "playwright";
import { startTestServer } from "@/scripts/lib/testServer";
import { requireTestDatabase, TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// J4 ACTING WITHOUT ASKING, AGAINST A REAL SERVER (2026-09-11):
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-autonomy-browser.ts" -OutFile out.txt
//
// RETARGETED THE SAME DAY IT WAS WRITTEN, AND THE REASON MATTERS.
//
// The first version proved this against update_homepage_content and
// update_store_content, which had just been raised to auto in e09f793. That
// raise was reverted: the tier was defensible on its own terms and still
// wrong, because nothing in production could ever select either action — no
// chat tool, no ProposedActionSchema member, no production caller. They were
// autonomous in the registry and unreachable in the product.
//
// So this now proves the same path against update_seo, which is genuinely
// autonomous AND genuinely reachable (Reason proposes it; see invariant 6 in
// verify-authority-boundary.ts). Nothing about the proof is weakened by the
// change — the gates, the read-back, the customer-visible result and the
// destructive control are all still here. Section 4 changed subject rather
// than disappearing: it now proves the two reverted actions STAY
// execution-only, which is what the revert actually asserts.
//
// ============ THE BINDING THAT DEFEATED THE FIRST ATTEMPT =============
//
// startTestServer points the CHILD server at the harness database and
// deliberately leaves this process alone. lib/prisma builds its adapter from
// DATABASE_URL at module-evaluation time, so importing a product module before
// rebinding instantiates a client against the developer's OWN database — and
// the first version of this file did exactly that, called
// tryExecuteAutonomousAction, and got a Prisma error from a database that had
// never heard of the store.
//
// I read that as the app and the harness being architecturally divided. They
// are not. verify-belief-review-browser.ts had already documented the whole
// thing — "point this process at the harness first, import the product code
// after, and then make requireTestDatabase confirm it actually landed there
// rather than trusting that it did." This file follows that, and nothing about
// the isolation boundary is weakened to do it: the marker table still has to
// be there, and it cannot be satisfied by exporting a variable.

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

const uniq = () => Math.random().toString(36).slice(2);

/**
 * A SCHEMA-VALID input, because gate 4 is input validation.
 *
 * An earlier version of this file passed a field the action does not have at
 * all, so inputSchema.safeParse refused it and tryExecuteAutonomousAction
 * returned false. That looked exactly like an authority refusal and was
 * nothing of the kind — which is why the no-grant case below uses a VALID
 * input too: a refusal that could be caused by a malformed fixture proves
 * nothing about authority.
 */
const VALID_SEO = {
  seoTitle: "ZZAFTERSEO",
  seoMetaDescription: "Hand-wound rings, measured by cubit.",
};

async function main(): Promise<void> {
  const server = await startTestServer();
  try {
    // Before any product module is loaded. See the note at the top.
    process.env.DATABASE_URL = server.db.url;
    // The cheap half of the guard. The half that matters is the marker table.
    process.env[TEST_DATABASE_ENV] = "1";

    const { tryExecuteAutonomousAction, grantDelegatedAuthority } = await import(
      "@/lib/execution/genesisAutonomy"
    );
    const { GENESIS_ACTIONS } = await import("@/lib/execution/genesisActions");
    const { prismaSystem } = await import("@/lib/prisma");

    // NOT TRUSTED — PROVED. A variable can be exported; this table only exists
    // because the harness created it.
    await requireTestDatabase(prismaSystem);

    // ======================================================================
    console.log("\n=== 0. This process and the server share one database ===\n");
    // ======================================================================
    //
    // The control for the whole file. If these disagree, every assertion below
    // is reading a different world from the one the server serves — which is
    // precisely the failure this repair exists to close.
    const owner = await prismaSystem.user.create({ data: { email: `auto-${uniq()}@test.local` } });
    const store = await prismaSystem.store.create({
      data: {
        userId: owner.id,
        name: "Copper & Coil",
        slug: `auto-${uniq()}`,
        published: true,
        currency: "USD",
        // AUTONOMY IS NOT THE ONLY GATE. Publishing a change costs Growth
        // Points, and a store with none gets a FAILED execution whose message
        // says so — the correct behaviour, and exactly what ai-actions.ts
        // predicts for "insufficient Growth Points for a paid auto-execute
        // action". Without this the suite reports an authority failure that is
        // really an empty wallet.
        growthPointBalance: 500,
        blueprint: { marketingAssets: { seoTitle: "ZZBEFORESEO", seoMetaDescription: "Before." } } as never,
      },
    });
    // SEEDED FOR SECTION 5, which needs a real product for delete_product to
    // be refused ON. Section 3b no longer depends on it: the field J4 changes
    // here is the page's own title, which a store renders with or without a
    // catalogue.
    const product = await prismaSystem.product.create({
      data: { storeId: store.id, name: "ZZDONOTDELETE", priceInCents: 1000, active: true },
    });

    const seenByHarness = await server.db.prisma.store.count({ where: { id: store.id } });
    check("a row written through the app's client is visible to the harness client",
      seenByHarness, 1);

    // ======================================================================
    console.log("\n=== 1. No grant means no autonomous action ===\n");
    // ======================================================================
    const withoutGrant = await tryExecuteAutonomousAction({
      storeId: store.id,
      actionType: "update_seo",
      input: { ...VALID_SEO, seoTitle: "ZZSHOULDNOTLAND" },
      summary: "Genesis acted on its own",
      topicKey: null,
      cognitiveOutputId: null,
    } as never);
    check("an autonomous-capable action still needs the owner's grant", withoutGrant, false);
    check("and nothing was written",
      ((await prismaSystem.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
        .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
      "ZZBEFORESEO");

    // ======================================================================
    console.log("\n=== 2. Granted, J4 acts without asking ===\n");
    // ======================================================================
    await grantDelegatedAuthority({
      storeId: store.id,
      actionType: "update_seo",
      grantedByUserId: owner.id,
    });
    const ran = await tryExecuteAutonomousAction({
      storeId: store.id,
      actionType: "update_seo",
      input: VALID_SEO,
      summary: "Genesis acted on its own",
      topicKey: null,
      cognitiveOutputId: null,
    } as never);
    check("update_seo runs under a grant", ran, true);
    // NOTHING IS LEFT WAITING FOR THE OWNER — which is not the same as
    // nothing being recorded, and my first assertion confused the two.
    //
    // An autonomous run DOES write an ApprovalRequest, at status EXECUTED and
    // summarised "Genesis acted on its own". That is the audit record of an
    // action taken on delegated authority, not a request for permission. What
    // would be wrong is a row still PENDING_APPROVAL, because that is the
    // owner being asked for something J4 already had authority to do.
    check("the owner is left with nothing to approve",
      await prismaSystem.approvalRequest.count({
        where: { storeId: store.id, status: "PENDING_APPROVAL" },
      }),
      0);
    check("and the action is recorded as already decided",
      (await prismaSystem.approvalRequest.findFirstOrThrow({
        where: { storeId: store.id, actionType: "update_seo" },
        select: { status: true },
      })).status,
      "EXECUTED");

    // ======================================================================
    console.log("\n=== 3. It landed, and J4 read it back ===\n");
    // ======================================================================
    const log = await prismaSystem.executionLog.findFirstOrThrow({
      where: { storeId: store.id, action: "store.update_seo" },
      orderBy: { createdAt: "desc" },
    });
    check("the execution is SUCCESS", log.status, "SUCCESS");
    // THE REASON AUTONOMY IS ALLOWED AT ALL. An unsupervised action that cannot
    // confirm itself would be the worst combination available.
    check("verification confirmed it by reading it back", log.verified, true);
    check("recorded as Genesis acting, not as a person", log.actorType, "GENESIS");
    check("and the store really changed",
      ((await prismaSystem.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
        .blueprint as { marketingAssets: { seoTitle: string } }).marketingAssets.seoTitle,
      "ZZAFTERSEO");

    // ======================================================================
    console.log("\n=== 3b. And a customer sees it ===\n");
    // ======================================================================
    //
    // seoTitle IS the storefront's page title (app/store/[slug]/page.tsx,
    // generateMetadata: `marketing?.seoTitle || store.name`), so the field J4
    // just changed on its own authority is one a visitor reads in the tab and
    // a search result reads in the listing.
    //
    // WAITING FOR THE PAGE, not for the navigation. An earlier version read
    // the rendered text straight after domcontentloaded and got an empty
    // string, which I mistook for a broken fixture and removed the whole
    // rendered half over. Fetching the same URL returned 24KB of correct
    // HTML: the page was never the problem, the read was simply too early.
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${server.baseUrl}/store/${store.slug}`, { waitUntil: "domcontentloaded" });
      // The wait is allowed to time out: the assertion below is what decides,
      // and a swallowed timeout here would otherwise become a crash that says
      // less than a FAIL line does.
      await page
        .waitForFunction("document.title.includes('ZZAFTERSEO')", undefined, { timeout: 30_000 })
        .catch(() => {});
      const title = await page.title();
      assert("the autonomous change is on the page a customer sees",
        title.includes("ZZAFTERSEO"), title);
      assert("and what it replaced is gone", !title.includes("ZZBEFORESEO"), title);
      await page.screenshot({ path: "verification-screenshots/autonomy-storefront.png" });
      await page.close();
    } finally {
      await browser.close().catch(() => {});
    }

    // ======================================================================
    console.log("\n=== 4. THE REVERT — execution-only stays execution-only ===\n");
    // ======================================================================
    //
    // update_homepage_content and update_store_content were autonomous for
    // part of one day. Nothing in production could select either, so the
    // capability was granted to nobody. This is that revert asserted rather
    // than remembered: both are capped at always_ask, so the owner cannot
    // delegate them even deliberately, and they cannot run on their own.
    for (const actionType of ["update_homepage_content", "update_store_content"] as const) {
      let refused = false;
      try {
        await grantDelegatedAuthority({ storeId: store.id, actionType, grantedByUserId: owner.id });
      } catch {
        refused = true;
      }
      assert(`${actionType} cannot be delegated`, refused);
      check(`  and its cap says so permanently`,
        (GENESIS_ACTIONS as Record<string, { maxAuthorityTier: string }>)[actionType].maxAuthorityTier,
        "always_ask");
    }

    // ======================================================================
    console.log("\n=== 5. THE CONTROL — destructive still stops ===\n");
    // ======================================================================
    //
    // If this refuses while section 2 succeeds, the difference is the authority
    // model rather than the harness.

    let grantRefused = false;
    try {
      await grantDelegatedAuthority({
        storeId: store.id,
        actionType: "delete_product",
        grantedByUserId: owner.id,
      });
    } catch {
      grantRefused = true;
    }
    assert("a destructive action cannot even be granted", grantRefused);

    const deleted = await tryExecuteAutonomousAction({
      storeId: store.id,
      actionType: "delete_product",
      input: { productId: product.id },
      summary: "Genesis acted on its own",
      topicKey: null,
      cognitiveOutputId: null,
    } as never);
    check("and it does not run autonomously", deleted, false);
    check("the product is untouched",
      await prismaSystem.product.count({ where: { id: product.id, active: true } }), 1);

    // And the ceiling that makes that permanent, read from the registry.
    check("delete_product can never be raised",
      (GENESIS_ACTIONS as Record<string, { maxAuthorityTier: string }>)["delete_product"].maxAuthorityTier,
      "always_ask");

    await prismaSystem.$disconnect();
  } finally {
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
