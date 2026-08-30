import { prismaSystem } from "@/lib/prisma";
import { humanBytes } from "./references";
import { compareToProvider, type Drift, type LedgerRow, type ProviderObject } from "./drift";

// WHAT THE LEDGER KNOWS, FOR AN OPERATOR.
//
// ============ WHY THIS EXISTS BESIDE report.ts (2026-08-30) ============
//
// Sean: "Build the operator storage view now using the ledger rather than the
// provider scan."
//
// buildStorageReport answers a different and slower question: it lists every
// blob and re-sweeps every text and JSON column in the schema to find what
// still references each one. That is the right tool for deciding what is safe
// to DELETE, and it stays exactly as it is.
//
// This answers "what does the ledger believe, and is it right" — two indexed
// aggregates and, optionally, one provider listing. It is the everyday view;
// the scan is the deep one. Keeping both is deliberate: the scan is what would
// catch something the ledger has never heard of, and a report that could only
// ask the ledger could never discover that it was wrong about the world.
//
// ============ READ ONLY, AND STRUCTURALLY SO ==========================
//
// There is no `del` import here and no write of any kind — not to StorageObject,
// not to StorageEvent. Drift is REPORTED. Correcting it is reconciliation's job,
// and reconciliation is a script an operator runs deliberately, not a side
// effect of looking at a page.
//
// ============ AND IT DOES NOT SPEAK ABOUT ALLOWANCES ==================
//
// Sean, 2026-08-30: "Do not decide or imply that planless stores are entitled to
// 5 GB. Keep the existing Starter fallback strictly as internal capacity
// arithmetic until we make an explicit product decision about planless storage."
//
// So there is no allowance, no remaining, and no percentage anywhere in this
// file — not even for an operator, because a number that exists gets quoted.
// `planName` is reported as the plain fact it is: the plan the store is actually
// on, which today is null for all sixteen.

export interface StoreStorageLine {
  storeId: string;
  slug: string;
  name: string;
  /** The plan the store is genuinely on. Null is the honest answer, not a gap. */
  planName: string | null;
  objects: number;
  bytes: number;
  human: string;
  /** permanent / derived / temporary / platform, as counted. */
  byLifecycle: { lifecycle: string; objects: number; bytes: number; human: string }[];
  /** Rows reserved but not yet landed. Not counted in `bytes`. */
  reservations: { objects: number; declaredBytes: number };
}

export interface LedgerStorageReport {
  source: "ledger";
  generatedAt: string;
  platform: {
    objects: number;
    bytes: number;
    human: string;
    landed: number;
    reservations: number;
  };
  stores: StoreStorageLine[];
  /**
   * Bytes that belong to no business we can name.
   *
   * Reported to an operator and to nobody else. Attributing them to a store
   * would invent ownership; dividing them between stores would invent it twice.
   */
  unattributed: {
    objects: number;
    bytes: number;
    human: string;
    byPrefix: { prefix: string; objects: number; bytes: number; human: string }[];
  };
  /** Null when the caller did not ask — it costs a provider listing. */
  drift: (Drift & { human: { provider: string; ledger: string; delta: string } }) | null;
  notes: string[];
}

/** Everything the report needs from one row, in one query. */
const ROW_SELECT = {
  id: true,
  pathname: true,
  storeId: true,
  attribution: true,
  lifecycle: true,
  prefix: true,
  sizeInBytes: true,
  declaredBytes: true,
  uploadedAt: true,
  touchedAt: true,
} as const;

/**
 * How the provider listing is obtained.
 *
 * INJECTABLE FOR THE SAME REASON EmailSender AND BlobDeleter ARE. The real
 * implementation lives behind `import "server-only"`, which cannot resolve
 * under tsx — so a statically-imported one would make this whole module
 * untestable by the harness, and an untestable report is one nobody can prove
 * reports the truth. The default is loaded lazily, and only when drift is
 * actually requested.
 */
export type ListObjects = () => Promise<{ objects: ProviderObject[]; truncated: boolean }>;

async function defaultListObjects(): Promise<{ objects: ProviderObject[]; truncated: boolean }> {
  const { vercelBlobStorage } = await import("./vercelBlob");
  const listing = await vercelBlobStorage.list();
  return {
    objects: listing.objects.map((o) => ({ pathname: o.pathname, url: o.url, size: o.size })),
    truncated: listing.truncated,
  };
}

export async function buildLedgerStorageReport(
  opts: { includeDrift?: boolean; listObjects?: ListObjects } = {},
): Promise<LedgerStorageReport> {
  const notes: string[] = [];

  // Cross-tenant by necessity and by design: blob storage is one namespace for
  // the whole deployment, and the question "who is using what" cannot be
  // answered from inside a single tenant. That is why the route above this is
  // restricted to a platform administrator — see report.ts's own note.
  const rows = (await prismaSystem.storageObject.findMany({ select: ROW_SELECT })) as LedgerRow[];

  const landed = rows.filter((r) => r.uploadedAt !== null);
  const reservations = rows.filter((r) => r.uploadedAt === null);

  const stores = await prismaSystem.store.findMany({
    select: { id: true, slug: true, name: true, plan: { select: { name: true } } },
  });

  const lines: StoreStorageLine[] = [];
  for (const store of stores) {
    const mine = landed.filter((r) => r.storeId === store.id);
    const held = reservations.filter((r) => r.storeId === store.id);

    const byLifecycle = new Map<string, { objects: number; bytes: number }>();
    for (const row of mine) {
      const entry = byLifecycle.get(row.lifecycle) ?? { objects: 0, bytes: 0 };
      entry.objects++;
      entry.bytes += row.sizeInBytes ?? 0;
      byLifecycle.set(row.lifecycle, entry);
    }

    const bytes = mine.reduce((s, r) => s + (r.sizeInBytes ?? 0), 0);
    lines.push({
      storeId: store.id,
      slug: store.slug,
      name: store.name,
      // The plan it is ACTUALLY on. No fallback is applied or reported here.
      planName: store.plan?.name ?? null,
      objects: mine.length,
      bytes,
      human: humanBytes(bytes),
      byLifecycle: [...byLifecycle.entries()]
        .map(([lifecycle, v]) => ({ lifecycle, ...v, human: humanBytes(v.bytes) }))
        .sort((a, b) => b.bytes - a.bytes),
      reservations: {
        objects: held.length,
        declaredBytes: held.reduce((s, r) => s + (r.declaredBytes ?? 0), 0),
      },
    });
  }
  lines.sort((a, b) => b.bytes - a.bytes);

  // ---- the ones nobody owns -------------------------------------------
  const orphaned = landed.filter((r) => r.storeId === null);
  const byPrefix = new Map<string, { objects: number; bytes: number }>();
  for (const row of orphaned) {
    const entry = byPrefix.get(row.prefix) ?? { objects: 0, bytes: 0 };
    entry.objects++;
    entry.bytes += row.sizeInBytes ?? 0;
    byPrefix.set(row.prefix, entry);
  }
  const unattributedBytes = orphaned.reduce((s, r) => s + (r.sizeInBytes ?? 0), 0);

  const platformBytes = landed.reduce((s, r) => s + (r.sizeInBytes ?? 0), 0);

  // ---- drift, only when asked ------------------------------------------
  let drift: LedgerStorageReport["drift"] = null;
  if (opts.includeDrift) {
    const listing = await (opts.listObjects ?? defaultListObjects)();
    if (listing.truncated) {
      // A partial listing would report every unseen blob as a missing row. Said
      // out loud rather than folded into the numbers.
      notes.push(
        "The provider listing stopped at its ceiling, so the drift below is not the whole store " +
          "and its missing-blob list is unreliable.",
      );
    }
    const compared = compareToProvider(listing.objects, rows);
    drift = {
      ...compared,
      human: {
        provider: humanBytes(compared.provider.bytes),
        ledger: humanBytes(compared.ledger.bytes),
        delta: humanBytes(Math.abs(compared.provider.bytes - compared.ledger.bytes)),
      },
    };
    if (compared.orphanBlobs.length > 0) {
      // THE DEPLOY GAP, NAMED. Production code has no ledger writes yet, so
      // every blob it writes lands with no row. Without this note the number
      // reads as a leak, and a monitor that cries leak on day one gets ignored.
      notes.push(
        `${compared.orphanBlobs.length} blob(s) have no ledger row. Until the ledger write paths ` +
          `are deployed, a blob written by production lands unclaimed — so this count measures the ` +
          `deploy gap rather than a leak. Nothing was created or deleted for them.`,
      );
    }
  }

  notes.push(
    "Read-only. This report writes nothing and cannot delete — correcting drift is " +
      "scripts/reconcile-storage.ts, which an operator runs deliberately.",
  );
  notes.push(
    "No storage allowance appears here. The planless fallback is internal capacity " +
      "arithmetic and is not a product decision yet.",
  );

  return {
    source: "ledger",
    generatedAt: new Date().toISOString(),
    platform: {
      objects: rows.length,
      bytes: platformBytes,
      human: humanBytes(platformBytes),
      landed: landed.length,
      reservations: reservations.length,
    },
    stores: lines,
    unattributed: {
      objects: orphaned.length,
      bytes: unattributedBytes,
      human: humanBytes(unattributedBytes),
      byPrefix: [...byPrefix.entries()]
        .map(([prefix, v]) => ({ prefix, ...v, human: humanBytes(v.bytes) }))
        .sort((a, b) => b.bytes - a.bytes),
    },
    drift,
    notes,
  };
}
