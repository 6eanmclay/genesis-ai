import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { createProductFromDesignExecutable } from "@/lib/execution/executables/productFromDesign";
import { SURFACES } from "@/lib/design/surfaces";

// TURNING A DESIGN INTO SOMETHING THE OWNER CAN ACTUALLY SELL:
//
//   npx tsx scripts/run-db-suites.ts
//
// The bridge from Studio to the catalogue, and it had no coverage.
//
// PARTLY EXTERNALLY BLOCKED, and recorded rather than substituted: once a
// product exists, this registers it with whichever fulfillment provider is
// connected, which needs real Printful credentials. Those are unavailable here
// and the standing rule is that the read-only Printful verification script is
// the legitimate path — no fake provider stands in for it. What IS reachable is
// everything up to that point, including every reason this refuses to create a
// product at all.
//
// THE REFUSALS ARE THE POINT. Each one is a way a design could turn into a
// listing an owner cannot fulfil:
//
//   * a design that no longer exists — deleted between proposal and approval
//   * a design whose stored record no longer parses — written before a schema
//     change, read back after it
//   * a design with no mockup — nothing to show a customer, so nothing to sell
//
// All three throw before any write. A version that created the product anyway
// would leave a real, purchasable row in the catalogue pointing at nothing.
//
// AND PROVENANCE IS THE OTHER HALF. A product made in Studio records which
// design it came from, which surface, and which print file a provider should
// use — without that, "reprint this" has nothing to resolve.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** What this threw, or null. */
async function threw(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: `design-${Date.now()}@test.local`, name: "Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `design-${Date.now()}` },
  });
  const other = await prisma.store.create({
    data: { userId: user.id, name: "Iron Gym", slug: `design-other-${Date.now()}` },
  });

  const design = async (storeId: string, data: unknown) =>
    (await prisma.businessRecord.create({
      data: {
        storeId,
        entityType: "design",
        externalId: `d-${Math.random().toString(36).slice(2)}`,
        sourceProvider: "genesis_studio",
        data: data as never,
      },
    })).id;

  const REAL_SURFACE = Object.keys(SURFACES)[0];
  // Every field DesignSchema requires. My first fixture omitted arrangement,
  // arrangementScale and sourceAssetUrls — so the "no mockup" case failed the
  // parse instead of reaching the mockup check, and the suite reported the
  // wrong refusal for the right reason.
  const complete = {
    assetIds: ["asset_1"],
    surface: REAL_SURFACE,
    arrangement: "centered",
    arrangementScale: 1,
    printFileUrl: "https://blob.test/print.png",
    mockupUrl: "https://blob.test/mockup.png",
    sourceAssetUrls: ["https://blob.test/asset.png"],
    createdAt: null,
  };

  const run = (designId: string, storeId: string, over: Record<string, unknown> = {}) =>
    createProductFromDesignExecutable.run(
      { designId, name: "Tensor Ring Tee", priceInCents: 2500, ...over } as never,
      { storeId, userId: user.id } as never
    );

  try {
    // ========================================================================
    console.log("\n=== 1. A design that cannot be sold from is refused ===\n");
    // ========================================================================
    const missing = await threw(() => run("clx0000000000000000000000", store.id));
    check("a design that no longer exists is refused", missing !== null, String(missing));
    check("and says so in the owner's words",
      (missing ?? "").includes("no longer exists"), String(missing));

    const unreadableId = await design(store.id, { surface: 12345, notADesign: true });
    const unreadable = await threw(() => run(unreadableId, store.id));
    check("a design that no longer parses is refused", unreadable !== null, String(unreadable));
    check("rather than crashing on the stored shape",
      (unreadable ?? "").includes("could not be read"), String(unreadable));

    const noMockupId = await design(store.id, { ...complete, mockupUrl: null });
    const noMockup = await threw(() => run(noMockupId, store.id));
    check("a design with no mockup is refused", noMockup !== null, String(noMockup));
    check("because there would be nothing to show a customer",
      (noMockup ?? "").includes("no mockup"), String(noMockup));

    check(
      "and none of the three wrote a product",
      (await prisma.product.count({ where: { storeId: store.id } })) === 0,
      "a listing pointing at nothing is worse than a refusal"
    );

    // ========================================================================
    console.log("\n=== 2. One store's design cannot become another's product ===\n");
    // ========================================================================
    const theirDesign = await design(other.id, complete);
    const crossStore = await threw(() => run(theirDesign, store.id));
    check("a design belonging to another business is refused", crossStore !== null, String(crossStore));
    check("as simply not existing, which is what it is from here",
      (crossStore ?? "").includes("no longer exists"), String(crossStore));
    check("and nothing was created in either store",
      (await prisma.product.count({ where: { storeId: { in: [store.id, other.id] } } })) === 0);

    // ========================================================================
    console.log("\n=== 3. A real design becomes a real, sellable product ===\n");
    // ========================================================================
    const goodId = await design(store.id, complete);
    const created = await run(goodId, store.id);
    const product = await prisma.product.findFirstOrThrow({ where: { storeId: store.id } });

    check("the product carries the name it was given", product.name === "Tensor Ring Tee", product.name);
    check("and the price", product.priceInCents === 2500, String(product.priceInCents));
    check("and shows the mockup", product.imageUrl === complete.mockupUrl, String(product.imageUrl));
    check("in the store it was made for", product.storeId === store.id, product.storeId);
    check("the result names what happened", created.message.length > 0, created.message);

    // The gallery and the scalar column must not disagree — "position 0 of the
    // gallery, same as every other product-creating path".
    const images = await prisma.productImage.findMany({ where: { productId: product.id } });
    check("the gallery has exactly one image", images.length === 1, String(images.length));
    check("at position 0", images[0]?.position === 0, String(images[0]?.position));
    check("and it is the same image as the scalar column",
      images[0]?.url === product.imageUrl,
      "the scalar column and the ProductImage table must not disagree");

    // ========================================================================
    console.log("\n=== 4. The product remembers where it came from ===\n");
    // ========================================================================
    const provenance = product.richContent as Record<string, unknown> | null;
    check("it records the design it was made from", provenance?.designId === goodId, JSON.stringify(provenance?.designId));
    check("and the surface", provenance?.surface === REAL_SURFACE, String(provenance?.surface));
    check("and the print file a provider would need",
      provenance?.printFileUrl === complete.printFileUrl, String(provenance?.printFileUrl));
    check("and the assets it was built from",
      JSON.stringify(provenance?.sourceAssetIds) === JSON.stringify(["asset_1"]),
      JSON.stringify(provenance?.sourceAssetIds));
    check(
      "so 'reprint this' has something real to resolve",
      Boolean(provenance?.designId && provenance?.printFileUrl),
      "without provenance the product is a picture with a price on it"
    );

    // ========================================================================
    console.log("\n=== 5. A description is written only when none was given ===\n");
    // ========================================================================
    // The default names the real surface rather than inventing a claim about
    // the product.
    const defaulted = product.description ?? "";
    const surfaceLabel = SURFACES[REAL_SURFACE]?.label ?? REAL_SURFACE;
    check("an absent description falls back to the surface's own name",
      defaulted.includes(surfaceLabel), `${defaulted} / ${surfaceLabel}`);
    check("without claiming anything about quality or materials",
      !/premium|best|luxury|finest|guaranteed/i.test(defaulted), defaulted);

    const withOwn = await design(store.id, complete);
    await run(withOwn, store.id, { name: "Second", description: "Hand-wound copper on cotton." });
    const second = await prisma.product.findFirstOrThrow({ where: { storeId: store.id, name: "Second" } });
    check("a given description is used exactly as written",
      second.description === "Hand-wound copper on cotton.", String(second.description));

    // Position increments, so a new product does not land on top of an existing
    // one's slot.
    check("the second product takes the next position",
      second.position === 1, String(second.position));

    // ========================================================================
    console.log("\n=== 6. Fulfillment registration is externally blocked ===\n");
    // ========================================================================
    // Recorded, not faked. With no Printful connection in this environment the
    // loop finds no connected provider and the product is created unregistered
    // — which is the honest local outcome, and is itself worth pinning: a
    // design with a print file must still become a sellable product when no
    // provider is connected at all.
    check("a product is still created with no provider connected",
      product.id.length > 0,
      "the fulfillment half needs real Printful credentials — see the read-only verification script");
    const connections = await prisma.storeIntegration.count({ where: { storeId: store.id } });
    check("and there genuinely was no provider to register with", connections === 0, String(connections));
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
