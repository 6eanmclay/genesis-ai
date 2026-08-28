import sharp from "sharp";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { AssetSchema, type Asset } from "@/lib/businessModel/entities";
import { detectTransparency } from "@/lib/businessAssets/transparency";
import {
  libraryFrom,
  inLibrary,
  removedFromLibrary,
  restoredToLibrary,
} from "@/lib/creation/assetLibrary";

// THE CREATION STATION'S ASSET LIBRARY:
//
//   npx tsx scripts/verify-creation-asset-library.ts
//
// ============ THE DISTINCTION UNDER TEST ================================
//
// Sean: "J4's memory is the business brain. Creation Station is the creative
// workspace... Deleting an asset from Creation Station should not automatically
// mean deleting J4's underlying memory/knowledge of it."
//
// Until this, the Creation Station's picker WAS J4's memory queried for photos.
// So the tests that matter are not "does the list render" — they are about the
// two things now being separable, and about removal being non-destructive in a
// way that is structural rather than promised.
//
// The transparency half is tested against REAL PNG BYTES, generated here with
// sharp, because the whole point is that a file's extension lies. A fixture
// asserting `{hasTransparency: true}` would prove nothing about a decoder.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const asset = (over: Partial<Asset> = {}): Asset =>
  AssetSchema.parse({
    fileType: "photo",
    category: "unclassified",
    storageUrl: "https://blob.test/a.png",
    originalFilename: "a.png",
    summary: null,
    extractionConfidence: null,
    relatedRecordId: null,
    relatedEntityType: null,
    ...over,
  });

async function main() {
  await requireTestDatabase(prismaSystem);

  // ======================================================================
  console.log("\n=== 1. Uploaded assets appear in the Creation Station ===\n");
  // ======================================================================
  const uploaded = asset({ origin: "uploaded", originalFilename: "my-logo.png" });
  const generated = asset({ origin: "generated", storageUrl: "https://blob.test/g.png" });

  const shown = libraryFrom([
    { id: "r1", data: uploaded },
    { id: "r2", data: generated },
  ]);
  eq("an upload is in the library the moment it exists", shown.length, 2);
  assert("carrying its own name", shown[0].name === "my-logo.png", JSON.stringify(shown[0]));

  // ============ AND J4'S OWN ASSETS ARE STILL THERE ==================
  //
  // The library is a LENS over the same records, not a replacement for them —
  // so a generated asset from before any of this existed is in it too, with no
  // migration and no backfill.
  eq("J4's generated assets remain available",
    shown.filter((a) => a.origin === "generated").length, 1);
  const legacy = AssetSchema.parse({
    fileType: "photo",
    category: "unclassified",
    storageUrl: "https://blob.test/old.png",
    originalFilename: "old.png",
    summary: null,
    extractionConfidence: null,
    relatedRecordId: null,
    relatedEntityType: null,
    // No creationLibraryRemovedAt, no hasTransparency — an asset written
    // before the fields existed.
  });
  assert("an asset written before these fields is in the library",
    inLibrary(legacy), JSON.stringify(legacy));
  eq("CONTROL: and its transparency is 'never inspected', not false",
    legacy.hasTransparency, null);

  // ======================================================================
  console.log("\n=== 2. Removing hides it from the Creation Station ===\n");
  // ======================================================================
  const removed = removedFromLibrary(uploaded);
  assert("a removed asset is not in the library", !inLibrary(removed));
  eq("so the picker does not show it",
    libraryFrom([{ id: "r1", data: removed }, { id: "r2", data: generated }]).length, 1);

  // ======================================================================
  console.log("\n=== 3. Removing does not change J4's record ===\n");
  // ======================================================================
  //
  // The guarantee Sean asked for, checked field by field rather than asserted
  // in prose: everything except the one flag is byte-identical.
  const before = { ...uploaded } as Record<string, unknown>;
  const after = removed as unknown as Record<string, unknown>;
  const changed = Object.keys(before).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  eq("exactly one field changes", changed, ["creationLibraryRemovedAt"]);
  assert("the file itself is untouched", after.storageUrl === before.storageUrl);
  assert("and so are role, origin, relationships and supersession",
    after.role === before.role &&
      after.origin === before.origin &&
      after.relatedRecordId === before.relatedRecordId &&
      after.supersedesAssetId === before.supersedesAssetId &&
      after.supersededByAssetId === before.supersededByAssetId);

  // AND IT REALLY IS THE SAME ROW. Proven against the database rather than
  // against a copy — the record J4 reads is the record the library wrote to.
  const user = await prisma.user.create({
    data: { email: `assetlib-${Date.now()}@example.test`, name: "Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `assetlib-${Date.now()}`, tagline: "t", description: "d" },
  });
  const row = await prisma.businessRecord.create({
    data: {
      storeId: store.id,
      entityType: "asset",
      sourceProvider: "genesis_upload",
      externalId: uploaded.storageUrl,
      data: uploaded as unknown as object,
    },
  });

  await prisma.businessRecord.update({
    where: { id: row.id, storeId: store.id },
    data: { data: removedFromLibrary(uploaded) as unknown as object },
  });

  const reread = await prisma.businessRecord.findUnique({ where: { id: row.id } });
  assert("the record still exists after removal", reread !== null);
  eq("with its entityType intact", reread?.entityType, "asset");
  const rereadData = reread?.data as unknown as Asset;
  eq("and J4 can still see the file", rereadData.storageUrl, uploaded.storageUrl);
  assert("only the library flag moved", rereadData.creationLibraryRemovedAt !== null);
  eq("CONTROL: the business still has exactly one asset record",
    await prisma.businessRecord.count({ where: { storeId: store.id, entityType: "asset" } }), 1);

  // ======================================================================
  console.log("\n=== 4. Removal is reversible ===\n");
  // ======================================================================
  const restored = restoredToLibrary(removed);
  assert("a restored asset is in the library again", inLibrary(restored));
  eq("and is byte-identical to before it was removed",
    JSON.stringify(restored), JSON.stringify(uploaded));

  await prisma.businessRecord.update({
    where: { id: row.id, storeId: store.id },
    data: { data: restoredToLibrary(rereadData) as unknown as object },
  });
  const back = await prisma.businessRecord.findUnique({ where: { id: row.id } });
  eq("in the database too", (back?.data as unknown as Asset).creationLibraryRemovedAt, null);

  // ======================================================================
  console.log("\n=== 5-7. Transparency is measured from real pixels ===\n");
  // ======================================================================
  //
  // Sean: "Do not infer transparency from the file extension or MIME type. A
  // PNG can have a completely opaque background."
  //
  // Both of these are PNGs. One has an alpha channel that is opaque
  // everywhere, which is exactly the case a MIME check gets wrong.
  const opaquePng = await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const transparentPng = await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
        })
          .png()
          .toBuffer(),
        top: 10,
        left: 10,
      },
    ])
    .png()
    .toBuffer();

  // A JPEG has no alpha channel at all — the cheap definite case.
  const jpeg = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .jpeg()
    .toBuffer();

  eq("an opaque PNG has no transparency", await detectTransparency(opaquePng), false);
  eq("a genuinely transparent PNG has transparency", await detectTransparency(transparentPng), true);
  eq("a JPEG has none", await detectTransparency(jpeg), false);

  // THE CONTROL THAT MATTERS. Both files are image/png; one of them is opaque.
  // Anything keying off the extension or the MIME type answers the same for
  // both, and would be wrong about exactly one.
  const opaqueMeta = await sharp(opaquePng).metadata();
  assert("CONTROL: and the opaque one still HAS an alpha channel",
    opaqueMeta.hasAlpha === true,
    "metadata().hasAlpha is the check that would have gotten this wrong");
  assert("CONTROL: so hasAlpha and real transparency genuinely disagree here",
    opaqueMeta.hasAlpha === true && (await detectTransparency(opaquePng)) === false);

  // Bytes that are not an image at all.
  eq("something undecodable is 'not inspected', not 'opaque'",
    await detectTransparency(Buffer.from("this is not a png")), null);

  // ======================================================================
  console.log("\n=== 8. Existing assets stay compatible ===\n");
  // ======================================================================
  //
  // Both new fields default, so every record written before today parses and
  // behaves — no migration, no backfill, and nothing disappears from a picker
  // because a field it never had is missing.
  const oldShapes = [
    { fileType: "photo", category: "logo", storageUrl: "https://b/1.png", originalFilename: "1.png",
      summary: null, extractionConfidence: null, relatedRecordId: null, relatedEntityType: null },
    { fileType: "photo", category: "logo", storageUrl: "https://b/2.png", originalFilename: "2.png",
      summary: null, extractionConfidence: null, relatedRecordId: null, relatedEntityType: null,
      role: "brand.logo", origin: "generated", supersedesAssetId: null, supersededByAssetId: null },
  ];
  for (const [i, shape] of oldShapes.entries()) {
    const parsed = AssetSchema.safeParse(shape);
    assert(`an older asset shape (${i + 1}) still parses`, parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
    if (parsed.success) {
      assert(`and shape ${i + 1} is in the library by default`, inLibrary(parsed.data));
    }
  }

  // A DESIGNATED ASSET KEEPS ITS ROLE THROUGH ALL OF THIS. The brand logo can
  // be in the toolbox, be taken out of it, and still be the brand logo —
  // which is the reason this is not stored in `role`.
  const brandLogo = asset({ role: "brand.logo", origin: "generated" });
  eq("the brand logo can leave the toolbox and still be the brand logo",
    removedFromLibrary(brandLogo).role, "brand.logo");
  assert("CONTROL: while genuinely leaving it",
    !inLibrary(removedFromLibrary(brandLogo)));

  // ---- clean up -------------------------------------------------------
  await prisma.businessRecord.deleteMany({ where: { storeId: store.id } });
  await prisma.store.delete({ where: { id: store.id } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  // GIVE THE CONNECTIONS BACK (2026-08-28).
  //
  // This suite opens TWO clients — prisma and prismaSystem — where almost every
  // other one opens a single client. The harness serves every suite in the run
  // from one PGlite socket server capped at 60 connections, so a suite holding
  // two pools costs roughly twice what its neighbours cost.
  //
  // Left undisconnected, that showed up as two INNOCENT suites failing:
  // two-factor and update-product-image, the last two alphabetically, with
  // "Connection terminated unexpectedly". Both pass alone, and both pass beside
  // this one. The evidence that it was this suite rather than the length of the
  // run: dropping any other suite to keep the count at 42 still failed, and
  // dropping only this one passed 42/42.
  //
  // A red that lands on someone else's file is the most expensive kind, so the
  // rule this encodes is: whatever a suite opens, it closes.
  await prisma.$disconnect();
  await prismaSystem.$disconnect();

  process.exit(failures === 0 ? 0 : 1);
}

void main();
