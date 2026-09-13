import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";

// TWO SURFACES, ONE QUESTION: "WHAT NEEDS ME" (2026-09-13).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/audit-attention-surfaces.ts" -OutFile out.txt
//
// ============ WHAT THIS IS ============================================
//
// A read-only audit, on Sean's instruction, of the relationship between the
// Business arrival's attention model and the Office's work model. It changes
// nothing in the product. It seeds ONE controlled business, renders both
// surfaces, and reports which underlying records each one shows, under which
// identity, and where they decide differently about the same row.
//
// ============ HOW IDENTITY IS ESTABLISHED, AND ITS ONE LIMIT ==========
//
// Sean: "Record the exact underlying IDs so this is an identity comparison,
// not a visual comparison based on matching headlines."
//
// The Office makes that easy: every row carries `data-work-id` in the DOM.
//
// The arrival does NOT. Its cards carry no id, no data- attribute and no test
// id; the card id reaches only a bound server action. Adding one would be a
// product change, and this audit is not allowed to make one — so identity on
// that side is read from the product's OWN WRITE instead: dismissing a card
// inserts a DismissedAttentionCard row whose cardId is exactly the identity
// the arrival uses for that record. That is stronger than an attribute I
// added for myself, because it is the identity the feature actually operates
// on.
//
// The limit, stated plainly: presence on the arrival is established by a
// unique seeded token in each record's own summary (AUDIT-OBS-3 and so on),
// not by reading an id off the card. Because every token is unique BY
// CONSTRUCTION in a fixture this script controls, token -> record is exact
// rather than a headline heuristic. Where an id is read, it is read; where it
// is inferred, it is inferred from a token nothing else can produce.

const PASSWORD = "harness-password-not-a-real-one";

type Seeded = { token: string; kind: string; id: string; dedupeKey: string | null; summary: string };

function line(char = "-"): string {
  return char.repeat(78);
}

/** Every attention card on the arrival, found by the one control they all share. */
async function readArrival(page: Page) {
  return page.evaluate(() => {
    // EVERY CARD KIND RENDERS THE SAME DISMISS CONTROL in the same position —
    // "same control, same position, every card kind" is the component's own
    // comment — so this finds cards without depending on a class name that is
    // free to change, and without a test id the product does not have.
    const buttons = [...document.querySelectorAll('button[aria-label^="Dismiss"]')];
    const cards = buttons.map((b) => {
      const root = b.closest("div.rounded-xl");
      const text = (root?.textContent ?? "").replace(/\s+/g, " ").trim();
      return {
        text: text.slice(0, 150),
        token: (text.match(/AUDIT-[A-Z]+-\d+/) ?? [""])[0],
        // Everything the card exposes to the page. Reported because "nothing"
        // is the finding.
        exposedAttributes: root
          ? [...root.attributes].map((a) => a.name).filter((n) => n !== "class")
          : [],
      };
    });
    // WHAT THE ARRIVAL SAYS ABOUT WHAT IT IS NOT SHOWING. ATTENTION_ZONE_CAP
    // trims the zone, and the page renders an overflow line plus a total in
    // the disclosure header. Captured because "the cap hides work" and "the
    // cap defers work to J4" are different claims and only one is true.
    const body = (document.body.textContent ?? "").replace(/\s+/g, " ");
    const overflow = body.match(/\+\d+ more[^.]*\./);
    // THE DISCLOSURE'S OWN TOTAL, which HomeWorkspace computes as
    // cards + observations + overflowCount. Read because it is the only way to
    // tell "the cap deferred N to J4" from "N never entered the zone at all" —
    // and those are different product behaviours. If the total exceeds what is
    // rendered and no "+N more" line appears, the remainder is unaccounted for.
    const discTotal = [...document.querySelectorAll("span")]
      .map((s) => (s.textContent ?? "").trim())
      .filter((t) => /^\d+$/.test(t));
    return {
      cards,
      dismissTooltip: buttons[0]?.getAttribute("title") ?? null,
      overflowLine: overflow ? overflow[0] : null,
      standaloneNumbers: discTotal,
    };
  });
}

/** Every work row in the Office, by the id it carries. */
async function readOffice(page: Page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="work-row"]')];
    return rows.map((el) => {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const section = el.closest('[data-testid^="office-section-"]');
      return {
        workId: el.getAttribute("data-work-id") ?? "",
        section: (section?.getAttribute("data-testid") ?? "").replace("office-section-", ""),
        token: (text.match(/AUDIT-[A-Z]+-\d+/) ?? [""])[0],
        text: text.slice(0, 110),
      };
    });
  });
}

/**
 * Open the arrival and wait until it can actually be operated.
 *
 * ============ WHY HYDRATION IS WAITED FOR (2026-09-13) ================
 *
 * The first version navigated, waited for a dismiss button to EXIST, then
 * clicked it from inside page.evaluate. That passed once and did nothing at
 * all the next run — the card stayed, no row was written, and the audit
 * reported "dismissal does not travel" on one run and "nothing happened" on
 * the next. A finding I cannot reproduce is not a finding.
 *
 * The button exists in the server HTML; the form that submits it is wired by
 * React. So this waits for the J4 overlay portal, which is a client component
 * and therefore cannot be in the DOM until hydration has run — the same
 * signal verify-office-browser uses for the same reason.
 */
async function openArrival(page: Page, baseUrl: string, slug: string): Promise<void> {
  await page.goto(`${baseUrl}/b/${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[aria-label^="Dismiss"]', { timeout: 60_000 });
  await page.waitForSelector("[data-j4-presentation]", { state: "attached", timeout: 60_000 });
}

/**
 * Dismiss one card by its seeded token, and return the cardId the product
 * wrote — or null if nothing was written.
 *
 * A real Playwright click on a located element rather than an
 * element.click() from inside evaluate: it waits for actionability and
 * dispatches a trusted event, which is what an owner's finger does.
 */
async function dismissByToken(
  page: Page,
  prisma: { dismissedAttentionCard: { findMany: (a: unknown) => Promise<{ cardId: string }[]> } },
  storeId: string,
  token: string,
): Promise<{ found: boolean; cardId: string | null }> {
  const before = new Set(
    (await prisma.dismissedAttentionCard.findMany({ where: { storeId }, select: { cardId: true } })).map((r) => r.cardId),
  );
  const card = page.locator("div.rounded-xl").filter({ hasText: token }).last();
  if ((await card.count()) === 0) return { found: false, cardId: null };
  await card.locator('button[aria-label^="Dismiss"]').first().click();
  for (let i = 0; i < 80; i++) {
    const now = await prisma.dismissedAttentionCard.findMany({ where: { storeId }, select: { cardId: true } });
    const added = now.map((r) => r.cardId).find((id) => !before.has(id));
    if (added) return { found: true, cardId: added };
    await page.waitForTimeout(250);
  }
  return { found: true, cardId: null };
}

async function openOfficeBriefing(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/j4`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="office-briefing"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="office-briefing"]')?.getAttribute("data-office-state") === "ready",
    undefined,
    { timeout: 60_000 },
  );
}

async function main(): Promise<void> {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser;
  try {
    const stamp = Date.now();
    const email = `audit-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `audit-${stamp}`, published: true, currency: "USD" },
    });

    const seeded: Seeded[] = [];
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

    // ---- ONE APPROVAL ------------------------------------------------
    const approval = await prisma.approvalRequest.create({
      data: {
        storeId: store.id,
        actionType: "update_store_content",
        input: { seoTitle: "Handmade copper cookware" },
        previousValues: { seoTitle: "Home" },
        summary: "AUDIT-APPROVAL-1 Rewrite the search listing",
        rationale: "Your listing says Home, which describes nothing you sell.",
        status: "PENDING_APPROVAL",
      },
    });
    seeded.push({ token: "AUDIT-APPROVAL-1", kind: "ApprovalRequest", id: approval.id, dedupeKey: null, summary: approval.summary });

    // ---- TWO TASKS ---------------------------------------------------
    for (const n of [1, 2]) {
      const task = await prisma.task.create({
        data: {
          storeId: store.id,
          dedupeKey: `audit:task:${n}:${stamp}`,
          source: "manual",
          title: `AUDIT-TASK-${n} Photograph the ${n === 1 ? "saucepan" : "skillet"}`,
          summary: "A real photograph is the one thing J4 cannot produce.",
          context: {},
          actionHref: "/dashboard/products",
          priority: n === 1 ? "WARNING" : "opportunity",
          status: "OPEN",
        },
      });
      seeded.push({ token: `AUDIT-TASK-${n}`, kind: "Task", id: task.id, dedupeKey: task.dedupeKey, summary: task.title });
    }

    // ---- SEVEN OBSERVATIONS, to push past the arrival's cap of five ---
    for (let n = 1; n <= 7; n++) {
      const obs = await prisma.genesisObservation.create({
        data: {
          storeId: store.id,
          dedupeKey: `audit:obs:${n}:${stamp}`,
          genesisState: n % 2 === 0 ? "opportunity" : "urgent",
          summary: `AUDIT-OBS-${n} Something J4 noticed, number ${n}`,
          actionHref: n % 3 === 0 ? "/dashboard/connections" : null,
          firstNoticedAt: daysAgo(n),
          status: "ACTIVE",
        },
      });
      seeded.push({ token: `AUDIT-OBS-${n}`, kind: "GenesisObservation", id: obs.id, dedupeKey: obs.dedupeKey, summary: obs.summary });
    }

    console.log(`\n${line("=")}`);
    console.log("  THE FIXTURE — one business, ten eligible attention items");
    console.log(`${line("=")}\n`);
    console.log(`    ${"token".padEnd(18)} ${"record".padEnd(20)} ${"id".padEnd(28)} dedupeKey`);
    console.log(`    ${line().slice(0, 18)} ${line().slice(0, 20)} ${line().slice(0, 28)} ---------`);
    for (const s of seeded) {
      console.log(`    ${s.token.padEnd(18)} ${s.kind.padEnd(20)} ${s.id.padEnd(28)} ${s.dedupeKey ?? "—"}`);
    }

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 60_000 });

    // ==================================================================
    // SURFACE A — the Business arrival
    // ==================================================================
    await openArrival(page, server.baseUrl, store.slug);
    const arrival = await readArrival(page);

    console.log(`\n${line("=")}`);
    console.log(`  SURFACE A — Business arrival  /b/${store.slug}`);
    console.log(`${line("=")}\n`);
    console.log(`    ${arrival.cards.length} attention cards rendered`);
    console.log(`    dismiss control says: ${JSON.stringify(arrival.dismissTooltip)}`);
    console.log(`    identity exposed to the page: ${JSON.stringify(arrival.cards[0]?.exposedAttributes ?? [])}`);
    console.log(`    what it says about the remainder: ${JSON.stringify(arrival.overflowLine)}`);
    console.log(`    bare numbers on the page (the disclosure total is one of these): ${arrival.standaloneNumbers.join(", ") || "none"}`);
    console.log("");
    for (const c of arrival.cards) {
      console.log(`      ${(c.token || "(no audit token)").padEnd(18)} ${c.text.slice(0, 92)}`);
    }

    // ==================================================================
    // SURFACE B — the Office
    // ==================================================================
    await openOfficeBriefing(page, server.baseUrl);
    const office = await readOffice(page);

    console.log(`\n${line("=")}`);
    console.log("  SURFACE B — the Office  /j4");
    console.log(`${line("=")}\n`);
    console.log(`    ${office.length} work rows rendered`);
    console.log("");
    console.log(`    ${"token".padEnd(18)} ${"section".padEnd(13)} data-work-id`);
    console.log(`    ${line().slice(0, 18)} ${line().slice(0, 13)} ------------`);
    for (const r of office) {
      console.log(`    ${(r.token || "(none)").padEnd(18)} ${r.section.padEnd(13)} ${r.workId}`);
    }

    // ==================================================================
    // WHICH RECORDS EACH SURFACE SHOWS
    // ==================================================================
    const onArrival = new Set(arrival.cards.map((c) => c.token).filter(Boolean));
    const inOffice = new Set(office.map((r) => r.token).filter(Boolean));

    console.log(`\n${line("=")}`);
    console.log("  THE COMPARISON — same business, same moment");
    console.log(`${line("=")}\n`);
    console.log(`    ${"token".padEnd(18)} ${"record".padEnd(20)} ${"arrival".padEnd(9)} office`);
    console.log(`    ${line().slice(0, 18)} ${line().slice(0, 20)} ${line().slice(0, 9)} ------`);
    for (const s of seeded) {
      const a = onArrival.has(s.token);
      const o = inOffice.has(s.token);
      const flag = a === o ? "" : "   <- DIFFERS";
      console.log(`    ${s.token.padEnd(18)} ${s.kind.padEnd(20)} ${(a ? "shown" : "—").padEnd(9)} ${(o ? "shown" : "—").padEnd(6)}${flag}`);
    }
    const arrivalSeeded = seeded.filter((s) => onArrival.has(s.token)).length;
    const officeSeeded = seeded.filter((s) => inOffice.has(s.token)).length;
    console.log("");
    console.log(`    of ${seeded.length} seeded items: arrival shows ${arrivalSeeded}, Office shows ${officeSeeded}`);
    console.log(`    arrival rendered ${arrival.cards.length} cards in total (ATTENTION_ZONE_CAP is 5)`);
    console.log(`    Office rendered ${office.length} work rows in total`);
    // THE ROWS NEITHER SEEDED NOR TOKENED — the onboarding tasks the product
    // generates for a new store. They are the population where the two
    // surfaces actually differ in this fixture, so they are named rather than
    // left as a count discrepancy the reader has to work out.
    const officeUntokened = office.filter((r) => !r.token).map((r) => r.text.slice(0, 46));
    const arrivalUntokened = arrival.cards.filter((c) => !c.token).map((c) => c.text.slice(0, 46));
    console.log("");
    console.log(`    rows with no audit token — generated by the product, not seeded:`);
    console.log(`      Office  (${officeUntokened.length}): ${officeUntokened.join(" | ") || "none"}`);
    console.log(`      arrival (${arrivalUntokened.length}): ${arrivalUntokened.join(" | ") || "none"}`);

    // ==================================================================
    // THE DISMISSAL TEST
    // ==================================================================
    console.log(`\n${line("=")}`);
    console.log("  THE DISMISSAL — \"not now\" on the arrival, then the Office");
    console.log(`${line("=")}\n`);

    // Pick a record both surfaces are currently showing, so the test is about
    // dismissal rather than about a population difference.
    const shared = seeded.find((s) => onArrival.has(s.token) && inOffice.has(s.token));
    if (!shared) {
      console.log("    no record is on BOTH surfaces — the dismissal test cannot be run");
    } else {
      console.log(`    dismissing ${shared.token} (${shared.kind} ${shared.id}) on the arrival\n`);
      await openArrival(page, server.baseUrl, store.slug);
      const result = await dismissByToken(page, prisma, store.id, shared.token);
      if (!result.found) {
        console.log("    could not find that card's dismiss control");
      } else if (result.cardId === null) {
        console.log("    the click landed but NO dismissal row was written — the test did not run");
      } else {
        console.log(`    the product wrote DismissedAttentionCard.cardId = ${JSON.stringify(result.cardId)}`);
        console.log(`    the record's own id is                          ${JSON.stringify(shared.id)}`);
        console.log(`    its dedupeKey is                                ${JSON.stringify(shared.dedupeKey)}`);
        console.log("");

        await openArrival(page, server.baseUrl, store.slug);
        const afterArrival = await readArrival(page);
        const stillOnArrival = afterArrival.cards.some((c) => c.token === shared.token);

        await openOfficeBriefing(page, server.baseUrl);
        const afterOffice = await readOffice(page);
        const stillInOffice = afterOffice.find((r) => r.token === shared.token);

        console.log(`    after dismissal — on the arrival: ${stillOnArrival ? "STILL SHOWN" : "gone"}`);
        console.log(`    after dismissal — in the Office : ${stillInOffice ? `STILL SHOWN as ${stillInOffice.workId} in ${stillInOffice.section}` : "gone"}`);
        console.log("");
        console.log(`    the underlying record is untouched by design: status is still what it was`);
        const check = shared.kind === "GenesisObservation"
          ? (await prisma.genesisObservation.findUnique({ where: { id: shared.id } }))?.status
          : shared.kind === "Task"
            ? (await prisma.task.findUnique({ where: { id: shared.id } }))?.status
            : (await prisma.approvalRequest.findUnique({ where: { id: shared.id } }))?.status;
        console.log(`    ${shared.kind}.status = ${JSON.stringify(check)}`);
      }
    }

    // ==================================================================
    // THE IDENTITY SCHEMES, read from the product's own writes
    // ==================================================================
    console.log(`\n${line("=")}`);
    console.log("  IDENTITY — how each surface names the same record");
    console.log(`${line("=")}\n`);
    // Dismiss one of each remaining kind purely to read the cardId the product
    // writes for it. Done LAST, after every population comparison above, so
    // nothing earlier is measured against a fixture this step has altered.
    for (const target of [
      seeded.find((s) => s.kind === "ApprovalRequest"),
      seeded.find((s) => s.kind === "Task"),
      // THE INTERESTING ONE. An observation is the only record the arrival
      // names by dedupeKey rather than by row id, so it is the case where a
      // shared attention state would have nothing to join on.
      seeded.find((s) => s.kind === "GenesisObservation"),
    ]) {
      if (!target) continue;
      await openArrival(page, server.baseUrl, store.slug);
      // THE SET, NOT "THE LATEST ROW". The first version polled a count and
      // then read `orderBy dismissedAt desc take 1` — so when a dismissal did
      // not land inside the wait, it printed the PREVIOUS dismissal's cardId
      // as if it belonged to this record, and reported the approval's id
      // under the task's name. An instrument that reports a stale value as a
      // finding is worse than one that reports nothing. dismissByToken now
      // returns only a cardId that was not there before.
      const probe = await dismissByToken(page, prisma, store.id, target.token);
      console.log(`    ${target.token}`);
      if (!probe.found) {
        console.log(`      not on the arrival, so its card id cannot be read this way`);
      } else if (probe.cardId === null) {
        console.log(`      the click landed but no new dismissal row appeared — NOT read`);
      } else {
        console.log(`      arrival calls it   ${JSON.stringify(probe.cardId)}`);
      }
      console.log(`      the row's id is    ${JSON.stringify(target.id)}`);
      console.log(`      its dedupeKey is   ${JSON.stringify(target.dedupeKey)}`);
    }
    console.log("");
    console.log("    the Office's own names for the same records, from data-work-id:");
    for (const r of office) {
      if (r.token) console.log(`      ${r.token.padEnd(18)} ${r.workId}`);
    }

    console.log("");
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
