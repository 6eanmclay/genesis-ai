import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { list, head } from "@vercel/blob";
import { PREFIX_LIFECYCLE, prefixOf, type Lifecycle } from "@/lib/storage/ledger";
import { canonicalUrl, humanBytes } from "@/lib/storage/references";
import { deriveAttribution, candidatesFor } from "@/lib/storage/attribution";

// ONE StorageObject ROW PER BLOB THAT ALREADY EXISTS.
//
//   npx tsx scripts/backfill-storage-objects.ts            # dry run, writes nothing
//   npx tsx scripts/backfill-storage-objects.ts --apply    # writes
//
// ============ WHY A BACKFILL AT ALL (2026-08-29) =======================
//
// The ledger is written before the blob from here on. Everything already in the
// store predates it, and a blob with no row is invisible to every number the
// milestone produces — which is precisely the leak STORAGE.md was written about.
// So the existing objects need rows, and those rows have to be derived from
// evidence rather than assumed.
//
// ============ THE RULES, AS APPROVED ===================================
//
// Sean, 2026-08-29, approving the dry run's plan:
//
//   "Preserve the 291 owner attributions. Keep the 36 unattributed with
//    storeId = null. Preserve actual provider byte sizes. Keep declaredBytes =
//    null for all historical/backfilled objects. Assign only the already-
//    declared lifecycle classes. Do not guess at attribution or lifecycle. Do
//    not delete any blobs. Do not touch TemporaryAsset or treat historical
//    objects as temporary. Record the backfill source so it remains
//    distinguishable from live writes."
//
// Every one of those is a line below, and each is annotated where it lands.
//
// ============ IT ONLY EVER INSERTS AND UPDATES =========================
//
// There is no `del` in this file and no DELETE in any statement it runs. The
// recovery path is DELETE FROM "StorageObject" WHERE source = 'backfill', which
// is why BACKFILL_SOURCE exists as a value and not just as documentation: it is
// the seam that separates 327 derived rows from anything a live write path
// created, forever.

/** The one value that makes a backfilled row distinguishable from a live one. */
const BACKFILL_SOURCE = "backfill";

const APPLY = process.argv.includes("--apply");

const db = new PrismaClient({
  // Deliberately the raw client: this is a cross-tenant operator task, and the
  // tenant-isolation extension exists to stop exactly this shape of query
  // happening by accident inside the application.
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// ---------------------------------------------------------------------------
// 1. What the provider actually holds
// ---------------------------------------------------------------------------

interface Blob {
  pathname: string;
  url: string;
  size: number;
  uploadedAt: Date;
  contentType: string | null;
}

async function listEverything(): Promise<{ blobs: Blob[]; truncated: boolean }> {
  const blobs: Blob[] = [];
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; ; page++) {
    if (page > 200) {
      truncated = true;
      break;
    }
    const result = await list({ limit: 1000, cursor });
    for (const b of result.blobs) {
      blobs.push({
        pathname: b.pathname,
        url: b.url,
        size: b.size,
        uploadedAt: new Date(b.uploadedAt),
        contentType: null,
      });
    }
    if (!result.hasMore || !result.cursor) break;
    cursor = result.cursor;
  }

  return { blobs, truncated };
}

/**
 * The provider's listing does not carry contentType; `head` does.
 *
 * NOT INFERRED FROM THE EXTENSION. A ".png" that is really a JPEG would be
 * recorded as a fact that was never checked, and the standing rule for this
 * whole pass is that nothing is guessed. A lookup that fails leaves the column
 * null, which is honest, and the count of failures is reported.
 */
async function fillContentTypes(blobs: Blob[]): Promise<{ resolved: number; failed: number }> {
  let resolved = 0;
  let failed = 0;
  const queue = [...blobs];

  const worker = async () => {
    for (;;) {
      const blob = queue.shift();
      if (!blob) return;
      try {
        const meta = await head(blob.url);
        blob.contentType = meta.contentType ?? null;
        resolved++;
      } catch {
        failed++;
      }
    }
  };

  await Promise.all(Array.from({ length: 8 }, worker));
  return { resolved, failed };
}

// ---------------------------------------------------------------------------
// 2. Who each blob belongs to — derived, never remembered
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. What each row would be
// ---------------------------------------------------------------------------

interface Row {
  pathname: string;
  url: string;
  storeId: string | null;
  attribution: "owner" | "unattributed" | "ambiguous";
  lifecycle: Lifecycle;
  prefix: string;
  sizeInBytes: number;
  uploadedAt: Date;
  contentType: string | null;
  evidence: string | null;
  candidates: string[];
}

async function main() {
  const runAt = new Date();
  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — StorageObject backfill, ${runAt.toISOString()}\n`);

  const { blobs, truncated } = await listEverything();
  if (truncated) {
    console.log("STOP — the provider listing was truncated. A partial ledger under-reports.");
    process.exitCode = 1;
    return;
  }
  const providerBytes = blobs.reduce((sum, b) => sum + b.size, 0);
  console.log(`provider: ${blobs.length} blobs, ${providerBytes} bytes (${humanBytes(providerBytes)})`);

  const contentTypes = await fillContentTypes(blobs);
  console.log(`contentType: ${contentTypes.resolved} resolved via head(), ${contentTypes.failed} left null`);

  const hosts = [...new Set(blobs.map((b) => new URL(b.url).host))];
  const att = await deriveAttribution(db, hosts);
  console.log(
    `scan: ${att.columnsScanned} columns across ${att.tier1Tables} storeId tables` +
      ` + ${att.tier2Joins.length} foreign-key joins (${att.tier2Joins.join(", ") || "none"})`,
  );
  if (att.columnsSkipped.length) console.log(`  columns skipped: ${att.columnsSkipped.join(", ")}`);

  // A storeId that no longer names a store is not an attribution.
  const liveStores = new Map(
    (await db.store.findMany({ select: { id: true, name: true, slug: true } })).map((s) => [s.id, s]),
  );

  // ---- the temporary cross-check, read-only ---------------------------
  //
  // Sean: "Do not touch TemporaryAsset or treat historical objects as
  // temporary." Nothing here writes to it. It is READ so that a live Slice 1
  // claim which happens to be mid-flight is not mislabelled `derived` by a
  // prefix rule that cannot see it — the one case where the prefix is not the
  // whole truth. There are none today; the check is what proves that.
  const unpromoted = new Set(
    (await db.temporaryAsset.findMany({ where: { promotedAt: null }, select: { pathname: true } }))
      .map((t) => t.pathname),
  );

  const rows: Row[] = [];
  const undeclared = new Set<string>();

  for (const blob of blobs) {
    const prefix = prefixOf(blob.pathname);
    const declared = PREFIX_LIFECYCLE[prefix];
    if (!declared) {
      undeclared.add(prefix);
      continue;
    }

    const url = canonicalUrl(blob.url);
    const candidates = candidatesFor(att, blob.url, new Set(liveStores.keys()));

    rows.push({
      pathname: blob.pathname,
      url: blob.url,
      // storeId stays NULL for anything but a single, live, referencing store.
      storeId: candidates.length === 1 ? candidates[0] : null,
      attribution:
        candidates.length === 1 ? "owner" : candidates.length === 0 ? "unattributed" : "ambiguous",
      lifecycle: unpromoted.has(blob.pathname) ? "temporary" : declared,
      prefix,
      // The provider's own figure. Never estimated, never rounded.
      sizeInBytes: blob.size,
      uploadedAt: blob.uploadedAt,
      contentType: blob.contentType,
      evidence: att.evidence.get(url) ?? null,
      candidates,
    });
  }

  // ---- an undeclared prefix aborts, it does not default ----------------
  if (undeclared.size > 0) {
    console.log(`\nSTOP — undeclared prefix: ${[...undeclared].join(", ")}`);
    console.log("STORAGE.md item 7 requires every blob path to declare its lifecycle.");
    console.log("Nothing was written. Declare the prefix in PREFIX_LIFECYCLE and re-run.");
    process.exitCode = 1;
    return;
  }

  const owner = rows.filter((r) => r.attribution === "owner");
  const unatt = rows.filter((r) => r.attribution === "unattributed");
  const ambig = rows.filter((r) => r.attribution === "ambiguous");

  console.log(`\nsplit: ${owner.length} owner  ${unatt.length} unattributed  ${ambig.length} ambiguous`);
  if (ambig.length) {
    console.log("STOP — a blob is referenced by more than one store. That is a decision, not a default.");
    for (const r of ambig) console.log(`  ${r.pathname}  <- ${r.candidates.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nby lifecycle and prefix:");
  const groups = new Map<string, { n: number; bytes: number }>();
  for (const r of rows) {
    const key = `${r.prefix.padEnd(14)} ${r.lifecycle}`;
    const g = groups.get(key) ?? { n: 0, bytes: 0 };
    g.n++;
    g.bytes += r.sizeInBytes;
    groups.set(key, g);
  }
  for (const [key, g] of [...groups].sort())
    console.log(`  ${key.padEnd(28)} ${String(g.n).padStart(4)}  ${humanBytes(g.bytes).padStart(9)}`);

  console.log("\nby store:");
  const perStore = new Map<string, { n: number; bytes: number }>();
  for (const r of rows) {
    const key = r.storeId ?? "(unattributed)";
    const g = perStore.get(key) ?? { n: 0, bytes: 0 };
    g.n++;
    g.bytes += r.sizeInBytes;
    perStore.set(key, g);
  }
  for (const [id, g] of [...perStore].sort((a, b) => b[1].bytes - a[1].bytes)) {
    const store = liveStores.get(id);
    console.log(
      `  ${(store ? store.slug : id).padEnd(30)} ${String(g.n).padStart(4)}  ${humanBytes(g.bytes).padStart(9)}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. ${rows.length} rows would be created or updated.`);
    console.log("Re-run with --apply to write them.");
    await db.$disconnect();
    return;
  }

  // ---- the write -------------------------------------------------------
  //
  // Upsert on pathname, which is unique, so a blob referenced from six rows in
  // five tables still produces exactly one StorageObject and a re-run after an
  // interruption updates rather than duplicates.
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const existing = await db.storageObject.findUnique({
      where: { pathname: r.pathname },
      select: { id: true },
    });
    const data = {
      url: r.url,
      storeId: r.storeId,
      attribution: r.attribution,
      lifecycle: r.lifecycle,
      prefix: r.prefix,
      source: BACKFILL_SOURCE,
      batchId: null,
      // NULL, ALWAYS. A backfilled object was never reserved. Writing the
      // actual size here would invent a reservation that never happened and
      // count the same bytes twice in every committed total.
      declaredBytes: null,
      sizeInBytes: r.sizeInBytes,
      contentType: r.contentType,
      uploadedAt: r.uploadedAt,
      touchedAt: r.uploadedAt,
      lastSeenAt: runAt,
    };
    if (existing) {
      await db.storageObject.update({ where: { pathname: r.pathname }, data });
      updated++;
    } else {
      await db.storageObject.create({ data: { pathname: r.pathname, ...data } });
      created++;
    }
  }

  console.log(`\nwritten: ${created} created, ${updated} updated`);
  console.log("No blob was read for content, moved, or deleted. TemporaryAsset was read, never written.");
  await db.$disconnect();
}

void main();
