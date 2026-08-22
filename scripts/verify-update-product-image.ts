import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { updateProductImageExecutable } from "@/lib/execution/executables/updateProductImage";

// REPLACING A PRODUCT PHOTO WITHOUT LOSING ANYTHING ELSE:
//
//   npx tsx scripts/run-db-suites.ts
//
// This executable predates the product media gallery and once wrote only
// Product.imageUrl. Its own comment records what that cost: "without this, a
// chat-approved photo replacement would desync the scalar column from the
// ProductImage table's own position-0 row (the real source every gallery UI
// reads from), silently reverting to the old photo the next time anything read
// the gallery instead of imageUrl directly."
//
// That is a bug an owner would experience as Genesis lying to them — they
// approve a new photo, the product page shows it, and the gallery quietly puts
// the old one back. It had no coverage.
//
// THE SECOND PROPERTY is provenance, and it crosses features. A product made in
// Studio records which design it came from, which surface, and which print file
// a provider should use. Replacing its photo merges the generation prompt INTO
// richContent rather than replacing the object — so a Studio product that gets
// a new photo must still know how to be reprinted. Nothing asserted that, and
// `richContent = { imagePrompt }` instead of a spread would pass every other
// check in this file.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function threw(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: `img-${Date.now()}@test.local`, name: "Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `img-${Date.now()}` },
  });
  const other = await prisma.store.create({
    data: { userId: user.id, name: "Iron Gym", slug: `img-other-${Date.now()}` },
  });

  const product = async (storeId: string, over: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        storeId,
        name: "Tensor Ring",
        description: "d",
        priceInCents: 8500,
        active: true,
        imageUrl: "https://blob.test/old.png",
        ...over,
      },
    });

  const run = (productId: string, storeId: string, over: Record<string, unknown> = {}) =>
    updateProductImageExecutable.run(
      { productId, imageUrl: "https://blob.test/new.png", ...over } as never,
      { storeId, userId: user.id } as never
    );

  try {
    // ========================================================================
    console.log("\n=== 1. The gallery and the product agree, always ===\n");
    // ========================================================================
    // A product that already has a gallery: the position-0 row is updated in
    // place rather than a second one appended.
    const withGallery = await product(store.id);
    await prisma.productImage.create({
      data: { productId: withGallery.id, url: "https://blob.test/old.png", position: 0 },
    });
    await prisma.productImage.create({
      data: { productId: withGallery.id, url: "https://blob.test/second.png", position: 1 },
    });

    await run(withGallery.id, store.id);
    const updated = await prisma.product.findUniqueOrThrow({ where: { id: withGallery.id } });
    const gallery = await prisma.productImage.findMany({
      where: { productId: withGallery.id },
      orderBy: { position: "asc" },
    });

    check("the product shows the new photo", updated.imageUrl === "https://blob.test/new.png", String(updated.imageUrl));
    check("and so does the gallery's first slot", gallery[0]?.url === "https://blob.test/new.png", String(gallery[0]?.url));
    check(
      "so nothing silently reverts to the old photo",
      updated.imageUrl === gallery[0]?.url,
      "the gallery is what every gallery UI reads; imageUrl is what the product page reads"
    );
    check("the position-0 row was updated in place, not appended to", gallery.length === 2, String(gallery.length));
    check("and the rest of the gallery is untouched",
      gallery[1]?.url === "https://blob.test/second.png", String(gallery[1]?.url));

    // A product with no gallery at all gets its first row created.
    const noGallery = await product(store.id, { name: "No gallery" });
    await run(noGallery.id, store.id);
    const created = await prisma.productImage.findMany({ where: { productId: noGallery.id } });
    check("a product with no images gains one", created.length === 1, String(created.length));
    check("at position 0", created[0]?.position === 0, String(created[0]?.position));
    check("matching the product itself",
      created[0]?.url === (await prisma.product.findUniqueOrThrow({ where: { id: noGallery.id } })).imageUrl);

    // ========================================================================
    console.log("\n=== 2. A new photo does not erase where a product came from ===\n");
    // ========================================================================
    // The cross-feature property. A Studio-made product carries provenance —
    // designId, surface, printFileUrl — and replacing its photo merges the
    // prompt INTO that rather than over it.
    const provenance = {
      designId: "design_1",
      surface: "garment.tshirt",
      printFileUrl: "https://blob.test/print.png",
      sourceAssetIds: ["asset_1"],
    };
    const studioMade = await product(store.id, { name: "Studio made", richContent: provenance });

    await run(studioMade.id, store.id, { generationPrompt: "a copper coil on charcoal" });
    const after = await prisma.product.findUniqueOrThrow({ where: { id: studioMade.id } });
    const rich = after.richContent as Record<string, unknown>;

    check("the prompt is recorded", rich.imagePrompt === "a copper coil on charcoal", String(rich.imagePrompt));
    check("the design it came from survives", rich.designId === "design_1", String(rich.designId));
    check("and the print file", rich.printFileUrl === provenance.printFileUrl, String(rich.printFileUrl));
    check("and the surface", rich.surface === provenance.surface, String(rich.surface));
    check(
      "so a Studio product that gets a new photo can still be reprinted",
      Boolean(rich.designId && rich.printFileUrl && rich.imagePrompt),
      "richContent = { imagePrompt } instead of a spread would pass every other check here"
    );

    // ========================================================================
    console.log("\n=== 3. A stock or uploaded photo leaves richContent alone ===\n");
    // ========================================================================
    // "Absent for stock-sourced/uploaded images, which leave richContent
    // untouched" — not overwritten with an empty object.
    const stockSourced = await product(store.id, { name: "Stock", richContent: provenance });
    await run(stockSourced.id, store.id);
    const untouched = await prisma.product.findUniqueOrThrow({ where: { id: stockSourced.id } });
    // Compared field by field rather than by JSON.stringify: richContent makes a
    // round trip through a Postgres jsonb column, which does not preserve key
    // order, so a string comparison fails on content that is identical. Same
    // lesson verify-preview-theme.ts already learned.
    const sameShape = (a: unknown, b: unknown) =>
      JSON.stringify(Object.entries(a as object).sort()) === JSON.stringify(Object.entries(b as object).sort());
    check("richContent is exactly what it was",
      sameShape(untouched.richContent, provenance),
      JSON.stringify(untouched.richContent));
    check("with no empty imagePrompt invented",
      !("imagePrompt" in (untouched.richContent as Record<string, unknown>)),
      "an absent prompt is an absence, not an empty string");

    // A product with no richContent at all stays that way.
    const plain = await product(store.id, { name: "Plain" });
    await run(plain.id, store.id);
    const stillPlain = await prisma.product.findUniqueOrThrow({ where: { id: plain.id } });
    check("a product with no richContent gains none", stillPlain.richContent === null,
      JSON.stringify(stillPlain.richContent));

    // But one that had none DOES get the prompt when there is one.
    const plainWithPrompt = await product(store.id, { name: "Plain with prompt" });
    await run(plainWithPrompt.id, store.id, { generationPrompt: "a ring" });
    const gained = await prisma.product.findUniqueOrThrow({ where: { id: plainWithPrompt.id } });
    check("while a generated one records its prompt from nothing",
      (gained.richContent as Record<string, unknown>)?.imagePrompt === "a ring",
      JSON.stringify(gained.richContent));

    // ========================================================================
    console.log("\n=== 4. One store cannot repaint another's product ===\n");
    // ========================================================================
    const theirs = await product(other.id, { name: "Theirs" });
    const refused = await threw(() => run(theirs.id, store.id));
    check("updating another business's product is refused", refused, "storeId is in the where clause");
    const theirsAfter = await prisma.product.findUniqueOrThrow({ where: { id: theirs.id } });
    check("and their photo is unchanged", theirsAfter.imageUrl === "https://blob.test/old.png", String(theirsAfter.imageUrl));
    check("with no gallery row created for it",
      (await prisma.productImage.count({ where: { productId: theirs.id } })) === 0);

    // ========================================================================
    console.log("\n=== 5. The result says which product changed ===\n");
    // ========================================================================
    const named = await product(store.id, { name: "Wax Melt Trio" });
    const result = await run(named.id, store.id);
    check("the message names the product", result.message.includes("Wax Melt Trio"), result.message);
    check("and the metadata carries its id",
      (result.metadata as { productId: string }).productId === named.id,
      JSON.stringify(result.metadata));
    check("and its name, for an owner reading the log later",
      (result.metadata as { name: string }).name === "Wax Melt Trio",
      JSON.stringify(result.metadata));
  } finally {
    await prisma.store.deleteMany({ where: { id: { in: [store.id, other.id] } } });
    await prisma.user.delete({ where: { id: user.id } });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
