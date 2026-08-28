// WHAT STILL POINTS AT A FILE.
//
// ============ THE QUESTION DELETION DEPENDS ON (2026-08-28) =============
//
// Sean: "We cannot simply say 'User removed this from the library, so delete
// the blob' because the asset may still be referenced by BusinessRecord, Store
// logo, Product/ProductImage, saved designs, design placements,
// sourceAssetUrls, existing product print files, existing product design
// specs, etc. Before deleting a blob, Genesis should determine whether anything
// still references it."
//
// This file answers that, and it is pure so the answer can be tested. Nothing
// here deletes; the report reads it, and a later deletion will refuse without
// it.
//
// ============ WHY IT ERRS TOWARD "REFERENCED" ==========================
//
// Every function below over-collects on purpose. A URL found somewhere it does
// not strictly need to be is a file that survives; a URL missed is a product
// whose picture disappears, a storefront with a broken tile, or a design that
// cannot be reopened. Those failures are not symmetrical, and the walker below
// therefore reads any string that looks like a stored file anywhere in a JSON
// blob rather than only in the fields it expects.
//
// That matters most for the fields nobody has thought of yet. richContent,
// designSpec and BusinessRecord.data are open JSON that features add to — the
// asset-library work added four new URL-bearing fields in one commit — so a
// reference check listing known field names would fall behind the first time
// somebody stored a URL somewhere new, and would fall behind silently.

/** Where a reference was found, so a report can explain itself. */
export interface UrlReference {
  url: string;
  /** "product.imageUrl", "design.placement", "store.logoUrl". */
  source: string;
}

/**
 * Every stored-file URL anywhere inside a value.
 *
 * Walks arrays, objects and strings to any depth. Cycles are impossible in
 * JSON from the database, but the depth cap is kept anyway: a runaway walk in a
 * diagnostic is a timed-out route rather than a wrong answer, and both are
 * avoidable for one line.
 */
export function urlsIn(value: unknown, isStoredUrl: (url: string) => boolean, depth = 0): string[] {
  if (depth > 12) return [];
  if (typeof value === "string") return isStoredUrl(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => urlsIn(item, isStoredUrl, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      urlsIn(item, isStoredUrl, depth + 1),
    );
  }
  return [];
}

/**
 * Whether a URL belongs to the store being reported on.
 *
 * A design records the SUPPLIER's blank URL beside its own artwork, and a
 * product may point at a supplier's photograph. Those are not ours to count or
 * to delete, and including them would make the report claim references to files
 * that are not in the store at all.
 */
export function storedUrlMatcher(knownUrls: Iterable<string>): (url: string) => boolean {
  // CANONICALISED ON BOTH SIDES (2026-08-28). This compared raw strings, so a
  // reference carrying a download token or a cache-buster — "...a.png?v=2" —
  // did not match the object it points at, and the file was reported as
  // referenced by nothing.
  //
  // That is the single most dangerous mistake this module can make: it does not
  // waste bytes, it deletes a live product's photograph. The suite caught it
  // before anything could delete on its say-so, which is the whole reason the
  // report was built before the deletion.
  const known = new Set([...knownUrls].map(canonicalUrl));
  return (url: string) => known.has(canonicalUrl(url));
}

/**
 * Normalise a URL for comparison.
 *
 * Query strings are stripped: a download token or a cache-buster on a stored
 * reference still points at the same object, and treating the two as different
 * strings is how a referenced file gets reported as unreferenced.
 */
export function canonicalUrl(url: string): string {
  const cut = url.indexOf("?");
  return cut === -1 ? url : url.slice(0, cut);
}

/** One row's worth of references, from any table, reduced to what matters. */
export interface ReferenceSource {
  /** "product", "productImage", "businessRecord", "store". */
  kind: string;
  id: string;
  /** Every value on the row that could hold a stored URL. */
  values: unknown[];
}

/**
 * Collect every reference from a set of rows.
 *
 * Deduplicated by URL, keeping the first place each was found — a report needs
 * to say THAT something is referenced and give one example, not enumerate every
 * row that mentions it.
 */
export function referencesFrom(
  sources: ReferenceSource[],
  isStoredUrl: (url: string) => boolean,
): Map<string, UrlReference> {
  const found = new Map<string, UrlReference>();
  for (const source of sources) {
    for (const raw of urlsIn(source.values, isStoredUrl)) {
      const url = canonicalUrl(raw);
      if (!found.has(url)) found.set(url, { url, source: `${source.kind}:${source.id}` });
    }
  }
  return found;
}

/** The folder an object lives in — "assets/x.png" is "assets". */
export function prefixOf(pathname: string): string {
  const cut = pathname.indexOf("/");
  return cut === -1 ? "(root)" : pathname.slice(0, cut);
}

export interface PrefixUsage {
  prefix: string;
  bytes: number;
  count: number;
  referencedBytes: number;
  referencedCount: number;
  unreferencedBytes: number;
  unreferencedCount: number;
}

export interface StorageUsage {
  totalBytes: number;
  totalCount: number;
  referencedBytes: number;
  unreferencedBytes: number;
  byPrefix: PrefixUsage[];
}

/**
 * The report itself: what is stored, what points at it, and what nothing does.
 *
 * Pure, so the arithmetic is testable without a storage account or a database.
 */
export function summarise(
  objects: { pathname: string; url: string; size: number }[],
  referenced: Set<string>,
): StorageUsage {
  const prefixes = new Map<string, PrefixUsage>();
  let totalBytes = 0;
  let referencedBytes = 0;

  for (const object of objects) {
    const prefix = prefixOf(object.pathname);
    const entry = prefixes.get(prefix) ?? {
      prefix,
      bytes: 0,
      count: 0,
      referencedBytes: 0,
      referencedCount: 0,
      unreferencedBytes: 0,
      unreferencedCount: 0,
    };

    const isReferenced = referenced.has(canonicalUrl(object.url));
    entry.bytes += object.size;
    entry.count += 1;
    if (isReferenced) {
      entry.referencedBytes += object.size;
      entry.referencedCount += 1;
      referencedBytes += object.size;
    } else {
      entry.unreferencedBytes += object.size;
      entry.unreferencedCount += 1;
    }

    prefixes.set(prefix, entry);
    totalBytes += object.size;
  }

  return {
    totalBytes,
    totalCount: objects.length,
    referencedBytes,
    unreferencedBytes: totalBytes - referencedBytes,
    // Biggest first: a report is read to decide what to delete, and the answer
    // is almost always at the top of that order.
    byPrefix: [...prefixes.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

/** Bytes as a person reads them. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
