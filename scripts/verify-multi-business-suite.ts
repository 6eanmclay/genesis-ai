import { chromium, type Browser } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// THREE BUSINESSES, ONE ACCOUNT — BUSINESS_CONTEXT.md Phase E:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-multi-business-suite.ts" -OutFile out.txt
//
// The three Sean named, deliberately different so that "J4 reasons from the
// active business" is a claim with observable consequences rather than a
// property that is trivially true because the businesses are alike:
//
//   Cubit & Coil       physical e-commerce — products, orders, a supplier
//   Genesis            a software platform — no catalogue, no shipping
//   Creator Presence   content and audience — no products, a social account
//
// ============ WHAT THIS PROVES THAT ISOLATION TESTS DO NOT ===============
//
// Every existing suite proves business A cannot SEE business B. That is
// necessary and it is not the same claim as J4 reasoning DIFFERENTLY about
// them. A system that returned an empty context for all three would pass every
// isolation assertion ever written and be useless.
//
// So this asserts both halves: nothing bleeds, AND what each business produces
// is genuinely its own — different words, different classifications, different
// catalogues, different connections.
//
// ============ THE TWO-TAB TEST ==========================================
//
// §6 is the one that decides whether the architecture worked. Two concurrent
// resolutions naming different slugs, asserting neither sees the other's
// business. It fails against any implementation that reads ambient state and
// passes only when the context is genuinely carried per request — which is
// exactly the difference between /dashboard and /b/[slug].

const PASSWORD = "correct-horse-battery-staple";

let failures = 0;
let passes = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser: Browser | undefined;

  // BEFORE THE IMPORTS BELOW, not after. lib/prisma builds its client from
  // DATABASE_URL at module load, so a dynamic import that happens first binds
  // to whatever URL was ambient — which in this harness is nothing, and fails
  // with ECONNREFUSED several assertions later rather than here.
  process.env.DATABASE_URL = server.db.url;

  const { accessibleBusinesses, businessFromSlug, resolveBusiness, setActiveBusiness } =
    await import("@/lib/businessContext");
  const { buildSourcingContext } = await import("@/lib/sourcing/context");
  const { stateFact } = await import("@/lib/businessModel/statements");

  try {
    const stamp = Date.now();
    const email = `multi-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean", password: await bcrypt.hash(PASSWORD, 10) },
    });

    // ------------------------------------------------------------------
    console.log("\n1. Three businesses, deliberately unalike");

    const cubit = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Cubit & Coil",
        slug: `cubit-${stamp}`,
        tagline: "Hand-wound copper for energy work",
        description: "Hand-wound copper tensor rings and coils.",
        brandPositioning: "minimalist",
        businessCategories: ["wellness"],
        revenueStreams: ["product_sales"],
        currency: "USD",
      },
    });
    const genesis = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Genesis",
        slug: `genesis-${stamp}`,
        tagline: "The business operating system",
        description: "An AI business partner that builds and runs a business with its owner.",
        brandPositioning: "premium",
        businessCategories: ["marketing_agency"],
        revenueStreams: ["subscriptions"],
        currency: "USD",
      },
    });
    const creator = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Creator Presence",
        slug: `creator-${stamp}`,
        tagline: "Building an audience in public",
        description: "Writing and video about building software in the open.",
        brandPositioning: "bold",
        businessCategories: ["marketing_agency"],
        revenueStreams: ["advertising"],
        currency: "USD",
      },
    });

    const reachable = await accessibleBusinesses(user.id);
    check("all three are reachable from one account", reachable.length, 3);
    check("and every one is owned", [...new Set(reachable.map((b) => b.role))], ["OWNER"]);
    // ONE ACCOUNT, NOT THREE. The whole requirement.
    check("all three belong to the same user", [...new Set(reachable.map((b) => b.store.userId))], [user.id]);

    // ------------------------------------------------------------------
    console.log("\n2. Each business gets its own data, and only its own");

    // Cubit sells things. Genesis and Creator Presence do not.
    const ring = await prisma.product.create({
      data: { storeId: cubit.id, name: "Copper tensor ring", description: "Hand-wound", priceInCents: 8500 },
    });
    await prisma.order.create({
      data: {
        storeId: cubit.id,
        productId: ring.id,
        productName: ring.name,
        amountInCents: 8500,
        buyerEmail: "buyer@example.test",
        status: "paid",
        paymentProvider: "STRIPE",
        externalOrderId: `cs_${stamp}`,
      },
    });
    // A different shape of business, with a different kind of connection.
    await prisma.storeIntegration.create({
      data: { storeId: cubit.id, provider: "PRINTFUL", status: "CONNECTED", externalAccountId: "pf_1" },
    });
    await prisma.storeIntegration.create({
      data: { storeId: creator.id, provider: "INSTAGRAM", status: "CONNECTED", externalAccountId: "ig_1" },
    });

    const counts = async (storeId: string) => ({
      products: await prisma.product.count({ where: { storeId } }),
      orders: await prisma.order.count({ where: { storeId } }),
      connections: await prisma.storeIntegration.count({ where: { storeId } }),
    });

    check("Cubit has its product, order and supplier", await counts(cubit.id),
      { products: 1, orders: 1, connections: 1 });
    // THE BLEED TEST. A platform and a creator brand have no catalogue.
    check("Genesis has none of it", await counts(genesis.id), { products: 0, orders: 0, connections: 0 });
    check("Creator Presence has only its own social account", await counts(creator.id),
      { products: 0, orders: 0, connections: 1 });

    // And the connection each has is genuinely a DIFFERENT one.
    const connectionOf = async (storeId: string) =>
      (await prisma.storeIntegration.findMany({ where: { storeId }, select: { provider: true } }))
        .map((i) => i.provider);
    check("Cubit's supplier is Printful", await connectionOf(cubit.id), ["PRINTFUL"]);
    check("Creator Presence's is Instagram", await connectionOf(creator.id), ["INSTAGRAM"]);
    assert("so connecting a supplier to one connects it to one",
      (await connectionOf(genesis.id)).length === 0);

    // ------------------------------------------------------------------
    console.log("\n3. Business facts are owner testimony, per business");

    for (const [store, statement] of [
      [cubit, "People who practise energy work and meditation at home"],
      [genesis, "Small business owners who have never run software before"],
      [creator, "Developers who follow my work and want to build in public"],
    ] as const) {
      await stateFact({
        storeId: store.id,
        userId: user.id,
        entityType: "targetAudience",
        data: { statement },
        modelExtracted: true,
        context: "onboarding",
      });
    }

    const audienceOf = async (storeId: string) => {
      const { readOwnerFacts } = await import("@/lib/businessModel/ownerFacts");
      return (await readOwnerFacts(storeId)).targetAudience;
    };
    const cubitAudience = await audienceOf(cubit.id);
    const genesisAudience = await audienceOf(genesis.id);
    const creatorAudience = await audienceOf(creator.id);

    assert("Cubit's audience is its own", (cubitAudience ?? "").includes("energy work"), cubitAudience ?? "");
    assert("Genesis's is its own", (genesisAudience ?? "").includes("never run software"), genesisAudience ?? "");
    assert("Creator Presence's is its own", (creatorAudience ?? "").includes("build in public"), creatorAudience ?? "");
    // THREE DIFFERENT ANSWERS, not one answer read three times.
    check("and all three are different", new Set([cubitAudience, genesisAudience, creatorAudience]).size, 3);

    // ------------------------------------------------------------------
    console.log("\n4. J4 reasons from the active business, and differently");

    const contexts = {
      cubit: await buildSourcingContext(cubit.id),
      genesis: await buildSourcingContext(genesis.id),
      creator: await buildSourcingContext(creator.id),
    };

    // ============ NOT MERELY ISOLATED — GENUINELY DIFFERENT ============
    // A context assembler that returned nothing for all three would satisfy
    // every isolation assertion above and be worthless.
    assert("Cubit's context is about copper and energy work",
      /copper/i.test(contexts.cubit.ownWords) && /energy work/i.test(contexts.cubit.ownWords),
      contexts.cubit.ownWords);
    assert("Genesis's is about software and business owners",
      /business/i.test(contexts.genesis.ownWords) && /never run software/i.test(contexts.genesis.ownWords),
      contexts.genesis.ownWords);
    assert("Creator Presence's is about audience and building in public",
      /audience/i.test(contexts.creator.ownWords) && /build in public/i.test(contexts.creator.ownWords),
      contexts.creator.ownWords);

    check("three distinct contexts, not one repeated",
      new Set([contexts.cubit.ownWords, contexts.genesis.ownWords, contexts.creator.ownWords]).size, 3);

    // NOTHING FROM ANOTHER BUSINESS APPEARS IN ANY OF THEM.
    assert("Genesis's context never mentions copper", !/copper/i.test(contexts.genesis.ownWords),
      contexts.genesis.ownWords);
    assert("Creator Presence's never mentions copper", !/copper/i.test(contexts.creator.ownWords),
      contexts.creator.ownWords);
    assert("Cubit's never mentions building in public", !/build in public/i.test(contexts.cubit.ownWords),
      contexts.cubit.ownWords);

    // What each SELLS differs, which is what a recommendation reasons from.
    check("only Cubit sells anything", contexts.cubit.sells, ["Copper tensor ring"]);
    check("Genesis sells nothing yet", contexts.genesis.sells, []);
    check("Creator Presence sells nothing yet", contexts.creator.sells, []);
    // PROVEN means it earned money, which only one of them has.
    check("and only Cubit has anything proven", contexts.cubit.proven, ["Copper tensor ring"]);
    check("Genesis has nothing proven", contexts.genesis.proven, []);

    // Positioning is the store's own, and drives what fits it.
    check("each carries its own positioning",
      [contexts.cubit.brandPositioning, contexts.genesis.brandPositioning, contexts.creator.brandPositioning],
      ["minimalist", "premium", "bold"]);

    // ------------------------------------------------------------------
    console.log("\n5. Switching changes which business answers");

    await setActiveBusiness(user.id, cubit.id);
    let active = await resolveBusiness(user.id);
    check("active is Cubit", active.kind === "resolved" && active.storeId, cubit.id);

    await setActiveBusiness(user.id, genesis.id);
    active = await resolveBusiness(user.id);
    check("switching makes Genesis active", active.kind === "resolved" && active.storeId, genesis.id);

    await setActiveBusiness(user.id, creator.id);
    active = await resolveBusiness(user.id);
    check("and again for Creator Presence", active.kind === "resolved" && active.storeId, creator.id);

    // A BUSINESS IS NEVER ACTIVE BECAUSE IT WAS TOUCHED. Updating Cubit must
    // not steal the active slot from Creator Presence — the whole defect
    // Phase 0 removed.
    await prisma.store.update({ where: { id: cubit.id }, data: { tagline: "Touched, not chosen" } });
    active = await resolveBusiness(user.id);
    check("touching another business does not make it active",
      active.kind === "resolved" && active.storeId, creator.id);

    // ------------------------------------------------------------------
    console.log("\n6. Two tabs, two businesses, at the same time");

    // ============ THE ASSERTION THE ARCHITECTURE EXISTS FOR ============
    //
    // Concurrent resolutions naming DIFFERENT slugs. This fails against any
    // implementation that reads ambient state — including the one Genesis had
    // before /b/[slug], where "the" business was a per-account fact shared by
    // every tab. It passes only when the context is carried per request.
    const [tabA, tabB, tabC] = await Promise.all([
      businessFromSlug(user.id, cubit.slug),
      businessFromSlug(user.id, genesis.slug),
      businessFromSlug(user.id, creator.slug),
    ]);
    check("tab A resolved Cubit", tabA?.store.id, cubit.id);
    check("tab B resolved Genesis", tabB?.store.id, genesis.id);
    check("tab C resolved Creator Presence", tabC?.store.id, creator.id);
    check("three concurrent requests, three different businesses",
      new Set([tabA?.store.id, tabB?.store.id, tabC?.store.id]).size, 3);

    // And the active business — a per-account fact — moved none of them.
    active = await resolveBusiness(user.id);
    check("while the active business is still what it was",
      active.kind === "resolved" && active.storeId, creator.id);

    // A BUSINESS THIS ACCOUNT CANNOT REACH IS REFUSED, NEVER SUBSTITUTED.
    const stranger = await prisma.user.create({ data: { email: `stranger-${stamp}@example.test` } });
    const theirs = await prisma.store.create({
      data: { userId: stranger.id, name: "Not yours", slug: `stranger-${stamp}`, tagline: "t", description: "d" },
    });
    check("a business belonging to somebody else resolves to nothing",
      await businessFromSlug(user.id, theirs.slug), null);
    // Succeeding with a DIFFERENT business than the one asked for would be
    // worse than failing, because it succeeds.
    assert("and is not quietly replaced with one of mine",
      (await businessFromSlug(user.id, theirs.slug)) === null);

    // ------------------------------------------------------------------
    console.log("\n7. The switcher, in a real browser");

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    // ============ THE SAME SIGN-IN verify-business-browser USES ==========
    //
    // Copied rather than reinvented, because the reason for its shape is not
    // obvious: the submit is a client-side next-auth call that pushes a route
    // instead of POSTing a form, so the click and the navigation are not one
    // event to wait on. Racing them times out intermittently, and a click that
    // lands before hydration is silently lost with nothing to wait on — which
    // reads as a 60-second failure in code that is fine.
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    for (let attempt = 0; attempt < 6; attempt++) {
      await page.click('button[type="submit"]').catch(() => {});
      try {
        await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
          timeout: 15_000,
        });
        break;
      } catch {
        // Not signed in yet — hydration, or the request is still in flight.
      }
    }
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
      timeout: 30_000,
    });
    await page.waitForLoadState("domcontentloaded");

    // Three businesses and nothing chosen would be ambiguous; one IS chosen,
    // so the account lands in it rather than at the chooser.
    await page.goto(`${server.baseUrl}/b/${cubit.slug}`, { waitUntil: "domcontentloaded" });
    const shell = (await page.locator("body").innerText()).replace(/\s+/g, " ");

    // THE ACTIVE BUSINESS IS OBVIOUS — Sean's own requirement.
    assert("the business being viewed is named on screen", shell.includes("Cubit & Coil"), shell.slice(0, 200));
    assert("and the others are not", !shell.includes("Creator Presence"), shell.slice(0, 300));

    // ============ THE VISIBLE ONE, NOT THE FIRST ONE ====================
    //
    // DashboardShell mounts its nav row twice — once for md–lg and once for
    // lg and up — with the other hidden by a breakpoint. `.first()` picked the
    // hidden one and spent thirty seconds waiting for it to become clickable.
    //
    // Asserting exactly ONE is visible is worth more than picking one anyway:
    // two visible switch controls on the same screen would be a real layout
    // bug, and this is where it would show up.
    const switchLink = page.locator('a[href="/choose-business"]:visible');
    check("exactly one switch control is visible", await switchLink.count(), 1);

    // ============ WAIT FOR THE URL, NOT FOR A LOAD STATE ================
    //
    // domcontentloaded resolves instantly on a page that is already loaded, so
    // it waited for nothing and the assertions below ran against the page we
    // had not left yet. Two of them PASSED that way -- "Cubit & Coil" is the
    // store name and "Genesis" is the product's own branding, so both appear
    // on Cubit's own workspace. Only "Creator Presence" failed, which is the
    // one name that could not be there.
    //
    // That is the failure mode worth naming: an assertion that passes because
    // the thing it looked for happened to be on the wrong page.
    await switchLink.click();
    await page.waitForURL("**/choose-business", { timeout: 30_000 });
    check("the switch control really navigates to the chooser",
      new URL(page.url()).pathname, "/choose-business");

    const chooser = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    for (const name of ["Cubit & Coil", "Genesis", "Creator Presence"]) {
      assert(`the chooser lists ${name}`, chooser.includes(name), chooser.slice(0, 400));
    }
    // AND A WAY TO MAKE ANOTHER, which is what Phase B left undone.
    check("and offers adding another business",
      await page.locator('a[href="/create-business"]:visible').count(), 1);

    // Switching really navigates into the other business.
    // The chooser's buttons are one per business; pick the one whose own text
    // names the target, and wait for the URL rather than a load state.
    await page.locator("form button:visible", { hasText: "Genesis" }).first().click();
    await page.waitForURL(`**/b/${genesis.slug}**`, { timeout: 30_000 });
    check("switching lands in the chosen business",
      new URL(page.url()).pathname.startsWith(`/b/${genesis.slug}`), true);
    const afterSwitch = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    // ============ ASSERTED ON WHAT LEFT, NOT ON WHAT ARRIVED ============
    //
    // "Genesis" is unusable as evidence here: it is this business's name AND
    // the product's own branding, so it appears on every workspace and would
    // pass from any of them. The tagline is not rendered in the shell at all.
    //
    // What IS unambiguous is the business we came from. Cubit's name cannot be
    // on Genesis's workspace for any innocent reason, so its absence -- with
    // the URL already asserted above -- is the honest pair.
    assert("and Cubit's name is gone from it",
      !afterSwitch.includes("Cubit & Coil"), afterSwitch.slice(0, 300));
    // NOTHING FROM THE BUSINESS WE LEFT.
    assert("with nothing left over from Cubit",
      !afterSwitch.includes("Copper tensor ring"), afterSwitch.slice(0, 400));

    // ------------------------------------------------------------------
    console.log("\n8. Create-another is reachable, and honest about the draft");

    await page.goto(`${server.baseUrl}/create-business`, { waitUntil: "domcontentloaded" });

    // ============ THE DOOR LEADS TO THE REAL CREATION FLOW ==============
    //
    // With ONBOARDING_V2_ENABLED set -- which it is, in .env and therefore in
    // this harness -- /create-business hands off to /onboarding rather than
    // rendering the classic form. That is the design: v2 owns creation, and a
    // second copy of it here would be a parallel flow that drifts.
    //
    // So what matters is not which page renders. It is that an account which
    // ALREADY HAS THREE BUSINESSES is allowed into the creation flow at all --
    // the exact thing that was impossible before this page existed, because
    // /dashboard offered creation only behind `if (!store)`.
    const landed = new URL(page.url()).pathname;
    assert("an account with three businesses reaches the creation flow",
      landed === "/onboarding" || landed === "/create-business", landed);
    // AND IS NOT BOUNCED BACK INTO A BUSINESS, which is what "no way to create
    // another" looked like from the outside.
    assert("and is not sent back into a business it already has",
      !landed.startsWith("/b/") && landed !== "/choose-business", landed);

    const create = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    assert("with something to actually start from", create.trim().length > 0, "the page rendered empty");

    await context.close();
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
