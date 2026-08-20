import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { ASSET_ROLES, resolveCurrentAsset, listAssetsByRole } from "@/lib/businessModel/assets";
import { buildLogoDirection } from "@/lib/brand/logoDirection";
import { hasExistingLogo } from "@/lib/brand/proposeBrandLogo";
import { updateBrandLogoExecutable } from "@/lib/execution/executables/updateBrandLogo";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";

// Verifies the brand-logo vertical slice against the real database.
//
// What is NOT covered, stated plainly: the image generation call itself needs
// an OpenAI key, which is not in this environment. Everything on either side
// of that call is exercised for real — the direction built from live Business
// Understanding, and the approval path that turns a URL into a designated,
// resolvable brand.logo Asset. A fake URL stands in for the generated one,
// which is exactly the boundary the missing credential draws.
//
// SAFE ON REAL DATA. It restores the store's original logoUrl and deletes only
// the asset rows it created, tracked by id. It never deletes anything
// pre-existing — see memory feedback_test_data_safety.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

const TEST_URL_A = "https://example.invalid/verify-logo-a.png";
const TEST_URL_B = "https://example.invalid/verify-logo-b.png";

async function main() {
  // Refuses to run against anything but an isolated test database. These
  // suites create, mutate and delete rows — without this, a production
  // DATABASE_URL in the shell was enough to rename a real merchant's product.
  // See scripts/lib/requireTestDatabase.ts.
  await requireTestDatabase(prismaSystem);
  const store = await prisma.store.findFirst({ select: { id: true, name: true, logoUrl: true } });
  if (!store) throw new Error("No store to test against.");
  console.log(`Testing against store: ${store.name}\n`);
  const originalLogoUrl = store.logoUrl;

  try {
    // 1. The direction is built from real Business Understanding.
    const understanding = await getBusinessUnderstanding(store.id);
    const direction = buildLogoDirection({ understanding, storeName: store.name });
    check(
      "logo direction is grounded in real Business Understanding",
      direction.prompt.includes(store.name) && direction.groundedIn.length > 0,
      `grounded in: ${direction.groundedIn.join(", ") || "(nothing)"}`
    );

    // 2. The owner's explicit words outrank inference — they come last.
    const withOwner = buildLogoDirection({
      understanding,
      storeName: store.name,
      refinement: "no blue, something hand-drawn",
    });
    const ownerIdx = withOwner.prompt.indexOf("takes priority over everything above");
    check(
      "the owner's explicit direction is weighted last, above inference",
      ownerIdx > 0 && ownerIdx > withOwner.prompt.indexOf(store.name),
      `owner clause at char ${ownerIdx} of ${withOwner.prompt.length}`
    );

    // 3. The no-pressure precondition is answerable.
    const had = await hasExistingLogo(store.id);
    check(
      "hasExistingLogo answers the no-pressure precondition",
      typeof had === "boolean",
      `store currently has a logo: ${had} (logoUrl set: ${Boolean(originalLogoUrl)})`
    );

    // 4. Approval writes the logo AND designates the Asset.
    const ctx = { storeId: store.id, userId: null, actorType: "USER" as const, actorId: null };
    await updateBrandLogoExecutable.run(
      { imageUrl: TEST_URL_A, generationPrompt: direction.prompt },
      ctx as Parameters<typeof updateBrandLogoExecutable.run>[1]
    );
    const afterA = await prisma.store.findUnique({ where: { id: store.id }, select: { logoUrl: true } });
    const assetA = await resolveCurrentAsset(store.id, ASSET_ROLES.brandLogo);
    check(
      "approving a logo updates Store.logoUrl and designates a brand.logo Asset",
      afterA?.logoUrl === TEST_URL_A && assetA?.url === TEST_URL_A,
      `logoUrl = ${afterA?.logoUrl === TEST_URL_A}; asset = ${assetA?.id ?? "none"} (${assetA?.origin})`
    );

    // 5. The Design layer's actual question: resolve "the current brand logo".
    check(
      "the Design layer can resolve the current brand logo to a real Asset",
      Boolean(assetA?.id && assetA.url === TEST_URL_A),
      `resolveCurrentAsset(brand.logo) -> ${assetA?.id ?? "null"}`
    );

    // 6. A second approved logo supersedes the first without deleting it.
    await updateBrandLogoExecutable.run(
      { imageUrl: TEST_URL_B, generationPrompt: "second" },
      ctx as Parameters<typeof updateBrandLogoExecutable.run>[1]
    );
    const assetB = await resolveCurrentAsset(store.id, ASSET_ROLES.brandLogo);
    const history = await listAssetsByRole(store.id, ASSET_ROLES.brandLogo);
    check(
      "a new logo supersedes the previous one and history survives",
      assetB?.url === TEST_URL_B && history.some((a) => a.url === TEST_URL_A),
      `current = ${assetB?.url}; history holds ${history.length} logo asset(s)`
    );

    // 7. The action is registered where the conversation can reach it.
    check(
      "update_brand_logo is a registered Genesis action",
      Boolean(GENESIS_ACTIONS.update_brand_logo) &&
        GENESIS_ACTIONS.update_brand_logo.authorizationTier === "always_ask",
      `tier = ${GENESIS_ACTIONS.update_brand_logo?.authorizationTier}`
    );
  } finally {
    // Restore. The store's real logo goes back exactly as it was.
    await prisma.store.update({ where: { id: store.id }, data: { logoUrl: originalLogoUrl } });
    const created = await prisma.businessRecord.findMany({
      where: { storeId: store.id, entityType: "asset", externalId: { in: [TEST_URL_A, TEST_URL_B] } },
      select: { id: true },
    });
    if (created.length > 0) {
      await prisma.businessRecord.deleteMany({ where: { storeId: store.id, id: { in: created.map((c) => c.id) } } });
    }
    console.log(`\nRestored logoUrl and removed ${created.length} test asset row(s).`);
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
