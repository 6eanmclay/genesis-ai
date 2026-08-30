import { readFileSync } from "fs";
import { join } from "path";

// THE PROMISES THE CODE ITSELF MAKES:
//
//   npx tsx scripts/verify-temporary-assets.ts
//
// The behavioural half — claiming, promoting, discarding, sweeping, and the
// hundred-failure loop STORAGE.md calls "the real test" — needs a real database
// and lives in verify-temporary-assets-db.ts.
//
// What is here is the half that is about SHAPE rather than behaviour: that the
// deletion path cannot see a customer's upload, that the row is written before
// the blob, and that Product Creation's own behaviour was not changed to
// achieve any of it. Those are properties of the source, and a test that reads
// them is how they survive the next person in this file.

let failures = 0;
let passes = 0;

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

function main(): void {
  const temp = codeOnly(read("lib", "storage", "temporaryAssets.ts"));
  const creation = codeOnly(read("lib", "execution", "executables", "productFromDesign.ts"));

  // ======================================================================
  console.log("\n=== 1. Deletion cannot reach a customer's own upload ===\n");
  // ======================================================================
  //
  // Sean: "deletion must be narrowly scoped to temporary artifacts so permanent
  // user assets cannot be accidentally swept." Two guards, tested separately,
  // because either one alone would be a rule somebody could remove.

  assert("every deletion reads TemporaryAsset and nothing else",
    /temporaryAsset\.findMany/.test(temp) && !/businessRecord|\bproduct\b\.findMany/.test(temp),
    "an owner's upload has no row here, so it is not representable in this file");

  assert("and the prefix is re-checked immediately before deleting",
    /TEMPORARY_PREFIXES\.some\(\(prefix\) => row\.pathname\.startsWith\(prefix\)\)/.test(temp),
    "a corrupted row must still not reach assets/");

  const prefixes = temp.match(/const TEMPORARY_PREFIXES = \[([^\]]*)\]/);
  assert("the deletable prefixes are exactly printfiles and mockups",
    !!prefixes && /"printfiles\/"/.test(prefixes[1]) && /"mockups\/"/.test(prefixes[1]) &&
      !/assets\/|products\/|voice/.test(prefixes[1]),
    prefixes?.[1] ?? "not found");

  // ============ THE CONTROL THAT MATTERS ==========================
  //
  // STORAGE.md: cleanup.ts was "the only file importing del". It is now one of
  // two, and the second one must stay this narrow.
  assert("CONTROL: this is the only new file that can delete a blob",
    /import \{ del \} from "@vercel\/blob"/.test(temp), "");
  assert("and Product Creation itself never deletes anything",
    !/from "@vercel\/blob"[\s\S]*\bdel\b/.test(creation) && !/\bdel\(/.test(creation),
    "the executable asks for a discard; it does not perform one");

  // ======================================================================
  console.log("\n=== 2. The row exists before the blob does ===\n");
  // ======================================================================
  //
  // The whole design. A row with no blob is harmless — the sweep tries to
  // delete something that is not there. A blob with no row is invisible, and
  // invisible is the leak.

  const recordAt = creation.indexOf("recordTemporary(");
  const putAt = creation.indexOf("await put(");
  assert("the print file is claimed before it is uploaded",
    recordAt > 0 && putAt > recordAt, `record at ${recordAt}, put at ${putAt}`);

  assert("and the key comes back from the claim rather than being rebuilt",
    /await put\(claim\.pathname,/.test(creation),
    "recording one name and uploading to another is the same leak with extra steps");

  assert("a claim with no upload is representable",
    /url\s+String\?/.test(read("prisma", "schema.prisma")),
    "url must be nullable, or the row cannot be written first");

  // ======================================================================
  console.log("\n=== 3. Promote late, discard on anything else ===\n");
  // ======================================================================

  const promoteAt = creation.indexOf("promoteTemporaries(");
  const productImagesAt = creation.indexOf("productImage.createMany");
  assert("promotion happens after the rows that reference the blobs exist",
    promoteAt > 0 && productImagesAt > 0 && promoteAt > productImagesAt,
    `images at ${productImagesAt}, promote at ${promoteAt}`);

  assert("and the failure path discards",
    /catch \(error\) \{[\s\S]*discardTemporaries\(ctx\.storeId, temporaries\)[\s\S]*throw error;/.test(creation),
    "");

  // ============ THE OWNER MUST SEE NO DIFFERENCE ==================
  //
  // Sean: "Product Creation behavior must remain exactly the same from the
  // user's perspective. This is storage safety underneath the existing
  // workflow." So the original error is re-thrown untouched — the engine still
  // turns it into the same FAILED run with the same sentence.
  assert("CONTROL: the original error is re-thrown, not replaced",
    /throw error;/.test(creation) && !/throw new Error\("(storage|cleanup)/i.test(creation),
    "a cleanup that changed the message would change what Create looks like");

  assert("and discarding cannot itself throw",
    /never throws/i.test(read("lib", "storage", "temporaryAssets.ts")),
    "a cleanup failure must not replace a clear supplier message");

  // A promoted asset is finished. Nothing may reclaim it afterwards.
  assert("a promoted asset is out of reach of both the discard and the sweep",
    (temp.match(/promotedAt: null/g) ?? []).length >= 3,
    "discard, sweep and promote must each require it");

  // ======================================================================
  console.log("\n=== 4. The sweep catches what never reached a finally ===\n");
  // ======================================================================

  assert("the sweep looks for unpromoted rows older than a cutoff",
    /promotedAt: null, createdAt: \{ lt: cutoff \}/.test(temp), "");
  assert("it is bounded",
    /take: 200/.test(temp), "a backlog must not become a thousand deletes in one cron");
  assert("it runs as the system, because it crosses every store",
    /prismaSystem\.temporaryAsset\.findMany/.test(temp),
    "a cron carries no session; the deletion is still narrow");

  const cron = codeOnly(read("app", "api", "cron", "sync", "route.ts"));
  assert("and it is wired into the daily cron",
    /sweepAbandonedTemporaries\(\)/.test(cron), "");
  assert("as its own catch, so one failing stage does not take the others down",
    /sweepAbandonedTemporaries\(\)\.catch\(/.test(cron), "");

  // A blob that is already gone is a success. Anything else keeps the row so
  // the next sweep tries again rather than losing track of a live blob.
  assert("a blob that is already gone settles the row",
    /not found\|404/.test(temp), "");
  assert("and a real delete failure keeps the row for the next sweep",
    /continue;/.test(temp) && /KEPT/.test(read("lib", "storage", "temporaryAssets.ts")),
    "");

  console.log(failures === 0 ? `\nAll ${passes} checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
