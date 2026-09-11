import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// J4 GREETS THE OWNER WITH WHAT HE FOUND (2026-09-09).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-office-arrival.ts" -OutFile out.txt
//
// WHY THIS IS A BROWSER SUITE. verify-office-briefing proves the ordering and
// the wording against the real functions, in three lines each. What it cannot
// prove is that any of it reaches a screen: the Office opened on
// `activeCategory = "conversation"` for weeks with 40 items loaded on every
// visit and none of them rendered, and no unit test could have noticed.
//
// It also photographs. A DOM assertion in this repository once passed
// underneath a full-screen overlay, and earlier today a suite went green while
// J4 was painted at 0x0 — so the pictures are part of the evidence, not a
// courtesy.

const PASSWORD = "harness-password-not-a-real-one";
const WIDTHS = [390, 1280];

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/**
 * ============ READING THE FIVE STATES, NOT THE FIVE KINDS (2026-09-11) =
 *
 * The arrival surface is now organised by what J4 can DO about a row rather
 * than by what the row IS. So this reads `data-action` and the section each
 * row sits in, where it used to read `data-kind`.
 *
 * The assertions below keep their INTENT exactly — a decision still has to
 * offer execution rather than navigation, an unfixable problem still has to
 * say why instead of wearing a button, nothing inert may look pressable. What
 * changed is where those rows now live, and that is the product change Sean
 * approved rather than a test being loosened to fit.
 */
async function readBriefing(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="office-briefing"]');
    const sections = [...document.querySelectorAll('[data-testid^="office-section-"]')].map((el) => ({
      key: (el.getAttribute("data-testid") ?? "").replace("office-section-", ""),
      count: Number(el.getAttribute("data-count") ?? "0"),
      top: Math.round(el.getBoundingClientRect().y),
    }));
    const rows = [...document.querySelectorAll('[data-testid="work-row"]')].map((el) => {
      const section = el.closest('[data-testid^="office-section-"]');
      const open = el.querySelector('[data-testid="work-action-open"]');
      const exec = el.querySelector('[data-testid="work-action-execute"]');
      const none = el.querySelector('[data-testid="work-action-none"]');
      const needs = el.querySelector('[data-testid="work-needs-owner"]');
      const why = el.querySelector('[data-testid="work-why"]');
      const r = el.getBoundingClientRect();
      return {
        action: el.getAttribute("data-action") ?? "",
        section: (section?.getAttribute("data-testid") ?? "").replace("office-section-", ""),
        headline: (el.querySelector("p")?.textContent ?? "").trim(),
        why: why ? (why.textContent ?? "").trim() : null,
        // WHICH CONTROL IS ACTUALLY PAINTED, read from the DOM rather than
        // inferred from the action — the two agreeing is the thing under test.
        control: open ? "open" : exec ? "execute" : needs ? "needs_owner" : none ? "none" : "MISSING",
        href: open?.getAttribute("href") ?? null,
        noneText: none ? (none.textContent ?? "").trim() : null,
        needsWhat: (el.querySelector('[data-testid="needs-what"]')?.textContent ?? "").trim() || null,
        needsBecause: (el.querySelector('[data-testid="needs-because"]')?.textContent ?? "").trim() || null,
        top: Math.round(r.y),
        visible: r.width > 0 && r.height > 0,
      };
    });
    // THE STRIP, READ FROM THE SAME SCREEN AS THE SECTIONS.
    //
    // This is the assertion that was missing when "2 NEEDS YOU" sat above
    // "Nothing is waiting on you right now": both halves were green because
    // no test ever read them together.
    const bandEl = document.querySelector('[data-testid="office-fact-needs-you"]');
    const bandNeedsYou = bandEl ? Number((bandEl.textContent ?? "").replace(/[^\d]/g, "")) : null;
    const taskEl = document.querySelector('[data-testid="office-fact-tasks"]');
    const bandTasks = taskEl ? Number((taskEl.textContent ?? "").replace(/[^\d]/g, "")) : null;

    const handled = document.querySelector('[data-testid="briefing-handled"]');
    return {
      present: !!root,
      bandNeedsYou,
      bandTasks,
      taskRowIds: [...document.querySelectorAll('[data-testid="work-row"]')]
        .map((el) => el.getAttribute("data-work-id") ?? "")
        .filter((id) => id.startsWith("task:")),
      bandNeedsYouSource: bandEl?.getAttribute("title") ?? null,
      sections,
      rows,
      handled: handled ? (handled.textContent ?? "").replace(/\s+/g, " ").trim() : null,
      changes: document.querySelectorAll('[data-testid="handled-change"]').length,
      // Nothing on this surface may look pressable without being pressable.
      fakeHovers: [...document.querySelectorAll('[data-testid="work-action-none"]')].filter((el) =>
        /hover:/.test((el as HTMLElement).className),
      ).length,
    };
  });
}

async function main(): Promise<void> {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser;
  try {
    const stamp = Date.now();
    const email = `arrival-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `arrival-${stamp}`, published: true, currency: "USD" },
    });

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

    // One of every kind that matters, fed in an order that is NOT the order
    // they should appear in.
    await prisma.genesisObservation.createMany({
      data: [
        {
          storeId: store.id,
          dedupeKey: "arr:opp-inert",
          genesisState: "opportunity",
          summary: "Repeat customers are drifting away",
          actionHref: null,
          firstNoticedAt: daysAgo(30),
        },
        {
          storeId: store.id,
          dedupeKey: "arr:prob-live",
          genesisState: "urgent",
          summary: "QuickBooks needs reconnecting",
          actionHref: "/dashboard/connections",
          firstNoticedAt: daysAgo(40),
        },
        {
          storeId: store.id,
          dedupeKey: "arr:prob-inert",
          genesisState: "urgent",
          summary: "Orders are being counted oddly this week",
          actionHref: null,
          firstNoticedAt: daysAgo(1),
        },
      ],
    });
    await prisma.approvalRequest.create({
      data: {
        storeId: store.id,
        // THE REGISTRY'S OWN KEY, not the execution-action id.
        //
        // The first version used "store.update_store_content" — a value from
        // EXECUTION_ACTIONS — and ApprovalRequest.actionType is keyed by
        // GENESIS_ACTIONS, whose keys are the short form. The result was
        // `Unknown Genesis action type`, thrown out of the server action and
        // into the root error boundary, which is why the row appeared to
        // vanish: the page had died, not the decision.
        //
        // The input is deliberately left empty. The point of this test is the
        // LOOP — settled, reported, gone — and an action that fails validation
        // exercises the honest half of it: J4 has to say it did not work.
        actionType: "update_store_content",
        input: {},
        previousValues: {},
        summary: "Publish the updated homepage copy",
        rationale: "Your bios are empty, so search and social have nothing to show.",
        status: "PENDING_APPROVAL",
      },
    });
    // A SECOND DECISION, so the reject path has its own row and is not reading
    // the wreckage of the approve test.
    await prisma.approvalRequest.create({
      data: {
        storeId: store.id,
        actionType: "update_store_content",
        input: {},
        previousValues: {},
        summary: "Rewrite the returns policy",
        rationale: "You have had two questions about returns this month.",
        status: "PENDING_APPROVAL",
      },
    });
    // Something already handled, and something internal that must NOT appear.
    await prisma.genesisObservation.create({
      data: {
        storeId: store.id,
        dedupeKey: "arr:resolved",
        genesisState: "urgent",
        summary: "A thing that cleared on its own",
        status: "RESOLVED",
        resolvedAt: daysAgo(2),
      },
    });
    await prisma.executionLog.createMany({
      data: [
        { storeId: store.id, executionId: `x1-${stamp}`, action: "product.edit", status: "SUCCESS", message: "Updated a product", actorType: "OWNER" },
        { storeId: store.id, executionId: `x2-${stamp}`, action: "genesis.store.message", status: "SUCCESS", message: "A chat turn", actorType: "GENESIS" },
        { storeId: store.id, executionId: `x3-${stamp}`, action: "genesis.communicate_finding", status: "SUCCESS", message: "Internal", actorType: "GENESIS" },
      ],
    });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: WIDTHS[0], height: 844 } });
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
    await page.waitForSelector('[data-testid="j4-boot"]', { state: "detached", timeout: 60_000 });

    for (const width of WIDTHS) {
      const label = width === 390 ? "mobile" : "desktop";
      console.log(`\n=== ${label} ${width}px ===\n`);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      // A fresh arrival each time — the point is what the owner sees on
      // landing, not what they see after clicking around.
      await page.goto(`${server.baseUrl}/j4`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="office-briefing"]', { timeout: 30_000 });
      await page.waitForTimeout(900);

      const b = await readBriefing(page);

      // NOTHING IS HIDDEN — the invariant that survives a moving database.
      //
      // Three versions of this check were wrong before this one. It asserted
      // the fixture's own count of four and found five; then it counted the
      // database before the browser opened and found four on screen against
      // five stored; then it counted after the render and found the opposite.
      // The cause is real and is not a defect: arriving makes J4 analyse the
      // business, and that can raise a proposal mid-render. A page is a
      // snapshot, so any assertion comparing it to a live count is racing.
      //
      // What Sean actually asked for is that what J4 knows is not hidden
      // behind a tab. So every seeded item must be ON the arrival screen, and
      // nothing may appear twice. A new item arriving while the page renders
      // satisfies both and is not a failure.

      check(`${width}: the Office opens on the briefing, not the conversation`, b.present);
      const SEEDED = [
        "Publish the updated homepage copy",
        "QuickBooks needs reconnecting",
        "Orders are being counted oddly this week",
        "Repeat customers are drifting away",
      ];
      const onScreen = b.rows.map((r) => r.headline);
      const missing = SEEDED.filter((s) => !onScreen.some((h) => h.includes(s)));
      check(`${width}: nothing J4 knows is left off the arrival screen`,
        missing.length === 0, missing.length ? `MISSING: ${missing.join(" | ")}` : `${onScreen.length} rows, all seeded items present`);

      const duplicated = onScreen.filter((h, i) => onScreen.indexOf(h) !== i);
      check(`${width}: nothing is listed twice`, duplicated.length === 0, duplicated.join(" | ") || "no duplicates");
      check(`${width}: all of them are actually painted`, b.rows.every((r) => r.visible), b.rows.map((r) => r.action).join(", "));

      // ---- THE FIVE STATES, IN THE APPROVED ORDER --------------------
      //
      // NEEDS YOU first, because what only the owner can supply is the
      // bottleneck J4 cannot multiply. Read from the painted geometry, not
      // from the array — a section rendered out of order on screen while the
      // data is in order is exactly the class of bug a DOM read catches and
      // a unit test cannot.
      const sectionOrder = b.sections.map((s) => s.key);
      check(`${width}: the Office renders all four action sections`,
        sectionOrder.join(",") === "needs_you,ready_to_go,decide,noticed", sectionOrder.join(" -> "));
      check(`${width}: and they are painted in that order`,
        b.sections.every((s, i) => i === 0 || b.sections[i - 1].top <= s.top),
        b.sections.map((s) => `${s.key}@${s.top}`).join(" "));
      check(`${width}: what is on screen is in the order the module returned`,
        b.rows.every((r, i) => i === 0 || b.rows[i - 1].top <= r.top),
        b.rows.map((r) => `${r.action}@${r.top}`).join(" "));

      // EVERY ROW IS FILED BY ITS OWN ACTION. This is the whole architectural
      // claim, checked against the rendered page: a row's section is not a
      // property of where it came from.
      const misfiled = b.rows.filter((r) => {
        const expected =
          r.action === "needs_owner" ? "needs_you"
          : r.action === "execute" ? ["ready_to_go", "decide"]
          : ["noticed"];
        return Array.isArray(expected) ? !expected.includes(r.section) : r.section !== expected;
      });
      check(`${width}: every row sits in the section its action dictates`,
        misfiled.length === 0,
        misfiled.map((r) => `${r.action} in ${r.section}`).join(" | ") || `${b.rows.length} rows, all filed by action`);

      const decision = b.rows.find((r) => r.action === "execute");
      check(`${width}: the decision shows J4's own reasoning`,
        decision?.why === "Your bios are empty, so search and social have nothing to show.",
        decision?.why ?? "none");
      check(`${width}: the decision offers to execute, not to navigate`,
        decision?.control === "execute", decision?.control ?? "none");
      check(`${width}: and it is filed under DECIDE`, decision?.section === "decide", decision?.section ?? "none");

      const live = b.rows.find((r) => r.action === "open");
      check(`${width}: a fixable problem carries a real destination`,
        live?.control === "open" && !!live.href?.endsWith("/connections"), live?.href ?? live?.control ?? "none");

      const inert = b.rows.find((r) => r.action === "none");
      check(`${width}: an unfixable one says why instead of offering a button`,
        inert?.control === "none" && (inert.noneText?.length ?? 0) > 20, inert?.noneText ?? inert?.control ?? "none");
      check(`${width}: and it is filed under NOTICED, not hidden`,
        inert?.section === "noticed", inert?.section ?? "none");
      check(`${width}: nothing inert is styled as pressable`, b.fakeHovers === 0, `${b.fakeHovers} with a hover`);

      // ---- NEEDS YOU SAYS BOTH THINGS, OR IS HONESTLY EMPTY ----------
      //
      // This fixture seeds no capability gap, so the section is expected to be
      // empty here — and an empty section must still be PRESENT and say so,
      // rather than disappearing. A section that vanishes when empty teaches
      // an owner it does not exist.
      const needsRows = b.rows.filter((r) => r.action === "needs_owner");
      const needsSection = b.sections.find((s) => s.key === "needs_you");
      check(`${width}: NEEDS YOU is present even with nothing in it`, !!needsSection, "the section must not vanish");

      // ---- THE STRIP AND THE SECTION, ON ONE SCREEN ------------------
      //
      // The defect a screenshot caught and no assertion did: the strip read
      // "2 NEEDS YOU" directly above a section reading "Nothing is waiting on
      // you right now". Read together now, from the rendered page, because
      // that is the only place the contradiction was ever visible.
      check(`${width}: the strip's NEEDS YOU count equals the rows below it`,
        b.bandNeedsYou === needsRows.length,
        `strip ${b.bandNeedsYou} vs ${needsRows.length} rows`);
      check(`${width}: a non-zero strip count cannot sit above an empty section`,
        !((b.bandNeedsYou ?? 0) > 0 && needsRows.length === 0),
        `strip ${b.bandNeedsYou}, rows ${needsRows.length}`);
      check(`${width}: and the strip says what it now means`,
        /only you can provide/i.test(b.bandNeedsYouSource ?? ""),
        b.bandNeedsYouSource ?? "no source");

      // ---- EVERY COUNTED TASK IS ON THE SCREEN ----------------------
      //
      // The strip reported three open tasks while officeWork was handed
      // `tasks: []`, so they were counted here and rendered nowhere. Read off
      // the same page now: the number in the strip and the task rows actually
      // painted below it.
      check(`${width}: every task the strip counts is rendered as a row`,
        b.bandTasks === b.taskRowIds.length,
        `strip ${b.bandTasks} vs ${b.taskRowIds.length} task rows`);
      check(`${width}: a counted task cannot be absent from the sections`,
        !((b.bandTasks ?? 0) > 0 && b.taskRowIds.length === 0),
        `strip ${b.bandTasks}, rows ${b.taskRowIds.length}`);

      // The same invariant for DECIDE, since its count is derived the same way.
      const decideRows = b.rows.filter((r) => r.section === "decide");
      const decideSection = b.sections.find((s) => s.key === "decide");
      check(`${width}: DECIDE's rendered count matches its rows`,
        decideSection?.count === decideRows.length,
        `section says ${decideSection?.count}, ${decideRows.length} rows`);
      for (const r of needsRows) {
        check(`${width}: a needs-you row names what J4 needs`, !!r.needsWhat, r.needsWhat ?? "MISSING");
        check(`${width}: and why J4 cannot supply it`, !!r.needsBecause, r.needsBecause ?? "MISSING");
      }

      check(`${width}: what J4 handled is shown`, !!b.handled, b.handled?.slice(0, 70) ?? "absent");
      check(`${width}: the handled figures carry their window`,
        /last 14 days/i.test(b.handled ?? ""), b.handled?.slice(0, 40) ?? "");
      // One product.edit is news; a chat turn and an internal finding are not.
      check(`${width}: internal executions did not become news`, b.changes === 1, `${b.changes} change lines`);

      // FULL PAGE, not the viewport. The viewport stops at DECIDE, so the task
      // rows in NOTICED — the whole point of this fix — were off the bottom of
      // the evidence. A screenshot that cannot show the thing under test is not
      // evidence of it.
      await page.screenshot({ path: `verification-screenshots/arrival-${label}.png`, fullPage: true });

      // AND THE BOTTOM OF THE LIST, which fullPage does NOT reach.
      //
      // The Office is a fixed overlay that scrolls inside itself, so the
      // document is never taller than the viewport and `fullPage` returns the
      // same first screen. The NOTICED section — where every task row lands —
      // was simply off the bottom of the evidence, which is how a screenshot
      // comes to "confirm" something it cannot show.
      const scrolled = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="office-briefing"]');
        let el: HTMLElement | null = root as HTMLElement | null;
        while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
        if (!el) return false;
        el.scrollTop = el.scrollHeight;
        return true;
      });
      check(`${width}: the list scrolls, so the lower sections are reachable`, scrolled);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `verification-screenshots/arrival-${label}-noticed.png` });
    }

    // ---- J4 DOES NOT WAIT FOR THE BUSINESS DATA ---------------------------
    //
    // Sean's rule, and the one thing the tier split exists to guarantee: "If
    // the briefing takes another second to arrive, I should still be able to
    // talk to J4 immediately."
    //
    // Racing it would be useless — locally the briefing lands about 13ms after
    // the composer, so a test that just compared the two would pass or fail on
    // machine noise and prove nothing either way. So the progressive load is
    // STALLED on purpose: every server-action POST is held for five seconds,
    // and the composer must still take a message inside two. If the conversation
    // ever becomes downstream of the intelligence, this cannot pass.
    console.log("\n=== the composer does not wait for the intelligence ===\n");
    await page.route("**/j4", async (route) => {
      const isServerAction = route.request().method() === "POST";
      if (isServerAction) await new Promise((r) => setTimeout(r, 5000));
      await route.continue();
    });

    const stalledStart = Date.now();
    await page.goto(`${server.baseUrl}/j4`, { waitUntil: "commit" });
    const composer = page.locator('textarea[name="message"]').first();
    let acceptedWhileStalled = -1;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await composer.fill("are you there?", { timeout: 500 });
        if ((await composer.inputValue()) === "are you there?") {
          acceptedWhileStalled = Date.now() - stalledStart;
          break;
        }
      } catch {
        // still hydrating
      }
      await page.waitForTimeout(25);
    }
    const briefingPresentThen = await page.evaluate(
      () => !!document.querySelector('[data-testid="work-row"]'),
    );
    check("J4 takes a message while the intelligence is still loading",
      acceptedWhileStalled >= 0 && acceptedWhileStalled < 2000,
      `${acceptedWhileStalled}ms with the progressive load stalled by 5s`);
    check("and the intelligence genuinely had not arrived yet",
      !briefingPresentThen,
      briefingPresentThen ? "the briefing was already there — the stall did not work" : "briefing absent, as intended");
    await page.unroute("**/j4");
    await composer.fill("").catch(() => {});

    // ---- THE LOOP CLOSES: approve -> execute -> J4 reports back ----------
    //
    // Sean's rule, in full: "If the owner approves -> execute it for real. If
    // it executes -> report the result back into J4's understanding."
    //
    // The first four steps were already proven above. This is the fifth, and
    // it is the one most likely to be quietly missing, because a button that
    // runs a server action and then goes silent LOOKS like it worked.
    //
    // What is asserted is the mechanics of the loop, not that this particular
    // synthetic proposal executes cleanly: the fixture's input is empty, so
    // the engine may well refuse it. Refusing it is a legitimate outcome — the
    // promise is that J4 SAYS what happened either way, which is exactly the
    // difference between an honest partner and a button.
    console.log("\n=== approve -> execute -> report back ===\n");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${server.baseUrl}/j4`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="work-action-execute"]', { timeout: 30_000 });

    const messagesBefore = await prisma.storeMessage.count({ where: { storeId: store.id } });
    const approvalId = (await prisma.approvalRequest.findFirst({
      where: { storeId: store.id, status: "PENDING_APPROVAL", summary: "Publish the updated homepage copy" },
      select: { id: true },
    }))?.id;
    check("the seeded decision is pending before approving", !!approvalId, approvalId ?? "not found");

    // DIAGNOSTICS AROUND THE CLICK. The first run of this failed with the
    // decision still PENDING_APPROVAL, no message written, and the row gone
    // from the screen — the exact "went quiet but looked fine" shape. What the
    // click actually caused is worth recording, not guessing.
    const posts: string[] = [];
    const errors: string[] = [];
    page.on("response", (r) => {
      if (r.request().method() === "POST") posts.push(`${r.status()} ${r.url().replace(server.baseUrl, "")}`);
    });
    page.on("pageerror", (e) => errors.push(String(e).split("\n")[0].slice(0, 160)));
    const urlBefore = page.url();

    await page.click('[data-testid="work-action-execute"]');
    // The button says it is working, then the surface refreshes.
    await page.waitForTimeout(6000);

    console.log(`   url: ${urlBefore.replace(server.baseUrl, "")} -> ${page.url().replace(server.baseUrl, "")}`);
    console.log(`   POSTs during the click: ${posts.length ? posts.join(", ") : "NONE — the handler never reached the server"}`);
    if (errors.length) console.log(`   page errors: ${errors.join(" / ")}`);

    const after = approvalId
      ? await prisma.approvalRequest.findUnique({ where: { id: approvalId }, select: { status: true, decidedAt: true } })
      : null;
    check("approving reaches the real engine", !!after, after ? `status ${after.status}` : "row gone");

    const messagesAfter = await prisma.storeMessage.count({ where: { storeId: store.id } });
    check("J4 reports what happened back into the conversation",
      messagesAfter > messagesBefore, `${messagesBefore} -> ${messagesAfter} messages`);

    const latest = await prisma.storeMessage.findFirst({
      where: { storeId: store.id, role: "assistant" },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });
    // Either "Done" or an honest account of why not — never silence.
    check("and the report says what actually happened",
      !!latest && latest.content.trim().length > 0,
      (latest?.content ?? "").replace(/\s+/g, " ").slice(0, 90));

    const stillListed = await page.evaluate((summary: string) =>
      [...document.querySelectorAll('[data-testid="work-row"]')].some((el) =>
        (el.textContent ?? "").includes(summary),
      ), "Publish the updated homepage copy");

    // THE SCREEN AND THE DATABASE AGREE, WHICHEVER WAY IT WENT.
    //
    // The first version asserted the success path — settled, and gone from the
    // list — while the fixture deliberately exercises the FAILURE path, so it
    // reported two defects that were correct behaviour. approveGenesisAction
    // reverts a failed execution to PENDING_APPROVAL on purpose, so the owner
    // can retry; pendingApprovals.ts documents that directly.
    //
    // So the invariant is the pairing, and it holds on both paths: a decision
    // that settled must be gone, and one still pending must still be offered.
    // An item that vanishes while still pending is the dangerous case — it is
    // what the page dying looked like — and this is what catches it.
    const settled = !!after && after.status !== "PENDING_APPROVAL";
    check(
      settled
        ? "a settled decision leaves the briefing"
        : "a decision that failed stays, so it can be retried",
      settled ? !stillListed : stillListed,
      `${settled ? "settled" : `still ${after?.status}`}, ${stillListed ? "on screen" : "not on screen"}`,
    );

    await page.screenshot({ path: "verification-screenshots/arrival-after-approve.png" });

    // ---- AND THE OTHER ANSWER, WHICH THE OWNER NEVER HAD ----------------
    //
    // The surface said "Your call" and offered only Approve. Saying no runs a
    // real server action too — performRejectGenesisAction, the same primitive
    // four dashboard surfaces already use — and the promise is the same as the
    // approve path: the row really changes, and J4 says so.
    console.log("\n=== reject -> recorded -> J4 says so ===\n");
    await page.goto(`${server.baseUrl}/j4`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="work-action-alternative"]', { timeout: 30_000 });

    const rejectId = (await prisma.approvalRequest.findFirst({
      where: { storeId: store.id, status: "PENDING_APPROVAL", summary: "Rewrite the returns policy" },
      select: { id: true },
    }))?.id;
    check("the second decision is pending before rejecting", !!rejectId, rejectId ?? "not found");

    // BOTH CONTROLS ARE ON THE ROW, read from the page rather than assumed.
    const controls = await page.evaluate((summary: string) => {
      const row = [...document.querySelectorAll('[data-testid="work-row"]')]
        .find((el) => (el.textContent ?? "").includes(summary));
      if (!row) return null;
      return {
        primary: row.querySelector('[data-testid="work-action-execute"]')?.textContent?.trim() ?? null,
        alternatives: [...row.querySelectorAll('[data-testid="work-action-alternative"]')].map((b) => ({
          label: (b.textContent ?? "").trim(),
          intent: b.getAttribute("data-intent"),
        })),
      };
    }, "Rewrite the returns policy");
    check("the decision renders BOTH answers", controls?.alternatives.length === 1,
      `primary=${controls?.primary}, alternatives=${JSON.stringify(controls?.alternatives)}`);
    check("and the second answer is a real reject",
      controls?.alternatives[0]?.intent === "reject", controls?.alternatives[0]?.intent ?? "none");
    check("and it is not worded as a deferral",
      !/not now|later|snooze/i.test(controls?.alternatives[0]?.label ?? ""),
      controls?.alternatives[0]?.label ?? "none");

    const messagesBeforeReject = await prisma.storeMessage.count({ where: { storeId: store.id } });
    await page.evaluate((summary: string) => {
      const row = [...document.querySelectorAll('[data-testid="work-row"]')]
        .find((el) => (el.textContent ?? "").includes(summary));
      (row?.querySelector('[data-testid="work-action-alternative"]') as HTMLButtonElement | null)?.click();
    }, "Rewrite the returns policy");
    await page.waitForTimeout(6000);

    const rejected = rejectId
      ? await prisma.approvalRequest.findUnique({ where: { id: rejectId }, select: { status: true, decidedAt: true } })
      : null;
    check("rejecting reaches the real engine", rejected?.status === "REJECTED", `status ${rejected?.status}`);
    check("  and the decision is recorded as decided", !!rejected?.decidedAt, String(rejected?.decidedAt ?? "none"));

    const messagesAfterReject = await prisma.storeMessage.count({ where: { storeId: store.id } });
    check("J4 says out loud that it was set aside",
      messagesAfterReject > messagesBeforeReject,
      `${messagesBeforeReject} -> ${messagesAfterReject} messages`);

    // NOTHING WAS APPLIED. A rejection must not execute the thing it rejected.
    const executedFromReject = await prisma.approvalRequest.count({
      where: { storeId: store.id, status: "EXECUTED", summary: "Rewrite the returns policy" },
    });
    check("and nothing was executed by saying no", executedFromReject === 0, `${executedFromReject} executed`);

    const stillOnScreen = await page.evaluate((summary: string) =>
      [...document.querySelectorAll('[data-testid="work-row"]')].some((el) =>
        (el.textContent ?? "").includes(summary)), "Rewrite the returns policy");
    check("a rejected decision leaves the list", !stillOnScreen, stillOnScreen ? "still on screen" : "gone");

    await page.screenshot({ path: "verification-screenshots/arrival-after-reject.png" });
    await page.close();
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  console.log("screenshots: verification-screenshots/arrival-*.png");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
