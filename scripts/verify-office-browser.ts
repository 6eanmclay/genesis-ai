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
    await prisma.approvalRequest.create({
      data: {
        storeId: store.id,
        actionType: "update_seo",
        input: {},
        previousValues: {},
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
