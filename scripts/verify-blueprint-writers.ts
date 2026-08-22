import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { updateSeoExecutable } from "@/lib/execution/executables/updateSeo";
import { updateHomepageContentExecutable } from "@/lib/execution/executables/updateHomepageContent";
import { updateBrandIdentityExecutable } from "@/lib/execution/executables/updateBrandIdentity";
import { updateStoreContentExecutable } from "@/lib/execution/executables/updateStoreContent";
import { updateDesignDirectionExecutable } from "@/lib/execution/executables/updateDesignDirection";
import { updateMarketingAssetsExecutable } from "@/lib/execution/executables/updateMarketingAssets";
import type { Executable } from "@/lib/execution/executable";

// EVERY ACTION THAT WRITES A STORE'S BLUEPRINT, AND THE ONE SPREAD THEY ALL
// DEPEND ON:
//
//   npx tsx scripts/run-db-suites.ts
//
// Store.blueprint is one opaque Json column holding everything Genesis knows
// about how a business presents itself — its brand identity, its homepage copy,
// its policies, its SEO, its design direction. Six executables write into it,
// none had coverage, and every one of them does the same thing:
//
//     const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
//     const updated = { ...blueprint, section: { ...blueprint.section, ...input } };
//
// TWO SPREADS, AND BOTH ARE LOAD BEARING. Drop the outer one and approving an
// SEO change erases the owner's brand story, homepage copy, policies and design
// direction in a single write. Drop the inner one and it erases the rest of its
// OWN section — an SEO title update that clears the meta description.
//
// Neither is a type error. `{ marketingAssets: input }` compiles perfectly and
// destroys a business's accumulated identity, and there is no undo: the
// blueprint is not versioned. That is what this suite exists for, and it is
// asserted the only way it can be — by writing a full blueprint, running each
// action, and checking every OTHER field is still there afterwards.
//
// The same check covers the cross-store boundary, because these all resolve the
// store from ctx rather than from input: one business's approved change must
// never land in another's blueprint.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** A full blueprint, so anything that gets clobbered is visibly missing. */
const FULL_BLUEPRINT = {
  brandIdentity: {
    brandStory: "ZZSTORY",
    missionStatement: "ZZMISSION",
    coreValues: ["ZZVALUE"],
  },
  homepageContent: {
    heroHeadline: "ZZHERO",
    aboutUs: "ZZABOUT",
    primaryCallToAction: "ZZCTA",
  },
  marketingAssets: {
    seoTitle: "ZZSEOTITLE",
    seoMetaDescription: "ZZSEODESC",
    brandKeywords: ["ZZKEYWORD"],
  },
  storeContent: {
    shippingPolicy: "ZZSHIPPING",
    returnPolicy: "ZZRETURNS",
  },
  designDirection: {
    visualStyle: "ZZSTYLE",
    brandMood: "ZZMOOD",
  },
};

/** Every marker the blueprint above contains, flattened. */
function markersIn(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.startsWith("ZZ")) found.push(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") return Object.values(v).forEach(walk);
  };
  walk(value);
  return found.sort();
}

const ALL_MARKERS = markersIn(FULL_BLUEPRINT);

interface Case {
  name: string;
  executable: Executable<never, unknown>;
  input: Record<string, unknown>;
  /** The section it writes, and every marker inside it this input replaces. */
  section: string;
  replaces: string[];
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: `bp-${Date.now()}@test.local`, name: "Owner" },
  });
  const other = await prisma.store.create({
    data: { userId: user.id, name: "Iron Gym", slug: `bp-other-${Date.now()}`, blueprint: FULL_BLUEPRINT as never },
  });

  const CASES: Case[] = [
    {
      name: "update_seo",
      executable: updateSeoExecutable as never,
      input: { seoTitle: "A new title", seoMetaDescription: "A new description" },
      section: "marketingAssets",
      // Two, because the input names both fields — a one-marker expectation
      // read a correct replacement as a loss on the first run.
      replaces: ["ZZSEOTITLE", "ZZSEODESC"],
    },
    {
      name: "update_homepage_content",
      executable: updateHomepageContentExecutable as never,
      input: { heroHeadline: "A new headline" },
      section: "homepageContent",
      replaces: ["ZZHERO"],
    },
    {
      name: "update_brand_identity",
      executable: updateBrandIdentityExecutable as never,
      input: { brandStory: "A new story" },
      section: "brandIdentity",
      replaces: ["ZZSTORY"],
    },
    {
      name: "update_store_content",
      executable: updateStoreContentExecutable as never,
      input: { shippingPolicy: "A new policy" },
      section: "storeContent",
      replaces: ["ZZSHIPPING"],
    },
    {
      name: "update_design_direction",
      executable: updateDesignDirectionExecutable as never,
      input: { visualStyle: "A new style" },
      section: "designDirection",
      replaces: ["ZZSTYLE"],
    },
    {
      name: "update_marketing_assets",
      executable: updateMarketingAssetsExecutable as never,
      input: { brandKeywords: ["new"] },
      section: "marketingAssets",
      replaces: ["ZZKEYWORD"],
    },
  ];

  const stores: string[] = [other.id];

  try {
    // ========================================================================
    console.log("\n=== 1. One approved change never erases the rest ===\n");
    // ========================================================================
    for (const testCase of CASES) {
      const store = await prisma.store.create({
        data: {
          userId: user.id,
          name: "Copper & Coil",
          slug: `bp-${testCase.name}-${Date.now()}`,
          blueprint: FULL_BLUEPRINT as never,
        },
      });
      stores.push(store.id);

      await testCase.executable.run(testCase.input as never, { storeId: store.id, userId: user.id } as never);
      const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
      const surviving = markersIn(after.blueprint);

      // Everything except the one marker this action genuinely replaces.
      const expected = ALL_MARKERS.filter((m) => !testCase.replaces.includes(m));
      const lost = expected.filter((m) => !surviving.includes(m));
      check(`${testCase.name} keeps every other part of the blueprint`, lost.length === 0,
        lost.length ? `lost ${JSON.stringify(lost)}` : "");

      // And it did change what it was asked to change, so the check above
      // cannot be passing because nothing happened.
      const section = (after.blueprint as Record<string, Record<string, unknown>>)[testCase.section];
      const [field, value] = Object.entries(testCase.input)[0];
      check(`${testCase.name} actually applied its change`,
        JSON.stringify(section?.[field]) === JSON.stringify(value),
        `${field} = ${JSON.stringify(section?.[field])}`);

      // The inner spread: everything else in ITS OWN section survives too.
      // The inner spread: what it replaced is genuinely gone, and nothing it
      // did not name went with it.
      const stillThere = testCase.replaces.filter((m) => surviving.includes(m));
      check(`${testCase.name} replaced exactly what it was given`, stillThere.length === 0,
        `still present: ${JSON.stringify(stillThere)}`);
    }

    // ========================================================================
    console.log("\n=== 2. A store with no blueprint gains one, not a crash ===\n");
    // ========================================================================
    const blank = await prisma.store.create({
      data: { userId: user.id, name: "Blank", slug: `bp-blank-${Date.now()}` },
    });
    stores.push(blank.id);
    await updateSeoExecutable.run(
      { seoTitle: "First title", seoMetaDescription: "First description" } as never,
      { storeId: blank.id, userId: user.id } as never
    );
    const seeded = await prisma.store.findUniqueOrThrow({ where: { id: blank.id } });
    const marketing = (seeded.blueprint as Record<string, Record<string, unknown>>)?.marketingAssets;
    check("a store that had no blueprint gets the section it needed",
      marketing?.seoTitle === "First title", JSON.stringify(marketing));
    check("and nothing else was invented alongside it",
      Object.keys(seeded.blueprint as object).length === 1,
      JSON.stringify(Object.keys(seeded.blueprint as object)));

    // ========================================================================
    console.log("\n=== 3. One business's change never lands in another's ===\n");
    // ========================================================================
    // These resolve the store from ctx rather than from input, so the wrong
    // business can only be reached by passing the wrong ctx — the property to
    // pin is that the OTHER store is untouched by every write above.
    const untouched = await prisma.store.findUniqueOrThrow({ where: { id: other.id } });
    check("the other business's blueprint is exactly as it was",
      markersIn(untouched.blueprint).join(",") === ALL_MARKERS.join(","),
      JSON.stringify(markersIn(untouched.blueprint)));
    check(
      "after six approved changes in a different business",
      markersIn(untouched.blueprint).length === ALL_MARKERS.length,
      "the blueprint is not versioned — there is no undo for a cross-store write"
    );

    // ========================================================================
    console.log("\n=== 4. Every writer asks for a real permission ===\n");
    // ========================================================================
    for (const testCase of CASES) {
      check(`${testCase.name} requires a permission`,
        Boolean(testCase.executable.requiredPermission),
        String(testCase.executable.requiredPermission));
      check(`${testCase.name} names a real execution action`,
        typeof testCase.executable.action === "string" && testCase.executable.action.length > 0,
        String(testCase.executable.action));
    }
  } finally {
    await prisma.store.deleteMany({ where: { id: { in: stores } } });
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
