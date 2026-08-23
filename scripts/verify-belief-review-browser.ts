import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import { requireTestDatabase, TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// WHAT J4 UNDERSTANDS, AND ARGUING WITH IT, IN A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-belief-review-browser.ts" -OutFile out.txt
//
// verify-belief-review.ts proves the decisions. It cannot prove the SCREEN, and
// this codebase has been bitten twice by exactly that gap — "tsc passes whether
// or not the wiring is right".
//
// The distinction matters more than usual here because the whole point of U4 is
// that a person can see and contradict what J4 believes. A correction path that
// works in a function and does not render is not the feature; it is the same
// invisible belief with extra code behind it.
//
// So this signs in as a real owner, opens Understanding, reads the claim off the
// page, opens the evidence, clicks "This isn't right", types a reason, submits,
// and then checks the belief has left the active list AND stopped reaching the
// reasoning path.
//
// WHY THE PRODUCT CODE IS IMPORTED LATE, and it is not a style choice.
// startTestServer points the CHILD server at the harness database; this process
// keeps whatever DATABASE_URL it inherited from .env. lib/prisma builds its
// adapter from that variable at module-evaluation time, so a static
// `import { persistSyncedRecords }` at the top of this file instantiates a
// client against the developer's own database and then writes fixtures into it —
// silently, and with the suite's assertions reading a different database than
// the one it just wrote to.
//
// It surfaced here as an ECONNREFUSED, which is luck rather than protection. So:
// point this process at the harness first, import the product code after, and
// then make requireTestDatabase confirm it actually landed there rather than
// trusting that it did. That guard exists precisely because "the only thing
// standing between a real customer's catalogue and a test run was whoever typed
// the command remembering which DATABASE_URL was in their shell".

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
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // The submit is a client-side next-auth call, so a click landing before
  // hydration is lost with no error.
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

async function dismissArrival(page: Page): Promise<void> {
  // Waited out, not clicked: it clears itself when its beat sequence finishes.
  // Identified by what it is — a fixed, full-screen element at z-index 100.
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
      // Still up after 30s. Assertions below will fail visibly rather than
      // reading through an overlay and reporting something wrong.
    });
}

/** One section of the room, read structurally rather than by class name. */
async function sectionUnder(page: Page, title: string): Promise<string> {
  return page.evaluate((wanted) => {
    const heading = Array.from(document.querySelectorAll("h2")).find(
      (h) => h.textContent?.trim() === wanted
    );
    return heading?.parentElement?.textContent ?? "";
  }, title);
}

async function beliefSection(page: Page): Promise<string> {
  return sectionUnder(page, "What J4 has learned");
}

async function main() {
  const server = await startTestServer({ timeoutMs: 180_000 });
  const prisma = server.db.prisma;
  let browser: Browser | null = null;

  // Before any product module is loaded. See the note at the top of this file.
  process.env.DATABASE_URL = server.db.url;
  // The cheap half of the guard. The half that actually matters is the marker
  // table below, which cannot be satisfied by setting a variable.
  process.env[TEST_DATABASE_ENV] = "1";
  const { persistSyncedRecords } = await import("@/lib/businessModel/sync");
  const { prismaSystem } = await import("@/lib/prisma");
  // Not trusted — proved. The marker table only the harness creates is what
  // makes this impossible to satisfy by exporting a variable.
  await requireTestDatabase(prismaSystem);

  try {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const owner = await prisma.user.create({
      data: { email: "owner@belief.test", name: "Owner", password: passwordHash },
    });
    const store = await prisma.store.create({
      data: { userId: owner.id, name: "Copper & Coil", slug: "belief-shop", currency: "GBP", published: true },
    });

    // REAL EVIDENCE, so the "Why" panel has something true to open. These are
    // the same rows the product writes: an insight it surfaced, and a proposal
    // the owner turned down.
    const finding = await prisma.cognitiveOutput.create({
      data: {
        storeId: store.id, kind: "insight", topicKey: "refunds.clustered",
        summary: "Refunds cluster on Mondays", status: "ACTIVE", generatedAt: daysAgo(9),
      },
    });
    const decision = await prisma.approvalRequest.create({
      data: {
        storeId: store.id, actionType: "update_product_image",
        summary: "Replace the hero image on Tensor Ring", status: "REJECTED",
        input: {}, previousValues: {}, createdAt: daysAgo(3),
      },
    });
    const belief = await prisma.belief.create({
      data: {
        storeId: store.id,
        topicKey: "insight_recurrence:refunds.clustered",
        claim: "Refunds keep clustering on Mondays",
        category: "insight_recurrence",
        confidence: 0.74,
        evidenceCount: 3,
        firstObservedAt: daysAgo(40),
        lastConfirmedAt: daysAgo(2),
        evidenceRefs: [finding.id, decision.id, "an-id-that-is-genuinely-gone"],
      },
    });

    // THREE FACTS WITH THREE DIFFERENT ORIGINS, plus one that predates any of
    // this being recorded — the four states the screen has to tell apart.
    const goalData = {
      description: "Open a second workshop", category: "expansion", priority: "high",
      targetDate: null, targetValueInCents: null, status: "active",
      identifiedAt: "2026-03-02", relatedChallengeIds: [] as string[],
    };
    const stated = await persistSyncedRecords(store.id, "genesis_chat", [
      { entityType: "goal", externalId: "g-stated", data: goalData as never },
    ], {
      provenance: "OWNER", provenanceDetail: "chat", statedById: owner.id,
      statedAt: daysAgo(150), modelExtracted: true,
    });
    const statedGoalId = stated.changes[0].recordId;

    await persistSyncedRecords(store.id, "quickbooks", [
      {
        entityType: "goal", externalId: "g-connector",
        data: { ...goalData, description: "Collect on outstanding invoices" } as never,
      },
    ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });

    // The legacy row: written straight to the table, exactly as every record
    // before today was.
    await prisma.businessRecord.create({
      data: {
        storeId: store.id, entityType: "goal", sourceProvider: "quickbooks",
        externalId: "g-legacy",
        data: { ...goalData, description: "A goal from before any of this" } as never,
      },
    });

    // A CHALLENGE THAT BLOCKS THE GOAL. Written through the ordinary sync path
    // so the relationship is PROJECTED by the product, not inserted by hand —
    // the point is that the screen reads what the pipeline produced.
    await persistSyncedRecords(store.id, "genesis_chat", [
      {
        entityType: "challenge", externalId: "c-blocking",
        data: {
          description: "The lease on the current unit ends in December",
          category: "operations", severity: "high", status: "active",
          identifiedAt: "2026-03-02", resolvedAt: null, relatedGoalIds: [statedGoalId],
        } as never,
      },
    ], { provenance: "OWNER", provenanceDetail: "chat", statedById: owner.id, modelExtracted: true });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(page, server.baseUrl, owner.email!);

    await page.goto(`${server.baseUrl}/b/belief-shop/understanding`, { waitUntil: "domcontentloaded" });
    await dismissArrival(page);
    await page.waitForSelector("h2", { state: "attached", timeout: 60_000 });

    // ======================================================================
    console.log("\n0. Every fact says where it came from — or honestly does not");
    // ======================================================================
    // This page has claimed to be "source-attributed" in its own opening line
    // since it was built, and until today that was aspirational: a fact in
    // BusinessRecord.data had no origin to attribute.
    const facts = await sectionUnder(page, "Goals & challenges");
    assert("a goal the owner stated says so", facts.includes("You told me"), facts.slice(0, 400));
    assert("with how long ago", facts.includes("5 months ago"), facts.slice(0, 400));
    // The half that changes how J4 may speak, not just how much to trust.
    assert("and that the wording is J4's reading of it", facts.includes("(interpreted by J4)"));
    assert("a goal from a connected system says that instead",
      facts.includes("From a connected system"), facts.slice(0, 500));
    assert("naming the system", facts.includes("(quickbooks)"));

    // THE HONEST SILENCE. A record nobody sourced renders NOTHING rather than
    // "Source: unknown" — which would say something stronger than the truth, and
    // would put a line under most facts on a real store for months.
    assert("the pre-existing goal is shown", facts.includes("A goal from before any of this"));
    const unknownClaims = (facts.match(/unknown/gi) ?? []).length;
    check("and claims no origin at all", unknownClaims, 0);

    // ======================================================================
    console.log("\n0b. And what is standing in the way of what");
    // ======================================================================
    // The old convention could say a goal and a challenge referenced each other
    // and could not say which one was the problem, so this screen showed two
    // lists side by side with nothing between them.
    assert("the goal says what is holding it up",
      facts.includes("is held up by") && facts.includes("The lease on the current unit ends in December"),
      facts.slice(0, 700));
    // The SAME row, read from the other end.
    assert("and the challenge is marked as blocking something", facts.includes("Blocking"));

    // ======================================================================
    console.log("\n1. The belief is on the screen, with what it is made of");
    // ======================================================================

    const initial = await beliefSection(page);
    assert("the claim is rendered", initial.includes("Refunds keep clustering on Mondays"), initial.slice(0, 160));
    assert("with a confidence a person can read", initial.includes("74% confidence"));
    // THE CATEGORY IN THE OWNER'S LANGUAGE, never the enum. "insight_recurrence"
    // on a screen is the exact failure ARCHITECTURE.md's label invariant exists
    // to stop, and it has shipped before.
    assert("the category is in plain words", initial.includes("Something that keeps coming up"));
    assert("and the raw key is nowhere on the page", !initial.includes("insight_recurrence"));
    // THE DATES, which are what say whether it still holds. Both were on the row
    // and neither was ever shown, so a pattern from March read like one from
    // yesterday.
    assert("first noticed is shown", initial.includes("First noticed"), initial.slice(0, 300));
    assert("and last confirmed", initial.includes("last confirmed"));

    // ======================================================================
    console.log("\n2. \"Why do you think that?\" has an answer");
    // ======================================================================
    await page.click('text="Why · 3 things"');
    await page.waitForFunction(
      () => document.body.textContent?.includes("Refunds cluster on Mondays") ?? false,
      undefined,
      { timeout: 10_000 }
    );
    const withEvidence = await beliefSection(page);
    assert("a real finding is listed", withEvidence.includes("Refunds cluster on Mondays"));
    assert("and a real decision", withEvidence.includes("Replace the hero image on Tensor Ring"));
    // REPORTED, NOT HIDDEN. A list that silently shrank would make the belief
    // look thinner than the count on the button says.
    assert("evidence that is gone is admitted rather than dropped",
      withEvidence.includes("no longer on file"), withEvidence.slice(0, 400));
    // Nothing internal reaches the page.
    assert("no internal id is on the screen",
      !withEvidence.includes(finding.id) && !withEvidence.includes(belief.id));

    // ======================================================================
    console.log("\n3. The owner says it is wrong, and it takes");
    // ======================================================================
    await page.click(`text="This isn't right"`);
    await page.waitForSelector('input[name="note"]', { timeout: 10_000 });
    await page.fill('input[name="note"]', "That was one bad month, not a pattern");
    await page.click('text="Mark this wrong"');

    // Waited on the DATABASE, not on a spinner: the claim of this milestone is
    // that a correction is recorded, and a screen that merely re-rendered would
    // satisfy any DOM assertion.
    await page.waitForTimeout(0);
    let recorded: { status: string; retiredReason: string | null } | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const row = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
      if (row.status === "DISMISSED") {
        recorded = { status: row.status, retiredReason: row.retiredReason };
        break;
      }
      await page.waitForFunction(() => true, undefined, { timeout: 1_000 }).catch(() => {});
    }
    check("the correction reached the database", recorded?.status ?? "never", "DISMISSED");
    assert("in the owner's own words",
      (recorded?.retiredReason ?? "").includes("That was one bad month"), String(recorded?.retiredReason));

    // ======================================================================
    console.log("\n4. And the screen agrees with the database");
    // ======================================================================
    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissArrival(page);
    await page.waitForSelector("h2", { state: "attached", timeout: 60_000 });
    const after = await beliefSection(page);
    assert("the claim is no longer presented as something J4 believes",
      !after.includes("Refunds keep clustering on Mondays") || after.includes("you've corrected"),
      after.slice(0, 300));
    assert("and the correction is offered back, not hidden",
      after.includes("you've corrected"), after.slice(0, 300));

    // KEPT AND VISIBLE. A correction the owner cannot see is one they cannot
    // take back.
    await page.click('text=/Show \\d+ you.ve corrected/');
    await page.waitForFunction(
      () => document.body.textContent?.includes("Actually, it was right") ?? false,
      undefined,
      { timeout: 10_000 }
    );
    const corrected = await beliefSection(page);
    assert("the corrected belief is readable", corrected.includes("Refunds keep clustering on Mondays"));
    assert("with the reason the owner gave", corrected.includes("That was one bad month"));
    assert("and a way to undo it", corrected.includes("Actually, it was right"));

    // ======================================================================
    console.log("\n5. J4 has actually stopped using it");
    // ======================================================================
    // THE ASSERTION THAT MAKES THIS A FEATURE RATHER THAN A SCREEN. A
    // correction that leaves the belief in the prompt has changed a page and
    // nothing else.
    //
    // Read through the HARNESS client rather than by calling getBeliefs here.
    // This process's own lib/prisma points at whatever DATABASE_URL it inherited
    // — not the server's database — so importing the reasoning path would either
    // refuse to connect or, worse, answer from somewhere else entirely and pass.
    // getBeliefs' own filter is proved against a real database in
    // verify-belief-review.ts; what this file is here to prove is that clicking
    // the button on the screen is what put the row in this state.
    const reasoningSees = await prisma.belief.findMany({
      where: { storeId: store.id, status: "ACTIVE" },
      select: { id: true },
    });
    check("the corrected belief is no longer among the ones reasoning reads",
      reasoningSees.filter((b) => b.id === belief.id).length, 0);
    assert("and it is the click that did it, not a fixture",
      reasoningSees.length === 0, `${reasoningSees.length} active beliefs remain`);
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
