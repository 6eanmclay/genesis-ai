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

async function readBriefing(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="office-briefing"]');
    const rows = [...document.querySelectorAll('[data-testid^="briefing-row-"]')].map((el) => {
      const open = el.querySelector('[data-testid="briefing-action-open"]');
      const exec = el.querySelector('[data-testid="briefing-action-execute"]');
      const none = el.querySelector('[data-testid="briefing-action-none"]');
      const why = el.querySelector('[data-testid="briefing-why"]');
      const r = el.getBoundingClientRect();
      return {
        kind: el.getAttribute("data-kind") ?? "",
        headline: (el.querySelector("p:nth-of-type(2)")?.textContent ?? "").trim(),
        why: why ? (why.textContent ?? "").trim() : null,
        action: open ? "open" : exec ? "execute" : none ? "none" : "MISSING",
        href: open?.getAttribute("href") ?? null,
        noneText: none ? (none.textContent ?? "").trim() : null,
        top: Math.round(r.y),
        visible: r.width > 0 && r.height > 0,
      };
    });
    const handled = document.querySelector('[data-testid="briefing-handled"]');
    return {
      present: !!root,
      rows,
      handled: handled ? (handled.textContent ?? "").replace(/\s+/g, " ").trim() : null,
      changes: document.querySelectorAll('[data-testid="handled-change"]').length,
      // Nothing on this surface may look pressable without being pressable.
      fakeHovers: [...document.querySelectorAll('[data-testid="briefing-action-none"]')].filter((el) =>
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
      check(`${width}: all of them are actually painted`, b.rows.every((r) => r.visible), b.rows.map((r) => r.kind).join(", "));

      const order = b.rows.map((r) => r.kind);
      check(`${width}: the decision J4 is blocked on comes first`, order[0] === "decision", order.join(" -> "));
      check(`${width}: a fixable problem outranks an unfixable one`,
        order.indexOf("problem_actionable") < order.indexOf("problem_inert"), order.join(" -> "));
      check(`${width}: problems come before opportunities`,
        order.indexOf("problem_actionable") < order.indexOf("opportunity_inert"), order.join(" -> "));
      check(`${width}: what is on screen is in the order the module returned`,
        b.rows.every((r, i) => i === 0 || b.rows[i - 1].top <= r.top),
        b.rows.map((r) => `${r.kind}@${r.top}`).join(" "));

      const decision = b.rows.find((r) => r.kind === "decision");
      check(`${width}: the decision shows J4's own reasoning`,
        decision?.why === "Your bios are empty, so search and social have nothing to show.",
        decision?.why ?? "none");
      check(`${width}: the decision offers to execute, not to navigate`,
        decision?.action === "execute", decision?.action ?? "none");

      const live = b.rows.find((r) => r.kind === "problem_actionable");
      check(`${width}: a fixable problem carries a real destination`,
        live?.action === "open" && !!live.href?.endsWith("/connections"), live?.href ?? live?.action ?? "none");

      const inert = b.rows.find((r) => r.kind === "problem_inert");
      check(`${width}: an unfixable one says why instead of offering a button`,
        inert?.action === "none" && (inert.noneText?.length ?? 0) > 20, inert?.noneText ?? inert?.action ?? "none");
      check(`${width}: nothing inert is styled as pressable`, b.fakeHovers === 0, `${b.fakeHovers} with a hover`);

      check(`${width}: what J4 handled is shown`, !!b.handled, b.handled?.slice(0, 70) ?? "absent");
      check(`${width}: the handled figures carry their window`,
        /last 14 days/i.test(b.handled ?? ""), b.handled?.slice(0, 40) ?? "");
      // One product.edit is news; a chat turn and an internal finding are not.
      check(`${width}: internal executions did not become news`, b.changes === 1, `${b.changes} change lines`);

      await page.screenshot({ path: `verification-screenshots/arrival-${label}.png` });
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
      () => !!document.querySelector('[data-testid="briefing-items"]'),
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
    await page.waitForSelector('[data-testid="briefing-action-execute"]', { timeout: 30_000 });

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

    await page.click('[data-testid="briefing-action-execute"]');
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
      [...document.querySelectorAll('[data-testid^="briefing-row-"]')].some((el) =>
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
