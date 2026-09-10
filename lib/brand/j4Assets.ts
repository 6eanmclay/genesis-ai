/**
 * THE CANONICAL J4 VISUAL SYSTEM. ONE SOURCE OF TRUTH.
 *
 * ============ THREE ASSETS, THREE JOBS (Sean, 2026-09-10) ==============
 *
 * Locked, and the point of locking it is that they are NOT interchangeable:
 *
 *   1. THE CHARACTER        white/black futuristic body, neon green lighting,
 *                           white helmet, clean black visor, J4 ear modules.
 *
 *   2. THE HELMET INSIGNIA  a black DIAMOND platform carrying a sharp,
 *                           continuous emblem - the version with no central
 *                           separation, which is what gives it the hourglass
 *                           geometry. This is J4's primary brand insignia, and
 *                           it is the same emblem used as the physical suit
 *                           lapel pin.
 *
 *   3. THE EAR-MODULE MARK  Sean's own analogy, and it is the right one: this
 *                           is the Beats-by-Dre mark. A signature hardware
 *                           identifier on the ear cup, not another placement
 *                           of the insignia. Its exact geometry, proportions,
 *                           line weight, angles, orientation and negative
 *                           space are the asset. A softer approximation is a
 *                           different mark.
 *
 * The hierarchy: J4 -> helmet insignia -> ear signature -> clean visor.
 *
 * ============ THE VISOR GETS NOTHING ===================================
 *
 * No logo, no emblem, no text, no branding, ever. J4's identity comes from the
 * character and the approved hardware markings. This is the one rule that has
 * survived every revision of the character since 2026-09-09, and
 * verify-j4-artwork asserts it against the component rather than trusting it.
 *
 * ============ CANONICAL MEANS CANONICAL ================================
 *
 * Sean: "I don't want 'close enough', 'similar J4', 'another interpretation of
 * the logo', or an image generator deciding that the logo should look
 * different. Exact geometry matters."
 *
 * So each master carries a FINGERPRINT. A regenerated, re-exported or
 * re-interpreted file has a different hash and fails, whatever it is named -
 * which is the only mechanical defence against a generator quietly producing
 * something adjacent. It is deliberately not a similarity check: "close to the
 * approved artwork" is the failure mode, not the test.
 *
 * ============ AND THE SAME RULE AS THE WEBSITE =========================
 *
 * "Don't claim the asset is correct because the file exists. Verify the actual
 * rendered asset." That is the standing invariant in ARCHITECTURE.md applied
 * to artwork: a file on disk proves persistence, not appearance. The registry
 * records what must be true; scripts/verify-j4-assets.ts measures it.
 */

export interface CanonicalAsset {
  /** Public path, or null when the master exists only as a reference. */
  path: string;
  /** sha256 of the approved bytes. A re-export is a different asset. */
  sha256: string;
  /** What this asset is for, and where it may appear. */
  job: string;
}

/**
 * The approved reference masters.
 *
 * These are what Sean supplied and signed off. They are the yardstick, not
 * necessarily what the runtime currently ships - see RUNTIME below, and E28.
 */
export const CANONICAL_REFERENCES = {
  /**
   * The full brand sheet: suited J4 in the futuristic office at sunrise, the
   * helmet insignia in three detail views, the suit pin, and the front/side/
   * back views. This is also the environmental direction for the new Office -
   * "J4 sitting in his office, professional business partner, futuristic
   * city/sunrise, calm, intelligent, premium".
   */
  brandSheet: {
    path: "/brand/canonical/j4-brand-sheet.png",
    sha256: "a829f325163cf1ee",
    job: "the signed-off character, insignia and environment direction",
  },
  /**
   * The ear-module mark, close up. THE geometry reference - sharp J and
   * triangle, specific angles, specific negative space.
   */
  earMark: {
    path: "/brand/canonical/j4-ear-mark-reference.png",
    sha256: "02a2b8acee7dc67a",
    job: "the exact geometry of the ear-module signature mark",
  },
  /**
   * The helmet insignia on its dark honeycomb ground: the emblem's own line
   * work, before it is set into the diamond platform.
   */
  helmetEmblem: {
    path: "/brand/canonical/j4-helmet-emblem-reference.png",
    sha256: "3c87aa59b7d45cb5",
    job: "the emblem line work for the helmet insignia and the suit pin",
  },
} as const satisfies Record<string, CanonicalAsset>;

/**
 * What the product actually renders today.
 *
 * SEPARATE FROM THE REFERENCES ON PURPOSE. Recording the runtime asset in the
 * same list as the masters would let "we have a J4 file" read as "we ship the
 * canonical J4", which is exactly the claim this registry exists to stop
 * anyone making. They are compared, and the comparison is allowed to fail.
 */
export const RUNTIME = {
  character: {
    path: "/brand/j4-v2.png",
    sha256: "",
    job: "the persistent J4 drawn by components/j4/J4Character.tsx",
  },
} as const satisfies Record<string, CanonicalAsset>;

/** Nothing may ever be drawn on the visor. Asserted, not remembered. */
export const VISOR_RULE =
  "No logo, emblem, text or branding on J4's visor. Ever. The visor stays clean black.";

/**
 * Where each mark belongs, so a future placement cannot be improvised.
 *
 * The helmet does not get the ear mark and the ear does not get the insignia.
 * Sean was explicit about both substitutions because both are the obvious
 * shortcut for a generator asked for "the J4 logo".
 */
export const MARK_PLACEMENT = {
  helmetCentre: "helmetEmblem",
  suitLapelPin: "helmetEmblem",
  earModule: "earMark",
  visor: null,
} as const;
