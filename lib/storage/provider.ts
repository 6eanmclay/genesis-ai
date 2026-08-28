// WHERE GENESIS KEEPS FILES, AS AN INTERFACE.
//
// ============ WHY THIS EXISTS BEFORE ANYTHING USES IT (2026-08-28) ======
//
// Sean: "Let's not build this around Vercel specifically. The application
// should have a storage abstraction so that Genesis knows 'Delete this asset'
// rather than the rest of the application knowing 'Call Vercel Blob del()'...
// The reference-checking/deletion policy belongs to Genesis. The actual
// physical deletion belongs to the storage provider adapter."
//
// He is right, and the shape of the mistake is already visible: `put` is
// imported directly from @vercel/blob in six places across the codebase. Every
// one of those is a line that would have to change to move providers, and none
// of them is where a decision about storage belongs. This interface is the
// seam that stops the seventh, and the diagnostic that reads through it is the
// first caller rather than an exception to it.
//
// ============ WHAT IS DELIBERATELY ABSENT ==============================
//
// There is no delete here yet. Sean's order is diagnostic first, cleanup
// second, safe deletion third — and an interface that offers deletion before
// the reference-checking exists is an invitation to call it. It will be added
// when the policy that guards it is.

/** One stored file, as any provider can describe it. */
export interface StoredObject {
  /** The provider's own path — "assets/<uuid>.png". */
  pathname: string;
  /** The public URL, which is what the database actually records. */
  url: string;
  size: number;
  uploadedAt: Date;
}

export interface StorageListing {
  objects: StoredObject[];
  /**
   * True when the provider stopped early rather than reaching the end.
   *
   * REPORTED, NEVER HIDDEN. A usage report that silently listed the first
   * thousand files would understate the total, and understating is the one
   * error a storage report must not make — it is the number somebody decides
   * what to delete from.
   */
  truncated: boolean;
}

export interface StorageProvider {
  /** What this provider is, for a report that names its source. */
  name: string;
  /**
   * Everything stored, paged through to the end.
   *
   * `limit` is a ceiling on how much will be walked, not a page size — a
   * provider pages internally until it runs out or hits this.
   */
  list(params?: { prefix?: string; limit?: number }): Promise<StorageListing>;
}
