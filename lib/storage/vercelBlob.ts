import "server-only";

import { list } from "@vercel/blob";
import type { StorageProvider, StoredObject } from "./provider";

// VERCEL BLOB, BEHIND THE INTERFACE.
//
// The only file in Genesis that is allowed to know which storage product is in
// use — everything else asks lib/storage for what it needs. Moving providers is
// a second file like this one plus a line in the registry, which is the same
// shape lib/fulfillment/registry.ts and lib/creation/registry.ts already hold.
//
// `put` is still imported directly in six other places. Those are not changed
// here: this pass is a read-only diagnostic, and rewriting six working upload
// paths is a different change with its own risk. Named so it is a known
// inconsistency rather than an unnoticed one.

/** Vercel returns at most 1000 per page; this walks until it runs out. */
const PAGE = 1000;

/**
 * A ceiling on how much will be walked in one report.
 *
 * A store with a million objects should produce a truncated report rather than
 * a timed-out route. Truncation is reported, so the number is never quietly
 * wrong — see StorageListing.truncated.
 */
const DEFAULT_LIMIT = 10_000;

export const vercelBlobStorage: StorageProvider = {
  name: "vercel-blob",

  async list(params) {
    const limit = params?.limit ?? DEFAULT_LIMIT;
    const objects: StoredObject[] = [];
    let cursor: string | undefined;
    let truncated = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await list({
        prefix: params?.prefix,
        limit: Math.min(PAGE, limit - objects.length),
        cursor,
      });

      for (const blob of page.blobs) {
        objects.push({
          pathname: blob.pathname,
          url: blob.url,
          size: blob.size,
          uploadedAt: new Date(blob.uploadedAt),
        });
      }

      if (!page.hasMore) break;
      if (objects.length >= limit) {
        truncated = true;
        break;
      }
      cursor = page.cursor;
      if (!cursor) break;
    }

    return { objects, truncated };
  },
};
