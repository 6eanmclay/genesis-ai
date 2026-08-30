import { randomUUID } from "crypto";
import { del } from "@vercel/blob";
import { prisma, prismaSystem } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";
import { resolveAllowance } from "./allowance";
import { summariseOwnerStorage, type OwnedObject, type OwnerStorage } from "./ownerStorage";

// THE LEDGER — one row per blob, written before the blob.
//
// ============ WHAT IT REPLACES ========================================
//
// Answering "how much is this business using?" meant listing every blob in the
// platform and re-scanning the whole schema for references. Fine for an
// operator report; useless on a page load, and impossible for a preflight that
// must answer before an upload starts.
//
// ============ THE RESERVATION IS A CEILING ============================
//
// Sean, 2026-08-29: "declared bytes create a reservation against available
// capacity, and that reservation is a hard authorization ceiling for the upload
// batch. An upload must not silently cause a store to exceed its available
// allocation simply because the declared size was inaccurate."
//
// So overage is PREVENTED at three layers rather than detected afterwards:
//
//   1. admission        — a batch that does not fit never starts (here)
//   2. provider ceiling — each upload token carries that file's declared size
//                         as maximumSizeInBytes, so Vercel itself refuses an
//                         oversize file and the bytes never land
//   3. server-side puts — the buffer's length is known before upload, so it is
//                         checked without writing
//
// Layer 4, in `recordActual` below, exists only because "should be unreachable"
// describes every leak STORAGE.md found before it was measured.
//
// ============ NO SOFT DELETE ==========================================
//
// A row for a blob that is gone is a second thing to reconcile. The row is
// removed and a StorageEvent records what happened. This and cleanup.ts and
// temporaryAssets.ts are the only files that import `del`.

/** How long a reservation holds space with no activity on its batch. */
export const RESERVATION_TTL_MS = 30 * 60 * 1000;

/**
 * Whether a reservation may REFUSE, as opposed to merely record.
 *
 * ============ ACCOUNTING IS ON; ENFORCEMENT IS NOT (2026-08-29) =========
 *
 * Sean: "Do not enable quota enforcement yet." Every write path below still
 * reserves, still records, and still reports — the ledger is complete. What is
 * dark is the single decision to say no.
 *
 * It is one flag rather than an absence of code on purpose. The alternative —
 * wiring the accounting now and the refusal later — means the refusal path
 * would ship unexercised, which is the state every leak in STORAGE.md started
 * from. Here it is written, tested, and switched off, so enabling it is a
 * config change against code that has already been proven to work.
 *
 * When it is off, a batch that WOULD have been refused is still admitted and
 * still reported through reportIssue, so the size of the problem is measurable
 * before anybody is told no.
 */
export function storageEnforcementEnabled(): boolean {
  return process.env.STORAGE_ENFORCEMENT === "on";
}

export type Lifecycle = "permanent" | "derived" | "temporary" | "platform";

/** STORAGE.md §6 — every prefix Genesis writes, and what it is. */
export const PREFIX_LIFECYCLE: Record<string, Lifecycle> = {
  "assets/": "permanent",
  "products/": "permanent",
  "designs/": "derived",
  "printfiles/": "derived",
  "mockups/": "derived",
  "voice-memos/": "permanent",
  "voice-turns/": "temporary",
};

/** Derived assets are reproducible; permanent ones are not. The whole of §6. */
export function isReproducible(lifecycle: string): boolean {
  return lifecycle === "derived" || lifecycle === "temporary";
}

export function prefixOf(pathname: string): string {
  const i = pathname.indexOf("/");
  return i === -1 ? "(root)" : pathname.slice(0, i + 1);
}

/** Deletion is injectable for the same reason it is in Slice 1 — see there. */
export type BlobDeleter = (url: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface Usage {
  /** Bytes actually stored. Always the real recorded figure. */
  usedBytes: number;
  /** Bytes held by live reservations that have not landed yet. */
  reservedBytes: number;
  /** What the allowance is measured against. */
  committedBytes: number;
  /**
   * NULL WHEN IT COULD NOT BE RESOLVED. Never a zero and never a guess — a
   * zero would read as "no space at all", which is the opposite of what an
   * unconfigured allowance means. See resolveAllowance.
   */
  allowanceBytes: number | null;
  remainingBytes: number | null;
  /**
   * True only when a KNOWN allowance is genuinely exceeded. An unknown
   * allowance cannot be exceeded, so this stays false and nothing is refused.
   */
  overAllocated: boolean;
}

/**
 * What a store is using, and what is left.
 *
 * ONE INDEXED QUERY PER TERM, no provider call. `usedBytes` is the actual
 * recorded size and nothing else — Sean: "Owner-facing usage must always
 * reflect the actual recorded bytes."
 */
export async function usageFor(storeId: string, now: Date = new Date()): Promise<Usage> {
  const fresh = new Date(now.getTime() - RESERVATION_TTL_MS);

  const [stored, reserved, allowance] = await Promise.all([
    prisma.storageObject.aggregate({
      where: { storeId, uploadedAt: { not: null } },
      _sum: { sizeInBytes: true },
    }),
    prisma.storageObject.aggregate({
      // Live reservations only: not yet uploaded, and the batch has been
      // touched inside the window. Expiry runs from touchedAt, not createdAt,
      // so a slow hundred-file batch is not cut off mid-upload.
      where: { storeId, uploadedAt: null, touchedAt: { gt: fresh } },
      _sum: { declaredBytes: true },
    }),
    resolveAllowance(storeId),
  ]);

  const usedBytes = stored._sum.sizeInBytes ?? 0;
  const reservedBytes = reserved._sum.declaredBytes ?? 0;
  const committedBytes = usedBytes + reservedBytes;
  return {
    usedBytes,
    reservedBytes,
    committedBytes,
    allowanceBytes: allowance.bytes,
    remainingBytes: allowance.bytes === null ? null : Math.max(0, allowance.bytes - committedBytes),
    // Measured on what is REALLY stored, not on committed — a store is not
    // over-allocated because somebody is mid-upload. And an unknown allowance
    // is not an exceeded one.
    overAllocated: allowance.bytes !== null && usedBytes > allowance.bytes,
  };
}

/**
 * What one business has stored, for that business to read.
 *
 * ============ THREE FILTERS, EACH LOAD-BEARING (2026-08-30) ============
 *
 *   storeId: storeId       — tenant-scoped through `prisma`, so the isolation
 *                            extension guards it as it guards everything else.
 *                            An owner cannot be shown another business's bytes.
 *   storeId is never null  — the 36 unattributed objects belong to nobody we
 *                            can name. This query cannot reach them, so the sum
 *                            of every owner view is genuinely less than the
 *                            platform total. That is correct, not a rounding gap.
 *   uploadedAt: not null   — a reservation is a promise, not a file. Counting
 *                            one would show a number that SHRINKS when the
 *                            upload succeeds, which is the opposite of what an
 *                            owner would reasonably expect.
 *
 * It returns bytes and lifecycles and nothing else — no allowance is read here,
 * because there is nothing on this path that could want one.
 */
export async function ownedObjects(storeId: string): Promise<OwnedObject[]> {
  return prisma.storageObject.findMany({
    where: { storeId, uploadedAt: { not: null } },
    select: { lifecycle: true, sizeInBytes: true },
  });
}

/** The owner-facing summary for one business. */
export async function storageForOwner(storeId: string): Promise<OwnerStorage> {
  return summariseOwnerStorage(await ownedObjects(storeId));
}

// ---------------------------------------------------------------------------
// Reserving
// ---------------------------------------------------------------------------

export interface ReservationRequest {
  /** The unique part of the key. The prefix supplies the rest. */
  name: string;
  prefix: string;
  source: string;
  declaredBytes: number;
  contentType?: string;
}

export type ReservationOutcome =
  | { ok: true; batchId: string; reservations: { id: string; pathname: string; declaredBytes: number }[] }
  | { ok: false; reason: "would_exceed"; usage: Usage; batchBytes: number }
  | { ok: false; reason: "over_allocated"; usage: Usage; batchBytes: number };

/**
 * Authorise a batch, or refuse it before a single byte moves.
 *
 * ============ THE LOCK, AND EXACTLY WHERE IT IS ======================
 *
 * Sean: "The lock must exist only around the database reservation transaction
 * and must never span a network/blob call."
 *
 * It does not. `SELECT … FOR UPDATE` on the store row runs inside one short
 * transaction that reads two sums and inserts rows — no upload, no provider
 * call, nothing that can block on a network. Without it two simultaneous
 * batches read the same committed total, both pass, and the second discovers
 * the truth half way through: the failure this whole milestone exists to end.
 *
 * ============ WHAT THE SUITE DOES AND DOES NOT PROVE ==================
 *
 * verify-storage-ledger-db asserts that two overlapping batches admit exactly
 * one. It passes with this lock REMOVED, so it does not prove the lock — and
 * that is recorded here rather than left to be discovered by whoever deletes
 * the line. Two things mask it in the harness: inserting a StorageObject takes
 * a FOR KEY SHARE lock on its Store row for the foreign key, so a second
 * transaction blocks at insert time regardless; and the pooled client appears
 * to serialise the two interactive transactions anyway.
 *
 * The lock is kept because it is the correct shape for a read-modify-write
 * against a shared total, not because a test caught its absence. Proving it
 * needs genuine parallelism against a pooled Postgres — a load-shaped test this
 * harness cannot express today.
 */
export async function reserveBatch(
  storeId: string,
  files: ReservationRequest[],
  now: Date = new Date(),
  opts: { enforce?: boolean } = {},
): Promise<ReservationOutcome> {
  const enforce = opts.enforce ?? storageEnforcementEnabled();
  const batchBytes = files.reduce((sum, f) => sum + Math.max(0, f.declaredBytes), 0);
  const batchId = randomUUID();
  const fresh = new Date(now.getTime() - RESERVATION_TTL_MS);
  const allowance = await resolveAllowance(storeId);

  return prisma.$transaction(async (tx) => {
    // The lock. Serialises admission for this store and nothing else.
    await tx.$queryRawUnsafe(`SELECT id FROM "Store" WHERE id = $1 FOR UPDATE`, storeId);

    const [stored, reserved] = await Promise.all([
      tx.storageObject.aggregate({
        where: { storeId, uploadedAt: { not: null } },
        _sum: { sizeInBytes: true },
      }),
      tx.storageObject.aggregate({
        where: { storeId, uploadedAt: null, touchedAt: { gt: fresh } },
        _sum: { declaredBytes: true },
      }),
    ]);

    const usedBytes = stored._sum.sizeInBytes ?? 0;
    const reservedBytes = reserved._sum.declaredBytes ?? 0;
    const committedBytes = usedBytes + reservedBytes;
    const usage: Usage = {
      usedBytes,
      reservedBytes,
      committedBytes,
      allowanceBytes: allowance.bytes,
      remainingBytes: allowance.bytes === null ? null : Math.max(0, allowance.bytes - committedBytes),
      overAllocated: allowance.bytes !== null && usedBytes > allowance.bytes,
    };

    // ============ FAIL OPEN ON CONFIGURATION ========================
    //
    // An allowance nobody configured is OUR problem, not the merchant's, and
    // refusing here would stop them creating products because of a missing row
    // in our own plan table. resolveAllowance has already reported it loudly.
    // The rows are still written, so accounting continues and the backlog is
    // measurable the moment the configuration is fixed.
    //
    // A KNOWN allowance still fails closed, immediately below.
    if (allowance.bytes !== null) {
      // Already over, from a previous overage that was kept rather than
      // deleted. The next upload is what refuses — see recordActual.
      const wouldRefuse = usage.overAllocated
        ? ("over_allocated" as const)
        : committedBytes + batchBytes > allowance.bytes
          ? ("would_exceed" as const)
          : null;

      if (wouldRefuse && enforce) {
        return { ok: false as const, reason: wouldRefuse, usage, batchBytes };
      }
      if (wouldRefuse) {
        // ENFORCEMENT IS OFF. Admitted anyway, and said out loud — the point of
        // running the check before it can refuse is to learn how often it
        // would, on real traffic, before an owner is ever told no.
        reportIssue(
          `storage would have refused a ${batchBytes}-byte batch for ${storeId} (${wouldRefuse})`,
          null,
          { subsystem: "storage", stage: "ledger.enforcementOff", storeId },
        );
      }
    }

    const reservations: { id: string; pathname: string; declaredBytes: number }[] = [];
    for (const file of files) {
      const pathname = `${file.prefix}${file.name}`;
      const row = await tx.storageObject.create({
        data: {
          pathname,
          storeId,
          attribution: "owner",
          lifecycle: PREFIX_LIFECYCLE[file.prefix] ?? "permanent",
          prefix: file.prefix,
          source: file.source,
          batchId,
          declaredBytes: Math.max(0, file.declaredBytes),
          contentType: file.contentType ?? null,
        },
        select: { id: true, pathname: true, declaredBytes: true },
      });
      reservations.push({ ...row, declaredBytes: row.declaredBytes ?? 0 });
    }

    return { ok: true as const, batchId, reservations };
  });
}

/** A single write with a known size — the server-side `put` case. */
export async function reserveOne(
  storeId: string,
  file: ReservationRequest,
  now: Date = new Date(),
  opts: { enforce?: boolean } = {},
): Promise<ReservationOutcome> {
  return reserveBatch(storeId, [file], now, opts);
}

/** Split a full key back into the two halves a reservation is built from. */
export function splitPathname(pathname: string): { prefix: string; name: string } {
  const cut = pathname.indexOf("/");
  return cut === -1
    ? { prefix: "(root)", name: pathname }
    : { prefix: pathname.slice(0, cut + 1), name: pathname.slice(cut + 1) };
}

/**
 * Reserve a key the BROWSER chose, before its upload token is issued.
 *
 * ============ WHY THE ROUTE RESERVES, NOT THE NINE CLIENTS =============
 *
 * Nine call sites across eight components upload straight to the provider, all
 * through two token routes. Putting the reservation in the clients would mean
 * nine places that each have to remember to do it, and the tenth — written next
 * month by someone who copied the eighth — is the bypass this whole slice
 * exists to close. The routes are the only door, so the lock goes on the door.
 *
 * ============ THE CEILING IS DERIVED, NOT DECLARED =====================
 *
 * A client-declared size is a number from the least trustworthy participant in
 * the exchange. This grants the route's own already-enforced per-kind maximum
 * instead, and hands that same figure to the provider as maximumSizeInBytes —
 * so the ceiling is enforced by Vercel, on bytes it is refusing to accept,
 * rather than by us after they have landed.
 *
 * The cost is that a reservation holds the maximum rather than the actual size
 * until the upload lands. That is the conservative direction, it lasts only
 * until recordActual replaces it with the truth, and it expires on its own
 * after RESERVATION_TTL_MS if the upload never happens at all.
 */
export async function reserveClientUpload(
  storeId: string,
  input: { pathname: string; source: string; ceilingBytes: number; contentType?: string },
  now: Date = new Date(),
): Promise<{ id: string; pathname: string; ceilingBytes: number }> {
  // A retry of the same upload reuses its reservation rather than colliding
  // with it — pathname is unique, and a second row for one blob is the
  // double-count the ledger is built to make impossible.
  const existing = await prismaSystem.storageObject.findUnique({
    where: { pathname: input.pathname },
    select: { id: true, uploadedAt: true, storeId: true },
  });
  if (existing && existing.uploadedAt === null && existing.storeId === storeId) {
    await prismaSystem.storageObject.update({
      where: { id: existing.id },
      data: { touchedAt: now, declaredBytes: input.ceilingBytes },
    });
    return { id: existing.id, pathname: input.pathname, ceilingBytes: input.ceilingBytes };
  }

  const { prefix, name } = splitPathname(input.pathname);
  const outcome = await reserveOne(
    storeId,
    { name, prefix, source: input.source, declaredBytes: input.ceilingBytes, contentType: input.contentType },
    now,
  );
  if (!outcome.ok) {
    // Only reachable with enforcement ON. The caller decides what to tell the
    // owner; the ledger's job was to know.
    throw new StorageRefusedError(outcome.reason, outcome.usage.allowanceBytes);
  }
  const row = outcome.reservations[0];
  return { id: row.id, pathname: row.pathname, ceilingBytes: row.declaredBytes };
}

/**
 * Give back space a reservation is holding for an upload that never happened.
 *
 * ONLY EVER AN UNLANDED ROW. The `uploadedAt: null` condition is the safety:
 * this can delete a promise, never a fact, so a mistaken call after a
 * successful upload removes nothing. No blob is touched — by definition there
 * is not one.
 */
export async function releaseReservation(id: string, storeId: string): Promise<boolean> {
  const { count } = await prismaSystem.storageObject.deleteMany({
    where: { id, storeId, uploadedAt: null },
  });
  return count > 0;
}

export class StorageRefusedError extends Error {
  constructor(
    readonly reason: "would_exceed" | "over_allocated",
    readonly allowanceBytes: number | null,
  ) {
    super(
      reason === "over_allocated"
        ? "This business is over its storage allowance."
        : "There isn't enough storage left for this upload.",
    );
    this.name = "StorageRefusedError";
  }
}

/**
 * A blob that belongs to no business, because there is not one yet.
 *
 * ============ THE PRE-STORE PATH IS REAL (2026-08-29) ==================
 *
 * GenesisModelScope is a union: { storeId } OR { userId } OR an anonymous
 * token. Onboarding generates product and logo imagery from `{ userId }`,
 * before any Store row exists — four live call sites in app/onboarding.
 *
 * That is a genuine conflict with a per-store reservation model, and the wrong
 * resolutions are both tempting: attribute it to a store that does not exist,
 * or leave the path unwired and keep a hole in the ledger. Neither is
 * acceptable — the first invents attribution, the second is the leak.
 *
 * So the row is written with no store and `unattributed`, which is exactly the
 * representation the backfill already uses for the 36 objects nobody could
 * place. Nothing is charged to anyone. And when onboarding finishes, the URL
 * lands on the new Store's own record, which is a reference — so the next
 * reconciliation promotes it to that owner through the ordinary evidence path,
 * with no special case anywhere.
 */
export async function recordUnattributed(input: {
  pathname: string;
  url: string;
  sizeInBytes: number;
  source: string;
  contentType?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const { prefix } = splitPathname(input.pathname);
  const lifecycle = PREFIX_LIFECYCLE[prefix];
  if (!lifecycle) {
    // An undeclared prefix is STORAGE.md item 7's whole concern. Recorded as
    // permanent — the class that is never automatically deleted — and reported,
    // because guessing "derived" here would make an unknown file reclaimable.
    reportIssue(`stored ${input.pathname} under an undeclared prefix`, null, {
      subsystem: "storage",
      stage: "ledger.undeclaredPrefix",
    });
  }
  await prismaSystem.storageObject.upsert({
    where: { pathname: input.pathname },
    create: {
      pathname: input.pathname,
      url: input.url,
      storeId: null,
      attribution: "unattributed",
      lifecycle: lifecycle ?? "permanent",
      prefix,
      source: input.source,
      declaredBytes: null,
      sizeInBytes: input.sizeInBytes,
      contentType: input.contentType ?? null,
      uploadedAt: now,
      touchedAt: now,
      lastSeenAt: now,
    },
    update: { url: input.url, sizeInBytes: input.sizeInBytes, uploadedAt: now, touchedAt: now },
  });
}

/**
 * Record a landed upload found by its key rather than its reservation id.
 *
 * The webhook that tells us a client upload finished knows the pathname; the
 * reconciliation backstop that notices a landed upload nobody told us about
 * knows only the pathname too. Both funnel here so there is one place where a
 * reservation becomes a fact.
 */
export async function recordActualByPathname(
  input: { pathname: string; url: string; sizeInBytes: number; contentType?: string },
  deleteBlob?: BlobDeleter,
): Promise<RecordOutcome | null> {
  const row = await prismaSystem.storageObject.findUnique({
    where: { pathname: input.pathname },
    select: { id: true, storeId: true },
  });
  if (!row) return null;
  if (!row.storeId) {
    // A storeless row is already a recorded fact, not a reservation.
    await prismaSystem.storageObject.update({
      where: { id: row.id },
      data: { url: input.url, sizeInBytes: input.sizeInBytes, uploadedAt: new Date() },
    });
    return { ok: true, overage: 0 };
  }
  return recordActual({ ...input, id: row.id, storeId: row.storeId }, deleteBlob);
}

// ---------------------------------------------------------------------------
// Completing
// ---------------------------------------------------------------------------

export type RecordOutcome =
  | { ok: true; overage: 0 }
  /** The blob landed larger than authorised, and is reproducible. Roll it back. */
  | { ok: false; action: "rolled_back"; overage: number }
  /** The blob landed larger than authorised and is the owner's. Kept. */
  | { ok: false; action: "kept_over_allocated"; overage: number };

/**
 * Record what the upload actually produced.
 *
 * ============ THE ACTUAL SIZE IS ALWAYS RECORDED ======================
 *
 * Sean: "Never under-record actual storage to make the numbers look healthy."
 * So the real figure is written first, before any decision about it. A ledger
 * that flatters itself is worse than no ledger.
 *
 * ============ AND THEN THE TWO ANSWERS ================================
 *
 * Layers 1-3 should make an overage unreachable. If one happens anyway:
 *
 *   derived   — rolled back. Delete the blob and the row, fail the operation.
 *               Safe precisely because a derived asset can be recomposed from
 *               the design, which is what STORAGE.md's organising principle buys.
 *   permanent — never deleted. It is the owner's file and Genesis cannot
 *               recreate it. Kept, counted, and the store becomes temporarily
 *               over-allocated; the NEXT upload is what refuses.
 *
 * Nothing is silent either way: an over_reservation event is written, and the
 * usage the owner sees is the true figure.
 */
export async function recordActual(
  input: { id: string; storeId: string; url: string; sizeInBytes: number; contentType?: string },
  deleteBlob?: BlobDeleter,
): Promise<RecordOutcome> {
  const row = await prisma.storageObject.findFirst({
    where: { id: input.id, storeId: input.storeId },
    select: { pathname: true, declaredBytes: true, lifecycle: true, batchId: true },
  });
  if (!row) {
    // No reservation. Recorded anyway rather than dropped — an unaccounted blob
    // is the one thing this file exists to prevent — and reported.
    reportIssue(`stored ${input.url} with no reservation row`, null, {
      subsystem: "storage",
      stage: "ledger.orphanWrite",
      storeId: input.storeId,
    });
    return { ok: true, overage: 0 };
  }

  const now = new Date();
  await prisma.storageObject.updateMany({
    where: { id: input.id, storeId: input.storeId },
    data: {
      url: input.url,
      sizeInBytes: input.sizeInBytes,
      uploadedAt: now,
      // The batch is alive: expiry runs from here.
      touchedAt: now,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    },
  });
  if (row.batchId) {
    await prisma.storageObject.updateMany({
      where: { batchId: row.batchId, uploadedAt: null },
      data: { touchedAt: now },
    });
  }

  const declared = row.declaredBytes ?? 0;
  const overage = input.sizeInBytes - declared;
  if (overage <= 0) return { ok: true, overage: 0 };

  await recordEvent({
    pathname: row.pathname,
    storeId: input.storeId,
    kind: "over_reservation",
    sizeInBytes: input.sizeInBytes,
    lifecycle: row.lifecycle,
    actor: "creation",
    reason: `landed ${input.sizeInBytes} bytes against a reservation of ${declared}`,
    // What was authorised, and what actually arrived.
    previousBytes: declared,
    providerBytes: input.sizeInBytes,
  });

  if (isReproducible(row.lifecycle)) {
    await deleteObject(
      { pathname: row.pathname, storeId: input.storeId },
      { actor: "creation", reason: "larger than the reservation authorised", deleteBlob },
    );
    return { ok: false, action: "rolled_back", overage };
  }

  // The owner's own file. Kept — see the note above.
  return { ok: false, action: "kept_over_allocated", overage };
}

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

export async function recordEvent(event: {
  pathname: string;
  storeId: string | null;
  kind: string;
  sizeInBytes?: number | null;
  lifecycle?: string | null;
  actor: string;
  reason: string;
  // ============ THE CORRECTION, AS DATA (2026-08-30) ================
  //
  // `reason` still says what happened in a sentence. These say it in columns,
  // because an operator asking "when did this store's usage change and by how
  // much" should be writing a query rather than parsing English. See the
  // per-kind table on the model.
  previousBytes?: number | null;
  providerBytes?: number | null;
  previousStoreId?: string | null;
  previousAttribution?: string | null;
}): Promise<void> {
  await prismaSystem.storageEvent.create({
    data: {
      pathname: event.pathname,
      storeId: event.storeId,
      kind: event.kind,
      sizeInBytes: event.sizeInBytes ?? null,
      lifecycle: event.lifecycle ?? null,
      actor: event.actor,
      reason: event.reason,
      previousBytes: event.previousBytes ?? null,
      providerBytes: event.providerBytes ?? null,
      previousStoreId: event.previousStoreId ?? null,
      previousAttribution: event.previousAttribution ?? null,
    },
  });
}

/**
 * Delete a blob and its row, and say so in the event log.
 *
 * Blob first, then row: the opposite order loses the only record of a blob that
 * still exists. A failed delete keeps the row so the next pass retries — the
 * rule Slice 1 already proved.
 */
export async function deleteObject(
  target: { pathname: string; storeId: string | null },
  opts: { actor: string; reason: string; deleteBlob?: BlobDeleter },
): Promise<boolean> {
  const remove = opts.deleteBlob ?? ((url: string) => del(url));
  const row = await prismaSystem.storageObject.findUnique({
    where: { pathname: target.pathname },
    select: {
      id: true, url: true, storeId: true, sizeInBytes: true, lifecycle: true, pathname: true,
      // Read because the event must carry it — after the delete there is
      // nowhere left to learn who this belonged to.
      attribution: true,
    },
  });
  if (!row) return false;
  // A caller that named a store must match it. A null store means the caller is
  // the system (reconciliation), which crosses tenants by design.
  if (target.storeId !== null && row.storeId !== target.storeId) return false;

  if (row.url) {
    try {
      await remove(row.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|404/i.test(message)) {
        reportIssue(`could not delete ${row.pathname}`, error, {
          subsystem: "storage",
          stage: "ledger.delete",
          storeId: row.storeId ?? undefined,
        });
        return false;
      }
    }
  }

  await recordEvent({
    pathname: row.pathname,
    storeId: row.storeId,
    kind: "deleted",
    sizeInBytes: row.sizeInBytes,
    lifecycle: row.lifecycle,
    actor: opts.actor,
    reason: opts.reason,
    // The row is about to stop existing. Its ownership survives here.
    previousStoreId: row.storeId,
    previousAttribution: row.attribution,
  });
  await prismaSystem.storageObject.delete({ where: { id: row.id } });
  return true;
}
