import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import { waitForOfficeIntelligence } from "@/scripts/lib/appReadiness";

// THE OFFICE'S SIX VIEWS, THROUGH A REAL BROWSER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-office-browser.ts" -OutFile out.txt
//
// GENESIS_SURFACES.md sets this as the acceptance step for the Understanding →
// Office work, and says exactly why it cannot be a unit test: "tsc passes
// whether or not the wiring is right — that is the entire lesson of 6b68cff,
// where the category rail rendered, highlighted on tap, and changed nothing
// because one line upstream still pinned the view. Rendering is not working."
//
// That bug has now happened TWICE in this component, for the same reason both
// times — an upstream line that still assumed the old room/layer split:
//
//   * shownCategory read `isLayer ? "conversation" : activeCategory`, so every
//     tab highlighted and displayed Conversation (fixed 2026-08-15).
//   * getOpenTasks was gated behind `isRoom ? … : []`, so the Tasks view showed
//     its empty state no matter how many open tasks a store had (2026-08-16).
//
// Neither was a type error. Both are invisible to every suite that does not
// click the tab and read what came back. So this suite seeds one unmistakable
// marker per view and, for each tab, asserts that view's marker is present AND
// that no other view's marker is — because "the rail changed nothing" and "the
// rail changed to the wrong thing" are different bugs with the same symptom,
// and a test that only checks for the expected string catches neither.
//
// SECTION 0 IS THE CONTROL, and it is not optional. J4Overlay keeps the Office
// MOUNTED while closed (Talk Mode sends through its composer without opening
// it), so the whole panel's markup is in the DOM of every dashboard page. A
// content assertion that did not first prove it can tell open from closed
// would pass against an Office nobody opened.

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

/** One unmistakable string per view, so "which view is showing" is unambiguous. */
const MARKER = {
  conversation: "ZZCONVERSATIONMARKER",
  tasks: "ZZTASKMARKER",
  ideas: "ZZIDEAMARKER",
  decisions: "ZZDECISIONMARKER",
  information: "ZZINFOMARKER",
} as const;

type ViewKey = keyof typeof MARKER;

/** The two sides of the seeded decision's diff, so the rendered page can be
 *  asserted to show the real values rather than a summary of them. */
const DIFF_BEFORE = "ZZDIFFBEFORE";
const DIFF_AFTER = "ZZDIFFAFTER";

const TAB_LABEL: Record<ViewKey, string> = {
  conversation: "Conversation",
  tasks: "Tasks",
  ideas: "Ideas",
  decisions: "Decisions",
  information: "Information",
};

/** Sign in through the real login form — same mechanics as verify-business-browser. */
async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  // What the credentials endpoint actually answered, kept so a failure reports
  // the server's own verdict rather than "the page did not navigate".
  const authResponses: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/auth/")) authResponses.push(`${r.status()} ${r.url().split("/api/auth/")[1]}`);
  });
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // Submitted more than once, on purpose.
  //
  // The submit is a client-side next-auth call, so the button does nothing at
  // all until React has attached its handler — and a click that lands in that
  // window is simply lost, with no error and no navigation. This suite hit it
  // twice on different runs (once on the first sign-in, once on the second),
  // which is what an unguarded race looks like rather than a broken login.
  //
  // There is no attribute that says "hydrated", so the honest fix is to keep
  // asking until the page responds. Re-clicking a submit that already worked is
  // harmless: by then the form is gone.
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
        timeout: 8_000,
      });
      break;
    } catch {
      // Still on /login — hydration had probably not finished. Try again.
    }
  }
  try {
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, {
      timeout: 30_000,
    });
  } catch (error) {
    // A sign-in that never leaves /login is almost always the form telling us
    // something. Report what it actually says rather than a bare timeout.
    console.log(`        still at ${page.url()}`);
    console.log(`        form says: ${(await page.innerText("body")).replace(/\s+/g, " ").slice(0, 600)}`);
    console.log(`        auth calls: ${authResponses.join(" | ") || "none"}`);
    console.log(`        console errors: ${consoleErrors.join(" | ") || "none"}`);
    throw error;
  }
  await page.waitForLoadState("domcontentloaded");
}

/**
 * Is the Office actually open, as opposed to merely mounted?
 *
 * aria-hidden on the dialog is derived from J4Overlay's `visible`, which is the
 * same state that drives the panel's transform — so it cannot disagree with what
 * the owner sees. Reading the transform instead would be reading an animation
 * mid-flight; reading `visible` through the attribute it already publishes for
 * assistive technology is the honest signal.
 */
/**
 * Is the OFFICE open - as opposed to merely mounted, or open as the panel?
 *
 * ============ THE LABEL IS NOT THE STATE (2026-09-10) ==============
 *
 * This used to find the overlay by aria-label="J4's Office". That label is
 * conditional: J4Overlay renders `aria-label={isPanel ? "J4" : "J4's Office"}`,
 * and since the panel/Office split the overlay sits in PANEL presentation until
 * the Office is opened. So a closed Office had no such element at all, the
 * control assertion "a closed Office is mounted" failed, and every check below
 * it was comparing against a state it could not identify.
 *
 * `data-j4-presentation` is the shell's own state and is present in both
 * presentations, which is what makes it the thing to read. aria-hidden still
 * answers open-versus-closed exactly as before.
 */
/**
 * EVERY FACT ON THE UNDERSTANDING VIEW CARRIES ITS EVIDENCE (2026-09-11).
 *
 * The surface rendered `lines: string[]` - prose with no author, no confidence
 * and no handle, on the one view whose job is saying what J4 believes and why.
 *
 * Read off the RENDERED PAGE rather than from the mapper, because a source the
 * mapper computes and the view drops is the same failure as never computing
 * it. Run at both breakpoints: the panel is a different layout at each, and a
 * check at one width reports a surface half the owners cannot see.
 */
async function assertUnderstandingEvidence(page: Page, width: number): Promise<void> {
  const evidence = await page.evaluate(() => {
    const facts = [...document.querySelectorAll('[data-testid="understanding-fact"]')];
    return {
      total: facts.length,
      withSource: facts.filter((f) => (f.getAttribute("data-source") ?? "") !== "").length,
      withRecord: facts.filter((f) => (f.getAttribute("data-record") ?? "") !== "").length,
      // An evidence line on a fact with no source would be the UI inventing
      // an attribution - the one thing this slice exists to prevent.
      orphanEvidence: facts.filter(
        (f) => (f.getAttribute("data-source") ?? "") === "" && !!f.querySelector('[data-testid="understanding-evidence"]'),
      ).length,
      sources: [...new Set(facts.map((f) => f.getAttribute("data-source") ?? "").filter(Boolean))],
      // A CONTROL MAY NOT EXIST WITHOUT A MECHANISM (2026-09-11).
      //
      // This asserted ZERO controls while contradictBelief was unreachable
      // from here. A real mechanism now exists for beliefs, so the intent is
      // unchanged and the measurement is not: a control is legitimate exactly
      // when its fact carries a correction, and orphaned means a button on a
      // fact that has no way to perform one.
      controls: facts.filter((f) => !!f.querySelector("button")).length,
      orphanControls: facts.filter(
        (f) => !!f.querySelector("button") && !f.querySelector('[data-testid="understanding-correct"]'),
      ).length,
      shownLabels: [...document.querySelectorAll('[data-testid="understanding-evidence"]')]
        .map((e) => (e.textContent ?? "").trim()).slice(0, 4),
    };
  });

  assert(`${width}: facts render as facts, not prose`, evidence.total > 0, `${evidence.total} facts`);
  assert(`${width}: some of them say where they came from`,
    evidence.withSource > 0, `${evidence.withSource} of ${evidence.total} carry a source`);
  assert(`${width}: and some carry a real record handle`,
    evidence.withRecord > 0, `${evidence.withRecord} of ${evidence.total}`);
  assert(`${width}: every source shown is a real provenance value`,
    evidence.sources.every((s) => ["CONNECTOR", "OWNER", "DOCUMENT", "DERIVED", "INFERENCE", "GENERATED"].includes(s)),
    evidence.sources.join(", "));
  assert(`${width}: a fact with no source shows no attribution`,
    evidence.orphanEvidence === 0, `${evidence.orphanEvidence} facts attributed without a source`);
  assert(`${width}: no control exists without a mechanism behind it`,
    evidence.orphanControls === 0, `${evidence.orphanControls} controls with nothing to perform`);
  assert(`${width}: the attribution is in the owner's words, not the enum's`,
    evidence.shownLabels.every((l) => !/OWNER|INFERENCE|CONNECTOR|DERIVED|GENERATED/.test(l)),
    evidence.shownLabels.join(" | "));
}

async function officeIsOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-j4-presentation="office"]');
    return dialog?.getAttribute("aria-hidden") === "false";
  });
}

/**
 * The text of the Office panel itself, not of the page.
 *
 * Scoped by walking up from the category rail's own button to its form, rather
 * than by a class name: the workspace UNDERNEATH the Office renders the same
 * business's tasks and observations, so a whole-page read would find every
 * marker in every state and prove nothing. Found structurally so no styling
 * change can silently widen the scope back out.
 *
 * textContent rather than innerText, deliberately — visibility is Section 0's
 * job, asserted once against a signal that means it, and conflating the two is
 * how a negative assertion comes to pass because nothing rendered at all.
 */
async function officeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // ============ SCOPED TO THE OFFICE, NOT TO A <form> ==============
    //
    // This used to walk up from the "Understanding" tab to its nearest form.
    // The Office rebuild moved the category rail out of a form and into a
    // plain container, so closest("form") returned null, this returned "", and
    // EVERY marker assertion failed at once with "the tab highlighted but the
    // view did not change". Six failures, one dead selector.
    //
    // The portal is the honest scope, and it is the one the doc comment above
    // always described: J4Overlay renders the Office through createPortal, so
    // its subtree is the Office and nothing else. The dashboard underneath -
    // which renders the same business's tasks and observations, and is the
    // reason a whole-page read proves nothing - is outside the portal
    // entirely. Structural, and it cannot silently widen.
    const office = document.querySelector("[data-j4-presentation]");
    return office?.textContent ?? "";
  });
}

/**
 * THE OFFICE HAS TWO DOORS, one per breakpoint, and they are different
 * controls rather than one control styled twice.
 *
 * On mobile the door is the "Office" label under the orb, inside the presence
 * bar — and that bar is `md:hidden`, so on a desktop viewport it is attached to
 * the DOM but never displayed. On desktop the door is the "J4 Portal" pill,
 * which is `hidden md:flex` and therefore the mirror-image case.
 *
 * The first run of this suite clicked the mobile door at Playwright's default
 * 1280×720 and timed out on an element that was present and invisible. That is
 * worth a helper rather than a fixed selector: an entry point that exists on
 * one breakpoint only can break on the other without any suite noticing, and
 * "the Office cannot be opened at all on desktop" is exactly the class of bug
 * this file exists to catch.
 */
// THE MOBILE DOOR MOVED (2026-09-04). It was the "Office" label under
// J4Summon's centre orb, and that orb is gone: "J4Summon put a blue Genesis orb
// in the middle of the mobile bar and was, for a while, the only J4 on a phone.
// It is now a second identity for the same partner... Sean's instruction is one
// J4 throughout the application." J4Summon is no longer mounted at all, so
// [aria-label="Open J4's Office"] is in a file nothing renders and the suite
// waited 60s for an element that could never appear.
//
// The door itself was not removed - it moved into J4Dock, "a small doorway set
// into its lower corner - a door in the side of the building". Addressed by its
// testid rather than its label, because the label carries an em-dash and a
// sentence of prose that will be reworded long before the control moves again.
const OFFICE_DOOR = {
  mobile: '[data-testid="j4-office"]',
  desktop: 'button:has-text("J4 Portal")',
} as const;

type Breakpoint = keyof typeof OFFICE_DOOR;

/**
 * Wait until the workspace is actually interactive.
 *
 * The orb, the pill and the Office are all client components rendered through a
 * portal, so none of them exists in the server HTML — they appear on hydration.
 * Asserting before that point measures how fast the page loaded rather than
 * what it contains, and the first run failed exactly there: "the Office is in
 * the DOM" was false because hydration had not happened yet.
 *
 * Waiting on the DOOR rather than on the Office is deliberate. The door is the
 * owner's real entry point, so waiting for it is waiting for the page to be
 * usable — whereas waiting for the Office itself would make Section 0's "the
 * Office is mounted before it is opened" assertion true by construction.
 */
async function waitForWorkspace(page: Page, at: Breakpoint): Promise<void> {
  await page.waitForSelector(OFFICE_DOOR[at], { state: "visible", timeout: 60_000 });
  // AND THE OVERLAY ITSELF. J4Overlay is always rendered but reaches the page
  // through createPortal into document.body, so it arrives on its own schedule
  // rather than with the door. Section 0's whole point is that a CLOSED Office
  // is already mounted - asserting that the instant the door appears was
  // measuring which of two client components hydrated first.
  await page.waitForSelector("[data-j4-presentation]", { state: "attached", timeout: 30_000 });
}

/** Open the Office through the door this breakpoint actually offers. */
async function openOffice(page: Page, at: Breakpoint): Promise<void> {
  await page.click(OFFICE_DOOR[at]);
  await page.waitForFunction(
    () => document.querySelector("[data-j4-presentation='office']")?.getAttribute("aria-hidden") === "false",
    undefined,
    { timeout: 15_000 }
  );
}

/** Tap a category tab and wait for the panel's content to actually change. */
async function showView(page: Page, label: string): Promise<string> {
  await page.click(`button:text-is("${label}")`);
  // The switch is local state with no network in it, but a click that resolves
  // before React commits would read the previous view — so wait for the tab to
  // report itself selected via its own active styling, then read.
  await page.waitForFunction(
    (l) => {
      const tab = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim().startsWith(l)
      );
      return tab?.className.includes("bg-[#8b7cf6]") ?? false;
    },
    label,
    { timeout: 15_000 }
  );
  // AND THE INTELLIGENCE THAT FILLS IT. The tab switching is local state with
  // no network in it, but the records the view shows are the progressive tier,
  // loaded after mount. Reading between the two showed the empty state - which
  // is a real state, correctly rendered, and simply not the one being asserted.
  await waitForOfficeIntelligence(page);
  return officeText(page);
}

async function main() {
  const server = await startTestServer({ timeoutMs: 180_000 });
  const prisma = server.db.prisma;
  let browser: Browser | null = null;

  try {
    // --- one owner, one business, one real row behind each view -------------
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const owner = await prisma.user.create({
      data: { email: "owner@office.test", name: "Owner", password: passwordHash },
    });
    const store = await prisma.store.create({
      data: {
        userId: owner.id,
        name: "Copper & Coil",
        slug: "copper-and-coil-office",
        tagline: "Hand-wound copper",
        description: "Tensor rings, wound by hand.",
        published: true,
      },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: store.id } });

    // Conversation.
    await prisma.storeMessage.create({
      data: { storeId: store.id, role: "assistant", content: `${MARKER.conversation} — a real prior turn.` },
    });
    // Tasks. priority is AttentionItem's severity vocabulary, not an integer.
    await prisma.task.create({
      data: {
        storeId: store.id,
        dedupeKey: "office.test.task",
        source: "manual",
        title: `${MARKER.tasks} title`,
        summary: "A real open task.",
        context: {},
        priority: "WARNING",
        status: "OPEN",
      },
    });
    // Ideas — an opportunity observation.
    await prisma.genesisObservation.create({
      data: {
        storeId: store.id,
        dedupeKey: "office.test.idea",
        genesisState: "opportunity",
        summary: `${MARKER.ideas} — worth trying.`,
        status: "ACTIVE",
      },
    });
    // A BELIEF J4 HOLDS, so the Understanding view has something the owner can
    // actually disagree with. Two of them, worded alike on purpose: the point
    // of addressing a correction by id is that the similar one survives.
    const belief = await prisma.belief.create({
      data: {
        storeId: store.id, topicKey: "office.test.belief", claim: "ZZBELIEFMARKER restocks on Mondays",
        category: "operations", confidence: 0.64, evidenceCount: 4, status: "ACTIVE",
        firstObservedAt: new Date(Date.now() - 30 * 86_400_000), lastConfirmedAt: new Date(),
      },
    });
    const lookalikeBelief = await prisma.belief.create({
      data: {
        storeId: store.id, topicKey: "office.test.belief2", claim: "ZZBELIEFMARKER restocks on Mondays and Thursdays",
        category: "operations", confidence: 0.51, evidenceCount: 3, status: "ACTIVE",
        firstObservedAt: new Date(Date.now() - 30 * 86_400_000), lastConfirmedAt: new Date(),
      },
    });
    // Information — an urgent observation.
    await prisma.genesisObservation.create({
      data: {
        storeId: store.id,
        dedupeKey: "office.test.info",
        genesisState: "urgent",
        summary: `${MARKER.information} — needs attention.`,
        status: "ACTIVE",
      },
    });
    // Decisions — a pending proposal.
    // A REAL PROPOSAL, because the Decisions view now has to show what
    // approving would change. Empty input/previousValues rendered an Approve
    // button over nothing, which is the exact state this suite must be able
    // to tell apart from a real one.
    await prisma.approvalRequest.create({
      data: {
        storeId: store.id,
        actionType: "update_seo",
        input: { seoTitle: DIFF_AFTER },
        previousValues: { seoTitle: DIFF_BEFORE },
        summary: `${MARKER.decisions} — rewrite the search listing.`,
        status: "PENDING_APPROVAL",
      },
    });

    browser = await chromium.launch();
    // A phone, because the mobile presence bar is where the Office door lives.
    // Section 5 covers the desktop door separately.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await signIn(page, server.baseUrl, owner.email!);
    await page.goto(`${server.baseUrl}/b/${store.slug}`, { waitUntil: "domcontentloaded" });
    await waitForWorkspace(page, "mobile");

    // -----------------------------------------------------------------------
    console.log("\n0. The control: a closed Office is mounted, and reads as closed");
    // -----------------------------------------------------------------------
    {
      const dialogExists = await page.evaluate(
        () => document.querySelector("[data-j4-presentation]") !== null
      );
      assert("the Office overlay is in the DOM before it is ever opened", dialogExists,
        "Talk Mode sends through its composer without opening it");
      check("and reports itself closed", await officeIsOpen(page), false);
      assert(
        "so every assertion below can tell open from closed",
        dialogExists && !(await officeIsOpen(page)),
        "otherwise a content check would pass against an Office nobody opened"
      );
    }

    // -----------------------------------------------------------------------
    console.log("\n1. Opening it gives the six views");
    // -----------------------------------------------------------------------
    await openOffice(page, "mobile");
    check("the Office reports itself open", await officeIsOpen(page), true);
    {
      const tabs = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Understanding"
        );
        const rail = btn?.parentElement;
        return Array.from(rail?.querySelectorAll("button") ?? []).map((b) =>
          b.textContent?.replace(/\d+$/, "").trim()
        );
      });
      check("all six, in the order the architecture names them", tabs, [
        "Conversation", "Tasks", "Ideas", "Decisions", "Information", "Understanding",
      ]);
      assert("Understanding is among them", tabs.includes("Understanding"),
        "GENESIS_SURFACES.md step 2");
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Each view shows its own content, and no other's");
    // -----------------------------------------------------------------------
    // THE 6b68cff CHECK. A rail that highlights and changes nothing fails the
    // present-marker assertion; a rail wired to the wrong branch fails the
    // absent-marker assertions. Both have been real bugs in this component.
    //
    // ONE OVERLAP IS DESIGNED, and this suite found it by asserting exclusivity
    // and being told otherwise: a pending proposal appears BOTH as a row in
    // Decisions and as the proposal on the table at the end of Conversation
    // (J4Workspace renders `shownCategory === "conversation" && proposal`). That
    // is the architecture — "THE proposal on the table — one, never a stack"
    // (J4Surface, 2026-08-14) — rather than a leak, because a proposal the owner
    // is being asked to judge belongs in the conversation where it was raised.
    //
    // So it is asserted as real behaviour below rather than excluded quietly.
    // Every other pairing stays forbidden.
    const DESIGNED_OVERLAP: Partial<Record<ViewKey, ViewKey[]>> = {
      conversation: ["decisions"],
    };
    for (const key of Object.keys(MARKER) as ViewKey[]) {
      const text = await showView(page, TAB_LABEL[key]);
      if (!text.includes(MARKER[key])) {
        // SAY WHAT WAS THERE INSTEAD. "marker missing" cannot distinguish an
        // Office that rendered nothing from one that rendered something else,
        // and those need completely different fixes.
        console.error(`      NOTE  ${TAB_LABEL[key]}: office subtree is ${text.length} chars: ${JSON.stringify(text.replace(/\s+/g, " ").trim().slice(0, 220))}`);
        // IS OFFICE EMPTY, OR ARE WE EARLY? Sample the portal over time, and
        // find out where the rail actually lives relative to it.
        const diag = await page.evaluate(async (marker: string) => {
          const read = () => {
            const el = document.querySelector("[data-j4-presentation]");
            return (el?.textContent ?? "").length;
          };
          const sizes = [read()];
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            sizes.push(read());
          }
          const tab = Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Tasks"
          );
          const portal = document.querySelector("[data-j4-presentation]");
          const chain: string[] = [];
          let n: Element | null = tab ?? null;
          while (n && chain.length < 8) {
            const id = n.getAttribute("data-testid");
            chain.push(n.tagName.toLowerCase() + (id ? `[${id}]` : ""));
            n = n.parentElement;
          }
          return {
            sizesOverTime: sizes,
            railFound: !!tab,
            railInsidePortal: !!(tab && portal && portal.contains(tab)),
            railAncestors: chain.join(" < "),
            markerAnywhereOnPage: document.body.textContent?.includes(marker) ?? false,
            portalPresentation: portal?.getAttribute("data-j4-presentation") ?? "(none)",
            portalHidden: portal?.getAttribute("aria-hidden") ?? "(none)",
          };
        }, MARKER[key]);
        console.error(`      NOTE  portal size over 5s: ${JSON.stringify(diag.sizesOverTime)}`);
        console.error(`      NOTE  rail found=${diag.railFound} insidePortal=${diag.railInsidePortal} presentation=${diag.portalPresentation} hidden=${diag.portalHidden}`);
        console.error(`      NOTE  rail ancestors: ${diag.railAncestors}`);
        console.error(`      NOTE  marker present anywhere on the page: ${diag.markerAnywhereOnPage}`);
        break;
      }
      assert(`${TAB_LABEL[key]} shows its own record`, text.includes(MARKER[key]),
        `marker ${MARKER[key]} missing — the tab highlighted but the view did not change`);
      const allowed = DESIGNED_OVERLAP[key] ?? [];
      const leaked = (Object.keys(MARKER) as ViewKey[])
        .filter((other) => other !== key && !allowed.includes(other) && text.includes(MARKER[other]));
      check(`${TAB_LABEL[key]} shows nothing belonging to another view`, leaked, []);
    }


    // ======================================================================
    // A DECISION SHOWS WHAT IT WOULD CHANGE (2026-09-12)
    // ======================================================================
    //
    // The Decisions view used to present a summary and an Approve button and
    // nothing else, so the owner agreed to a sentence. ApprovalRequest has
    // stored `input` and `previousValues` since Phase 6 and ActionDiffRows
    // has rendered them elsewhere all along; BriefingInput simply left them
    // behind.
    //
    // Read off the rendered page, because the claim is about what an owner
    // can see before they press a live control.
    {
      await showView(page, TAB_LABEL.decisions);
      const decided = await page.evaluate(() => {
        const portal = document.querySelector("[data-j4-presentation='office']");
        return [...(portal?.querySelectorAll('[data-testid="work-row"]') ?? [])].map((row) => {
          const proposal = row.querySelector('[data-testid="work-proposal"]');
          const control = row.querySelector('[data-testid="work-action-execute"]');
          const diffText = (proposal?.textContent ?? "").replace(/\s+/g, " ").trim();
          return {
            workId: row.getAttribute("data-work-id") ?? "",
            headline: (row.querySelector("p")?.textContent ?? "").trim(),
            hasProposal: !!proposal,
            empty: !!row.querySelector('[data-testid="work-proposal-empty"]'),
            diffText,
            // Position, because "before the controls" is the requirement —
            // evidence that arrives after the question is not evidence.
            proposalBeforeControl: !!(proposal && control &&
              (proposal.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
          };
        });
      });

      assert("there are decisions to inspect", decided.length > 0, `${decided.length}`);

      // THE INVERSE: a real proposal produces a real diff.
      const withDiff = decided.filter((d) => d.hasProposal && !d.empty);
      assert("a decision shows what approving would change",
        withDiff.length > 0, JSON.stringify(decided.map((d) => ({ id: d.workId, empty: d.empty }))));
      // SCOPED TO THE ROW WE SEEDED. Other real decisions are on this page
      // with diffs of their own, and asserting every one of them showed THIS
      // fixture's values failed against perfectly correct rendering.
      const seeded = decided.find((d) => d.headline.includes(MARKER.decisions));
      assert("the seeded decision is on screen", !!seeded, decided.map((d) => d.headline.slice(0, 40)).join(" | "));
      assert("  and the change names the real values, not a placeholder",
        !!seeded && seeded.diffText.includes(DIFF_BEFORE) && seeded.diffText.includes(DIFF_AFTER),
        seeded?.diffText.slice(0, 200) ?? "(no seeded row)");
      assert("  the evidence sits above the controls, not after them",
        withDiff.every((d) => d.proposalBeforeControl),
        "a diff below the button is a receipt, not a basis for deciding");

      // THE DIFF BELONGS TO THIS ROW. Both the evidence and the controls are
      // inside the same work row, so there is no way to read one decision's
      // change beside another's Approve.
      const misplaced = await page.evaluate(() => {
        const portal = document.querySelector("[data-j4-presentation='office']");
        const proposals = [...(portal?.querySelectorAll('[data-testid="work-proposal"]') ?? [])];
        return proposals.filter((p) => !p.closest('[data-testid="work-row"]')).length;
      });
      check("every diff is inside the work row it describes", misplaced, 0);
    }

    // ======================================================================
    // THE ACTION IS ON THE ITEM THAT OWNS IT (2026-09-12)
    // ======================================================================
    //
    // The category views used to render a link-or-nothing of their own, so the
    // Decisions view listed decisions with no way to decide them — the
    // controls existed, on the same items, in the briefing. They render the
    // one WorkRow now, which means there is a single action renderer over a
    // single list rather than an action model per surface.
    //
    // Read off the rendered page, because the claim is about what an owner can
    // press and where it sits, not about what a function returns.
    {
      await showView(page, TAB_LABEL.decisions);
      const rows = await page.evaluate(() => {
        const portal = document.querySelector("[data-j4-presentation='office']");
        return [...(portal?.querySelectorAll('[data-testid="work-row"]') ?? [])].map((row) => ({
          workId: row.getAttribute("data-work-id") ?? "",
          action: row.getAttribute("data-action") ?? "",
          // A control is something the owner can press INSIDE this row.
          controls: [...row.querySelectorAll("button, a[href]")].map((c) =>
            (c.getAttribute("data-testid") ?? c.tagName.toLowerCase()),
          ),
          hasDot: !!row.querySelector('[data-testid="work-kind-dot"]'),
        }));
      });

      assert("Decisions renders its items as work rows", rows.length > 0, `${rows.length} rows`);

      // 1 + 6. THE CONTROL BELONGS TO THE ROW, and the row is a WorkItem.
      const executes = rows.filter((r) => r.action === "execute");
      assert("a decision carries its own answer controls",
        executes.length > 0 && executes.every((r) => r.controls.includes("work-action-execute")),
        JSON.stringify(executes.slice(0, 2)));
      assert("  and every control sits inside the row whose work id it belongs to",
        executes.every((r) => r.workId.length > 0),
        executes.map((r) => r.workId).join(" "));

      // 3. NONE MEANS NO CONTROL. Not a dimmed button, not a dead link.
      const inert = rows.filter((r) => r.action === "none" || r.action === "internal");
      check("an item J4 cannot act on offers nothing to press",
        inert.filter((r) => r.controls.length > 0).map((r) => r.workId), []);

      // THE KIND COLOUR SURVIVED THE MOVE. Commit 2 carried taskPriority and
      // genesisState expressly so a FAILED task could not read as an
      // opportunity; rendering the briefing's row here must not lose it.
      assert("category rows still carry their kind colour",
        rows.every((r) => r.hasDot), `${rows.filter((r) => !r.hasDot).length} without a dot`);

      // AND THE SAME ITEM IN THE BRIEFING IS THE SAME ITEM. One list, two
      // surfaces — if these diverge, a parallel collection has appeared.
      const briefingIds = await page.evaluate(async () => {
        const tab = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Briefing");
        tab?.click();
        await new Promise((r) => setTimeout(r, 800));
        const portal = document.querySelector("[data-j4-presentation='office']");
        return [...(portal?.querySelectorAll('[data-testid="work-row"]') ?? [])].map(
          (row) => row.getAttribute("data-work-id") ?? "",
        );
      });
      const decisionIds = executes.map((r) => r.workId);
      assert("a decision shown in Decisions is the same work item shown in Briefing",
        decisionIds.every((id) => briefingIds.includes(id)),
        `decisions ${decisionIds.join(" ")} / briefing ${briefingIds.join(" ")}`);
    }

    // And the overlap is a real requirement, not a tolerance: if the proposal
    // ever stopped appearing in the conversation, the owner would be asked to
    // decide something in a place they were never taken to.
    {
      const conversation = await showView(page, "Conversation");
      assert("the proposal on the table is in the conversation too",
        conversation.includes(MARKER.decisions),
        "a proposal belongs where it was raised, not only in a queue");
    }

    // -----------------------------------------------------------------------
    console.log("\n3. Understanding is a standing picture, not a queue");
    // -----------------------------------------------------------------------
    {
      // UNDERSTANDING IS THE ON-DEMAND TIER, and it is loaded only once its
      // view is opened. Until it settles the panel says "Gathering everything I
      // know about you" - a real state, correctly rendered, and not the one
      // these assertions are about.
      await showView(page, "Understanding");
      await waitForOfficeIntelligence(page, { tier: "understanding" });
      const text = await officeText(page);
      // Its own stated design: every group renders, including the ones J4 knows
      // nothing about, because "I don't know your suppliers yet" is real
      // information about what J4 understands.
      assert("the business's identity is there", text.includes("Copper & Coil"), text.slice(0, 300));
      assert("what J4 can point at by name", text.includes("Assets I can use"),
        "the group that proves a designated asset resolves to a real record");
      assert("what the business sells", text.includes("What you sell"));
      assert("and revenue", text.includes("Revenue"));
      assert(
        "an empty group says so rather than being hidden",
        text.includes("Nothing designated yet") || text.includes("Nothing in the catalog yet"),
        "hiding empty groups would quietly overstate how much J4 knows"
      );
      // No count beside it — the four queues carry counts; a standing picture
      // with a number beside it would read as "14 things to deal with".
      const understandingTabText = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent?.trim().startsWith("Understanding")
          )?.textContent?.trim() ?? ""
      );
      check("and it carries no count", understandingTabText, "Understanding");

      await assertUnderstandingEvidence(page, 390);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. Closing returns to the workspace, not to a navigation");
    // -----------------------------------------------------------------------
    {
      const before = page.url();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.querySelector('[aria-label="J4\'s Office"]')?.getAttribute("aria-hidden") === "true",
        undefined,
        { timeout: 15_000 }
      );
      check("the Office reports itself closed", await officeIsOpen(page), false);
      check("and the workspace underneath was never navigated away from", page.url(), before,
      );
      // Reopening lands on Conversation rather than wherever the owner left —
      // asserted as the observed behaviour, whichever it is, so a deliberate
      // change to it is a visible decision rather than a silent drift.
      await openOffice(page, "mobile");
      const reopened = await officeText(page);
      assert(
        "reopening shows a real view rather than nothing",
        (Object.keys(MARKER) as ViewKey[]).some((k) => reopened.includes(MARKER[k])) ||
          reopened.includes("Assets I can use"),
        reopened.slice(0, 200)
      );
    }

    // -----------------------------------------------------------------------
    console.log("\n5. The desktop door opens the same Office");
    // -----------------------------------------------------------------------
    // Not a duplicate of section 1. These are two different controls behind two
    // mutually exclusive breakpoints, so either can break while the other keeps
    // working — and a suite that only ever ran at one width would report the
    // Office as reachable when half the owners could not reach it.
    //
    // Done by RESIZING the signed-in page rather than by signing in again in a
    // second context, and that is a correction rather than a convenience. The
    // second sign-in failed twice, and the instrumentation said why: the
    // credentials endpoint was never called at all, no error was shown, and the
    // button never entered its loading state — the page had not become
    // interactive. Repeating a login to reach a question about a button is a
    // second thing that can fail for reasons that have nothing to do with what
    // is being tested.
    {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspace(page, "desktop");

      // ============ THE DOORS ARE NO LONGER EXCLUSIVE (2026-09-04) ======
      //
      // This asserted the dock door is hidden on desktop, which was true while
      // it lived in J4Summon's `md:hidden` phone bar. J4's corner is now his
      // seat at EVERY breakpoint - "one J4 throughout the application" - so the
      // dock door is deliberately present on desktop, alongside the J4 Portal
      // pill. Asserting it away would be asserting the old shape of the
      // product.
      //
      // What must not change is the fact underneath, and it is the same fact
      // this section always existed to prove: however many doors there are,
      // they all lead to ONE Office. So the check becomes that the dock door
      // is genuinely present here and that opening through the OTHER door
      // still lands in the same single Office - which is strictly stronger
      // than the visibility check it replaces.
      const dockDoors = await page.locator(OFFICE_DOOR.mobile).count();
      check("the dock door is J4's seat at this breakpoint too", dockDoors, 1);
      const offices = await page.locator("[data-j4-presentation]").count();
      check("and there is exactly one Office in the document", offices, 1);

      check("it starts closed here too", await officeIsOpen(page), false);
      await openOffice(page, "desktop");
      check("and the pill opens it", await officeIsOpen(page), true);
      check("still exactly one Office after the second door opened it",
        await page.locator("[data-j4-presentation]").count(), 1);

      await showView(page, "Understanding");
      await waitForOfficeIntelligence(page, { tier: "understanding" });
      const text = await officeText(page);
      assert("with the same six views behind it", text.includes("Assets I can use"),
        "one Office, two doors — never two Offices");

      // The same evidence, at the other breakpoint. The panel is a different
      // layout here, and a check at one width reports a surface half the
      // owners cannot see.
      await assertUnderstandingEvidence(page, 1280);

      // ---- THE OWNER TELLS J4 IT IS WRONG, FOR REAL -----------------
      //
      // Slice 3. Until now the only way to correct a belief was to SAY SO in
      // chat, where the tool matches on the claim's wording and refuses
      // outright when two beliefs read alike. The surface holds the id.
      //
      // What is proven is the round trip: the control exists only where a
      // mechanism does, pressing it reaches contradictBelief, the belief is
      // retired in the DATABASE, and the reloaded understanding no longer
      // contains it. Not a success message — a changed answer.
      const controls = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="understanding-correct"]')].map((b) => ({
          belief: b.getAttribute("data-belief") ?? "",
          label: (b.textContent ?? "").trim(),
        })),
      );
      assert("both beliefs offer a correction", controls.length === 2, JSON.stringify(controls));
      assert("each is addressed by its own belief id",
        new Set(controls.map((c) => c.belief)).size === 2, JSON.stringify(controls.map((c) => c.belief)));
      assert("and the control says what it does",
        controls.every((c) => /wrong/i.test(c.label)), controls.map((c) => c.label).join(" | "));

      const beforeRow = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
      check("BEFORE: the belief is active", beforeRow.status, "ACTIVE");

      await page.click(`[data-testid="understanding-correct"][data-belief="${belief.id}"]`);
      await page.waitForTimeout(5000);

      const afterRow = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
      check("AFTER: the correction reached the database", afterRow.status, "DISMISSED");
      assert("and it is recorded as the OWNER disagreeing",
        afterRow.retiredReason?.startsWith("dismissed by the owner") ?? false, String(afterRow.retiredReason));

      // THE LOOK-ALIKE SURVIVED. A correction addressed by id cannot take the
      // wrong belief, which is precisely the case the chat tool has to refuse.
      check("the similarly-worded belief is untouched",
        (await prisma.belief.findUniqueOrThrow({ where: { id: lookalikeBelief.id } })).status, "ACTIVE");

      // AND THE SURFACE RE-READ, rather than hiding the row locally.
      const remaining = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="understanding-correct"]')].map((b) => b.getAttribute("data-belief") ?? ""),
      );
      assert("the corrected belief is gone from the surface",
        !remaining.includes(belief.id), remaining.join(", ") || "none left");
      assert("and the other one is still there",
        remaining.includes(lookalikeBelief.id), remaining.join(", ") || "none left");

      // SCROLLED TO THE BELIEFS, because the panel scrolls inside itself and
      // "What I've learned" is below the fold. A screenshot that cannot show
      // the control is not evidence of it.
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="understanding-correct"]');
        btn?.scrollIntoView({ block: "center" });
      });
      await page.waitForTimeout(400);
      await page.screenshot({ path: "verification-screenshots/understanding-corrected.png" });
      // PHOTOGRAPHED. A DOM assertion in this repository once passed underneath
      // a full-screen overlay; attribution the owner cannot read is the same
      // class of pass.
      await page.screenshot({ path: "verification-screenshots/understanding-evidence.png" });
    }

    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
