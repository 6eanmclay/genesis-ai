import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer } from "@/scripts/lib/testServer";
import { classifyAttentionRows } from "@/lib/attention/state";
import { approvalRef, taskRef, observationRef } from "@/lib/attention/identity";
import { DEFERRAL_WINDOW_MS } from "@/lib/attention/deferral";

// ONE ITEM, TWO SURFACES, ONE ANSWER (2026-09-13).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-attention-consumption.ts" -OutFile out.txt
//
// ============ WHAT THIS PROVES ========================================
//
// The audit (92d2ab4) showed, on two rendered surfaces, that dismissing an
// approval on the Business arrival left it live in the Office — because the
// state was written under a presentation id no other surface could ask about.
//
// This is the same walk, after the fix, and it is an IDENTITY comparison: both
// surfaces now render data-attention-source and data-attention-id, so the two
// rows are compared by the record they name rather than by their headlines.
//
// The split it must also protect is Sean's: "Do not force Business and Office
// into one UI or one rendering model merely to eliminate divergence." So a
// deferred item is SUPPRESSED on the arrival and SHOWN, marked, in the Office.
// Proving only the first half would be proving a bug.

const PASSWORD = "harness-password-not-a-real-one";

/**
 * The owner attention state, read through the HARNESS client.
 *
 * Never the app's prisma: in a script process that resolves DATABASE_URL from
 * the repo's .env, which is a real database. The classification itself is the
 * shipped one — only the query is local.
 */
async function readStateFrom(
  // A READER, NOT THE CLIENT. Naming a slice of PrismaClient's generated type
  // does not structurally match it — the same mistake the audit script made,
  // where tsx ran happily and `tsc --noEmit` did not.
  listRows: () => Promise<{ cardId: string; source: string | null; sourceId: string | null; dismissedAt: Date }[]>,
) {
  return classifyAttentionRows(await listRows());
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Open the arrival and wait until its forms are wired, not merely present. */
async function openArrival(page: Page, baseUrl: string, slug: string): Promise<void> {
  await page.goto(`${baseUrl}/b/${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-j4-presentation]', { state: "attached", timeout: 60_000 });
}

/** Every canonical item the arrival is showing, by the row it names. */
async function arrivalItems(page: Page): Promise<{ source: string; id: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-attention-source]")].map((el) => ({
      source: el.getAttribute("data-attention-source") ?? "",
      id: el.getAttribute("data-attention-id") ?? "",
    })),
  );
}

/** Every work row the Office is showing, by the row it names and its state. */
async function officeItems(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/j4`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="office-briefing"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="office-briefing"]')?.getAttribute("data-office-state") === "ready",
    undefined,
    { timeout: 60_000 },
  );
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="work-row"]')].map((el) => {
      const control = el.querySelector('[data-testid="work-action-execute"]');
      return {
        source: el.getAttribute("data-attention-source") ?? "",
        id: el.getAttribute("data-attention-id") ?? "",
        deferred: el.getAttribute("data-deferred") === "true",
        marked: !!el.querySelector('[data-testid="work-deferred"]'),
        markedText: (el.querySelector('[data-testid="work-deferred"]')?.textContent ?? "").trim(),
        // WHETHER THE CONTROL STILL LOOKS LIKE THE ORDINARY PRIMARY ONE. The
        // solid green fill is what a decision waiting on an answer wears.
        //
        // THE TOKEN, NOT THE SUBSTRING. The first version matched
        // /bg-\[#4ade3a\]/, which is also inside the muted variant's
        // `hover:bg-[#4ade3a]/[.06]` — so it reported the deferred control as
        // still solid when it was not. This requires the bare utility: not
        // prefixed by `hover:`, not followed by an opacity suffix.
        controlPresent: !!control,
        controlSolid: /(^|\s)bg-\[#4ade3a\](?![/\w])/.test((control as HTMLElement | null)?.className ?? ""),
        controlDeferred: control?.getAttribute("data-deferred") === "true",
        controlLabel: (control?.textContent ?? "").trim(),
      };
    }),
  );
}

/** Set one card aside from the arrival, the way an owner does. */
async function deferFromArrival(page: Page, baseUrl: string, slug: string, token: string): Promise<boolean> {
  await openArrival(page, baseUrl, slug);
  const card = page.locator("div.rounded-xl").filter({ hasText: token }).last();
  if ((await card.count()) === 0) return false;
  await card.locator('button[aria-label^="Dismiss"]').first().click();
  // A NAMED FAILURE, NOT A THROWN TIMEOUT. Under sabotage — the arrival asking
  // by cardId again — the card never leaves, and the first version of this
  // ended the whole run with a TimeoutError before a single assertion could
  // say what went wrong. The wait is the same; only the way it reports
  // changed, and the caller turns it into a real check.
  try {
    await page.waitForFunction(
      (t: string) =>
        ![...document.querySelectorAll("div.rounded-xl")].some((el) => (el.textContent ?? "").includes(t)),
      token,
      { timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser;
  try {
    const stamp = Date.now();
    const email = `consume-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `consume-${stamp}`, published: true, currency: "USD" },
    });

    // Closes over the harness client, so the query is local and the
    // classification is the one that ships.
    const readState = () =>
      readStateFrom(() =>
        prisma.dismissedAttentionCard.findMany({
          where: { storeId: store.id, dismissedAt: { gte: new Date(Date.now() - DEFERRAL_WINDOW_MS) } },
          select: { cardId: true, source: true, sourceId: true, dismissedAt: true },
        }),
      );

    const approval = await prisma.approvalRequest.create({
      data: {
        storeId: store.id, actionType: "update_store_content",
        input: { seoTitle: "Handmade copper cookware" }, previousValues: { seoTitle: "Home" },
        summary: "CONSUME-APPROVAL Rewrite the search listing",
        rationale: "Your listing says Home.", status: "PENDING_APPROVAL",
      },
    });
    const task = await prisma.task.create({
      data: {
        storeId: store.id, dedupeKey: `consume:task:${stamp}`, source: "manual",
        title: "CONSUME-TASK Photograph the saucepan", summary: "A real photograph.",
        context: {}, actionHref: "/dashboard/products", priority: "WARNING", status: "OPEN",
      },
    });
    const observation = await prisma.genesisObservation.create({
      data: {
        storeId: store.id, dedupeKey: `consume:obs:${stamp}`, genesisState: "urgent",
        summary: "CONSUME-OBS QuickBooks needs reconnecting",
        actionHref: "/dashboard/connections", status: "ACTIVE",
      },
    });

    // A LEGACY ROW THAT MUST NOT REACH A CANONICAL ITEM. Its cardId carries the
    // APPROVAL'S OWN ID under an `issue:` prefix — the nastiest shape available,
    // because anything that matched on the id alone, or stripped a prefix and
    // compared, would silently defer a real approval that the owner never
    // touched.
    await prisma.dismissedAttentionCard.create({
      data: { storeId: store.id, cardId: `issue:${approval.id}` },
    });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 60_000 });

    // ==================================================================
    console.log("\n=== 1-3. Both surfaces name the same underlying rows ===\n");
    // ==================================================================
    await openArrival(page, server.baseUrl, store.slug);
    const arrivalBefore = await arrivalItems(page);
    const officeBefore = await officeItems(page, server.baseUrl);

    const want = [
      { label: "ApprovalRequest", ref: approvalRef(approval.id) },
      { label: "Task", ref: taskRef(task.id) },
      { label: "GenesisObservation", ref: observationRef(observation.id) },
    ];
    for (const { label, ref } of want) {
      const onArrival = arrivalBefore.some((i) => i.source === ref.source && i.id === ref.id);
      const inOffice = officeBefore.some((i) => i.source === ref.source && i.id === ref.id);
      check(`${label}: the arrival names ${ref.source}/${ref.id.slice(0, 8)}…`, onArrival,
        arrivalBefore.map((i) => `${i.source}:${i.id.slice(0, 6)}`).join(" ") || "nothing");
      check(`  and the Office names the same row`, inOffice,
        officeBefore.map((i) => `${i.source}:${i.id.slice(0, 6)}`).join(" ") || "nothing");
    }
    // THE IDENTITY IS THE ROW'S, not a spelling either surface invented.
    check("no surface renders a dedupeKey as an identity",
      !arrivalBefore.some((i) => i.id === `consume:obs:${stamp}`) &&
        !officeBefore.some((i) => i.id === `consume:obs:${stamp}`),
      "the observation is named by its id on both");

    // ==================================================================
    console.log("\n=== 10. A legacy issue: row never reaches a canonical item ===\n");
    // ==================================================================
    //
    // Run BEFORE anything is deferred, so the approval's visibility here is
    // about the legacy row and nothing else.
    const stateEarly = await readState();
    check("the legacy row is held as legacy, not as a deferral",
      stateEarly.deferrals.length === 0 && stateEarly.legacyCardIds.has(`issue:${approval.id}`),
      `${stateEarly.deferrals.length} deferrals, ${stateEarly.legacyCardIds.size} legacy`);
    check("  and the approval carrying that id is still shown on the arrival",
      arrivalBefore.some((i) => i.source === "approval" && i.id === approval.id),
      "an issue: row must not defer the approval whose id it happens to contain");
    check("  and still shown, undeferred, in the Office",
      officeBefore.some((i) => i.source === "approval" && i.id === approval.id && !i.deferred));

    // ==================================================================
    console.log("\n=== 4-5. Deferred on the arrival, suppressed there ===\n");
    // ==================================================================
    for (const token of ["CONSUME-APPROVAL", "CONSUME-TASK", "CONSUME-OBS"]) {
      check(`${token}: the owner can set it aside from the arrival`,
        await deferFromArrival(page, server.baseUrl, store.slug, token),
        "the card must leave the arrival — if it stays, the surface is not reading the state it just wrote");
    }
    const stateAfter = await readState();
    check("all three are now owner-level deferrals, by canonical identity",
      stateAfter.deferrals.length === 3,
      stateAfter.deferrals.map((d) => `${d.source}:${d.sourceId.slice(0, 6)}`).join(" "));
    for (const { label, ref } of want) {
      check(`  ${label} is deferred by its own row id`,
        stateAfter.deferrals.some((d) => d.source === ref.source && d.sourceId === ref.id));
    }

    await openArrival(page, server.baseUrl, store.slug);
    const arrivalAfter = await arrivalItems(page);
    for (const { label, ref } of want) {
      check(`${label}: the arrival suppresses it`,
        !arrivalAfter.some((i) => i.source === ref.source && i.id === ref.id),
        arrivalAfter.map((i) => `${i.source}:${i.id.slice(0, 6)}`).join(" ") || "nothing left");
    }

    // ==================================================================
    console.log("\n=== 6-7. The Office still shows them, marked ===\n");
    // ==================================================================
    const officeAfter = await officeItems(page, server.baseUrl);
    for (const { label, ref } of want) {
      const row = officeAfter.find((i) => i.source === ref.source && i.id === ref.id);
      check(`${label}: still in the Office`, !!row,
        row ? "" : "the Office must not hide work the owner set aside");
      check(`  and marked deferred`, row?.deferred === true && row?.marked === true,
        row ? `deferred=${row.deferred} marked=${row.marked} "${row.markedText}"` : "absent");
    }

    // ==================================================================
    console.log("\n=== 8. A deferred approval cannot pass as ordinary ===\n");
    // ==================================================================
    const decision = officeAfter.find((i) => i.source === "approval" && i.id === approval.id);
    check("the deferred approval still offers its control", decision?.controlPresent === true,
      "a dead button would be worse than a marked one");
    check("  the control says it belongs to a deferred item", decision?.controlDeferred === true,
      `data-deferred=${decision?.controlDeferred}`);
    check("  and it is NOT wearing the ordinary primary treatment",
      decision?.controlSolid === false,
      decision?.controlSolid ? "still solid green — it reads as a decision waiting on an answer" : "muted");
    // AND AN UNDEFERRED DECISION STILL IS. Without this the assertion above
    // passes if the solid treatment is simply gone from the product.
    const liveApproval = await prisma.approvalRequest.create({
      data: {
        storeId: store.id, actionType: "update_store_content", input: {}, previousValues: {},
        summary: "CONSUME-LIVE A decision nobody set aside",
        rationale: "r", status: "PENDING_APPROVAL",
      },
    });
    const withLive = await officeItems(page, server.baseUrl);
    const live = withLive.find((i) => i.source === "approval" && i.id === liveApproval.id);
    check("an untouched decision still wears the primary treatment",
      live?.controlSolid === true && live?.deferred === false,
      live ? `solid=${live.controlSolid} deferred=${live.deferred}` : "the live decision did not render");
    // AND THEN IT GOES AWAY AGAIN. It exists only to prove the contrast above,
    // and leaving it would spend one of the arrival's five zone slots — which
    // pushed the task out of the cap and made section 9 read as a regression
    // when it was my own fixture competing with itself.
    await prisma.approvalRequest.delete({ where: { id: liveApproval.id } });

    // ==================================================================
    console.log("\n=== 9. An expired deferral becomes eligible again ===\n");
    // ==================================================================
    //
    // The window is moved by ageing the stored row, not by waiting — the rule
    // reads dismissedAt, so a row one millisecond past the window is the real
    // boundary condition.
    await prisma.dismissedAttentionCard.updateMany({
      where: { storeId: store.id, source: { not: null } },
      data: { dismissedAt: new Date(Date.now() - DEFERRAL_WINDOW_MS - 1000) },
    });
    const stateExpired = await readState();
    check("an expired deferral is no longer in force",
      stateExpired.deferrals.length === 0, `${stateExpired.deferrals.length} still live`);
    await openArrival(page, server.baseUrl, store.slug);
    const arrivalExpired = await arrivalItems(page);
    // ELIGIBLE IS NOT THE SAME AS RENDERED, and the difference is the cap.
    //
    // Sean's requirement is that an expired deferral "becomes eligible
    // again". On the Office — uncapped — eligible and rendered are the same
    // thing, so all three are asserted there. On the arrival they are not:
    // ATTENTION_ZONE_CAP is 5 and this business also carries four
    // product-generated onboarding tasks, so a task ranked last can be
    // eligible and still be held back. That is the arrival's own presentation
    // rule, preserved deliberately — "existing counts/overflow semantics
    // remain" — and an assertion that ignored it would be asserting the cap
    // away rather than the deferral back.
    // A COUNT COMPARISON WAS HERE AND HAS BEEN REMOVED, deliberately.
    //
    // "The arrival shows more than it did while they were deferred" read 4->4
    // on one run and 4->3 on the next, because which items the five-slot zone
    // holds depends on the rank ordering of a population that includes
    // product-generated onboarding tasks. The number moves for reasons that
    // have nothing to do with deferral, so as an assertion about deferral it
    // was noise wearing a claim. The per-item checks below say the same thing
    // and mean it.
    for (const { label, ref } of want) {
      const shown = arrivalExpired.some((i) => i.source === ref.source && i.id === ref.id);
      const cappedOut = ref.source === "task";
      check(`${label}: ${cappedOut ? "eligible again (arrival placement is the cap's call)" : "back on the arrival once the week is up"}`,
        cappedOut ? true : shown,
        shown ? "rendered" : "held by ATTENTION_ZONE_CAP, not by a deferral");
    }
    const officeExpired = await officeItems(page, server.baseUrl);
    // THE UNCAPPED SURFACE IS WHERE "ELIGIBLE AGAIN" IS PROVEN FOR ALL THREE.
    for (const { label, ref } of want) {
      const row = officeExpired.find((i) => i.source === ref.source && i.id === ref.id);
      check(`  ${label}: in the Office, no longer marked deferred`,
        row !== undefined && row.deferred === false,
        row ? `deferred=${row.deferred}` : "absent from the Office");
    }
    const decisionExpired = officeExpired.find((i) => i.source === "approval" && i.id === approval.id);
    check("and the Office stops marking it deferred",
      decisionExpired?.deferred === false && decisionExpired?.controlSolid === true,
      `deferred=${decisionExpired?.deferred} solid=${decisionExpired?.controlSolid}`);

    // ==================================================================
    console.log("\n=== Sabotage guards: no route back to cardId lookup ===\n");
    // ==================================================================
    //
    // The behaviour above could be restored tomorrow by a change that asks the
    // old question again. These assert the shape of the code that answers it.
    const strip = (rel: string) =>
      readFileSync(join(process.cwd(), rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");

    // SCOPED TO THE FUNCTION, NOT TO A WINDOW OF CHARACTERS. The first
    // version used "within N characters of this name", which caught the NEXT
    // function along — isLegacyCardDismissed sits 27 lines below
    // isItemDeferred and legitimately takes a cardId, and attentionRefOf is
    // called from isCardSetAside, which legitimately uses card.id on its
    // legacy branch. Both reported a regression that was not there.
    const bodyOf = (src: string, name: string): string => {
      const start = src.indexOf(`export function ${name}(`);
      if (start === -1) return "";
      const end = src.indexOf("\n}", start);
      return end === -1 ? src.slice(start) : src.slice(start, end + 2);
    };

    const stateSrc = strip("lib/attention/state.ts");
    const isItemDeferredBody = bodyOf(stateSrc, "isItemDeferred");
    check("the canonical question takes a ref and never a card id",
      /ref: AttentionRef/.test(isItemDeferredBody) && !/cardId/.test(isItemDeferredBody),
      isItemDeferredBody ? "there is no card id in scope to fall back to" : "isItemDeferred not found");
    check("  while the legacy question is the only one that takes a card id",
      /cardId: string/.test(bodyOf(stateSrc, "isLegacyCardDismissed")),
      "two questions, so the canonical path cannot reach a string");

    const cardsSrc = strip("lib/dashboard/attentionCards.ts");
    check("a card with a canonical item is never matched by its id",
      /ref === null \? isLegacyCardDismissed\(state, card\.id\) : isItemDeferred\(state, ref/.test(cardsSrc),
      "the legacy path is reachable only when there is no ref");
    const refOfBody = bodyOf(cardsSrc, "attentionRefOf");
    check("  and the ref comes from typed fields, not from card.id",
      /case "observation":\s*return observationRef\(card\.observationId\)/.test(refOfBody) &&
        !/card\.id/.test(refOfBody),
      refOfBody ? "attentionRefOf reads observationId, approvalRequestId, taskId" : "attentionRefOf not found");

    const workSrc = strip("lib/j4/officeWork.ts");
    check("the Office names decisions and observations from separate loops",
      /for \(const item of state\.decisions\)/.test(workSrc) &&
        /for \(const item of state\.observations\)/.test(workSrc) &&
        !/\[\.\.\.state\.decisions, \.\.\.state\.observations\]/.test(workSrc),
      "a merged loop could not tell an approval from an observation without inferring");

    const officeSrc = strip("app/j4/OfficeBriefing.tsx");
    check("the Office renders the item's ref rather than parsing its work id",
      /data-attention-source=\{item\.ref\?\.source/.test(officeSrc),
      "identity on the page comes from the carried ref");

    // NEITHER SURFACE KEPT A DISMISSAL QUERY OF ITS OWN.
    const home = strip("app/dashboard/HomeWorkspace.tsx");
    const intel = strip("app/j4/intelligence-actions.ts");
    check("both surfaces load the one shared state",
      /loadOwnerAttentionState/.test(home) && /loadOwnerAttentionState/.test(intel),
      "one query, two presentations");
    check("  and neither reads DismissedAttentionCard directly",
      !/dismissedAttentionCard/i.test(home) && !/dismissedAttentionCard/i.test(intel),
      "the table is reached through lib/attention/state only");

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
    if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
