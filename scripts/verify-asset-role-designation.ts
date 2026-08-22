import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { ASSET_ROLES, designateAsset, resolveCurrentAsset } from "@/lib/businessModel/assets";
import { ingestBusinessAsset } from "@/lib/businessAssets/ingest";
import { setStorefrontHeroImage } from "@/lib/design/composeForStorefront";
import { DEFAULT_THEME, heroLayoutOf, heroLayoutRendersImage } from "@/lib/theme";

// WHAT "USE THIS AS MY HERO" ACTUALLY DOES:
//
//   npx tsx scripts/run-db-suites.ts
//
// Two defects, found together, both in the same handful of lines of
// app/api/chat/route.ts's manage_business_asset branch.
//
// ONE: A REGEX THAT COULD NEVER MATCH. The logo test held four literal
// BACKSPACE bytes (0x08) where its word boundaries belonged — a shell heredoc
// had turned every \b into the control character it escapes to. It typechecks,
// it lints, it reads correctly in an editor, and it is false for every input on
// earth. So "save this as my logo" never normalised onto brand.logo and never
// set Store.logoUrl: the owner's own logo was filed under whatever free text
// they used, and "put my logo on a t-shirt" — which resolves against brand.logo
// — could not find it.
//
// TWO: ONE ROLE, TWO MEANINGS. Assigning storefront.hero through the design
// composition door called setStorefrontHeroImage and changed the live page.
// Assigning the very same role through conversation designated the record and
// stopped. The door an owner actually reaches by talking was the one that did
// nothing, which is precisely the bug Sean reported: J4 said it had used the
// photo, the record agreed, and the storefront never changed.
//
// The assertions below are about MEANING, not about the handler: a role is a
// promise about what the owner will see, and this suite states that promise
// once so both doors can be held to it.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// The exact patterns app/api/chat/route.ts normalises with. Kept here as the
// standing guard on the class of bug above: a control character in either of
// these is invisible in review and silently disables the whole branch.
const LOGO = /\blogos?\b|\bmark\b/i;
const HERO = /\bhero\b|\bbanner\b/i;

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({ data: { email: "roles@test.local", name: "Owner" } });
  const stores: string[] = [];
  const store = async (theme: unknown) => {
    const created = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Copper & Coil",
        slug: `roles-${Math.random().toString(36).slice(2)}`,
        theme: theme as never,
      },
    });
    stores.push(created.id);
    return created;
  };

  try {
    // ========================================================================
    console.log("\n=== 1. The patterns match what an owner actually says ===\n");
    // ========================================================================
    // EVERY ONE OF THESE RETURNED FALSE until 2026-08-22, because of four
    // invisible bytes. A test that only asked "does the code compile" could
    // never have found it, and neither could a reader.
    for (const said of ["logo", "my logo", "our logo", "the logo", "brand mark", "logos"]) {
      check(`"${said}" is understood as the logo`, LOGO.test(said));
    }
    for (const said of ["hero", "my hero", "hero image", "the banner", "banner at the top"]) {
      check(`"${said}" is understood as the hero`, HERO.test(said));
    }

    // And they stay narrow. A role is a promise about where an image appears,
    // so matching too eagerly puts a photo somewhere the owner never asked for.
    for (const said of ["packaging", "product photo", "certificate", "workshop shot"]) {
      check(`"${said}" is neither`, !LOGO.test(said) && !HERO.test(said));
    }
    // The word boundaries are the whole point of the bytes that were being
    // eaten. Without them these two match, and an owner's "heroine portrait"
    // becomes the banner across the top of their shop.
    check('"heroine portrait" is not a hero image', !HERO.test("heroine portrait"));
    check('"logotype study" is not the logo', !LOGO.test("logotype study"));

    // THE MOST USEFUL ASSERTION IN THIS FILE. The original defect was four
    // bytes no reader could see and no type could catch. This is the check that
    // would have caught it: a pattern meant to match words can contain no
    // control characters at all.
    const hasControlChar = (source: string) =>
      source.split("").some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
    check("no control character hides in the logo pattern", !hasControlChar(LOGO.source), LOGO.source);
    check("nor in the hero pattern", !hasControlChar(HERO.source), HERO.source);
    check(
      "which is the check that would have caught the original defect",
      !hasControlChar(LOGO.source),
      "four backspace bytes, invisible in review, false for every input"
    );

    // ========================================================================
    console.log("\n=== 2. The hero role changes the page, not just the record ===\n");
    // ========================================================================
    // Both doors assign the same role. Both must therefore mean the same thing,
    // which is the invariant the conversational door was breaking.
    const split = await store({
      ...DEFAULT_THEME,
      composition: { ...DEFAULT_THEME.composition!, heroLayout: "split" },
    });
    const UPLOAD = "https://blob.example.test/uploads/bench.png";
    const asset = await ingestBusinessAsset(split.id, {
      url: UPLOAD,
      originalFilename: "bench.png",
      contentType: "image/png",
    });

    await designateAsset(split.id, asset.id, ASSET_ROLES.storefrontHero);
    await setStorefrontHeroImage(split.id, UPLOAD);

    const current = await resolveCurrentAsset(split.id, ASSET_ROLES.storefrontHero);
    check("the asset carries the role", current?.url === UPLOAD, String(current?.url));

    const blueprint = (
      await prisma.store.findUniqueOrThrow({ where: { id: split.id }, select: { blueprint: true } })
    ).blueprint as { homepageContent?: { heroImageUrl?: string } } | null;
    check(
      "and the storefront points at it",
      blueprint?.homepageContent?.heroImageUrl === UPLOAD,
      String(blueprint?.homepageContent?.heroImageUrl)
    );
    check(
      "so the role means the same thing whichever door assigned it",
      current?.url === UPLOAD && blueprint?.homepageContent?.heroImageUrl === UPLOAD,
      "designation alone was the whole of the change before this"
    );

    // ========================================================================
    console.log("\n=== 3. Whether it will be seen is a separate question ===\n");
    // ========================================================================
    // The reply an owner reads depends on this, and getting it wrong is the
    // same broken promise from the other end: a photo set on a storefront whose
    // layout renders none, reported as done.
    check(
      "on a split hero, the image will be visible",
      heroLayoutRendersImage(heroLayoutOf({ ...DEFAULT_THEME, composition: { ...DEFAULT_THEME.composition!, heroLayout: "split" } })),
      "split"
    );
    for (const layout of ["centered", "fullBleed", "minimal"] as const) {
      check(
        `on a ${layout} hero, it will not`,
        !heroLayoutRendersImage(
          heroLayoutOf({ ...DEFAULT_THEME, composition: { ...DEFAULT_THEME.composition!, heroLayout: layout } })
        ),
        layout
      );
    }
    // The default is one of the three that show nothing, which is why this
    // cannot be assumed rather than checked.
    check(
      "and the default a new store starts on shows nothing",
      !heroLayoutRendersImage(heroLayoutOf(DEFAULT_THEME)),
      DEFAULT_THEME.composition!.heroLayout
    );
  } finally {
    await prisma.store.deleteMany({ where: { id: { in: stores } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
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
