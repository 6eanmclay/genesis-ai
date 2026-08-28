import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { saveDesignAsProduct } from "@/lib/creation/saveDesign";
import type { ProductDesign, DesignLayer, PrintArea } from "@/lib/creation/design";
import type { Garment, GarmentVariant } from "@/lib/creation/garment";

// SAVING A DESIGN AS A PRODUCT, ACTUALLY RUN:
//
//   npx tsx scripts/run-db-suites.ts creation-save
//
// ============ WHY THIS SUITE EXISTS (2026-08-28) ========================
//
// Sean: "making sure the Creation Station can reliably create/save a product
// using the supplier's real capabilities and that the UI only exposes
// capabilities the supplier actually supports."
//
// The save path had never been executed. It lived inside a Server Function that
// needs a connected Printful account to reach, so verify-creation-catalog.ts
// covered it the only way it could — regular expressions over the file's own
// source. Those assertions are real, and they can only ever prove that a line
// is present. They cannot prove a row comes out the other end, that a refusal
// refuses, or that what is stored matches what was previewed.
//
// So the decision and the write now live in lib/creation/saveDesign.ts, and
// this calls it against a real database with a garment of its own making.
//
// ============ THE GARMENT IS THE SUPPLIER'S TESTIMONY ==================
//
// Every fixture below is built as if a supplier had declared it. That is the
// property under test: the function must honour what the garment says and
// refuse what it does not, without knowing which supplier said it. The
// negative controls are the important half — a check that only ever sees a
// valid design proves nothing about a system that never refuses anything.

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
  id: "l1",
  assetUrl: "https://blob.test/logo.png",
  x: 0.25,
  y: 0.2,
  width: 0.5,
  height: 0.3,
  flipX: false,
  flipY: false,
  rotation: 0,
  ...over,
});

const variant = (over: Partial<GarmentVariant> = {}): GarmentVariant => ({
  externalVariantId: "v-black-m",
  color: "Black",
  colorHex: "#000000",
  size: "M",
  imageUrl: "https://cdn.test/black.png",
  costInCents: 2199,
  ...over,
});

const area = (placement: string, over: Partial<PrintArea> = {}): PrintArea => ({
  placement,
  width: 12,
  height: 16,
  unit: "in",
  ...over,
});

/** A blank as a supplier declared it. Front-only unless told otherwise. */
const garment = (over: Partial<Garment> = {}): Garment => ({
  provider: "PRINTFUL",
  externalProductId: "146",
  name: "Unisex Hoodie",
  type: "Hoodie",
  brand: "Gildan",
  description: "A hoodie a supplier actually stocks",
  imageUrl: "https://cdn.test/hoodie.png",
  variants: [variant()],
  printAreas: [area("front")],
  ...over,
});

const design = (over: Partial<ProductDesign> = {}): ProductDesign => ({
  externalProductId: "146",
  externalVariantId: "v-black-m",
  placements: { front: [layer()] },
  ...over,
});

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: "creation-save@example.test", name: "Save Owner" },
  });
  const store = await prisma.store.create({
    data: {
      userId: user.id,
      name: "Save Store",
      slug: "creation-save-store",
      tagline: "t",
      description: "d",
      published: true,
    },
  });
  const other = await prisma.store.create({
    data: {
      userId: user.id,
      name: "Other Store",
      slug: "creation-save-other",
      tagline: "t",
      description: "d",
      published: true,
    },
  });

  const save = (over: Parameters<typeof saveDesignAsProduct>[0]["garment"] | null, d = design(), storeId = store.id) =>
    saveDesignAsProduct({
      storeId,
      design: d,
      meta: { name: "My Hoodie", retailPriceInCents: 5500 },
      garment: over ?? garment(),
    });

  // ======================================================================
  console.log("\n=== 1. A complete design becomes a product ===\n");
  // ======================================================================

  const saved = await save(null);
  assert("a design the supplier can print saves", saved.ok, saved.error ?? "");
  assert("and returns the product it wrote", typeof saved.productId === "string");

  const row = await prisma.product.findUnique({
    where: { id: saved.productId! },
    select: {
      name: true, priceInCents: true, active: true, storeId: true,
      sourceKind: true, externalProductId: true, externalVariantId: true,
      fulfillmentProvider: true, costInCents: true, imageUrl: true,
      description: true, designSpec: true,
    },
  });

  eq("it belongs to the store that asked", row?.storeId, store.id);
  eq("it carries the owner's name", row?.name, "My Hoodie");
  eq("and the owner's price", row?.priceInCents, 5500);
  eq("the supplier's description travels with it", row?.description, "A hoodie a supplier actually stocks");
  eq("the supplier's own cost is recorded", row?.costInCents, 2199);
  eq("the blank it was designed on", row?.externalProductId, "146");
  eq("the exact colour and size chosen", row?.externalVariantId, "v-black-m");

  // ======================================================================
  console.log("\n=== 2. Designed is not the same as ready to sell ===\n");
  // ======================================================================
  //
  // The rule from 3361c08. A product Printful has never been told about must
  // not look sellable, and this is the assertion that a future change cannot
  // quietly undo.

  eq("it is NOT on sale, because nothing has made it yet", row?.active, false);
  eq("printed by a partner per order, which is what it is", row?.sourceKind, "PRINT_ON_DEMAND");
  const spec = row?.designSpec as Record<string, unknown> | null;
  eq("and the design says the supplier does not have it", spec?.supplierProductCreated, false);

  // ======================================================================
  console.log("\n=== 3. Who makes it is asked, never assumed ===\n");
  // ======================================================================
  //
  // Sean: "keep the supplier abstraction intact: Genesis should understand
  // capabilities from the supplier's declared product/placement capabilities
  // rather than hardcoding Printful behavior."
  //
  // This wrote the literal "PRINTFUL". The control below is the whole test:
  // with a garment from any other provider, a hardcoded string still passes
  // every other assertion in this file.

  eq("the connected supplier is recorded", row?.fulfillmentProvider, "PRINTFUL");

  // ALIEXPRESS rather than PRINTIFY, which would read better: PRINTIFY is not
  // in the IntegrationProvider enum, and adding a value for a supplier that
  // does not exist would be inventing the very thing this file is checking we
  // do not assume. Any provider that is not PRINTFUL proves the point.
  const elsewhere = await save(garment({ provider: "ALIEXPRESS" }));
  const elsewhereRow = await prisma.product.findUnique({
    where: { id: elsewhere.productId! },
    select: { fulfillmentProvider: true },
  });
  eq("CONTROL: another supplier is recorded as itself, not as Printful",
    elsewhereRow?.fulfillmentProvider, "ALIEXPRESS");

  // ======================================================================
  console.log("\n=== 4. Only what the supplier declared it can print ===\n");
  // ======================================================================
  //
  // The UI already hides a Back tab a blank has no print area for. This is the
  // server refusing the same thing, because a hidden tab is not a check — the
  // action is reachable without the screen.

  const backArtwork = design({ placements: { front: [layer()], back: [layer({ id: "l2" })] } });
  const refusedBack = await save(null, backArtwork);
  assert("artwork on a placement this blank has no print area for is refused",
    !refusedBack.ok && /can't be printed on the back/i.test(refusedBack.error ?? ""),
    refusedBack.error ?? "it saved");
  assert("and nothing was written", refusedBack.productId === undefined);

  const twoSided = garment({ printAreas: [area("front"), area("back")] });
  const acceptedBack = await save(twoSided, backArtwork);
  assert("CONTROL: the same design saves on a blank that DOES declare a back",
    acceptedBack.ok, acceptedBack.error ?? "");

  // ======================================================================
  console.log("\n=== 5. Only colours and sizes the supplier still offers ===\n");
  // ======================================================================

  const goneVariant = await save(null, design({ externalVariantId: "v-purple-xxl" }));
  assert("a variant the supplier no longer lists is refused",
    !goneVariant.ok && /colour and size/i.test(goneVariant.error ?? ""),
    goneVariant.error ?? "it saved");

  const undecided = await save(null, design({ externalVariantId: null }));
  assert("so is a design with no colour chosen at all",
    !undecided.ok && /colour and size/i.test(undecided.error ?? ""),
    undecided.error ?? "it saved");

  const empty = await save(null, design({ placements: {} }));
  assert("and a garment with no artwork on it",
    !empty.ok && /artwork/i.test(empty.error ?? ""),
    empty.error ?? "it saved");

  // ======================================================================
  console.log("\n=== 6. What is stored is what was previewed ===\n");
  // ======================================================================
  //
  // The placements are resolved server-side through the same pure function the
  // canvas draws with. If these disagreed, the owner would approve one thing
  // and the supplier would receive another.

  const provider = (spec?.providerPlacements ?? []) as { placement: string; layers: { assetUrl: string }[] }[];
  eq("the resolved placements name the side the artwork is on",
    provider.map((p) => p.placement), ["front"]);
  eq("and carry the artwork itself, which the supplier fetches",
    provider[0]?.layers?.[0]?.assetUrl, "https://blob.test/logo.png");
  eq("the product's picture is that artwork until a supplier mockup exists",
    row?.imageUrl, "https://blob.test/logo.png");
  eq("the supplier's print areas are frozen onto the design",
    (spec?.printAreas as PrintArea[])?.map((a) => a.placement), ["front"]);
  eq("as is the colour, by name rather than by id", spec?.color, "Black");
  eq("and the size", spec?.size, "M");

  // ======================================================================
  console.log("\n=== 7. The write is scoped to the store that asked ===\n");
  // ======================================================================

  // Counted before and after rather than against a fixed number: a literal
  // would have to be re-derived every time an assertion above saves one more
  // product, and getting that arithmetic wrong makes the suite fail for a
  // reason that has nothing to do with scoping.
  const firstStoreBefore = await prisma.product.count({ where: { storeId: store.id } });

  const elsewhereSave = await save(null, design(), other.id);
  const elsewhereProduct = await prisma.product.findUnique({
    where: { id: elsewhereSave.productId! },
    select: { storeId: true },
  });
  eq("a save for another store writes to that store", elsewhereProduct?.storeId, other.id);
  eq("and the first store gained nothing from it",
    await prisma.product.count({ where: { storeId: store.id } }), firstStoreBefore);
  eq("the other store has exactly the one",
    await prisma.product.count({ where: { storeId: other.id } }), 1);

  // ---- clean up -------------------------------------------------------
  await prisma.product.deleteMany({ where: { storeId: { in: [store.id, other.id] } } });
  await prisma.store.deleteMany({ where: { id: { in: [store.id, other.id] } } });
  await prisma.user.delete({ where: { id: user.id } });

  // Whatever a suite opens, it closes — the harness serves the whole run from
  // one socket server with a finite budget. See scripts/lib/testDatabase.ts.
  await prisma.$disconnect();
  await prismaSystem.$disconnect();

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
