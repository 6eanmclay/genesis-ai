import sharp from "sharp";

// DOES THIS FILE ACTUALLY HAVE TRANSPARENCY?
//
// ============ NOT THE EXTENSION, NOT THE MIME TYPE (2026-08-28) =========
//
// Sean: "Do not assume that every PNG has transparency. The uploaded file needs
// to be inspected for actual alpha/transparency... A PNG can have a completely
// opaque background."
//
// He is right, and this codebase has already been bitten by exactly this kind
// of assumption at one remove: Printful's blank is named `base_whitebg.png`,
// carries a full alpha channel, and its opaque part is the BACKGROUND. Four
// rounds went into that file because its structure was inferred from its name.
//
// So: read the pixels.
//
// ============ AN ALPHA CHANNEL IS NOT TRANSPARENCY ======================
//
// `metadata().hasAlpha` says the file has a fourth channel, which is the check
// most code stops at. It is not the question. A PNG exported with an alpha
// channel that is 255 everywhere has no transparency at all, and treating it as
// transparent is how a white box ends up printed onto a garment.
//
// The question is whether any pixel is actually see-through, so this counts
// them.

/** Below this, a pixel is doing real work as transparency rather than dithering. */
const CLEAR = 250;

/**
 * Whether an image has genuinely transparent pixels, or null if it could not
 * be read.
 *
 * NULL IS A REAL ANSWER and is kept distinct from false. False is a
 * measurement — this file was inspected and is opaque. Null means nobody
 * knows, which is the honest state for a file that would not decode, and the
 * caller can decide differently about the two.
 */
export async function detectTransparency(bytes: Buffer): Promise<boolean | null> {
  try {
    const meta = await sharp(bytes).metadata();
    // No alpha channel at all is a definite no, and cheap — no need to decode
    // the pixels to know a JPEG is opaque.
    if (!meta.hasAlpha) return false;

    const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < CLEAR) return true;
    }
    // An alpha channel that is opaque everywhere. This is the case the
    // extension and the MIME type both get wrong.
    return false;
  } catch {
    return null;
  }
}

/**
 * The same question, for a file that lives at a URL.
 *
 * Failure is null rather than an exception: an upload that succeeded must not
 * be rejected because a follow-up read of it did not. The asset is stored
 * either way, and "not inspected" is a state the schema can hold.
 */
export async function detectTransparencyAt(url: string): Promise<boolean | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await detectTransparency(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}
