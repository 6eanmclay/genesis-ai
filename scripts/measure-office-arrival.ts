import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import { startTestServer } from "@/scripts/lib/testServer";

// WHAT THE OFFICE ARRIVAL ACTUALLY COSTS, IN PIXELS (2026-09-12).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/measure-office-arrival.ts" -OutFile out.txt
//
// ============ WHAT THIS IS FOR, AND WHEN TO RUN IT =====================
//
// A vertical-budget reading of the Office arrival at both supported widths,
// plus a business with nothing waiting. Run it whenever something changes
// what the Office pins, what it renders above the work, or how tall any of
// that is — it answers the one question a green suite cannot: how much of the
// owner's screen is spent before the first thing they can act on.
//
// KEPT DELIBERATELY (2026-09-13, Sean's call after Priority 3). It found the
// defect that started this work: at 390x844 the pinned band was 461px, the
// work window was 177px holding 2288px of briefing, and the first actionable
// row sat 49px below that window's bottom edge — the phone arrival showed no
// actionable work at all. Then it measured the fix. A reading like that is
// worth being able to reproduce rather than reconstruct.
//
// ============ WHY IT IS NOT A SUITE ====================================
//
// It asserts nothing and fixes nothing; it prints geometry. The success
// condition it exists to inform IS asserted, on the same rendered page, by
// verify-office-arrival — "the first actionable item is IN the work window on
// arrival" and "its control can be reached without scrolling". That is where
// a regression must fail, because a suite is what the runner enforces.
//
// The `measure-` prefix is load-bearing: run-all-suites discovers `verify-*`
// only (see its allSuites()), so this cannot become a discovered regression
// suite by naming convention, and its output stays a reading rather than a
// verdict. scripts/measure-office-assembly.ts is here on the same footing.

const PASSWORD = "harness-password-not-a-real-one";
const SHOTS = "C:/Users/hyper/AppData/Local/Temp/claude/c--Users-hyper-Projects-genesis-ai/bf92a8db-c343-486c-8851-fbd8c29a73d0/scratchpad/shots";

type Block = {
  name: string;
  found: boolean;
  top: number;
  height: number;
  bottom: number;
  /** Visible without scrolling anything. */
  inFirstScreen: boolean;
  /** Proof of identity — the text actually inside what was measured. */
  sample: string;
};

/**
 * Every block of the arrival screen, top to bottom, as rendered.
 *
 * Selected STRUCTURALLY rather than by adding test ids, because the brief is
 * measurement and a new attribute is a change to the product. Each block
 * carries a text sample so the numbers can be checked against what was really
 * under the rectangle — a measurement of the wrong element is worse than none.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // NO NAMED FUNCTION EXPRESSIONS IN HERE. tsx compiles this body with
    // esbuild's keep-names on, which rewrites `const f = () => {}` into
    // `__name(f, "f")` — and `__name` exists in the bundler's prelude, not in
    // the browser. The measurement died with "ReferenceError: __name is not
    // defined" before it read a single rectangle. Everything below therefore
    // uses inline callbacks, which are never renamed.

    // TWO BLOCKS NOW, NOT ONE (2026-09-13). `office-presence` is what stays
    // pinned — J4, his title, the business. `office-band` kept its test id and
    // is now everything that moved into the scrolling region below the work.
    // Measuring them separately is the whole point of the comparison.
    const presence = document.querySelector('[data-testid="office-presence"]');
    const band = document.querySelector('[data-testid="office-band"]');
    const h1 = presence?.querySelector("h1") ?? null;
    // h1 -> the baseline row -> the text column. The character is that
    // column's previous sibling, which is how the flex row is built.
    const textCol = h1?.parentElement?.parentElement ?? null;
    const intro = textCol?.parentElement ?? null;
    const character = textCol?.previousElementSibling ?? null;
    const arc = band?.querySelector("ol") ?? null;
    const blurb = arc?.nextElementSibling ?? null;
    const facts = document.querySelector('[data-testid="office-facts"]');
    const quick = document.querySelector('[data-testid="office-quick-actions"]');

    const briefingTab = [...document.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Briefing",
    );
    const tabs = briefingTab?.parentElement ?? null;

    const briefing = document.querySelector('[data-testid="office-briefing"]');
    // The briefing's parent is the one element on this screen that scrolls.
    const scroller = briefing?.parentElement ?? null;

    const sections = [...document.querySelectorAll('[data-testid^="office-section-"]')].map((el) => {
      const r = el.getBoundingClientRect();
      const count = Number(el.getAttribute("data-count") ?? "-1");
      return {
        key: (el.getAttribute("data-testid") ?? "").replace("office-section-", ""),
        count,
        top: Math.round(r.y),
        height: Math.round(r.height),
        // An empty section still renders a heading and a sentence. That is a
        // deliberate product rule ("a section that vanishes when empty teaches
        // an owner it does not exist") and it is also vertical space.
        empty: count === 0,
      };
    });

    const rows = [...document.querySelectorAll('[data-testid="work-row"]')];
    const actionable = rows.filter((r) =>
      r.querySelector(
        '[data-testid="work-action-open"],[data-testid="work-action-execute"],[data-testid="needs-provide"]',
      ),
    );

    const handled = document.querySelector('[data-testid="briefing-handled"]');
    const talk = document.querySelector('[data-testid="briefing-talk"]');

    // The composer, because on a phone it is the other end of the same budget.
    const composer = document.querySelector("textarea");

    // THE UTILITY HEADER ABOVE THE BAND. Easy to forget because it carries
    // almost no content on the room — J4WorkingPublisher, the Just Talk
    // toggle and the ✕ — but it is the first thing on the screen and it is
    // fixed chrome, so it spends the same pixels as anything else.
    const header = (presence ?? band)?.previousElementSibling ?? null;

    const targets: [Element | null | undefined, string][] = [
      [header, "0. utility header (Just Talk, close)"],
      [presence, "1. PINNED presence row"],
      [intro, "1a.   intro row (character + text)"],
      [character, "1b.     J4 character"],
      [h1, "1c.     'J4 Office' + store name"],
      [tabs, "2. PINNED tab navigation"],
      [scroller, "3. scrolling region (everything below is inside it)"],
      [briefing, "3a.   briefing"],
      [document.querySelector('[data-testid="office-section-needs_you"]'), "3b.     NEEDS YOU section"],
      [rows[0], "3c.     first work row (any)"],
      [actionable[0], "3d.     FIRST ACTIONABLE work row"],
      [handled, "3e.     Done / handled summary"],
      [talk, "3f.     'Talk to me about any of this'"],
      [band, "4.   grounding block (below the work)"],
      [quick, "4a.     Quick Actions"],
      [facts, "4b.     fact strip (Products)"],
      [arc, "4c.     arc (Plan > Create > Execute > Grow)"],
      [blurb, "4d.     blurb"],
      [composer, "5. composer"],
    ];

    const blocks: Block[] = targets.map(([el, name]) => {
      if (!el) return { name, found: false, top: -1, height: -1, bottom: -1, inFirstScreen: false, sample: "" };
      const r = el.getBoundingClientRect();
      return {
        name,
        found: true,
        top: Math.round(r.y),
        height: Math.round(r.height),
        bottom: Math.round(r.y + r.height),
        inFirstScreen: r.y < vh && r.y + r.height > 0 && r.width > 0 && r.height > 0,
        sample: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 64),
      };
    });

    return {
      vw,
      vh,
      docHeight: Math.round(document.documentElement.scrollHeight),
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      scrollerScrollHeight: scroller ? Math.round(scroller.scrollHeight) : -1,
      scrollerClientHeight: scroller ? Math.round(scroller.clientHeight) : -1,
      blocks,
      sections,
      rowCount: rows.length,
      actionableCount: actionable.length,
      // How far the owner must push the list to bring the first thing they can
      // act on to the top of the region that scrolls.
      scrollToFirstActionable:
        actionable[0] && scroller
          ? Math.round(actionable[0].getBoundingClientRect().y - scroller.getBoundingClientRect().y)
          : -1,
      // ============ THE SUCCESS CONDITION, READ OFF THE PAGE ==========
      //
      // Sean: "the first actionable WorkItem is actually visible within the
      // initial work viewport, without requiring the owner to scroll past the
      // entire J4 introduction."
      //
      // Not "is it in the viewport" — the work window is the scrolling region,
      // and before this change the first actionable row sat 49px BELOW that
      // region's bottom edge while still being inside the viewport's
      // coordinate space. Measured against the scroller's own rectangle, at
      // scrollTop 0, which is what an owner meets on arrival.
      firstActionable: (() => {
        if (!actionable[0] || !scroller) return { exists: false, visible: false, fully: false, detail: "no actionable row" };
        const a = actionable[0].getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        return {
          exists: true,
          visible: a.y < s.y + s.height && a.y + a.height > s.y,
          fully: a.y >= s.y && a.y + a.height <= s.y + s.height,
          detail: `row ${Math.round(a.y)}..${Math.round(a.y + a.height)} vs work window ${Math.round(s.y)}..${Math.round(s.y + s.height)}`,
        };
      })(),
      // WHETHER ITS CONTROLS ARE REACHABLE, not just its headline. A decision
      // whose Approve is below the fold is not a decision the owner can take.
      firstActionableControl: (() => {
        const control = actionable[0]?.querySelector(
          '[data-testid="work-action-execute"],[data-testid="work-action-open"],[data-testid="needs-provide"]',
        );
        if (!control || !scroller) return { exists: false, visible: false, detail: "no control" };
        const c = control.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        return {
          exists: true,
          visible: c.y >= s.y && c.y + c.height <= s.y + s.height,
          detail: `${(control.textContent ?? "").trim().slice(0, 24)} at ${Math.round(c.y)}..${Math.round(c.y + c.height)}`,
        };
      })(),
    };
  });
}

function table(m: Awaited<ReturnType<typeof measure>>): void {
  console.log(`    viewport ${m.vw}x${m.vh}   document ${m.docHeight}px   page scrolls: ${m.pageScrolls}`);
  console.log(`    scrolling region: ${m.scrollerClientHeight}px tall, ${m.scrollerScrollHeight}px of content`);
  console.log("");
  console.log(`    ${"block".padEnd(52)} ${"top".padStart(6)} ${"h".padStart(6)} ${"bottom".padStart(7)}  first screen`);
  console.log(`    ${"-".repeat(52)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(7)}  ${"-".repeat(12)}`);
  for (const b of m.blocks) {
    if (!b.found) {
      console.log(`    ${b.name.padEnd(52)} ${"-".padStart(6)} ${"-".padStart(6)} ${"-".padStart(7)}  NOT RENDERED`);
      continue;
    }
    console.log(
      `    ${b.name.padEnd(52)} ${String(b.top).padStart(6)} ${String(b.height).padStart(6)} ${String(b.bottom).padStart(7)}  ${b.inFirstScreen ? "yes" : "NO"}`,
    );
  }
  console.log("");
  console.log("    sections, in render order (an empty one still costs its heading):");
  for (const s of m.sections) {
    console.log(
      `      ${s.key.padEnd(12)} count ${String(s.count).padStart(2)}  top ${String(s.top).padStart(5)}  h ${String(s.height).padStart(4)}${s.empty ? "   <- empty, still rendered" : ""}`,
    );
  }
  console.log("");
  console.log(`    ${m.rowCount} work rows, ${m.actionableCount} of them actionable`);
  console.log(`    scroll needed to bring the first actionable row to the top of the list: ${m.scrollToFirstActionable}px`);
  console.log("");
  console.log(`    >>> SUCCESS CONDITION  first actionable row visible in the work window: ${m.firstActionable.visible ? "YES" : "NO"}${m.firstActionable.fully ? " (whole row)" : m.firstActionable.visible ? " (partly)" : ""}`);
  console.log(`        ${m.firstActionable.detail}`);
  console.log(`        its control reachable without scrolling: ${m.firstActionableControl.visible ? "YES" : "NO"} — ${m.firstActionableControl.detail}`);
  console.log("");
  console.log("    identity of what was measured (so a wrong rectangle shows here):");
  for (const b of m.blocks) {
    if (b.found && b.sample) console.log(`      ${b.name.trim().slice(0, 44).padEnd(46)} ${JSON.stringify(b.sample)}`);
  }
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser;
  try {
    const stamp = Date.now();
    const email = `measure-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `measure-${stamp}`, published: true, currency: "USD" },
    });

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

    // THE SAME POPULATION verify-office-arrival seeds, so the geometry here
    // describes the screen that suite already walks rather than a second,
    // conveniently-shaped business.
    await prisma.genesisObservation.createMany({
      data: [
        { storeId: store.id, dedupeKey: "m:opp-inert", genesisState: "opportunity",
          summary: "Repeat customers are drifting away", actionHref: null, firstNoticedAt: daysAgo(30) },
        { storeId: store.id, dedupeKey: "m:prob-live", genesisState: "urgent",
          summary: "QuickBooks needs reconnecting", actionHref: "/dashboard/connections", firstNoticedAt: daysAgo(40) },
        { storeId: store.id, dedupeKey: "m:prob-inert", genesisState: "urgent",
          summary: "Orders are being counted oddly this week", actionHref: null, firstNoticedAt: daysAgo(1) },
      ],
    });
    await prisma.approvalRequest.create({
      data: { storeId: store.id, actionType: "update_store_content", input: {}, previousValues: {},
        summary: "Publish the updated homepage copy",
        rationale: "Your bios are empty, so search and social have nothing to show.",
        status: "PENDING_APPROVAL" },
    });
    await prisma.approvalRequest.create({
      data: { storeId: store.id, actionType: "update_store_content", input: {}, previousValues: {},
        summary: "Rewrite the returns policy",
        rationale: "You have had two questions about returns this month.",
        status: "PENDING_APPROVAL" },
    });
    await prisma.executionLog.createMany({
      data: [
        { storeId: store.id, executionId: `m1-${stamp}`, action: "product.edit", status: "SUCCESS", message: "Updated a product", actorType: "OWNER" },
        { storeId: store.id, executionId: `m2-${stamp}`, action: "genesis.store.message", status: "SUCCESS", message: "A chat turn", actorType: "GENESIS" },
      ],
    });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 60_000 });
    await page.waitForSelector('[data-testid="j4-boot"]', { state: "detached", timeout: 60_000 });

    for (const [width, height] of [[390, 844], [1280, 900]] as const) {
      console.log(`\n${"=".repeat(78)}`);
      console.log(`  THE ROOM  /j4  at ${width}x${height}`);
      console.log(`${"=".repeat(78)}\n`);
      await page.setViewportSize({ width, height });
      await page.goto(`${server.baseUrl}/j4`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="office-briefing"]', { timeout: 60_000 });
      // The work arrives with the progressive tier; measuring before it lands
      // would measure the loading state, which is a real screen but not this
      // question.
      await page.waitForFunction(
        () => document.querySelector('[data-testid="office-briefing"]')?.getAttribute("data-office-state") === "ready",
        undefined,
        { timeout: 60_000 },
      );
      table(await measure(page));
      await page.screenshot({ path: `${SHOTS}/room-${width}.png` });
      await page.screenshot({ path: `${SHOTS}/room-${width}-full.png`, fullPage: true });
    }

    // ======================================================================
    // AND A BUSINESS WITH NOTHING WAITING, which is a real arrival too.
    // ======================================================================
    //
    // Sean: "the increased work window should allow the existing truthful
    // empty-state messages to coexist without becoming a reason to bury the
    // rest of the experience."
    //
    // A populated fixture can only prove the work is reachable. This proves
    // the other end: with every section empty, the four honest "nothing is
    // waiting" lines and everything the room offers below them are all on one
    // screen, rather than the empty states filling it on their own.
    // ======================================================================
    // AND THE OTHER OFFICE, because there are two and they are not the same.
    // ======================================================================
    //
    // /j4 is the room. Inside a business the Office is a LAYER over the
    // workspace (BusinessWorkspace renders J4Surface surface="layer"), and the
    // layer renders no OfficeBand at all — `showsOfficeBand = !talkingOnly &&
    // !isLayer`. Measuring only the room would describe one of the two screens
    // an owner can call the Office.
    for (const [width, height] of [[390, 844], [1280, 900]] as const) {
      console.log(`\n${"=".repeat(78)}`);
      console.log(`  THE LAYER  /b/${store.slug}  at ${width}x${height}`);
      console.log(`${"=".repeat(78)}\n`);
      await page.setViewportSize({ width, height });
      await page.goto(`${server.baseUrl}/b/${store.slug}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-j4-presentation]", { state: "attached", timeout: 60_000 });
      // THROUGH THE DOOR THE BREAKPOINT ACTUALLY OFFERS, which is the same
      // pair verify-office-browser uses. My first version guessed at any
      // button mentioning "J4" or "office", clicked something that was not
      // the door, and measured a layer that had never opened — every block
      // NOT RENDERED, which reads exactly like a finding and was an
      // instrument failure.
      const door = width <= 768 ? '[data-testid="j4-office"]' : 'button:has-text("J4 Portal")';
      await page.waitForSelector(door, { state: "visible", timeout: 60_000 });
      await page.click(door);
      await page.waitForFunction(
        () => document.querySelector("[data-j4-presentation='office']")?.getAttribute("aria-hidden") === "false",
        undefined,
        { timeout: 30_000 },
      );
      // The layer opens on Conversation. The briefing is what this measurement
      // is about, so ask for it the way an owner would — and note that on the
      // layer there is no Briefing tab at all, which is itself the finding.
      const hasBriefingTab = await page.evaluate(() =>
        [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === "Briefing"),
      );
      console.log(`    a Briefing tab exists on this surface: ${hasBriefingTab}`);
      const state = await page.evaluate(() => ({
        presentation: document.querySelector("[data-j4-presentation]")?.getAttribute("data-j4-presentation") ?? "(none)",
        hasBand: !!document.querySelector('[data-testid="office-band"]'),
        hasBriefing: !!document.querySelector('[data-testid="office-briefing"]'),
        tabs: [...document.querySelectorAll("button")]
          .map((b) => (b.textContent ?? "").trim())
          .filter((t) => /^(Briefing|Conversation|Tasks|Ideas|Decisions|Information|Understanding)\s*\d*$/.test(t)),
      }));
      console.log(`    presentation=${state.presentation}  OfficeBand rendered: ${state.hasBand}  briefing rendered: ${state.hasBriefing}`);
      console.log(`    tabs: ${state.tabs.join(" | ") || "(none)"}`);
      console.log("");
      table(await measure(page));
      await page.screenshot({ path: `${SHOTS}/layer-${width}.png` });
    }

    // THE SAME BUSINESS, EMPTIED — not a second account. The first version
    // created another user and logged in again, and the login never
    // redirected; rather than debug a second session to prove a layout point,
    // this clears the work from the store already on screen. It is also the
    // better comparison: one business, one session, the only difference being
    // that there is nothing waiting.
    {
      await prisma.genesisObservation.deleteMany({ where: { storeId: store.id } });
      await prisma.approvalRequest.deleteMany({ where: { storeId: store.id } });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${server.baseUrl}/j4`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="office-briefing"]', { timeout: 60_000 });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="office-briefing"]')?.getAttribute("data-office-state") === "ready",
        undefined,
        { timeout: 60_000 },
      );
      console.log(`\n${"=".repeat(78)}`);
      console.log(`  THE ROOM, NOTHING WAITING  /j4  at 390x844`);
      console.log(`${"=".repeat(78)}\n`);
      const m = await measure(page);
      table(m);
      const emptyCopy = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="office-section-"]')].map((el) =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        ),
      );
      console.log("\n    the empty states, as rendered — all four must still say their piece:");
      for (const line of emptyCopy) console.log(`      ${JSON.stringify(line)}`);
      // WHAT THE EMPTY STATES COST, which is the question — not whether the
      // grounding block happens to be above the fold. Supporting context
      // living below the work is the intended order; the thing to watch is
      // that four honest "nothing is waiting" lines do not fill the window on
      // their own and push the real work out of it.
      const emptyCost = m.sections.filter((s) => s.empty).reduce((n, s) => n + s.height, 0);
      console.log(`\n    ${m.sections.filter((s) => s.empty).length} empty sections cost ${emptyCost}px of a ${m.scrollerClientHeight}px work window`);
      console.log(`    and the work below them is still reachable: ${m.firstActionable.fully ? "YES" : "NO"} — ${m.firstActionable.detail}`);
      await page.screenshot({ path: `${SHOTS}/room-390-empty.png` });
    }

    console.log(`\n  screenshots: ${SHOTS}\n`);
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
