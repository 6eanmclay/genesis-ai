import { prismaSystem } from "@/lib/prisma";
import { compareToProvider, type Drift, type LedgerRow, type ProviderObject } from "./drift";
import { deriveAttribution, candidatesFor, type AttributionScan } from "./attribution";
import {
  PREFIX_LIFECYCLE,
  recordActualByPathname,
  recordEvent,
  type BlobDeleter,
} from "./ledger";

// THE LEDGER AND THE PROVIDER, MADE TO AGREE — ON A TIMER.
//
// ============ WHY THIS IS A MODULE AND NOT A SCRIPT (2026-08-30) ========
//
// Both passes lived inline in scripts/reconcile-storage.ts, which was fine
// while a person ran them and watched. Two things made that untenable:
//
//   a cron has to call them, and a cron cannot call a script's main()
//   the deletion refusal below cannot be OBSERVED from outside a function, and
//   an unobservable safety property is a claim rather than a guarantee
//
// So the decisions live here with every dependency injected, the script became
// a thin operator wrapper, and the cron is orchestration only.
//
// ============ THE SPLIT ================================================
//
// Sean, 2026-08-30: "Nightly: provider/ledger reconciliation — presence, size,
// landed reservations, last-seen state, and the cheap attribution checks that
// can be performed from existing ledger evidence. Weekly: the full schema
// attribution sweep."
//
// The expensive half sweeps 279 text and JSON columns with regexp_matches. It
// is the right instrument — a hand-maintained list of places to look is what
// missed voice memos entirely — and it is priced for somebody running it
// deliberately, not for a nightly function with a 300-second ceiling on a
// database that keeps growing. Attribution changes when references change,
// which is slow. Sizes and existence change with every upload.
//
// ============ IT CANNOT DELETE A BLOB ==================================
//
// Not "does not". The header of the old script claimed the property by pointing
// at a missing `del` import, and the claim was false: the backstop reached
// recordActualByPathname -> recordActual -> deleteObject -> del(url) whenever a
// reproducible asset landed larger than its reservation. Unreachable in
// practice, one refactor from reachable, and asserted by a test that was
// checking the wrong thing.
//
// Now REFUSE_TO_DELETE is the only deleter this module can reach — not a
// default a caller may override — and a test constructs the exact situation
// and watches nothing happen. See the note above NightlyDeps.

/** Reconciliation's deleter. It exists to say no, loudly, and leave the row. */
export const REFUSE_TO_DELETE: BlobDeleter = async (url: string) => {
  await recordEvent({
    pathname: url,
    storeId: null,
    kind: "deletion_refused",
    actor: "reconciliation",
    reason:
      "reconciliation asked to delete a blob and was refused; it corrects and reports, " +
      "it never removes bytes. The ledger row is left intact for an operator to decide on.",
  });
  // deleteObject treats a throwing deleter as a reason to KEEP the row, which
  // is exactly the outcome wanted: nothing deleted, nothing forgotten.
  throw new Error(`reconciliation may not delete blobs (${url})`);
};

/** How long a row with no blob is given before it is believed to be absent. */
export const GRACE_MS = 60 * 60 * 1000;

// ============ SWITCHING IT ON AND LETTING IT WRITE ARE TWO THINGS ======
//
// Added 2026-09-01, preparing this branch for its first deploy. The task was
// enabled by one variable and hard-coded `apply: true`, so the single act of
// turning it on would have taken it straight from never having run to writing
// to production on its first pass — against a ledger whose write paths had not
// been live long enough for anyone to know what it would find.
//
// Nothing was unsafe about the run itself, and it is worth being precise about
// that rather than implying otherwise: a truncated listing is refused before
// any write, blob deletion is impossible by construction, and the only rows it
// removes are ones whose blob the provider no longer lists after a grace
// period, each with a StorageEvent recording enough to reconstruct it.
//
// What was missing was the ability to LOOK FIRST. Every other destructive
// scheduled task in this codebase defaults to a dry run and needs an explicit
// second signal to act — the retention sweep and the security prune both do —
// and this one could not be watched before it was trusted.
//
//   unset    the task does not run at all
//   "on"     it runs, classifies, and reports — writing nothing
//   "apply"  it runs and corrects
//
// The middle state is the one that did not exist.

/** Whether the nightly pass runs at all. */
export function nightlyEnabled(): boolean {
  return process.env.STORAGE_RECONCILE === "on" || process.env.STORAGE_RECONCILE === "apply";
}

/**
 * Whether it may write.
 *
 * Deliberately a different value rather than a second variable: two variables
 * make a state where one says on and the other says apply, and somebody has to
 * decide what that means. One variable with three values has no such state.
 */
export function nightlyApplies(): boolean {
  return process.env.STORAGE_RECONCILE === "apply";
}
export function attributionSweepEnabled(): boolean {
  return process.env.STORAGE_ATTRIBUTION_SWEEP === "on";
}

/** Everything the nightly pass reaches outside itself. */
export interface NightlyDeps {
  listObjects: () => Promise<{ objects: ProviderObject[]; truncated: boolean }>;
  now?: Date;
  /** Dry run: classify and report, write nothing. */
  apply?: boolean;
}

// ============ THE DELETER IS NOT AN ARGUMENT ==========================
//
// It was, briefly, "so a test could prove nothing calls it" — and writing that
// test showed the idea was backwards. A test that injects a PERMISSIVE deleter
// proves the injection point works and nothing about the safety property; and
// an injectable deleter means any future caller can hand reconciliation the
// power to delete, which is exactly what must be impossible.
//
// Sean, 2026-08-30: "Reconciliation must never be able to delete a blob."
// Never able. So REFUSE_TO_DELETE is not a default that a caller may override,
// it is the only deleter this module can reach.
//
// The property is proven behaviourally instead: the suite builds the one shape
// that reaches the rollback branch — a reproducible asset landing larger than
// its reservation — and asserts a deletion_refused event exists, the row
// survives, and no `deleted` event was written. Remove the refusal and the
// first of those disappears.

export interface LedgerInconsistency {
  pathname: string;
  problem: string;
  corrected: boolean;
}

export interface NightlyResult {
  ranAt: string;
  truncated: boolean;
  drift: Drift;
  /** Orphans seen this run, and how many of them were new. */
  orphans: { total: number; firstSeen: number; standing: number };
  recovered: number;
  rowsRemoved: number;
  sizesCorrected: number;
  inconsistencies: LedgerInconsistency[];
  lastSeenTouched: number;
  applied: boolean;
}

/**
 * The cheap pass. One provider listing, one ledger read, a handful of indexed
 * queries, and no schema sweep of any kind.
 */
export async function runNightlyReconciliation(deps: NightlyDeps): Promise<NightlyResult> {
  const now = deps.now ?? new Date();
  const apply = deps.apply ?? false;

  const listing = await deps.listObjects();
  if (listing.truncated) {
    // A partial listing would report every unseen blob as a missing row and
    // then remove it. Refused outright rather than acted on.
    return {
      ranAt: now.toISOString(),
      truncated: true,
      drift: compareToProvider([], [], now),
      orphans: { total: 0, firstSeen: 0, standing: 0 },
      recovered: 0,
      rowsRemoved: 0,
      sizesCorrected: 0,
      inconsistencies: [],
      lastSeenTouched: 0,
      applied: false,
    };
  }

  const rows = (await prismaSystem.storageObject.findMany({
    select: {
      id: true, pathname: true, storeId: true, attribution: true, lifecycle: true,
      prefix: true, sizeInBytes: true, declaredBytes: true, uploadedAt: true, touchedAt: true,
    },
  })) as LedgerRow[];
  const byPathname = new Map(rows.map((r) => [r.pathname, r]));
  const providerByPath = new Map(listing.objects.map((o) => [o.pathname, o]));

  const drift = compareToProvider(listing.objects, rows, now);

  // ---- orphans: first sighting is news, the ninetieth is not -----------
  //
  // ============ ABSOLUTE DEDUPLICATION, NOT A TIME WINDOW ============
  //
  // A window would reintroduce exactly the periodic spam this exists to remove.
  // Absolute dedup is safe here for a specific reason rather than by luck: an
  // orphan is never adopted, and every pathname Genesis writes carries a
  // randomUUID, so a key is never reused. Once "this pathname was seen with no
  // row" is true, it stays true.
  const orphanPaths = drift.orphanBlobs.map((o) => o.pathname);
  const alreadyReported = new Set(
    (
      await prismaSystem.storageEvent.findMany({
        where: { kind: "reconciled_orphan", pathname: { in: orphanPaths } },
        select: { pathname: true },
      })
    ).map((e) => e.pathname),
  );
  const newOrphans = drift.orphanBlobs.filter((o) => !alreadyReported.has(o.pathname));

  // ---- cheap attribution checks, from the ledger alone -----------------
  const inconsistencies: LedgerInconsistency[] = [];

  // THE STORE ITSELF IS GONE. StorageObject's foreign key is onDelete: SetNull,
  // so deleting a Store nulls storeId and leaves attribution saying "owner" —
  // a row claiming to be owned, by nobody.
  //
  // This is NOT the demotion Sean ruled out. That rule protects an owner whose
  // REFERENCE disappeared: the product row went, the business did not, and the
  // file is still theirs. Here the business is gone and the foreign key already
  // destroyed the ownership information before reconciliation looked.
  // Relabelling loses nothing; it makes attribution agree with a storeId that
  // is already null.
  const ownerWithNoStore = rows.filter((r) => r.attribution === "owner" && r.storeId === null);

  // The opposite shape should be impossible. Reported, never "fixed" — a row
  // that carries a store while claiming not to be owned means something wrote
  // it wrongly, and guessing which half is right would destroy the evidence.
  const unattributedWithStore = rows.filter(
    (r) => r.attribution === "unattributed" && r.storeId !== null,
  );
  const unknownAttribution = rows.filter(
    (r) => !["owner", "unattributed", "ambiguous", "platform"].includes(r.attribution),
  );
  const lifecycleDrift = rows.filter((r) => {
    const declared = PREFIX_LIFECYCLE[r.prefix];
    // Lifecycle decides what a future cleanup may delete, so a mismatch is
    // reported and never rewritten — the one correction that could turn a
    // permanent asset into a reclaimable one.
    return declared && declared !== r.lifecycle && r.lifecycle !== "temporary";
  });

  for (const r of ownerWithNoStore) {
    inconsistencies.push({
      pathname: r.pathname,
      problem: "attribution says owner but the store is gone",
      corrected: apply,
    });
  }
  for (const r of unattributedWithStore) {
    inconsistencies.push({
      pathname: r.pathname,
      problem: `unattributed but carries store ${r.storeId}`,
      corrected: false,
    });
  }
  for (const r of unknownAttribution) {
    inconsistencies.push({ pathname: r.pathname, problem: `unknown attribution "${r.attribution}"`, corrected: false });
  }
  for (const r of lifecycleDrift) {
    inconsistencies.push({
      pathname: r.pathname,
      problem: `lifecycle ${r.lifecycle}, prefix ${r.prefix} declares ${PREFIX_LIFECYCLE[r.prefix]}`,
      corrected: false,
    });
  }

  const removable = drift.missingBlobs.filter((m) => m.ageMs > GRACE_MS);

  const result: NightlyResult = {
    ranAt: now.toISOString(),
    truncated: false,
    drift,
    orphans: {
      total: drift.orphanBlobs.length,
      firstSeen: newOrphans.length,
      // Still visible on every subsequent run, even though the event is not
      // written again. Stopping the writes must not mean stopping the noticing.
      standing: drift.orphanBlobs.length - newOrphans.length,
    },
    recovered: drift.landedReservations.length,
    rowsRemoved: removable.length,
    sizesCorrected: drift.sizeDisagreements.length,
    inconsistencies,
    lastSeenTouched: 0,
    applied: apply,
  };

  if (!apply) return result;

  // ---- the writes ------------------------------------------------------

  // The backstop first: a landed reservation should become a fact before
  // anything else reasons about what is and is not recorded.
  for (const landedRes of drift.landedReservations) {
    const blob = providerByPath.get(landedRes.pathname)!;
    await recordActualByPathname(
      { pathname: landedRes.pathname, url: blob.url, sizeInBytes: blob.size },
      // THE REFUSAL, not overridable. recordActual can reach deleteObject when a
      // reproducible asset landed larger than its reservation; this argument is
      // what makes "reconciliation cannot delete a blob" true rather than claimed.
      REFUSE_TO_DELETE,
    ).catch(async (error) => {
      // A refusal is not a failure of the run. It is the safety property
      // working, and it has already recorded itself.
      await recordEvent({
        pathname: landedRes.pathname,
        storeId: null,
        kind: "reconciled_orphan",
        actor: "reconciliation",
        reason: `could not record a landed reservation: ${error instanceof Error ? error.message : String(error)}`,
        providerBytes: blob.size,
      });
      return null;
    });
  }

  for (const m of removable) {
    const row = byPathname.get(m.pathname)!;
    await prismaSystem.storageObject.delete({ where: { id: row.id } });
    await recordEvent({
      pathname: m.pathname,
      storeId: row.storeId,
      kind: "reconciled_missing",
      sizeInBytes: row.sizeInBytes,
      lifecycle: row.lifecycle,
      actor: "reconciliation",
      reason: "the provider no longer lists this object; the bytes are not there",
      // So a removed row is reconstructable without reading the sentence.
      previousStoreId: row.storeId,
      previousAttribution: row.attribution,
    });
  }

  for (const d of drift.sizeDisagreements) {
    const row = byPathname.get(d.pathname)!;
    await prismaSystem.storageObject.update({
      where: { id: row.id },
      data: { sizeInBytes: d.actual },
    });
    await recordEvent({
      pathname: d.pathname,
      storeId: row.storeId,
      kind: "size_corrected",
      sizeInBytes: d.actual,
      lifecycle: row.lifecycle,
      actor: "reconciliation",
      reason: `recorded ${d.recorded}, provider reports ${d.actual}; the provider wins`,
      previousBytes: d.recorded,
      providerBytes: d.actual,
    });
  }

  for (const r of ownerWithNoStore) {
    await prismaSystem.storageObject.update({
      where: { id: r.id },
      data: { attribution: "unattributed" },
    });
    await recordEvent({
      pathname: r.pathname,
      storeId: null,
      kind: "reattributed",
      sizeInBytes: r.sizeInBytes,
      lifecycle: r.lifecycle,
      actor: "reconciliation",
      reason:
        "the store this claimed to belong to no longer exists; the foreign key had already " +
        "cleared storeId, so the ownership claim was left pointing at nobody",
      previousStoreId: null,
      previousAttribution: "owner",
    });
  }

  for (const orphan of newOrphans) {
    await recordEvent({
      pathname: orphan.pathname,
      storeId: null,
      kind: "reconciled_orphan",
      sizeInBytes: orphan.size,
      lifecycle: PREFIX_LIFECYCLE[orphan.prefix] ?? null,
      actor: "reconciliation",
      reason: `a blob with no ledger row, prefix ${orphan.prefix}. Reported, not removed and not adopted`,
      providerBytes: orphan.size,
    });
  }

  const seen = rows
    .filter((r) => r.uploadedAt !== null && providerByPath.has(r.pathname))
    .map((r) => r.id);
  if (seen.length > 0) {
    await prismaSystem.storageObject.updateMany({
      where: { id: { in: seen } },
      data: { lastSeenAt: now },
    });
  }
  result.lastSeenTouched = seen.length;

  return result;
}

// ---------------------------------------------------------------------------
// The weekly sweep
// ---------------------------------------------------------------------------

export interface SweepDeps {
  /** Hosts to anchor the scan on — from the provider listing. */
  hosts: string[];
  /** Injected so the nightly pass can be proven never to call it. */
  derive?: (hosts: string[]) => Promise<AttributionScan>;
  apply?: boolean;
}

export interface SweepResult {
  columnsScanned: number;
  columnsSkipped: string[];
  promoted: number;
  /** Evidence now names a different store. Surfaced, never applied. */
  ownerChanged: { pathname: string; from: string | null; to: string }[];
  /** An owner whose last reference vanished. Counted, never acted on. */
  ownerReferenceGone: number;
  applied: boolean;
}

/**
 * The expensive pass: re-derive attribution from the whole schema.
 *
 * Runs weekly, behind its own flag. Only ever moves toward MORE knowledge —
 * unattributed or ambiguous becomes owner when exactly one live store
 * references it, and nothing else is written.
 */
export async function runAttributionSweep(deps: SweepDeps): Promise<SweepResult> {
  const apply = deps.apply ?? false;
  const derive = deps.derive ?? ((hosts: string[]) => deriveAttribution(prismaSystem, hosts));

  const scan = await derive(deps.hosts);
  const liveStoreIds = new Set(
    (await prismaSystem.store.findMany({ select: { id: true } })).map((s) => s.id),
  );

  const rows = await prismaSystem.storageObject.findMany({
    where: { uploadedAt: { not: null } },
    select: {
      id: true, pathname: true, url: true, storeId: true, attribution: true,
      lifecycle: true, sizeInBytes: true,
    },
  });

  const ownerChanged: SweepResult["ownerChanged"] = [];
  let ownerReferenceGone = 0;
  let promoted = 0;

  for (const row of rows) {
    if (!row.url) continue;
    const candidates = candidatesFor(scan, row.url, liveStoreIds);

    if (row.attribution === "owner") {
      // NOT A DEMOTION. Deleting a product does not transfer its photograph:
      // the file is still that business's, sitting in that business's store.
      if (candidates.length === 0) {
        ownerReferenceGone++;
        continue;
      }
      // A change of hands needs a person, not a cron.
      if (candidates.length === 1 && candidates[0] !== row.storeId) {
        ownerChanged.push({ pathname: row.pathname, from: row.storeId, to: candidates[0] });
      }
      continue;
    }

    // unattributed or ambiguous: the only direction re-attribution may run.
    if (candidates.length !== 1) continue;
    promoted++;
    if (!apply) continue;

    const where = scan.evidence.get(row.url.split("?")[0]) ?? "an unnamed column";
    await prismaSystem.storageObject.update({
      where: { id: row.id },
      data: { storeId: candidates[0], attribution: "owner" },
    });
    await recordEvent({
      pathname: row.pathname,
      storeId: candidates[0],
      kind: "reattributed",
      sizeInBytes: row.sizeInBytes,
      lifecycle: row.lifecycle,
      actor: "reconciliation",
      reason: `${row.attribution} -> owner, referenced by ${where}`,
      previousStoreId: row.storeId,
      previousAttribution: row.attribution,
    });
  }

  return {
    columnsScanned: scan.columnsScanned,
    columnsSkipped: scan.columnsSkipped,
    promoted,
    ownerChanged,
    ownerReferenceGone,
    applied: apply,
  };
}
