import type { Asset } from "@/lib/businessModel/entities";

// THE CREATION STATION'S ASSET LIBRARY — pure.
//
// ============ THE DISTINCTION THIS EXISTS FOR (2026-08-28) ==============
//
// Sean: "J4's memory is the business brain. Creation Station is the creative
// workspace... Deleting an asset from Creation Station should not automatically
// mean deleting J4's underlying memory/knowledge of it."
//
// Until now those were the same thing. The picker queried BusinessRecord for
// photos and showed whatever came back, so an owner had no way to tidy their
// toolbox that did not mean making J4 forget. The library is now a VIEW over
// the same records rather than a second store — which is why nothing here
// copies, moves or deletes anything.
//
// Pure and provider-agnostic on purpose: it knows nothing about hoodies, mugs
// or print areas. The same artwork has to work on all of them.

/** An asset as the Creation Station shows it. */
export interface LibraryAsset {
  id: string;
  url: string;
  name: string;
  /** "uploaded" | "generated" | null — where it came from. */
  origin: string | null;
  /**
   * True, false, or null for "never inspected".
   *
   * Carried through rather than collapsed to a boolean: an asset whose bytes
   * could not be read is not the same as one measured and found opaque, and
   * the difference decides whether a future Remove Background is worth
   * offering on it.
   */
  hasTransparency: boolean | null;
}

/** Is this asset currently in the owner's creative workspace? */
export function inLibrary(asset: Pick<Asset, "creationLibraryRemovedAt">): boolean {
  return !asset.creationLibraryRemovedAt;
}

/**
 * The images an owner can design with.
 *
 * TWO FILTERS, AND BOTH ARE ABOUT THE OWNER RATHER THAN THE FILE. Only images,
 * because a supplier invoice is a real business asset and not artwork; and only
 * what has not been removed, because the toolbox is theirs to curate.
 *
 * Everything else — role, supersession, classification, provenance — is left
 * exactly as it is. This is a lens, not a lifecycle.
 */
export function libraryFrom(
  records: { id: string; data: Asset }[],
): LibraryAsset[] {
  return records
    .filter((r) => r.data.fileType === "photo" && r.data.storageUrl && inLibrary(r.data))
    .map((r) => ({
      id: r.id,
      url: r.data.storageUrl,
      name: r.data.originalFilename || "Artwork",
      origin: r.data.origin,
      hasTransparency: r.data.hasTransparency,
    }));
}

/**
 * The asset, removed from the library — as a new value, not a mutation.
 *
 * REVERSIBLE BY CONSTRUCTION. Removal writes a date and restoration clears it;
 * nothing is deleted and no other field is touched. That is the whole guarantee
 * Sean asked for, expressed as a shape rather than as a promise in a comment:
 * there is no code path here that could remove a record even by mistake.
 */
export function removedFromLibrary(asset: Asset, at: Date = new Date()): Asset {
  return { ...asset, creationLibraryRemovedAt: at.toISOString() };
}

/** The asset, back in the library. The exact inverse of the above. */
export function restoredToLibrary(asset: Asset): Asset {
  return { ...asset, creationLibraryRemovedAt: null };
}
