import "server-only";

import { del } from "@vercel/blob";
import { vercelBlobStorage } from "./vercelBlob";
import { scanAllReferences, hostsOf } from "./scan";
import { canonicalUrl, humanBytes } from "./references";

// RECLAIMING STORAGE, ONCE NOTHING NEEDS IT.
//
// ============ THE ONE PLACE ANYTHING IS DELETED (2026-08-28) ============
//
// Sean: "Create one centralized storage deletion/reference-checking mechanism
// rather than scattering del() calls throughout the codebase."
//
// This is that place, and it is the only file in Genesis that imports `del`.
// Everything else asks for a cleanup and gets one that has already checked.
//
// ============ IT RE-CHECKS. IT DOES NOT TRUST A LIST ===================
//
// A caller passes pathnames, and this deletes NONE of them on that basis. The
// reference scan is run again, here, at the moment of deletion, and anything a
// row still points at is refused however explicitly it was asked for.
//
// That is not defensiveness for its own sake. A report is a photograph of a
// moment; between reading it and acting on it somebody can create a product,
// finish a design, or set a logo — and the file that was safe when the report
// was drawn is load-bearing by the time the delete arrives. Re-checking closes
// that window. The cost is one extra scan; the alternative is a storefront with
// a hole in it and no way to tell which delete caused it.
//
// ============ DRY RUN IS THE DEFAULT ==================================
//
// Sean: "Before deleting a large batch, show me the proposed deletion list/
// count and estimated storage recovery." So nothing happens without an explicit
// confirmation, and the proposal is the same code path as the deletion — the
// list shown is by construction the list that would go.

export interface CleanupCandidate {
  pathname: string;
  url: string;
  size: number;
  human: string;
  uploadedAt: string;
}

export interface CleanupResult {
  dryRun: boolean;
  /** What would be, or was, deleted. */
  candidates: CleanupCandidate[];
  count: number;
  bytes: number;
  human: string;
  /** Asked for but refused, with the row that still needs them. */
  refused: { pathname: string; referencedBy: string }[];
  deleted: number;
  errors: { pathname: string; error: string }[];
  notes: string[];
}

/**
 * Everything the database still points at, scanned across every business.
 *
 * SYSTEM-WIDE, for the same reason the report is: blob storage is one namespace
 * for the whole deployment, so a file referenced by any store is unsafe to
 * delete. A scan scoped to one business would happily delete another's.
 */
async function referencedUrls(knownUrls: string[]): Promise<Map<string, string>> {
  // THE SAME WHOLE-DATABASE SWEEP THE REPORT USES, deliberately — the check
  // that decides a deletion must not be a weaker version of the check that
  // proposed it. See lib/storage/scan.ts for why it reads information_schema
  // rather than a list of tables somebody has to remember to extend.
  const found = await scanAllReferences(hostsOf(knownUrls));
  return new Map([...found].map(([url, source]) => [canonicalUrl(url), source]));
}

/**
 * Delete storage that nothing needs, or say what would go.
 *
 * `prefixes` narrows what is considered — passing ["printfiles", "mockups"]
 * reclaims failed-creation leftovers without touching anything an owner
 * uploaded. Omitting it considers everything, still subject to the reference
 * check.
 */
export async function cleanupUnreferenced(params: {
  confirm: boolean;
  prefixes?: string[];
  /** A ceiling on how many objects one run will remove. */
  max?: number;
}): Promise<CleanupResult> {
  const listing = await vercelBlobStorage.list();
  const referenced = await referencedUrls(listing.objects.map((object) => object.url));

  const notes: string[] = [];
  if (listing.truncated) {
    notes.push("The listing stopped at its ceiling, so this considered only part of the store.");
  }

  const wanted = params.prefixes?.length
    ? listing.objects.filter((object) => params.prefixes!.some((p) => object.pathname.startsWith(`${p}/`)))
    : listing.objects;

  const refused: CleanupResult["refused"] = [];
  const candidates: CleanupCandidate[] = [];

  for (const object of wanted) {
    const holder = referenced.get(canonicalUrl(object.url));
    if (holder) {
      refused.push({ pathname: object.pathname, referencedBy: holder });
      continue;
    }
    candidates.push({
      pathname: object.pathname,
      url: object.url,
      size: object.size,
      human: humanBytes(object.size),
      uploadedAt: object.uploadedAt.toISOString(),
    });
  }

  // Biggest first: a run capped by `max` should reclaim the most it can.
  candidates.sort((a, b) => b.size - a.size);
  const selected = params.max ? candidates.slice(0, params.max) : candidates;
  const bytes = selected.reduce((sum, candidate) => sum + candidate.size, 0);

  if (!params.confirm) {
    notes.push("Dry run. Nothing was deleted — pass confirm to act on exactly this list.");
    return {
      dryRun: true,
      candidates: selected,
      count: selected.length,
      bytes,
      human: humanBytes(bytes),
      refused,
      deleted: 0,
      errors: [],
      notes,
    };
  }

  const errors: CleanupResult["errors"] = [];
  let deleted = 0;
  for (const candidate of selected) {
    try {
      await del(candidate.url);
      deleted += 1;
    } catch (error) {
      errors.push({
        pathname: candidate.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  notes.push(`${deleted} of ${selected.length} objects deleted.`);
  if (refused.length > 0) {
    notes.push(`${refused.length} were refused because a record still points at them.`);
  }

  return {
    dryRun: false,
    candidates: selected,
    count: selected.length,
    bytes,
    human: humanBytes(bytes),
    refused,
    deleted,
    errors,
    notes,
  };
}
