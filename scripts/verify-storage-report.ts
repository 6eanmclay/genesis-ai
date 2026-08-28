import {
  urlsIn,
  storedUrlMatcher,
  canonicalUrl,
  referencesFrom,
  prefixOf,
  summarise,
  humanBytes,
} from "@/lib/storage/references";

// WHAT STILL POINTS AT A FILE:
//
//   npx tsx scripts/verify-storage-report.ts
//
// ============ WHY THIS IS TESTED BEFORE ANYTHING DELETES (2026-08-28) ===
//
// Sean: "Before deleting a blob, Genesis should determine whether anything
// still references it. If something does, don't delete it."
//
// Nothing deletes yet, and this is the reason it is safe to build the report
// first: the walker below is the thing a future deletion will trust, so it is
// worth being right before it has consequences rather than after.
//
// The asymmetry drives every case here. A file wrongly called REFERENCED
// survives and wastes bytes. A file wrongly called UNREFERENCED is a product
// with no picture, a storefront with a broken tile, or a design that cannot be
// reopened. So the tests that matter most are the ones proving a URL buried
// somewhere nobody would think to look is still found.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const A = "https://blob.test/assets/a.png";
const B = "https://blob.test/printfiles/b.png";
const C = "https://blob.test/mockups/c.png";
const SUPPLIER = "https://files.cdn.printful.com/blank.png";

function main(): void {
  const isStored = storedUrlMatcher([A, B, C]);

  // ======================================================================
  console.log("\n=== 1. A reference is found wherever it is buried ===\n");
  // ======================================================================
  //
  // richContent, designSpec and BusinessRecord.data are open JSON that features
  // add to — the asset-library work added four URL-bearing fields in a single
  // commit. A check that listed field names would fall behind the first time
  // somebody stored a URL somewhere new, and would do it silently.

  eq("a plain string", urlsIn(A, isStored), [A]);
  eq("a field on an object", urlsIn({ imageUrl: A }, isStored), [A]);
  eq("inside an array", urlsIn({ printFileUrls: [A, B] }, isStored), [A, B]);
  eq("deeply nested, where a design keeps its layers",
    urlsIn({ placement: { placements: { front: [{ assetUrl: A }], back: [{ assetUrl: B }] } } }, isStored),
    [A, B]);
  eq("CONTROL: and a supplier's own CDN is not counted as ours",
    urlsIn({ blanks: { front: SUPPLIER } }, isStored), []);
  eq("CONTROL: nor is a string that merely looks like a URL",
    urlsIn({ note: "https://blob.test/assets/deleted-long-ago.png" }, isStored), []);

  // ======================================================================
  console.log("\n=== 2. A query string does not make it a different file ===\n");
  // ======================================================================
  //
  // A download token or a cache-buster on a stored reference still points at
  // the same object. Treating the two as different strings is exactly how a
  // referenced file gets reported as unreferenced — and then deleted.

  eq("the token is dropped", canonicalUrl(`${A}?download=1`), A);
  eq("and a bare URL is unchanged", canonicalUrl(A), A);

  const refs = referencesFrom(
    [{ kind: "product", id: "p1", values: [{ imageUrl: `${A}?v=2` }] }],
    storedUrlMatcher([A]),
  );
  assert("a reference with a query string still matches the stored object", refs.has(A),
    "this is the case that would silently delete a live product image");

  // ======================================================================
  console.log("\n=== 3. The report says where each reference came from ===\n");
  // ======================================================================

  const found = referencesFrom(
    [
      { kind: "store", id: "s1", values: [{ logoUrl: A }] },
      { kind: "product", id: "p9", values: [{ imageUrl: B }] },
    ],
    isStored,
  );
  eq("the brand logo is attributed to the store", found.get(A)?.source, "store:s1");
  eq("and a print file to its product", found.get(B)?.source, "product:p9");

  // ======================================================================
  console.log("\n=== 4. Usage is grouped the way somebody decides by ===\n");
  // ======================================================================

  const objects = [
    { pathname: "assets/a.png", url: A, size: 500 },
    { pathname: "printfiles/b.png", url: B, size: 300 },
    { pathname: "mockups/c.png", url: C, size: 200 },
  ];
  const usage = summarise(objects, new Set([A]));

  eq("the total is the total", usage.totalBytes, 1000);
  eq("counted", usage.totalCount, 3);
  eq("what is still needed", usage.referencedBytes, 500);
  eq("and what is not", usage.unreferencedBytes, 500);
  eq("biggest prefix first, because that is what gets deleted",
    usage.byPrefix.map((p) => p.prefix), ["assets", "printfiles", "mockups"]);

  const printfiles = usage.byPrefix.find((p) => p.prefix === "printfiles");
  eq("an unreferenced print file is counted as reclaimable", printfiles?.unreferencedBytes, 300);
  eq("CONTROL: and a referenced asset is not",
    usage.byPrefix.find((p) => p.prefix === "assets")?.unreferencedBytes, 0);

  eq("a folder is read off the path", prefixOf("printfiles/x.png"), "printfiles");
  eq("CONTROL: and a loose file is not invented into one", prefixOf("stray.png"), "(root)");

  // ======================================================================
  console.log("\n=== 5. Bytes read as a person reads them ===\n");
  // ======================================================================

  eq("small", humanBytes(512), "512 B");
  eq("kilobytes", humanBytes(2048), "2.0 KB");
  eq("megabytes", humanBytes(5 * 1024 * 1024), "5.0 MB");
  eq("and the number that matters here", humanBytes(1024 * 1024 * 1024), "1.0 GB");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
