import type { Page } from "playwright";

/**
 * WHEN IS THE APPLICATION ACTUALLY READY TO BE TESTED?
 *
 * ============ THE BUG THIS EXISTS TO END (2026-09-10) ==================
 *
 * Every browser suite invented its own answer, and when the opening changed on
 * 2026-09-04 they broke in four different ways at once:
 *
 *   verify-office-arrival     waited for [data-testid="j4-boot"] to detach
 *                             ................................ still passes
 *   verify-business-map       waited for a fixed div at z-index 100
 *   verify-rooms-browser      waited for a fixed div at z-index 100
 *   verify-identity-split     waited for nothing at all
 *
 * J4Boot renders at z-[120]. So both z-index waits silently became no-ops -
 * they did not fail, they returned immediately and the suites then measured a
 * page with a full-screen overlay on top of it. identity-split's "Save" click
 * landed on the boot sequence, its rename never happened, and the suite
 * reported that as a product defect.
 *
 * rooms-browser is the sharpest lesson, because it had ALREADY been fixed for
 * exactly this and its own comment records the finding:
 *
 *     "every screenshot this suite took was a picture of the ritual rather
 *      than of the room underneath - the assertions passed the whole time,
 *      because computed styles are readable through it, and the images were
 *      quietly worthless."
 *
 * That fix keyed on z-index 100, so when the implementation moved to 120 the
 * bug came back and nothing said so. A PASSING ASSERTION IS WORTHLESS IF THE
 * SCREENSHOT CAPTURED THE WRONG APPLICATION STATE.
 *
 * ============ SO THE SIGNAL IS THE LIFECYCLE, NOT THE STYLING ==========
 *
 * Sean: "j4-boot is an application-level state signal, whereas z-index === 100
 * was an implementation guess."
 *
 * `[data-testid="j4-boot"]` is the component's own existence. It is attached
 * while the opening plays and gone when it has finished, which is the fact
 * every one of those suites was trying to approximate. This module depends on
 * that and on NOTHING else - not a z-index, not a pixel position, not an
 * animation duration, not a sleep.
 *
 * The reference implementation is verify-office-arrival, which already passes;
 * this generalises it rather than inventing a fifth answer.
 *
 * ============ THE LIFECYCLE, AS IT ACTUALLY IS =========================
 *
 *   1. NAVIGATED        the browser has left /login
 *   2. SHELL RENDERED   <main> exists - SERVER-rendered, so this is early
 *   3. SHELL HYDRATED   React has attached; handlers and form actions work
 *   4. OPENING DECIDED  a client effect has decided whether to play J4Boot
 *   5. BOOT PLAYING     [data-testid="j4-boot"] is attached
 *   6. BOOT FINISHED    it has detached, and the page underneath is exposed
 *
 * STEPS 2 AND 3 ARE DIFFERENT, and conflating them cost two bugs in one hour.
 * The first version of this file checked for the boot as soon as <main>
 * existed, arguing that J4Boot renders inside the shell so the two must arrive
 * together. A screenshot disproved it: <main> comes from the server, while
 * J4Boot appears only after the client decides this is a fresh launch - which
 * it cannot do during hydration without a markup mismatch, so it happens in an
 * effect afterwards. The check ran too early, reported "noBoot", and the suite
 * photographed the opening it had just declared absent.
 *
 * Step 3 also matters on its own: a form whose action is a function does
 * nothing at all when clicked before hydration - no error, no request - which
 * is what made identity-split's rename look like a lost write. See
 * waitForHydration.
 *
 * Step 4 is the one place a bounded window is unavoidable, because "the effect
 * has not run yet" and "the effect ran and chose not to play" are the same DOM.
 * Nothing in the product distinguishes them today. It is a window for an
 * EVENT, not a guess at a duration - once the boot appears, the rest of the
 * lifecycle is followed to completion however long it takes. If the shell ever
 * exposes the decision itself, this is the line that gets to disappear.
 *
 * The opening plays once per real sign-in, so `noBoot` is a legitimate,
 * common outcome and is reported rather than treated as an error.
 */

/**
 * Wait until React has actually hydrated the element that owns a form.
 *
 * ============ WHY A CLICK CAN LAND AND DO NOTHING =====================
 *
 * A client component's `<form action={formAction}>` is not a browser form
 * submission - `formAction` is a function React attaches during hydration.
 * Before that, the markup is on screen, the button is visible, nothing covers
 * it, and Playwright clicks it perfectly happily. Nothing happens, and there
 * is no error anywhere: no alert, no network request, no console message.
 *
 * That is what verify-identity-split-browser was reporting as "the business in
 * the URL was renamed — got Cubit & Coil". The write was never attempted. It
 * looked like a lost write, and it survived a rewrite of the overlay wait
 * because the overlay was never the reason.
 *
 * THE FIBER IS THE FACT. React stores its fiber on the DOM node under a
 * `__reactFiber$…` key, and it is there if and only if that subtree has been
 * hydrated. Every other candidate signal is a proxy: `load` fires before
 * hydration, `networkidle` is timing, and a fixed sleep is the guess this
 * module exists to remove. This reads the thing itself.
 */
export async function waitForHydration(
  page: Page,
  selector: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return Object.keys(el).some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"));
    },
    selector,
    { timeout: options.timeoutMs ?? 30_000 },
  );
}

/** The component's own marker. The one selector this contract depends on. */
export const J4_BOOT = '[data-testid="j4-boot"]';

/** What the shell renders once it is mounted, boot or no boot. */
export const APP_SHELL = "main";

export type Readiness =
  /** The opening played and finished while we watched. */
  | { state: "bootFinished"; waitedMs: number }
  /** No opening was playing - a navigation within an existing session. */
  | { state: "noBoot"; waitedMs: number };

/**
 * Wait until the application is genuinely interactive, and say which happened.
 *
 * Safe to call on any dashboard page at any time. Returns rather than throws
 * for the ordinary case of no boot playing; throws only when the shell itself
 * never appears, which means nothing was tested and the caller must not
 * proceed to measure anything.
 */
export async function waitForAppReady(
  page: Page,
  options: { timeoutMs?: number; appearWindowMs?: number } = {},
): Promise<Readiness> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const appearWindowMs = options.appearWindowMs ?? 4_000;
  const started = Date.now();

  // 2. THE SHELL, FIRST. Everything below is a question about the shell's
  //    contents, and asking it before the shell exists is what produced two
  //    silent no-op waits.
  await page.waitForSelector(APP_SHELL, { state: "attached", timeout: timeoutMs });

  // 2b. AND HYDRATED, WHICH IS NOT THE SAME THING.
  //
  //     The first version of this function checked for the boot the moment
  //     <main> existed, on the reasoning that J4Boot renders inside the shell
  //     so the two arrive together. THAT WAS WRONG, and a screenshot caught
  //     it: <main> is server-rendered, while J4Boot only appears once the
  //     client decides this is a fresh launch - which it cannot do during
  //     hydration without a markup mismatch, so it happens in an effect
  //     afterwards. Checking at <main> found no boot, reported "noBoot", and
  //     the suite went on to photograph the opening it had just declared
  //     absent. Exactly the failure this module was written to end, one layer
  //     further in.
  await waitForHydration(page, APP_SHELL, { timeoutMs: Math.max(1_000, timeoutMs - (Date.now() - started)) });

  // 3. THE OPENING - and the one bounded wait in this file, stated plainly
  //    rather than hidden. Whether the opening plays is decided in a client
  //    effect, and "an effect that has not run yet" and "an effect that ran
  //    and decided not to play" look identical in the DOM. Nothing in the
  //    product distinguishes them today, so this allows a short window for it
  //    to appear. It is a window for an EVENT, not a guess at a duration: if
  //    the boot appears at any point inside it the full lifecycle is then
  //    followed to completion, however long that takes.
  const appeared = await page
    .waitForSelector(J4_BOOT, { state: "attached", timeout: appearWindowMs })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return { state: "noBoot", waitedMs: Date.now() - started };

  // 4. AND GONE. No catch: if the opening never finishes, nothing the caller
  //    is about to measure means anything.
  const remaining = Math.max(1_000, timeoutMs - (Date.now() - started));
  await page.waitForSelector(J4_BOOT, { state: "detached", timeout: remaining });
  return { state: "bootFinished", waitedMs: Date.now() - started };
}

/** The Office's progressive intelligence tier, and its own completion state. */
export const OFFICE_INTELLIGENCE = "[data-office-intelligence]";

/**
 * Wait until the Office's progressive intelligence has finished loading.
 *
 * ============ APPLICATION STATE WITH NO COMPLETION CONTRACT =========
 *
 * The tier split of 2026-09-09 moved seven reads - tasks, ideas, decisions,
 * information, the briefing, the facts strip, the handled summary - off the
 * server render and into a load that runs after mount. That is why J4 can be
 * spoken to immediately, and it was the right call.
 *
 * What it did not leave behind was any way to know when those reads had
 * ARRIVED. `intel` was React state; nothing in the DOM reflected it; and from
 * outside, "still loading" and "loaded and legitimately empty" were the same
 * page. Six assertions in verify-office-browser failed against that empty
 * state, and the only ways to wait without this signal were a sleep or a poll
 * for some string to appear - which is a test waiting for ROWS TO EXIST rather
 * than for the LOAD TO BE DONE, and passes or fails on the fixture.
 *
 * `ready` means settled. Empty, full and failed all report it alike.
 */
export async function waitForOfficeIntelligence(
  page: Page,
  options: { timeoutMs?: number; tier?: "intelligence" | "understanding" } = {},
): Promise<void> {
  const attribute =
    options.tier === "understanding" ? "data-office-understanding" : "data-office-intelligence";
  try {
    await page.waitForFunction(
      (attr: string) => {
        // "is the intelligence still pending?" - and `not-needed` answers it
        // as honestly as `ready` does. The conversation view never requests
        // this tier, so waiting for `ready` there would wait forever on a page
        // already showing everything it will ever show.
        const state = document.querySelector(`[${attr}]`)?.getAttribute(attr);
        return state === "ready" || state === "not-needed";
      },
      attribute,
      { timeout: options.timeoutMs ?? 30_000 },
    );
  } catch (error) {
    // A bare timeout here is unreadable: "idle" (never asked for), "loading"
    // (asked and hanging) and a missing element (not rendered at all) are
    // three different faults, and the caller needs to know which.
    const seen = await page.evaluate((attr: string) => {
      const nodes = Array.from(document.querySelectorAll(`[${attr}]`));
      return nodes.map((n) => n.getAttribute(attr));
    }, attribute);
    throw new Error(
      `the Office's ${attribute} never reported ready — found ${seen.length} element(s) in state ${JSON.stringify(seen)}. ` +
        `"not-needed" means the current view does not use this tier, "loading" means the load never settled, none means the workspace is not rendered. ` +
        `Original: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
}

/**
 * What is actually painted over a given element, if anything.
 *
 * ============ MEASURED, NOT INFERRED ==================================
 *
 * The old overlay checks asked "is there a fixed div at z-index 100", which is
 * a guess about how covering is implemented. This asks the browser what is at
 * the point instead - `elementFromPoint` is the same question a fingertip
 * asks, so it stays true through any restyling.
 *
 * Returns null when the element is genuinely on top, or a short description of
 * whatever is covering it.
 */
export async function whatCovers(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return "NO ELEMENT";
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return "ZERO SIZE";
    const hit = document.elementFromPoint(
      Math.round(r.left + Math.min(20, r.width / 2)),
      Math.round(r.top + r.height / 2),
    );
    if (!hit) return "nothing at that point";
    if (el.contains(hit) || hit.contains(el)) return null;
    const id = hit.getAttribute("data-testid");
    const cls = (hit.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
    return hit.tagName.toLowerCase() + (id ? "[" + id + "]" : "") + (cls ? "." + cls : "");
  }, selector);
}

/**
 * A screenshot worth keeping, or an explicit refusal.
 *
 * The rooms-browser lesson as a function: a suite that screenshots while the
 * opening is playing produces images of the opening, and nothing in the run
 * says so. This makes that impossible to do by accident.
 */
export async function screenshotWhenReady(
  page: Page,
  path: string,
  options: { fullPage?: boolean; timeoutMs?: number } = {},
): Promise<Readiness> {
  const readiness = await waitForAppReady(page, { timeoutMs: options.timeoutMs });
  await page.screenshot({ path, fullPage: options.fullPage ?? false });
  return readiness;
}
