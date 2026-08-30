import {
  summariseOwnerStorage,
  usageSentence,
  LIFECYCLE_LABELS,
  EMPTY_STORAGE_MESSAGE,
  type OwnerStorage,
  type OwnerStorageCategory,
} from "@/lib/storage/ownerStorage";
import { PREFIX_LIFECYCLE } from "@/lib/storage/ledger";

// WHAT AN OWNER IS TOLD ABOUT THEIR STORAGE:
//
//   npx tsx scripts/verify-owner-storage.ts
//
// Pure — no database, no provider, no clock. The isolation half (that one
// business never sees another's bytes, and that the unattributed reach nobody)
// needs real rows and lives in verify-owner-storage-db.ts.

// ===========================================================================
// THE TYPE-LEVEL PROHIBITION
// ===========================================================================
//
// Sean, 2026-08-30: "Keep the owner-facing type completely free of
// allowanceBytes, remainingBytes, percentUsed, plan, or equivalent entitlement
// fields. They must be absent, not nullable."
//
// Absent is the whole point. A nullable allowanceBytes is a field a screen can
// render, and "it was null so I showed 0 of 0" is a bug somebody writes in good
// faith next year. So the prohibition is enforced by the COMPILER, not by this
// file's runtime assertions and not by anyone remembering the conversation.
//
// Adding any of these keys back to OwnerStorage or OwnerStorageCategory makes
// `npx tsc` fail on the lines below, before a test is ever run.

type EntitlementField =
  | "allowanceBytes"
  | "remainingBytes"
  | "percentUsed"
  | "plan"
  | "planName"
  | "limit"
  | "limitBytes"
  | "quota"
  | "quotaBytes"
  | "percentOfLimit"
  | "capacity"
  | "capacityBytes"
  | "includedStorageBytes";

/** Compiles only when T is `never` — i.e. when the intersection is empty. */
type MustBeEmpty<T extends never> = T;

// If either line stops compiling, an entitlement field has returned.
type _OwnerStorageIsClean = MustBeEmpty<Extract<keyof OwnerStorage, EntitlementField>>;
type _CategoryIsClean = MustBeEmpty<Extract<keyof OwnerStorageCategory, EntitlementField>>;

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const KB = 1024;
const MB = 1024 * 1024;
const file = (lifecycle: string, sizeInBytes: number | null) => ({ lifecycle, sizeInBytes });

function main(): void {
  console.log("\n--- the sentence ---\n");
  {
    const s = summariseOwnerStorage([
      ...Array.from({ length: 46 }, () => file("permanent", 3_675_000)),
      ...Array.from({ length: 21 }, () => file("derived", 100_000)),
    ]);
    eq("file count is every landed object", s.fileCount, 67);
    assert("the sentence names bytes and files and nothing else",
      /^Using [\d.]+ (B|KB|MB|GB) across 67 files\.$/.test(usageSentence(s)), usageSentence(s));
    assert("it contains no denominator", !usageSentence(s).includes(" of "), usageSentence(s));
    assert("and no percentage", !usageSentence(s).includes("%"), usageSentence(s));
  }
  {
    const s = summariseOwnerStorage([file("permanent", 1234)]);
    assert("one file is singular", usageSentence(s).endsWith("across 1 file."), usageSentence(s));
  }

  console.log("\n--- the empty state, exactly as approved ---\n");
  {
    const s = summariseOwnerStorage([]);
    assert("an empty business is empty", s.empty);
    eq("the words are exact", usageSentence(s), "Nothing stored yet.");
    eq("and the constant says the same", EMPTY_STORAGE_MESSAGE, "Nothing stored yet.");
    eq("with no categories to render", s.categories, []);
    eq("and honest zeroes behind it", [s.totalBytes, s.fileCount], [0, 0]);
  }
  {
    // A ZERO-BYTE FILE IS STILL A FILE. Measuring emptiness in bytes would tell
    // an owner "Nothing stored yet" while a file of theirs sits in the library.
    const s = summariseOwnerStorage([file("permanent", 0)]);
    assert("a business holding one empty file is NOT empty", !s.empty);
    assert("and is told so", usageSentence(s) !== EMPTY_STORAGE_MESSAGE, usageSentence(s));
    eq("its count is honest", s.fileCount, 1);
  }

  console.log("\n--- categories are the ledger's lifecycles, in words ---\n");
  {
    const s = summariseOwnerStorage([
      file("permanent", 10 * MB),
      file("permanent", 5 * MB),
      file("derived", 2 * MB),
    ]);
    eq("one entry per lifecycle in use", s.categories.map((c) => c.lifecycle), ["permanent", "derived"]);
    eq("labelled for a person, never the raw word", s.categories.map((c) => c.label),
      ["Your photos and files", "Files Genesis can recreate"]);
    eq("counts and bytes are per category", s.categories.map((c) => [c.fileCount, c.bytes]),
      [[2, 15 * MB], [1, 2 * MB]]);
    eq("ordered by size", s.categories[0].bytes > s.categories[1].bytes, true);
    assert("no category carries a denominator",
      s.categories.every((c) => !("allowanceBytes" in c) && !("percentUsed" in c)));
  }
  {
    const s = summariseOwnerStorage([file("permanent", 1), file("derived", 0)]);
    eq("a lifecycle with files but no bytes is still shown", s.categories.map((c) => c.lifecycle), ["permanent", "derived"]);
  }
  {
    const s = summariseOwnerStorage([file("permanent", 1)]);
    eq("a lifecycle with nothing in it is not shown at all", s.categories.length, 1);
  }

  console.log("\n--- the mirrored registry between labels and lifecycles ---\n");
  {
    // ARCHITECTURE.md's standing invariant. LIFECYCLE_LABELS mirrors the values
    // of PREFIX_LIFECYCLE, and the compiler cannot check it — a lifecycle added
    // there without a label here renders an internal word on a customer's
    // screen.
    const inUse = [...new Set(Object.values(PREFIX_LIFECYCLE))].sort();
    const missing = inUse.filter((l) => !LIFECYCLE_LABELS[l]);
    eq("every lifecycle the ledger can write has a human label", missing, []);
    assert("and every label is written for a person, not for a sweep",
      Object.values(LIFECYCLE_LABELS).every((l) => /^[A-Z]/.test(l) && l.includes(" ")),
      JSON.stringify(LIFECYCLE_LABELS));
  }
  {
    // An unlabelled lifecycle must still be counted. Dropping it would make the
    // categories disagree with the total the owner is reading.
    const s = summariseOwnerStorage([file("permanent", 100), file("brand-new-class", 50)]);
    eq("an unknown lifecycle falls back to its raw name rather than vanishing",
      s.categories.map((c) => c.label).includes("brand-new-class"), true);
    eq("and its bytes are still in the total", s.totalBytes, 150);
  }

  console.log("\n--- sizes and the rounding boundary ---\n");
  {
    // The boundary that already bit me once: humanBytes drops to whole numbers
    // at 100, so a total near it must still be internally consistent.
    for (const [bytes, expected] of [
      [0, "0 B"], [1, "1 B"], [1023, "1023 B"], [1024, "1.0 KB"],
      [99 * MB, "99.0 MB"], [100 * MB, "100 MB"], [1024 * MB, "1.0 GB"],
    ] as const) {
      const s = summariseOwnerStorage([file("permanent", bytes)]);
      eq(`${bytes} bytes renders as ${expected}`, s.totalHuman, expected);
    }
  }
  {
    const s = summariseOwnerStorage([file("permanent", 700 * KB), file("permanent", 400 * KB)]);
    eq("the raw total is exact even where the display rounds", s.totalBytes, 1_126_400);
  }
  {
    // A file we hold but never measured. It counts as a file; its unknown size
    // adds nothing rather than being invented.
    const s = summariseOwnerStorage([file("permanent", null), file("permanent", 500)]);
    eq("an unmeasured file still counts as a file", s.fileCount, 2);
    eq("but contributes no bytes", s.totalBytes, 500);
    eq("and its category counts it too", s.categories[0].fileCount, 2);
  }

  console.log("\n--- nothing entitlement-shaped survives serialisation ---\n");
  {
    const s = summariseOwnerStorage([file("permanent", 226 * MB), file("derived", 2 * MB)]);
    const json = JSON.stringify(s);
    for (const word of ["allowance", "remaining", "percent", "quota", "limit", "plan", "of 5", "GB of"]) {
      assert(`the owner payload contains no "${word}"`, !json.toLowerCase().includes(word.toLowerCase()), json);
    }
    eq("its keys are exactly the five approved",
      Object.keys(s).sort(), ["categories", "empty", "fileCount", "totalBytes", "totalHuman"]);
    eq("and a category's keys are exactly the five approved",
      Object.keys(s.categories[0]).sort(), ["bytes", "fileCount", "human", "label", "lifecycle"]);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
