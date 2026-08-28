// WHERE THE ARTWORK SITS ON THE PICTURE — shared by the preview and the product.
//
// ============ WHY THIS IS ITS OWN FILE (2026-08-28) ====================
//
// These two constants are needed by CreationCanvas, which is a client
// component, and by lib/creation/composeMockup.ts, which imports sharp. Putting
// them in the composer would pull a native image library into the browser
// bundle; leaving a copy in the canvas would let the preview and the product
// photograph drift apart the first time either is adjusted.
//
// So: no imports, no side effects, nothing but the numbers both sides agree on.

/**
 * The print area's rectangle on the mockup, as fractions of the canvas.
 *
 * Presentation rather than supplier data — a supplier states a printable area
 * in inches, not where to draw it over a photograph.
 */
export const PRINT_AREA_BOX = { x: 0.29, y: 0.26, width: 0.42, height: 0.46 };

/** The mockup's own shape. 3:4, matching the canvas the owner designs on. */
export const MOCKUP_SIZE = { width: 1200, height: 1600 };
