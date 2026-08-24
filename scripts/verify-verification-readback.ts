import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// READ-BACK, AGAINST A REAL DATABASE.
//
//   npx tsx scripts/verify-verification-readback.ts
//
// The behavioural half of VERIFICATION_HARDENING_CONTRACT.md §9.2. The source
// and comparison-rule half is verify-verification-hardening.ts, which needs no
// database.
//
// BRINGS ITS OWN POSTGRES, so it is NOT in the shared runner — the lane
// verification-inventory.ts calls "own-infrastructure". A green 41/41 does not
// include this file, and it has to be run.
//
// WHAT MAKES THIS WORTH RUNNING. Every assertion here is paired with a control
// that BREAKS THE REAL WRITE — corrupting the row after a successful execution
// and confirming verification notices. Not a mock: the actual persisted state,
// actually wrong. A verify() nobody has watched fail is a claim, not a check.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const ex = {
    theme: (await import("@/lib/execution/executables/updateTheme")).updateThemeExecutable,
    identity: (await import("@/lib/execution/executables/updateStoreIdentity")).updateStoreIdentityExecutable,
    brand: (await import("@/lib/execution/executables/updateBrandIdentity")).updateBrandIdentityExecutable,
    seo: (await import("@/lib/execution/executables/updateSeo")).updateSeoExecutable,
    products: await import("@/lib/execution/executables/products"),
  };

  try {
    const user = await prisma.user.create({ data: { email: `vh-${Date.now()}@test.local` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Read Back Co", slug: `read-back-${Date.now()}` },
    });
    const ctx = { storeId: store.id, userId: user.id, actorType: "USER" as const };

    // =====================================================================
    console.log("\n=== CLASS A — the input is the stored value ===\n");
    // =====================================================================
    const identityInput = { name: "Read Back Co", tagline: "Proven, not assumed", description: "A shop." };
    await ex.identity.run(identityInput, ctx);
    assert("a real write verifies",
      (await ex.identity.verify(identityInput, ctx, undefined)).state === "verified");

    // CONTROL: break the actual row, not a mock.
    await prisma.store.update({ where: { id: store.id }, data: { tagline: "something else" } });
    const broken = await ex.identity.verify(identityInput, ctx, undefined);
    assert("CONTROL: corrupting the stored value fails verification",
      broken.state === "failed");
    assert("and it names WHICH field, not a bare boolean",
      broken.state === "failed" && broken.mismatches.some((m) => m.startsWith("tagline")),
      broken.state === "failed" ? broken.mismatches.join("; ") : "");

    // =====================================================================
    console.log("\n=== CLASS B — only the keys the input named ===\n");
    // =====================================================================
    // The blueprint section is seeded with a key this action never touches.
    await prisma.store.update({
      where: { id: store.id },
      // A key this action's input does NOT name. Blueprint sections accumulate
      // keys from several actions over time, which is exactly why the read-back
      // may only compare the ones this input named.
      data: { blueprint: { brandIdentity: { legacyPositioningNote: "written by something else" } } },
    });
    const brandInput = {
      brandStory: "Wound by hand.",
      missionStatement: "Make one good thing.",
      visionStatement: "A bench, a coil, a customer.",
      brandPromise: "Finished within 48 hours.",
      targetAudience: "People who wait for good things.",
      uniqueSellingProposition: "Hand-wound, one at a time.",
      coreValues: ["patience", "craft"],
      brandPersonality: "quiet",
      brandVoiceAndTone: "plain",
    };
    await ex.brand.run(brandInput, ctx);
    assert("a merge write verifies",
      (await ex.brand.verify(brandInput, ctx, undefined)).state === "verified");

    // THE FALSE-POSITIVE DIRECTION (§9.4 item 13). An untouched key sitting in
    // the same section must not fail verification — that would turn every
    // successful merge into a WARNING.
    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } });
    const section = (after.blueprint as { brandIdentity?: Record<string, unknown> }).brandIdentity ?? {};
    assert("the untouched key really is still there",
      section.legacyPositioningNote === "written by something else",
      "if it were gone the assertion below would pass for the wrong reason");
    assert("and it does NOT fail verification",
      (await ex.brand.verify(brandInput, ctx, undefined)).state === "verified");

    // CONTROL: break one named key inside the section.
    await prisma.store.update({
      where: { id: store.id },
      data: { blueprint: { brandIdentity: { ...section, brandStory: "replaced behind our back" } } },
    });
    const brandBroken = await ex.brand.verify(brandInput, ctx, undefined);
    assert("CONTROL: a named key that changed fails verification", brandBroken.state === "failed");
    assert("and names the section and the key",
      brandBroken.state === "failed" && brandBroken.mismatches.some((m) => m.includes("brandIdentity.brandStory")),
      brandBroken.state === "failed" ? brandBroken.mismatches.join("; ") : "");

    // Two actions share blueprint.marketingAssets — seo writes two keys of it.
    const seoInput = { seoTitle: "Read Back Co", seoMetaDescription: "Proven." };
    await ex.seo.run(seoInput, ctx);
    assert("a second action merging into a shared section verifies",
      (await ex.seo.verify(seoInput, ctx, undefined)).state === "verified");

    // =====================================================================
    console.log("\n=== CLASS C — rows that must exist, and must be gone ===\n");
    // =====================================================================
    const created = await ex.products.createProductExecutable.run(
      { name: "Copper Ring", description: "Hand-wound.", priceInCents: 8500 }, ctx
    );
    const productId = (created.metadata as { productId: string }).productId;
    assert("a created row verifies",
      (await ex.products.createProductExecutable.verify(
        { name: "Copper Ring", description: "Hand-wound.", priceInCents: 8500 }, ctx, created.metadata
      )).state === "verified");

    // CONTROL: the row exists but carries a different price.
    // Store-scoped, because lib/tenantIsolation.ts requires it — the guard
    // caught this fixture the first time it ran, which is the guard working.
    await prisma.product.updateMany({ where: { id: productId, storeId: store.id }, data: { priceInCents: 1 } });
    assert("CONTROL: a created row with the wrong value fails",
      (await ex.products.createProductExecutable.verify(
        { name: "Copper Ring", description: "Hand-wound.", priceInCents: 8500 }, ctx, created.metadata
      )).state === "failed");

    // CONTROL: the row is gone entirely — absence must not throw, it must fail.
    await prisma.productImage.deleteMany({ where: { productId, product: { storeId: store.id } } });
    await prisma.product.deleteMany({ where: { id: productId, storeId: store.id } });
    const gone = await ex.products.createProductExecutable.verify(
      { name: "Copper Ring", description: "Hand-wound.", priceInCents: 8500 }, ctx, created.metadata
    );
    assert("CONTROL: a vanished row fails rather than throwing", gone.state === "failed");

    // The delete direction: a delete that matched nothing is the same defect
    // from the other side, and deleteMany does not throw.
    const doomed = await ex.products.createProductExecutable.run(
      { name: "Doomed", description: null, priceInCents: 100 }, ctx
    );
    const doomedId = (doomed.metadata as { productId: string }).productId;
    assert("CONTROL: before the delete, absence-verification fails",
      (await ex.products.deleteProductExecutable.verify(
        { productId: doomedId, name: "Doomed" }, ctx, undefined
      )).state === "failed",
      "the row is still there, so 'it is gone' must not pass");
    await prisma.productImage.deleteMany({ where: { productId: doomedId, product: { storeId: store.id } } });
    await prisma.product.deleteMany({ where: { id: doomedId, storeId: store.id } });
    assert("and after a real delete it verifies",
      (await ex.products.deleteProductExecutable.verify(
        { productId: doomedId, name: "Doomed" }, ctx, undefined
      )).state === "verified");

    // =====================================================================
    console.log("\n=== CLASS D — the expectation run() computed ===\n");
    // =====================================================================
    const toggled = await prisma.product.create({
      data: { storeId: store.id, name: "Toggle", priceInCents: 500, active: true, position: 0 },
    });
    await ex.products.toggleProductActiveExecutable.run(
      { productId: toggled.id, currentActive: true }, ctx
    );
    assert("a toggle verifies against the flip of its stated prior value",
      (await ex.products.toggleProductActiveExecutable.verify(
        { productId: toggled.id, currentActive: true }, ctx, undefined
      )).state === "verified");

    // CONTROL: put the row back the way it was — the toggle's claim is now false.
    await prisma.product.updateMany({ where: { id: toggled.id, storeId: store.id }, data: { active: true } });
    assert("CONTROL: a toggle that did not take fails",
      (await ex.products.toggleProductActiveExecutable.verify(
        { productId: toggled.id, currentActive: true }, ctx, undefined
      )).state === "failed");

    // =====================================================================
    console.log("\n=== The theme, end to end through the engine ===\n");
    // =====================================================================
    const themeInput = {
      colors: { primary: "#b87333", secondary: "#1a1a1a", accent: "#e8d5b7", background: "#faf8f5", surface: "#fff", text: "#1a1a1a", textSecondary: "#666" },
      typography: { headingFont: "Fraunces", bodyFont: "Inter" },
    } as Parameters<typeof ex.theme.run>[0];
    await ex.theme.run(themeInput, ctx);
    assert("the theme verifies after a real write",
      (await ex.theme.verify(themeInput, ctx, undefined)).state === "verified");

    await prisma.store.update({ where: { id: store.id }, data: { theme: { colors: {}, typography: {} } } });
    assert("CONTROL: a theme replaced behind our back fails",
      (await ex.theme.verify(themeInput, ctx, undefined)).state === "failed");
  } finally {
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
