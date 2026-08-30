import { humanBytes } from "./references";

// WHAT A BUSINESS OWNER IS TOLD ABOUT THEIR OWN STORAGE.
//
// ============ THE DECISION THIS FILE ENFORCES (2026-08-30) =============
//
// Every store on the platform is on NO plan — sixteen of sixteen. The ledger
// borrows Starter's 5 GB when it needs a number for capacity arithmetic, and
// that borrowing is invisible and harmless while it stays internal.
//
// Shown to an owner, it stops being arithmetic. "226 MB of 5 GB" tells somebody
// they have five gigabytes. They do not: nobody has decided what a business
// without a plan is entitled to. And the billing screen says, today, in its own
// words, "[store] isn't on a plan yet" — so the allowance would put the product
// in the position of saying both things at once.
//
// Sean, 2026-08-30: "show usage only — no allowance, denominator, percentage,
// progress bar, or language implying a plan entitlement... Keep the existing
// Starter fallback strictly as internal capacity arithmetic until we make an
// explicit product decision about planless storage."
//
// ============ SO THE FIELDS ARE ABSENT, NOT NULL ======================
//
// A nullable allowanceBytes would be a field a future screen could render, and
// "it was null, so I showed 0 of 0" is a bug somebody would write in good faith
// a year from now. There is no such field on OwnerStorage. The compiler is what
// holds the decision, not anyone's memory of this conversation — and
// scripts/verify-owner-storage.ts asserts that at the type level, so adding one
// back fails to compile rather than failing review.
//
// ============ WHAT IS DELIBERATELY NOT COUNTED ========================
//
//   unattributed objects — 36 of them, 20.8 MB, belonging to nobody we can
//                          name. Showing them to a business would attribute
//                          them to it; splitting them between businesses would
//                          invent ownership twice. They reach an operator and
//                          nobody else, so the sum of every owner view is
//                          genuinely less than the platform total. By design.
//   live reservations    — a promise that bytes are coming, not a file that
//                          exists. An owner counting an in-flight upload would
//                          see a number that shrinks when the upload finishes.
//   platform totals      — no owner is shown what the platform holds.

/** One landed object, as this summary needs it. The whole input shape. */
export interface OwnedObject {
  lifecycle: string;
  sizeInBytes: number | null;
}

export interface OwnerStorageCategory {
  /** The ledger's own lifecycle value, unchanged. */
  lifecycle: string;
  /** That value, said to a person. */
  label: string;
  fileCount: number;
  bytes: number;
  human: string;
}

/**
 * Everything an owner is told.
 *
 * NOTE WHAT IS NOT HERE, and note that it is absent rather than nullable:
 * allowanceBytes, remainingBytes, percentUsed, plan, limit, quota. See the
 * header. verify-owner-storage.ts fails to compile if any of them returns.
 */
export interface OwnerStorage {
  totalBytes: number;
  totalHuman: string;
  fileCount: number;
  /** Only categories that actually hold something. */
  categories: OwnerStorageCategory[];
  /** True when this business has stored nothing at all. */
  empty: boolean;
}

/**
 * The lifecycle classes, named for the person who owns the files.
 *
 * ============ WHY THE DERIVED/PERMANENT SPLIT IS WORTH SHOWING =========
 *
 * It is the one distinction that means something to an owner rather than to a
 * sweep: a derived file can be made again from the design it came from, and a
 * permanent one cannot. That is exactly the fact somebody needs when they are
 * deciding what they could stand to lose — so the label says it plainly rather
 * than exposing the word "derived".
 *
 * A MIRRORED REGISTRY, and named as one. These keys mirror PREFIX_LIFECYCLE's
 * values in ledger.ts. A lifecycle added there without a label here would
 * render as a raw internal word on a customer's screen, so the suite
 * cross-checks the two rather than trusting them to stay in step —
 * ARCHITECTURE.md's standing invariant, in the place it actually applies.
 */
export const LIFECYCLE_LABELS: Record<string, string> = {
  permanent: "Your photos and files",
  derived: "Files Genesis can recreate",
  temporary: "Files still being worked on",
  platform: "Platform files",
};

/** The empty state, in the exact words approved. */
export const EMPTY_STORAGE_MESSAGE = "Nothing stored yet.";

/**
 * Summarise what a business has stored.
 *
 * PURE. No database, no provider, no clock — so every edge that matters can be
 * asserted without either: zero files, one zero-byte file, the byte boundary
 * where the human figure changes precision, and a lifecycle nobody has labelled.
 */
export function summariseOwnerStorage(objects: OwnedObject[]): OwnerStorage {
  const byLifecycle = new Map<string, { fileCount: number; bytes: number }>();
  for (const object of objects) {
    const entry = byLifecycle.get(object.lifecycle) ?? { fileCount: 0, bytes: 0 };
    entry.fileCount++;
    // A null size is a file we hold but never measured. Counted as a FILE
    // regardless — the count is of things that exist, and dropping it would
    // make the file count disagree with what the owner can see in their library.
    entry.bytes += object.sizeInBytes ?? 0;
    byLifecycle.set(object.lifecycle, entry);
  }

  const categories: OwnerStorageCategory[] = [...byLifecycle.entries()]
    // Only what holds something. A row of zeroes teaches an owner nothing.
    .filter(([, v]) => v.fileCount > 0)
    .map(([lifecycle, v]) => ({
      lifecycle,
      // An unlabelled lifecycle falls back to the raw value rather than being
      // dropped: showing an odd word is recoverable, and silently omitting
      // files from a total the owner is reading is not.
      label: LIFECYCLE_LABELS[lifecycle] ?? lifecycle,
      fileCount: v.fileCount,
      bytes: v.bytes,
      human: humanBytes(v.bytes),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));

  const totalBytes = objects.reduce((sum, o) => sum + (o.sizeInBytes ?? 0), 0);
  return {
    totalBytes,
    totalHuman: humanBytes(totalBytes),
    fileCount: objects.length,
    categories,
    // MEASURED ON FILES, NOT BYTES. A business holding one zero-byte file has
    // stored something; saying "Nothing stored yet" would be false.
    empty: objects.length === 0,
  };
}

/** "Using 226 MB across 67 files." — the sentence, built in one place. */
export function usageSentence(storage: OwnerStorage): string {
  if (storage.empty) return EMPTY_STORAGE_MESSAGE;
  const files = storage.fileCount === 1 ? "1 file" : `${storage.fileCount} files`;
  return `Using ${storage.totalHuman} across ${files}.`;
}
