// NAMING A FILE ON THE WAY TO BLOB STORAGE.
//
// ============ WHY A BARE FILENAME IS A BUG (2026-08-28) =================
//
// The Creation Station's own upload used `file.name` as the blob pathname and
// failed with "That upload did not finish". Two reasons, both real:
//
//   1. The token is issued with `addRandomSuffix: false`, so the pathname is
//      taken literally. Uploading a name that already exists is refused by
//      @vercel/blob v2 unless `allowOverwrite` is set — so the SECOND upload of
//      any given filename fails, and retrying with the same file fails
//      identically. "Try again" could never have worked.
//
//   2. The namespace is global. Two businesses uploading "logo.png" are
//      writing to one path. That is a tenant boundary crossed by a default.
//
// Every other upload in Genesis already avoided this — GenesisAssistant,
// J4Workspace, StudioActions, CreateProductForm and ProductImageGallery all
// build `assets/<random>.<ext>` — and each carries its own private copy of
// these two functions. This is that pattern, in one place, so the next upload
// path added does not have to rediscover it.
//
// The five existing copies are deliberately NOT refactored here: the fix is a
// broken upload, and rewriting five working call sites to share a helper is a
// different change with its own risk. Named so it is a known duplication
// rather than an unnoticed one.

/** A collision-free key. Random, not derived from anything the user typed. */
export function randomAssetKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The extension to store a file under.
 *
 * The filename is preferred and the MIME type is the fallback, because a real
 * extension is more specific than a browser's guess — but a "filename" like
 * "IMG_0001" with no dot, or one ending in something implausibly long, is not
 * an extension, so those fall through.
 */
export function extensionFor(file: { name: string; type: string }): string {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && fromName !== file.name.toLowerCase() && fromName.length <= 5) return fromName;
  const fromType = file.type.split("/")[1]?.toLowerCase();
  return fromType === "jpeg" ? "jpg" : (fromType ?? "png");
}
