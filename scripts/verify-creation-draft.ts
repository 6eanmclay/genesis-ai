import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { DesignSchema, type Design } from "@/lib/businessModel/entities";
import { toDraft, toDesign, isPlacementDraft, isCreated, layerUrls, draftSummary } from "@/lib/creation/designDraft";
import { randomAssetKey, extensionFor } from "@/lib/businessAssets/uploadKey";
import type { ProductDesign, DesignLayer } from "@/lib/creation/design";
import type { Garment, GarmentVariant } from "@/lib/creation/garment";

// SAVING A DESIGN SO IT CAN BE COME BACK TO:
//
//   npx tsx scripts/run-db-suites.ts creation-draft
//
// ============ THE PROPERTY UNDER TEST (2026-08-28) ======================
//
// Sean, after testing the live deployment: "If someone saves a design because
// they're not sure it's finished, it should remain available in their Creation
// Station/design library so they can reopen it later and continue working on
// it." And: "The user should be able to save something 10 times while working
// on it without paying Growth Points every time."
//
// Before this, Save wrote a Product row carrying a `designSpec` blob that HAS
// NO READERS ANYWHERE IN THE CODEBASE — nothing listed it, nothing loaded it,
// no route reopened it. So the tests that matter are not "does a save return
// ok". They are:
//
//   a design goes in and the SAME design comes back        (round trip)
//   ten saves leave one draft, not ten                     (upsert)
//   a draft that became a product still says so            (no second charge)
//
// The last one is the one with money attached. If re-saving reset the record's
// productId, the owner would be offered a second 2-point Create for a product
// they already have.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const layer = (over: Partial<DesignLayer> = {}): DesignLayer => ({
  id: "l1", assetUrl: "https://blob.test/logo.png",
  x: 0.25, y: 0.2, width: 0.5, height: 0.3,
  flipX: false, flipY: false, rotation: 0, ...over,
});

const variant = (over: Partial<GarmentVariant> = {}): GarmentVariant => ({
  externalVariantId: "v-black-m", color: "Black", colorHex: "#000000",
  size: "M", imageUrl: null, costInCents: 2199, ...over,
});

const garment = (over: Partial<Garment> = {}): Garment => ({
  provider: "PRINTFUL", externalProductId: "146", name: "Unisex Hoodie",
  type: "Hoodie", brand: "Gildan", description: "d", imageUrl: null,
  variants: [variant()],
  // The real measured areas for 146 — front and back are NOT the same shape.
  printAreas: [
    { placement: "front", width: 2100, height: 2100, unit: "px" },
    { placement: "back", width: 1800, height: 2400, unit: "px" },
  ],
  ...over,
});

const design = (over: Partial<ProductDesign> = {}): ProductDesign => ({
  externalProductId: "146",
  externalVariantId: "v-black-m",
  placements: { front: [layer()], back: [layer({ id: "l2", x: 0.1, rotation: 15 })] },
  ...over,
});

/** The blanks the owner was looking at, as the save resolves them. */
const BLANKS = { front: "https://cdn.test/front.png", back: "https://cdn.test/back.png" };

const DRAFT_SOURCE = "genesis_creation";

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: "creation-draft@example.test", name: "Draft Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Draft Store", slug: "creation-draft-store", tagline: "t", description: "d" },
  });

  const save = (data: Design, externalId: string) =>
    persistSyncedRecords(store.id, DRAFT_SOURCE, [{ entityType: "design", externalId, data }], {
      provenance: "OWNER", provenanceDetail: "creation station", statedById: user.id, modelExtracted: false,
    });

  // ======================================================================
  console.log("\n=== 1. A design goes in and the same design comes back ===\n");
  // ======================================================================

  const original = design();
  const draft = toDraft(original, { garment: garment(), name: "My Hoodie", retailPriceInCents: 5500, blanks: BLANKS });

  assert("the draft parses as a design record", DesignSchema.safeParse(draft).success);
  assert("and is a product design rather than a composition", isPlacementDraft(draft));

  const restored = toDesign(draft);
  eq("the blank comes back", restored?.externalProductId, original.externalProductId);
  eq("the exact colour and size comes back", restored?.externalVariantId, original.externalVariantId);
  eq("EVERY placement and layer comes back, unchanged", restored?.placements, original.placements);
  assert("including the rotation on the back layer",
    restored?.placements.back?.[0]?.rotation === 15,
    "a reopened draft that quietly loses a rotation is worse than one that fails to open");

  // ======================================================================
  console.log("\n=== 2. What was saved alongside it ===\n");
  // ======================================================================

  eq("the owner's own name for it", draft.placement?.productName, "My Hoodie");
  eq("and their price", draft.placement?.retailPriceInCents, 5500);
  eq("the colour, by name", draft.placement?.color, "Black");
  eq("the size", draft.placement?.size, "M");
  eq("who makes it, read off the garment", draft.placement?.provider, "PRINTFUL");
  eq("the supplier's print areas, frozen",
    draft.placement?.printAreas.map((a) => `${a.placement}:${a.width}x${a.height}`),
    ["front:2100x2100", "back:1800x2400"]);
  eq("the artwork used, for provenance", layerUrls(original), ["https://blob.test/logo.png"]);
  eq("and a line a person can read", draftSummary(draft), "Black, front and back");

  // ======================================================================
  console.log("\n=== 3. Ten saves leave ONE draft ===\n");
  // ======================================================================
  //
  // The upsert key is (storeId, entityType, sourceProvider, externalId). If a
  // save ever minted a new id, a person tidying one design would find ten.

  const draftId = "draft-fixed-id";
  for (let i = 0; i < 10; i++) {
    const moved = design({ placements: { front: [layer({ x: 0.1 * i })] } });
    const result = await save(toDraft(moved, { garment: garment(), name: "My Hoodie", retailPriceInCents: 5500, blanks: BLANKS }), draftId);
    if (result.errors.length > 0) assert(`save ${i} wrote cleanly`, false, JSON.stringify(result.errors));
  }

  const rows = await prisma.businessRecord.findMany({
    where: { storeId: store.id, entityType: "design", sourceProvider: DRAFT_SOURCE, externalId: draftId },
    select: { id: true, data: true, provenance: true },
  });
  eq("ten saves of one design leave exactly one record", rows.length, 1);

  const latest = DesignSchema.safeParse(rows[0]?.data);
  assert("and it holds the LAST state, not the first",
    latest.success && latest.data.placement?.placements.front?.[0]?.x === 0.9,
    `x was ${latest.success ? latest.data.placement?.placements.front?.[0]?.x : "unparseable"}`);
  eq("saved as the owner's own work", rows[0]?.provenance, "OWNER");

  // ======================================================================
  console.log("\n=== 4. A draft that became a product still says so ===\n");
  // ======================================================================
  //
  // THE ONE WITH MONEY ATTACHED. Product Creation costs 2 Growth Points. If
  // re-saving reset this, the owner would be offered a second paid Create for a
  // product they already have.

  const created: Design = {
    ...draft,
    placement: { ...draft.placement!, productId: "prod_123", supplierProductCreated: true },
  };
  assert("a created draft reports itself created", isCreated(created));

  const resaved = toDraft(design({ placements: { front: [layer({ x: 0.42 })] } }),
    { garment: garment(), name: "My Hoodie", retailPriceInCents: 5500, blanks: BLANKS },
    created.placement);

  eq("editing and re-saving keeps the product it already made", resaved.placement?.productId, "prod_123");
  eq("and keeps knowing the supplier has it", resaved.placement?.supplierProductCreated, true);
  assert("CONTROL: while still saving the edit", resaved.placement?.placements.front?.[0]?.x === 0.42);
  assert("CONTROL: a fresh draft has made nothing",
    !isCreated(toDraft(design(), { garment: garment(), name: "n", retailPriceInCents: null, blanks: BLANKS })));

  // ======================================================================
  console.log("\n=== 5. CONTROL: a composed design is not a product design ===\n");
  // ======================================================================
  //
  // Both live in the `design` entity, which is the point — one design system.
  // They are not the same shape, and the editor must not try to open one.

  const composed: Design = DesignSchema.parse({
    assetIds: ["a1"], surface: "tshirt", arrangement: "centered", arrangementScale: 1,
    printFileUrl: "https://blob.test/print.png", mockupUrl: "https://blob.test/mockup.png",
    sourceAssetUrls: [], createdAt: new Date().toISOString(), placement: null,
  });
  eq("a composition has no placement design", toDesign(composed), null);
  assert("and does not claim to be one", !isPlacementDraft(composed));

  // ======================================================================
  console.log("\n=== 6. The upload names files so they cannot collide ===\n");
  // ======================================================================
  //
  // The bug Sean hit: the Creation Station uploaded under the bare filename,
  // and the token is issued with addRandomSuffix false — so the SECOND upload
  // of any name was refused, and "Try again" with the same file failed
  // identically. Every other upload in Genesis already used a random key.

  const keys = new Set(Array.from({ length: 500 }, () => randomAssetKey()));
  eq("five hundred keys are five hundred keys", keys.size, 500);

  eq("a normal filename keeps its extension", extensionFor({ name: "logo.PNG", type: "image/png" }), "png");
  eq("a phone photo with no extension falls back to its type",
    extensionFor({ name: "IMG_0001", type: "image/heic" }), "heic");
  eq("jpeg is normalised to jpg", extensionFor({ name: "shot", type: "image/jpeg" }), "jpg");
  eq("and something unreadable still produces a usable name",
    extensionFor({ name: "file", type: "" }), "png");

  // ---- clean up -------------------------------------------------------
  await prisma.businessRecord.deleteMany({ where: { storeId: store.id } });
  await prisma.store.delete({ where: { id: store.id } });
  await prisma.user.delete({ where: { id: user.id } });

  await prisma.$disconnect();
  await prismaSystem.$disconnect();

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
