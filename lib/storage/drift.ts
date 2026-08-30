// WHERE THE LEDGER AND THE PROVIDER DISAGREE.
//
// ============ ONE COMPARISON, TWO CALLERS (2026-08-30) =================
//
// scripts/reconcile-storage.ts asks this question in order to FIX the answer.
// lib/storage/ledgerReport.ts asks it in order to SHOW the answer. Two copies
// would be the same mirrored-registry hazard the attribution derivation already
// avoids, and worse in the same specific way: they would agree the day they were
// written, then drift — leaving an operator report that says "in sync" about a
// ledger reconciliation is quietly correcting.
//
// So this is the one implementation, and it is PURE. No database, no provider,
// no clock beyond what it is handed. That is what lets it be tested exhaustively
// without either — which matters, because a comparison that cannot see is
// indistinguishable from a comparison that found nothing.
//
// ============ NOTHING HERE ACTS ========================================
//
// It classifies. Deciding what to do about a class — record it, remove the row,
// report and leave it alone — belongs to the caller, and the two callers
// deliberately decide differently.

/** The provider's view of one object. */
export interface ProviderObject {
  pathname: string;
  url: string;
  size: number;
}

/** The ledger's view. The subset of StorageObject a comparison needs. */
export interface LedgerRow {
  id: string;
  pathname: string;
  storeId: string | null;
  attribution: string;
  lifecycle: string;
  prefix: string;
  sizeInBytes: number | null;
  declaredBytes: number | null;
  /** Null means a live reservation: it is SUPPOSED to have no blob yet. */
  uploadedAt: Date | null;
  touchedAt: Date;
}

export interface Drift {
  provider: { objects: number; bytes: number };
  /** Landed rows only — a reservation is not a claim that bytes exist. */
  ledger: { objects: number; bytes: number; landed: number; reservations: number };
  /** A blob nobody claimed. Something wrote without reserving. */
  orphanBlobs: { pathname: string; size: number; prefix: string }[];
  /** A landed row whose blob is not there. The bytes genuinely are not. */
  missingBlobs: { pathname: string; storeId: string | null; sizeInBytes: number | null; ageMs: number }[];
  /** The provider and the row disagree on size. The provider is right. */
  sizeDisagreements: { pathname: string; recorded: number | null; actual: number }[];
  /** A reservation whose upload landed — the completion webhook never arrived. */
  landedReservations: { pathname: string; declaredBytes: number | null; actual: number }[];
  /** True when every one of the four lists above is empty. */
  inSync: boolean;
}

/**
 * Compare a provider listing to the ledger.
 *
 * `now` is passed in rather than read, so a caller can ask "what was true at
 * this moment" and so the grace-period arithmetic is testable without waiting.
 */
export function compareToProvider(
  blobs: ProviderObject[],
  rows: LedgerRow[],
  now: Date = new Date(),
): Drift {
  const providerByPath = new Map(blobs.map((b) => [b.pathname, b]));

  // A row with no uploadedAt is a live reservation, not a missing object.
  // Comparing it against the provider would report every in-flight upload as a
  // fault, and a caller acting on that would delete the reservation of an
  // upload that is still happening.
  const landed = rows.filter((r) => r.uploadedAt !== null);
  const reservations = rows.filter((r) => r.uploadedAt === null);

  // Against EVERY row, not only the landed ones. A blob matching a live
  // reservation is not an orphan — it is a landed reservation, below. Counting
  // it in both places would report one blob as two different problems.
  const allPaths = new Set(rows.map((r) => r.pathname));

  const orphanBlobs = blobs
    .filter((b) => !allPaths.has(b.pathname))
    .map((b) => ({ pathname: b.pathname, size: b.size, prefix: prefixOf(b.pathname) }));

  const missingBlobs = landed
    .filter((r) => !providerByPath.has(r.pathname))
    .map((r) => ({
      pathname: r.pathname,
      storeId: r.storeId,
      sizeInBytes: r.sizeInBytes,
      ageMs: now.getTime() - (r.uploadedAt ?? r.touchedAt).getTime(),
    }));

  const sizeDisagreements: Drift["sizeDisagreements"] = [];
  for (const row of landed) {
    const blob = providerByPath.get(row.pathname);
    if (!blob) continue;
    if (blob.size !== (row.sizeInBytes ?? -1)) {
      sizeDisagreements.push({ pathname: row.pathname, recorded: row.sizeInBytes, actual: blob.size });
    }
  }

  const landedReservations = reservations
    .filter((r) => providerByPath.has(r.pathname))
    .map((r) => ({
      pathname: r.pathname,
      declaredBytes: r.declaredBytes,
      actual: providerByPath.get(r.pathname)!.size,
    }));

  return {
    provider: { objects: blobs.length, bytes: blobs.reduce((s, b) => s + b.size, 0) },
    ledger: {
      objects: rows.length,
      // Landed bytes only. A reservation is a promise, and adding promises to a
      // figure the provider is compared against would make every in-flight
      // upload look like a disagreement.
      bytes: landed.reduce((s, r) => s + (r.sizeInBytes ?? 0), 0),
      landed: landed.length,
      reservations: reservations.length,
    },
    orphanBlobs,
    missingBlobs,
    sizeDisagreements,
    landedReservations,
    inSync:
      orphanBlobs.length === 0 &&
      missingBlobs.length === 0 &&
      sizeDisagreements.length === 0 &&
      landedReservations.length === 0,
  };
}

/** The folder half of a key, with its slash — "assets/x.png" is "assets/". */
function prefixOf(pathname: string): string {
  const cut = pathname.indexOf("/");
  return cut === -1 ? "(root)" : pathname.slice(0, cut + 1);
}
