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
 *   2. SHELL MOUNTED    DashboardShell has rendered its <main>
 *   3. BOOT PLAYING     [data-testid="j4-boot"] is attached  (fresh sign-in only)
 *   4. BOOT FINISHED    it has detached, and the shell underneath is exposed
 *   5. UNCOVERED        nothing full-screen sits over the page any more
 *
 * Step 2 is what makes step 3 raceless, and it is the part the old waits got
 * wrong. J4Boot is rendered INSIDE the shell (`{returningActive && <J4Boot/>}`
 * in DashboardShell), so once <main> exists the boot either exists too or
 * never will. Waiting for "detached" before the shell mounts would resolve
 * instantly against an element that had not been created yet - a wait that
 * looks correct in the source and does nothing at runtime, which is precisely
 * the failure mode above. So there is no appearance window and no guess: the
 * shell's presence is the moment the question becomes answerable.
 *
 * The opening plays once per real sign-in, so `noBoot` is a legitimate,
 * common outcome and is reported rather than treated as an error.
 */

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
  options: { timeoutMs?: number } = {},
): Promise<Readiness> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const started = Date.now();

  // 2. THE SHELL, FIRST. Everything below is a question about the shell's
  //    contents, and asking it before the shell exists is what produced two
  //    silent no-op waits.
  await page.waitForSelector(APP_SHELL, { state: "attached", timeout: timeoutMs });

  // 3/4. THE OPENING. Attached means it is playing; absent means it is not
  //      playing and will not start, because it mounts with the shell.
  const playing = (await page.locator(J4_BOOT).count()) > 0;
  if (!playing) return { state: "noBoot", waitedMs: Date.now() - started };

  const remaining = Math.max(1_000, timeoutMs - (Date.now() - started));
  await page.waitForSelector(J4_BOOT, { state: "detached", timeout: remaining });
  return { state: "bootFinished", waitedMs: Date.now() - started };
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
