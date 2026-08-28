import "server-only";

import { prismaSystem } from "@/lib/prisma";
import { vercelBlobStorage } from "./vercelBlob";
import {
  referencesFrom,
  storedUrlMatcher,
  canonicalUrl,
  summarise,
  humanBytes,
  type ReferenceSource,
  type StorageUsage,
} from "./references";

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

  // Every URL that actually exists, so a reference to a supplier's CDN or a
  // deleted file is not counted as a reference to something we hold.
  const isStoredUrl = storedUrlMatcher(listing.objects.map((object) => canonicalUrl(object.url)));

  // ---- everything in the database that could point at a file ------------
  //
  // Whole rows are handed to the walker rather than named columns. The
  // asset-library work added four URL-bearing fields in one commit, and a
  // reference check that lists field names falls behind the first time somebody
  // stores a URL somewhere new — silently, which is the dangerous way.
  const [records, products, images, stores, sourced] = await Promise.all([
    prismaSystem.businessRecord.findMany({ select: { id: true, data: true } }),
    prismaSystem.product.findMany({
      select: { id: true, imageUrl: true, richContent: true, designSpec: true },
    }),
    prismaSystem.productImage.findMany({ select: { id: true, url: true } }),
    prismaSystem.store.findMany({ select: { id: true, logoUrl: true } }),
    prismaSystem.sourcedProduct.findMany({ select: { id: true, imageUrl: true } }),
  ]);

  const sources: ReferenceSource[] = [
    ...records.map((r) => ({ kind: "businessRecord", id: r.id, values: [r.data] })),
    ...products.map((p) => ({
      kind: "product",
      id: p.id,
      values: [p.imageUrl, p.richContent, p.designSpec],
    })),
    ...images.map((i) => ({ kind: "productImage", id: i.id, values: [i.url] })),
    ...stores.map((s) => ({ kind: "store", id: s.id, values: [s.logoUrl] })),
    ...sourced.map((s) => ({ kind: "sourcedProduct", id: s.id, values: [s.imageUrl] })),
  ];

  const references = referencesFrom(sources, isStoredUrl);
  const referenced = new Set(references.keys());
  const usage = summarise(listing.objects, referenced);

  const unreferenced = listing.objects
    .filter((object) => !referenced.has(canonicalUrl(object.url)))
    .sort((a, b) => b.size - a.size);

  const leftovers = unreferenced.filter(
    (object) => object.pathname.startsWith("printfiles/") || object.pathname.startsWith("mockups/"),
  );

  notes.push(
    `${records.length} business records, ${products.length} products, ${images.length} product images, ` +
      `${stores.length} stores and ${sourced.length} sourced products were scanned for references.`,
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
