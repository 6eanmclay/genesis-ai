import "server-only";

import { vercelBlobStorage } from "./vercelBlob";
import { scanAllReferences, hostsOf } from "./scan";
import { canonicalUrl, summarise, humanBytes, type StorageUsage } from "./references";

// WHAT IS IN STORAGE, AND WHAT STILL NEEDS IT.
//
// ============ READ ONLY, DELIBERATELY (2026-08-28) =====================
//
// Sean: "Before we start deleting anything from the Vercel dashboard, I want
// the read-only usage report... The report should be read-only. No deletion
// yet." Nothing in this file or anything it imports can delete an object — the
// storage interface does not yet offer the operation.
//
// ============ WHY THE SCAN IS SYSTEM-WIDE ==============================
//
// Blob storage is one namespace for the whole deployment, shared by every
// business. A file referenced by ANY store is unsafe to delete, so a reference
// scan restricted to one store would report another business's product image as
// unreferenced — and the first deletion built on that report would take a
// stranger's storefront picture with it.
//
// That is why this reads through prismaSystem and why the route above it is
// restricted to a platform administrator rather than to a business owner: the
// answer requires seeing across tenants, so the question may only be asked by
// somebody entitled to.

export interface StorageReport {
  provider: string;
  scannedAt: string;
  /** True when the listing stopped early — the totals are then a floor. */
  truncated: boolean;
  usage: StorageUsage;
  human: {
    total: string;
    referenced: string;
    unreferenced: string;
    /** Against the plan's ceiling, when one is known. */
    percentOfLimit: number | null;
  };
  /** The biggest unreferenced objects, which is where reclaiming starts. */
  largestUnreferenced: { pathname: string; size: string; uploadedAt: string }[];
  /**
   * Objects that look like the leftovers of a failed creation.
   *
   * printfiles/ and mockups/ are written BEFORE the supplier call in
   * productFromDesign.ts, so a Create that fails leaves both behind for ever.
   * Counted separately because they are the one category known to leak rather
   * than merely suspected of it.
   */
  probableFailedCreations: { count: number; bytes: string };
  notes: string[];
}

/** The Hobby plan's ceiling. Reported against, never enforced here. */
const HOBBY_LIMIT_BYTES = 1024 * 1024 * 1024;

export async function buildStorageReport(limitBytes = HOBBY_LIMIT_BYTES): Promise<StorageReport> {
  const listing = await vercelBlobStorage.list();
  const notes: string[] = [];
  if (listing.truncated) {
    notes.push("The listing stopped at its ceiling, so these totals are a floor rather than the whole store.");
  }

  // ---- everything in the database that could point at a file ------------
  //
  // ============ THE FIRST VERSION OF THIS SCANNED FIVE TABLES ==========
  //
  // And the schema has more than forty JSON columns. It showed itself
  // honestly: voice-memos/ and voice-turns/ came back 100% unreferenced,
  // thirty-three files and not one reference between them. A whole category
  // being orphaned is not a plausible fact about a working system — it is the
  // shape of a scan that cannot see. uploadVoiceMemo records the audio on
  // StoreMessage.changes, which the scan never read, and deleting on that
  // report would have stripped the audio out of the owner's conversation.
  //
  // It now asks information_schema what the columns are, so a column added next
  // month is covered the day it exists. See lib/storage/scan.ts.
  const referenceMap = await scanAllReferences(hostsOf(listing.objects.map((o) => o.url)));

  const referenced = new Set([...referenceMap.keys()].map(canonicalUrl));
  const usage = summarise(listing.objects, referenced);

  const unreferenced = listing.objects
    .filter((object) => !referenced.has(canonicalUrl(object.url)))
    .sort((a, b) => b.size - a.size);

  const leftovers = unreferenced.filter(
    (object) => object.pathname.startsWith("printfiles/") || object.pathname.startsWith("mockups/"),
  );

  notes.push(
    `${referenceMap.size} distinct stored files are referenced somewhere in the database. ` +
      `Every text and JSON column in the schema was swept, not a fixed list of tables.`,
  );
  notes.push("Nothing was deleted. This report cannot delete — the storage interface has no delete yet.");

  return {
    provider: vercelBlobStorage.name,
    scannedAt: new Date().toISOString(),
    truncated: listing.truncated,
    usage,
    human: {
      total: humanBytes(usage.totalBytes),
      referenced: humanBytes(usage.referencedBytes),
      unreferenced: humanBytes(usage.unreferencedBytes),
      percentOfLimit: limitBytes > 0 ? Math.round((usage.totalBytes / limitBytes) * 1000) / 10 : null,
    },
    largestUnreferenced: unreferenced.slice(0, 40).map((object) => ({
      pathname: object.pathname,
      size: humanBytes(object.size),
      uploadedAt: object.uploadedAt.toISOString(),
    })),
    probableFailedCreations: {
      count: leftovers.length,
      bytes: humanBytes(leftovers.reduce((sum, object) => sum + object.size, 0)),
    },
    notes,
  };
}
