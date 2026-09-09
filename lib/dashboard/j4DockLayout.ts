/**
 * HOW MUCH ROOM J4 TAKES, DEFINED ONCE.
 *
 * ============ THE BUG THIS EXISTS TO PREVENT (2026-09-09) ==============
 *
 * Two components each decided this independently, and they disagreed.
 * `J4Dock` anchors J4 `fixed bottom-0 left-0`, while `DashboardShell`'s mobile
 * bar reserved his place with a `flex-[1.5]` spacer in the CENTRE - left over
 * from when J4 was a centre orb. Measured at 360px, that produced:
 *
 *     j4-corner   x=8   w=90        <- J4 sits here
 *     Business    x=0   w=55        *** UNDER J4 ***
 *     Storefront  x=55  w=55        *** UNDER J4 ***
 *     Studio      x=194             <- an 84px empty gap before this
 *     Commerce    x=249
 *     Account     x=305
 *
 * Two of five rooms were unreachable, and the space held for J4 was nowhere
 * near J4. Sean: "this should fix the underlying source-of-truth problem, not
 * just make the screenshot look right."
 *
 * ============ SO IT IS ONE VALUE, IN CSS, READ BY BOTH =================
 *
 * `--j4-dock-reserve` is declared once in app/globals.css and consumed by:
 *
 *   - J4Dock            as its own WIDTH, so J4 is exactly as big as the space
 *                       reserved for him - he cannot outgrow it
 *   - the mobile bar    as `padding-left`, so the rooms begin where he ends
 *
 * Because the dock's width and the bar's padding are the SAME declaration,
 * they cannot drift apart. Changing J4's size is one number in one file, and
 * the navigation follows automatically. Adding a second spacer anywhere would
 * reintroduce exactly the bug above, which is why there is no second spacer.
 *
 * TypeScript does not own the value - CSS does, because it has to change at
 * breakpoints and a media query cannot live in a constant. What lives here is
 * the NAME, the contract, and the numbers the browser test asserts against, so
 * a change to the CSS that nobody meant fails a suite rather than a screenshot.
 */

/** The custom property. Declared in app/globals.css; never re-declared. */
export const J4_DOCK_RESERVE_VAR = "--j4-dock-reserve";

/** Ready to drop into a style prop, so no call site retypes the var name. */
export const J4_DOCK_RESERVE = `var(${J4_DOCK_RESERVE_VAR})`;

/**
 * What the variable resolves to at each width, asserted by
 * verify-mobile-nav-layout. These are a mirror of globals.css, and the suite
 * exists to make sure the mirror never lies.
 *
 * Chosen from the real measurement rather than picked. Measured at 360px, the
 * old dock was 106px wide and J4's ARTWORK inside it was 84x84. Sean asked for
 * him slightly larger, so:
 *
 *   - the reserve is 104px, leaving 256px for five rooms (51px each, above the
 *     44px minimum tap target)
 *   - the dock's own padding dropped from 20px to 12px, so 92px of that 104
 *     is J4 himself: larger than the 84px he was, and not one pixel taken
 *     from the navigation
 *
 * That distinction is the point. Making J4 bigger by raising the reserve makes
 * every room narrower; making him bigger by spending less of the reserve on
 * chrome does not. At 390px and above the reserve is 116px and he is 104px.
 *
 * The desktop step is a HOLD, not a growth. The old dock drew J4 at a literal
 * 124px above 1024px inside 32px of padding, so 156 is 124 + 32 and the dock
 * keeps its exact former footprint - the tighter mobile chrome is undone by
 * `lg:` variants in J4Dock. Sean asked for a larger J4 in the phone bar;
 * resizing or shifting him on a desktop that never had this problem, purely
 * because the two now share a variable, would be this change deciding
 * something nobody asked for. verify-mobile-nav-layout asserts the 124px.
 */
export const J4_DOCK_RESERVE_AT: ReadonlyArray<{ minWidth: number; reserve: number }> = [
  { minWidth: 0, reserve: 104 },
  { minWidth: 390, reserve: 116 },
  { minWidth: 1024, reserve: 156 },
];

/** The reserve that applies at a given viewport width. */
export function reserveAt(viewportWidth: number): number {
  let value = J4_DOCK_RESERVE_AT[0].reserve;
  for (const step of J4_DOCK_RESERVE_AT) if (viewportWidth >= step.minWidth) value = step.reserve;
  return value;
}

/** The smallest a room's tap target may be. Apple and Android both say 44. */
export const MIN_TAP_TARGET_PX = 44;

/** How many rooms share the space to J4's right. */
export const PRIMARY_ROOMS = 5;

/**
 * Whether five rooms still fit as real tap targets at this width.
 *
 * Used by the suite so a future change to the reserve cannot quietly squeeze
 * the navigation below usable - the failure would otherwise only show up on
 * somebody's phone.
 */
export function roomsFitAt(viewportWidth: number): { fits: boolean; perRoom: number } {
  const perRoom = (viewportWidth - reserveAt(viewportWidth)) / PRIMARY_ROOMS;
  return { fits: perRoom >= MIN_TAP_TARGET_PX, perRoom };
}
