import { del } from "@vercel/blob";
import { prisma, prismaSystem } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";

// PROMOTE OR DISCARD.
//
// ============ THE LEAK THIS CLOSES (2026-08-29) ========================
//
// STORAGE.md section 5, and Sean's own words: "If Genesis uploads temporary
// print files/mockups and the supplier creation fails, those temporary assets
// should be cleaned up safely rather than permanently consuming customer
// storage."
//
// Creating a product uploads two to four composed images and only then calls
// the supplier. A refusal, an unconfirmed placement, a timeout or a crash after
// that point stranded every one of them — which is why the document calls this
// a correctness bug rather than a storage feature: every failed creation made
// the next creation likelier to fail.
//
//   record  ->  upload  ->  supplier verified  ->  PROMOTE (the product's now)
//                       \
//                        ->  anything else     ->  DISCARD
//
// ============ THE ROW IS WRITTEN BEFORE THE BLOB =======================
//
// Deliberately, and it is the whole design. A row with no blob is harmless: the
// sweep tries to delete something that is not there and moves on. A blob with
// no row is invisible, and invisible is the leak. Because the caller generates
// its own key, the record can always be made first.
//
// ============ AND DELETION CANNOT SEE A CUSTOMER'S UPLOAD ==============
//
// Sean: "deletion must be narrowly scoped to temporary artifacts so permanent
// user assets cannot be accidentally swept."
//
// Two guards, because one of them is a table and the other is a fact about the
// object itself:
//
//   1. Every deletion path here reads TemporaryAsset and nothing else. An
//      owner's upload has no row, so it is not merely protected from deletion —
//      it is not representable in the code that deletes.
//   2. The pathname is re-checked against the temporary prefixes immediately
//      before `del`. A corrupted or hand-edited row still cannot reach
//      `assets/`.
//
// This is the only file besides cleanup.ts that imports `del`.
//
// ============ AND WHY IT CARRIES NO `server-only` MARKER ===============
//
// The rest of lib/storage does. This one cannot: `server-only` is resolved by
// Next rather than installed as a package, so a module carrying it cannot be
// imported by a suite at all — and STORAGE.md's own acceptance test is "the one
// that runs the loop a hundred times and asserts the bytes did not climb",
// which has to call these functions.
//
// The same trade the codebase already made twice, for the same reason:
// lib/creation/saveDesign.ts was extracted specifically so the write was
// testable, and lib/orders/orderConfirmation.ts is plain for the same purpose.
// Nothing client-side imports this — the executable and the cron are its only
// callers — and the narrowness that actually protects a customer's upload is
// the TemporaryAsset table plus the prefix re-check, both asserted, not a
// bundler marker.

/**
 * Removing one blob.
 *
 * ============ INJECTABLE, FOR THE REASON EVERYTHING HERE IS ============
 *
 * STORAGE.md's acceptance test runs a hundred failed creations and asserts the
 * bytes did not climb. Reaching Vercel Blob a hundred times would make that
 * test a network test, and the harness has no blob credentials anyway — the
 * first run failed on exactly that, with the code behaving correctly.
 *
 * It also buys something a source scan cannot: the suite can assert WHICH
 * pathnames were handed to the deleter, which is a real check of the narrowness
 * rather than a claim about it.
 *
 * Production passes nothing and `del` is used.
 */
export type BlobDeleter = (url: string) => Promise<void>;

/** The prefixes a temporary artefact may live under. Nothing else is deletable. */
const TEMPORARY_PREFIXES = ["printfiles/", "mockups/"] as const;

/** What kind of artefact a row describes. Mirrors the prefixes above. */
export type TemporaryKind = "printfile" | "mockup";

const PREFIX_FOR: Record<TemporaryKind, string> = {
  printfile: "printfiles/",
  mockup: "mockups/",
};

/**
 * Claim a key before anything is written to it.
 *
 * Returns the pathname to upload under, so the caller cannot record one key and
 * upload to another.
 */
export async function recordTemporary(input: {
  storeId: string;
  kind: TemporaryKind;
  /** The unique part of the name — usually a uuid and a side. */
  name: string;
}): Promise<{ id: string; pathname: string }> {
  const pathname = `${PREFIX_FOR[input.kind]}${input.name}`;
  const row = await prisma.temporaryAsset.create({
    data: { storeId: input.storeId, pathname, kind: input.kind },
    select: { id: true, pathname: true },
  });
  return row;
}

/** Record what the upload actually produced, once it has. */
export async function markTemporaryUploaded(input: {
  id: string;
  storeId: string;
  url: string;
  sizeInBytes: number;
}): Promise<void> {
  await prisma.temporaryAsset.updateMany({
    where: { id: input.id, storeId: input.storeId },
    data: { url: input.url, sizeInBytes: input.sizeInBytes },
  });
}

/**
 * The product kept them. They are no longer temporary.
 *
 * Called only after a verified supplier product exists AND the rows that
 * reference these blobs have been written — so a promoted asset is always one
 * something else already points at.
 */
export async function promoteTemporaries(storeId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.temporaryAsset.updateMany({
    where: { id: { in: ids }, storeId, promotedAt: null },
    data: { promotedAt: new Date() },
  });
}

/**
 * The attempt failed. Take the blobs back.
 *
 * Never throws. It runs on the failure path, and a cleanup that turns a
 * supplier refusal into an unhandled error would replace a clear message to the
 * owner with a confusing one — while the sweep would have caught the leak
 * anyway.
 */
export async function discardTemporaries(
  storeId: string,
  ids: string[],
  deleteBlob?: BlobDeleter,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await prisma.temporaryAsset.findMany({
    // promotedAt: null is not decoration. A promoted asset belongs to a product
    // now, and a late failure elsewhere must not reclaim it.
    where: { id: { in: ids }, storeId, promotedAt: null },
    select: { id: true, url: true, pathname: true },
  });
  return deleteRows(rows, "creation failed", deleteBlob);
}

/** How long an unpromoted artefact may sit before the sweep reclaims it. */
export const ABANDONED_AFTER_MS = 60 * 60 * 1000;

export interface SweepResult {
  /** Rows examined. */
  found: number;
  /** Blobs actually reclaimed. */
  deleted: number;
}

/**
 * Reclaim what a crash left behind.
 *
 * ============ THE CASE THAT LEAKS IS THE ONE THAT DID NOT FINISH =======
 *
 * discardTemporaries covers a failure the code caught. This covers the failure
 * it did not: a process killed between two uploads, a deploy mid-creation, a
 * timeout that took the whole function with it. STORAGE.md requires exactly
 * this, and it is why the row is written before the blob.
 *
 * An hour is long enough that no live creation is still holding one — the
 * supplier call is the slow part and it is measured in seconds — and short
 * enough that a crash does not park bytes for a day.
 *
 * Cross-tenant by design, so it runs as the system: it is a cron with no
 * session, sweeping every store. Deletion is still narrow — see the file note.
 */
export async function sweepAbandonedTemporaries(
  now: Date = new Date(),
  olderThanMs: number = ABANDONED_AFTER_MS,
  deleteBlob?: BlobDeleter,
): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = await prismaSystem.temporaryAsset.findMany({
    where: { promotedAt: null, createdAt: { lt: cutoff } },
    select: { id: true, url: true, pathname: true },
    orderBy: { createdAt: "asc" },
    // Bounded: a backlog must not turn one cron into a thousand deletes.
    take: 200,
  });
  const deleted = await deleteRows(rows, "abandoned by a creation that never finished", deleteBlob);
  return { found: rows.length, deleted };
}

/**
 * Delete the blobs these rows describe, then the rows.
 *
 * The second of the two guards lives here: whatever a row claims, its pathname
 * must still start with a temporary prefix. A row that fails that check is left
 * alone and reported — it should be impossible, and a leak is a better outcome
 * than deleting something that was never temporary.
 */
async function deleteRows(
  rows: { id: string; url: string | null; pathname: string }[],
  reason: string,
  deleteBlob: BlobDeleter = (url) => del(url),
): Promise<number> {
  let deleted = 0;
  const settled: string[] = [];

  for (const row of rows) {
    if (!TEMPORARY_PREFIXES.some((prefix) => row.pathname.startsWith(prefix))) {
      reportIssue(`refused to delete ${row.pathname} — not a temporary prefix`, null, {
        subsystem: "storage",
        stage: "temporary.refused",
      });
      continue;
    }

    // A row with no url never finished uploading. There is nothing to delete,
    // and the row itself should still go.
    if (row.url) {
      try {
        await deleteBlob(row.url);
        deleted++;
      } catch (error) {
        // A blob that is already gone is a success for our purposes. Anything
        // else is reported and the row is KEPT, so the next sweep tries again
        // rather than losing track of a blob that is still there.
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found|404/i.test(message)) {
          reportIssue(`could not reclaim temporary ${row.pathname} (${reason})`, error, {
            subsystem: "storage",
            stage: "temporary.delete",
          });
          continue;
        }
      }
    }
    settled.push(row.id);
  }

  if (settled.length > 0) {
    await prismaSystem.temporaryAsset.deleteMany({ where: { id: { in: settled } } });
  }
  return deleted;
}
