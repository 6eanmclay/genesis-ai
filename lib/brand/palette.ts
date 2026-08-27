// GENESIS'S VISUAL LANGUAGE, AS THREE COLOURS AND A RULE.
//
// ============ WHAT THIS IS FOR ==========================================
//
// Sean's direction (2026-08-27): black as the foundation, J4 blue for J4's own
// identity, deep green for active and system states, and much less purple. He
// asked to ESTABLISH the language rather than redesign the interface around it,
// which is exactly what this file is — a small, named set that a few surfaces
// use now and everything else can adopt deliberately later.
//
// The reference he gave: original Xbox and Alien. Black and green,
// technological, slightly extraterrestrial, but sophisticated. And the line
// that matters most for restraint —
//
//   "Genesis shouldn't look like an alien product. It should look like we took
//    that kind of futuristic technology and made it understandable to humans."
//
// So green is a SIGNAL, never a skin. It appears where something is genuinely
// alive, active or happening, and nowhere else. A green that is always present
// says nothing, because it would always be saying it.
//
// ============ WHY SEAN SAW GREY, AND WHY THE GREEN MOVED ANYWAY =========
//
// He reported the speaking bars as grey. The likeliest cause is simply that
// the first green had not reached him: it shipped in 75c3883 and only went out
// in a push minutes before he looked, so what he saw still had the bars at
// `currentColor` — which IS grey.
//
// Worth being exact about this rather than inventing a colour theory to
// explain it. The previous value, #1F7A46, measures hue 146 at saturation
// 0.59: genuinely green, not grey. Claiming it "read as grey" would have been
// a tidy story that the numbers do not support.
//
// It moved regardless, because his brief describes something the old value was
// not. He asked for a green with energy, referencing the Xbox mark and the
// Alien egg glow — both of which lean YELLOW-green. #1F7A46 leans the other
// way and is dark (lightness 0.30). #22A24A is hue 139 at lightness 0.38:
// still medium-dark and nowhere near neon or lime, but warmer and with more
// life in it. That is a match to the brief, not a bug fix.

/** The ground. Near-black rather than black, so surfaces above it can lift. */
export const GENESIS_BLACK = "#0B0C0E";

/**
 * J4'S OWN COLOUR, AND ONLY J4'S.
 *
 * His identity, unchanged and not up for reallocation — the avatar, his
 * presence, the things that are him. Nothing that is merely a system state
 * should borrow it, or his presence stops meaning anything.
 */
export const J4_BLUE = "#4C8DFF";

/**
 * ACTIVE. Speaking, processing, running, alive right now.
 *
 * Medium-dark and genuinely green — see the note above on why the first
 * attempt read as grey. Energetic enough to feel lit, restrained enough that
 * it is not a highlighter.
 */
export const GENESIS_GREEN = "#22A24A";

/**
 * The same green, for illumination rather than fill.
 *
 * A touch brighter, because a glow at the fill's own value reads as a smudge
 * rather than as light coming off something.
 */
export const GENESIS_GREEN_LIGHT = "#2FBF5A";

/** That green at an opacity, for washes and shadows. */
export function genesisGreenAlpha(alpha: number): string {
  const clamped = Math.min(Math.max(alpha, 0), 1);
  return `rgba(34, 162, 74, ${clamped})`;
}

// ============ PROVING A COLOUR IS THE COLOUR IT CLAIMS ==================

/** Hue (0-360), saturation and lightness (0-1) of a #rrggbb. Pure. */
export function hslOf(hex: string): { hue: number; saturation: number; lightness: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Not a six-digit hex colour: ${hex}`);
  const int = parseInt(match[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { hue: 0, saturation: 0, lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);

  return { hue: (hue + 360) % 360, saturation, lightness };
}

/**
 * Is this unmistakably green, rather than grey, teal or lime?
 *
 * MEASURED, NOT EYEBALLED. "It has a big G channel" is not a check: what
 * decides whether a colour reads as green is hue and saturation together, and
 * a hex can look green in a code review and land as grey on a screen.
 *
 * Hue 90-150 is green proper — past 150 it turns teal and starts reading blue,
 * below 90 it slides to yellow-lime, both of which Sean ruled out by name.
 * Saturation under 0.3 is where any hue collapses toward grey, which is the
 * specific complaint this guards against.
 *
 * Deliberately a BAND rather than an equality test. Pinning the exact hex
 * would assert that nobody may ever adjust the green; this asserts that
 * whatever it becomes is still green.
 */
export function readsAsGreen(hex: string): boolean {
  const { hue, saturation, lightness } = hslOf(hex);
  return hue >= 90 && hue <= 150 && saturation >= 0.3 && lightness > 0.15 && lightness < 0.75;
}
