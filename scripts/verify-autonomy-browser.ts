import { chromium } from "playwright";
import { startTestServer } from "@/scripts/lib/testServer";
import { requireTestDatabase, TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// J4 ACTING WITHOUT ASKING, AGAINST A REAL SERVER (2026-09-11):
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-autonomy-browser.ts" -OutFile out.txt
//
// update_homepage_content and update_store_content moved from always_ask to
// auto in e09f793. verify-autonomy-live proves the five gates against a
// standalone Postgres; what had never been shown is the same path running
// beside a real Next server on the database that server is reading.
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
 * The first version passed `{ heroHeading }`, which is not a field this action
 * has at all — so inputSchema.safeParse refused it and
 * tryExecuteAutonomousAction returned false. That looked exactly like an
 * authority refusal and was nothing of the kind, which is why the no-grant
 * case below uses a VALID input too: a refusal that could be caused by a
 * malformed fixture proves nothing about authority.
 */
const VALID_HOMEPAGE = {
        primaryCallToAction: "ZZAFTERCTA",
        secondaryCallToAction: null,
        aboutUs: "Hand-wound in a small workshop.",
        whyChooseUs: "Every ring is measured by cubit.",
        featuredCollections: [],
        faq: [],
        newsletterSection: "",
        footerContent: "",
        customSection: null,
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
        // AUTONOMY IS NOT THE ONLY GATE. Publishing a storefront change costs
        // Growth Points, and a store with none gets a FAILED execution whose
        // message says so — the correct behaviour, and exactly what
        // ai-actions.ts predicts for "insufficient Growth Points for a paid
        // auto-execute action". Without this the suite reports an authority
        // failure that is really an empty wallet.
        growthPointBalance: 500,
        blueprint: { homepageContent: { primaryCallToAction: "ZZBEFORECTA" } } as never,
      },
    });
    // SEEDED HERE, not in section 5. The storefront's shop section returns
    // null when a store has no active products (page.tsx: `if
    // (products.length === 0) return null`), and primaryCallToAction is that
    // section's button label — so with no product the field J4 changes is
    // simply not on the page, and the rendered check times out against
    // perfectly correct behaviour.
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
      actionType: "update_homepage_content",
      input: { ...VALID_HOMEPAGE, primaryCallToAction: "ZZSHOULDNOTLAND" },
      summary: "Genesis acted on its own",
      topicKey: null,
      cognitiveOutputId: null,
    } as never);
    check("a newly autonomous action still needs the owner's grant", withoutGrant, false);
    check("and nothing was written",
      ((await prismaSystem.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
        .blueprint as { homepageContent: { primaryCallToAction: string } }).homepageContent.primaryCallToAction,
      "ZZBEFORECTA");

    // ======================================================================
    console.log("\n=== 2. Granted, J4 acts without asking ===\n");
    // ======================================================================
    await grantDelegatedAuthority({
      storeId: store.id,
      actionType: "update_homepage_content",
      grantedByUserId: owner.id,
    });
    const ran = await tryExecuteAutonomousAction({
      storeId: store.id,
      actionType: "update_homepage_content",
      input: VALID_HOMEPAGE,
      summary: "Genesis acted on its own",
      topicKey: null,
      cognitiveOutputId: null,
    } as never);
    check("update_homepage_content runs under a grant", ran, true);
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
        where: { storeId: store.id, actionType: "update_homepage_content" },
        select: { status: true },
      })).status,
      "EXECUTED");

    // ======================================================================
    console.log("\n=== 3. It landed, and J4 read it back ===\n");
    // ======================================================================
    const log = await prismaSystem.executionLog.findFirstOrThrow({
      where: { storeId: store.id, action: "store.update_homepage_content" },
      orderBy: { createdAt: "desc" },
    });
    check("the execution is SUCCESS", log.status, "SUCCESS");
    // THE REASON AUTONOMY IS ALLOWED AT ALL. An unsupervised action that cannot
    // confirm itself would be the worst combination available.
    check("verification confirmed it by reading it back", log.verified, true);
    check("recorded as Genesis acting, not as a person", log.actorType, "GENESIS");
    check("and the store really changed",
      ((await prismaSystem.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
        .blueprint as { homepageContent: { primaryCallToAction: string } }).homepageContent.primaryCallToAction,
      "ZZAFTERCTA");

    // ======================================================================
    console.log("\n=== 3b. And a customer sees it ===\n");
    // ======================================================================
    //
    // primaryCallToAction is the storefront's shop-button label
    // (app/store/[slug]/page.tsx: `homepage?.primaryCallToAction || "Shop Now"`),
    // so the field J4 just changed on its own authority is one a customer reads.
    //
    // WAITING FOR THE PAGE, not for the navigation. The first version read
    // page.innerText("body") straight after domcontentloaded and got an empty
    // string, which I mistook for a broken fixture and removed the whole
    // rendered half over. Fetching the same URL returned 24KB of correct HTML:
    // the page was never the problem, the read was simply too early.
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${server.baseUrl}/store/${store.slug}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("text=ZZAFTERCTA", { timeout: 30_000 });
      const body = (await page.innerText("body")).replace(/\s+/g, " ");
      assert("the autonomous change is on the page a customer sees",
        body.includes("ZZAFTERCTA"), body.slice(0, 200));
      assert("and what it replaced is gone", !body.includes("ZZBEFORECTA"), body.slice(0, 200));
      await page.screenshot({ path: "verification-screenshots/autonomy-storefront.png" });
      await page.close();
    } finally {
      await browser.close().catch(() => {});
    }

    // ======================================================================
    console.log("\n=== 4. The second raised action behaves the same ===\n");
    // ======================================================================
    await grantDelegatedAuthority({
      storeId: store.id,
      actionType: "update_store_content",
      grantedByUserId: owner.id,
    });
    const ranStore = await tryExecuteAutonomousAction({
      storeId: store.id,
      actionType: "update_store_content",
      input: {
        shippingPolicy: "Ships in two days.",
        returnPolicy: "ZZAFTERRETURNS",
        privacyPolicy: "We keep your details.",
        termsAndConditions: "Be kind.",
        contactPageCopy: "Say hello.",
      },
      summary: "Genesis acted on its own",
      topicKey: null,
      cognitiveOutputId: null,
    } as never);
    check("update_store_content runs under a grant", ranStore, true);
    const storeLog = await prismaSystem.executionLog.findFirstOrThrow({
      where: { storeId: store.id, action: "store.update_store_content" },
      orderBy: { createdAt: "desc" },
    });
    check("and it too was verified by read-back", storeLog.verified, true);

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
