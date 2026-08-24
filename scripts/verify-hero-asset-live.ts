import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// AN UPLOADED PHOTO REACHES THE STOREFRONT — or nothing is claimed:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-hero-asset-live.ts" -OutFile out.txt
//
// THE BUG THIS CLOSES (reported 2026-08-09). Six real photos were uploaded, J4
// said "let me put these six to work in the store's design", the owner approved
// — and the live storefront contained none of them. The approved changes were
// text and layout. The asset reference never existed in the proposal, so there
// was nothing for execution to apply, and execution reported success anyway.
//
// Sean's own requirement, and what each part is asserted by below:
//
//   "the proposed change must contain an explicit reference to the real asset"
//        -> §2: a URL that is not this store's own is refused, not written
//   "Upload -> Understand -> Propose -> Approve -> Execute -> Verify must
//    preserve that reference end to end"
//        -> §3: the uploaded asset's own URL survives into the blueprint the
//           storefront reads
//   "The verify step must confirm the image actually exists in the resulting
//    storefront - J4 should not report success if it only changed text"
//        -> §4: verify() fails when the image did not land
//        -> §5: and fails when it DID land on a storefront that cannot show
//           it, which is the same broken promise reached from the other
//           direction — and the more dangerous one, because every part of the
//           system agrees it worked
//
// §6 covers the consolidation the codebase itself asked for: one writer for
// blueprint.homepageContent, so neither door drops the other's fields.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { updateHeroExecutable } = await import("@/lib/execution/executables/updateHero");
  const { resolveOwnedImageUrl } = await import("@/lib/businessModel/assets");
  const { writeHomepageContent } = await import("@/lib/storefront/homepageContent");
  const { setStorefrontHeroImage } = await import("@/lib/design/composeForStorefront");
  const { ingestBusinessAsset } = await import("@/lib/businessAssets/ingest");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { DEFAULT_THEME } = await import("@/lib/theme");
  const { Prisma } = await import("@prisma/client");

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  let n = 0;
  async function business(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}-${++n}@example.test` } });
    return prisma.store.create({
      data: {
        userId: user.id,
        name: slug,
        slug,
        tagline: "t",
        description: "d",
        currency: "USD",
        // A HERO LAYOUT THAT CAN ACTUALLY SHOW AN IMAGE (2026-08-22).
        //
        // Added because its absence was hiding a real defect. Three of the four
        // hero layouts render no image at all and the default is one of them,
        // so this suite's own "the upload reaches the storefront, end to end"
        // was being proved against a store whose storefront would never have
        // displayed it. verify() agreed, because it only checked the value had
        // round-tripped. §6 below now covers the case this fixture used to be.
        theme: { ...DEFAULT_THEME, composition: { ...DEFAULT_THEME.composition!, heroLayout: "split" } },
        blueprint: {
          theme: { primary: "#123456" },
          homepageContent: {
            heroHeadline: "Original headline",
            heroSubheadline: "Original subheadline",
            primaryCallToAction: "Shop now",
            aboutUs: "A real about-us paragraph nobody should lose.",
          },
          sectionOrder: ["hero", "products"],
        },
      },
    });
  }

  const homepageOf = async (storeId: string) => {
    const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { blueprint: true } });
    return (store.blueprint as { homepageContent?: Record<string, unknown> }).homepageContent ?? {};
  };
  const ctx = (storeId: string) => ({ storeId }) as never;

  await reset();
  const store = await business("hero-store");
  const other = await business("other-store");

  // A REAL UPLOAD, through the real ingest path — not a hand-written record.
  const UPLOAD = "https://blob.example.test/uploads/workshop-bench.png";
  await ingestBusinessAsset(store.id, {
    url: UPLOAD,
    originalFilename: "workshop-bench.png",
    contentType: "image/png",
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: "Bench",
      description: "d",
      priceInCents: 1000,
      active: true,
      imageUrl: "https://blob.example.test/products/bench.png",
    },
  });
  // Another business's upload. Real, and not this store's to use.
  const THEIRS = "https://blob.example.test/uploads/someone-elses.png";
  await ingestBusinessAsset(other.id, {
    url: THEIRS,
    originalFilename: "someone-elses.png",
    contentType: "image/png",
  });

  // ==========================================================================
  console.log("\n=== 1. What counts as a real reference ===\n");
  // ==========================================================================
  assert("an uploaded asset resolves", (await resolveOwnedImageUrl(store.id, UPLOAD))?.source === "asset");
  assert(
    "an existing product photo resolves",
    (await resolveOwnedImageUrl(store.id, product.imageUrl!))?.source === "product"
  );
  check("an invented URL resolves to nothing",
    await resolveOwnedImageUrl(store.id, "https://blob.example.test/uploads/never-existed.png"), null);
  check("another business's real upload resolves to nothing here",
    await resolveOwnedImageUrl(store.id, THEIRS), null);
  check("an empty string is not a reference", await resolveOwnedImageUrl(store.id, ""), null);

  // ==========================================================================
  console.log("\n=== 2. A fabricated image is refused, not written ===\n");
  // ==========================================================================
  const before = await homepageOf(store.id);
  const invented = await rejects(() =>
    updateHeroExecutable.run(
      {
        heroHeadline: "New headline",
        heroSubheadline: "New subheadline",
        heroImageUrl: "https://blob.example.test/uploads/never-existed.png",
      },
      ctx(store.id)
    )
  );
  assert("execution refuses an image this business does not own", invented !== null);
  assert("and says so in the owner's terms", (invented ?? "").includes("isn't one of this business's own files"));
  // THE PART THAT MATTERS MOST: a refusal must not half-apply. The headline
  // change rode along with the image, and neither may land.
  check("nothing at all was written — not even the text", await homepageOf(store.id), before);

  const borrowed = await rejects(() =>
    updateHeroExecutable.run(
      { heroHeadline: "h", heroSubheadline: "s", heroImageUrl: THEIRS },
      ctx(store.id)
    )
  );
  assert("another business's real image is refused too", borrowed !== null);
  check("and still nothing was written", await homepageOf(store.id), before);

  // ==========================================================================
  console.log("\n=== 3. The upload reaches the storefront, end to end ===\n");
  // ==========================================================================
  const applied = await updateHeroExecutable.run(
    { heroHeadline: "Made by hand", heroSubheadline: "In Hartlepool", heroImageUrl: UPLOAD },
    ctx(store.id)
  );
  const after = await homepageOf(store.id);
  check("the uploaded photo is on the storefront blueprint", after.heroImageUrl, UPLOAD);
  check("the headline changed with it", after.heroHeadline, "Made by hand");
  // app/store/[slug]/page.tsx reads exactly this field — the same key the
  // rendered page uses, so this is the storefront's own value, not a parallel one.
  assert("under the key the live page reads", "heroImageUrl" in after);
  check("the reference is reported back, not just written", applied.metadata?.heroImageUrl, UPLOAD);
  assert("and the message says an image changed", applied.message.includes("image"));
  // Content the proposal never mentioned must survive.
  check("unrelated homepage content is untouched", after.aboutUs, "A real about-us paragraph nobody should lose.");
  check("and so is the rest of the blueprint",
    ((await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { blueprint: true } }))
      .blueprint as { sectionOrder?: unknown }).sectionOrder, ["hero", "products"]);

  // ==========================================================================
  console.log("\n=== 4. Verify refuses to call a missed image a success ===\n");
  // ==========================================================================
  check("verify passes when the image really landed",
    await updateHeroExecutable.verify(
      { heroHeadline: "x", heroSubheadline: "y", heroImageUrl: UPLOAD },
      ctx(store.id),
      undefined
    ),
    { state: "verified" });

  // The original bug, reproduced exactly: text applied, image silently not.
  await writeHomepageContent(store.id, { heroImageUrl: null });
  const missed = await updateHeroExecutable.verify(
    { heroHeadline: "x", heroSubheadline: "y", heroImageUrl: UPLOAD },
    ctx(store.id),
    undefined
  );
  check("verify FAILS when only the text changed", (missed.state === 'verified'), false);
  assert("and says the image is what did not save",
    missed.state === "failed" && missed.mismatches.join(" ").includes("hero image"));

  check("a text-only proposal has no image claim to verify",
    await updateHeroExecutable.verify({ heroHeadline: "x", heroSubheadline: "y" }, ctx(store.id), undefined),
    { state: "verified" });

  // ==========================================================================
  console.log("\n=== 5. Saved is not the same as shown ===\n");
  // ==========================================================================
  // THE GAP SEAN REPORTED, in its second form. §4 covers the image failing to
  // save. This covers the image saving perfectly and still not being there: on
  // a store using any hero layout but `split` — including the default every
  // store starts on — the field round-trips and the page renders nothing.
  //
  // Before this, verify() confirmed the round-trip and reported success. J4
  // said it would use the photo, said it had, and the storefront did not have
  // it. That is the same broken promise as a failed write, reached from the
  // opposite direction — and it is the more dangerous one, because everything
  // in the system agrees it worked.
  //
  // Theme cleared to null rather than set to a chosen layout: that is the real
  // "no composition of its own yet" state, and it is resolved through the same
  // DEFAULT_THEME fallback the storefront uses — so this asserts against what a
  // store genuinely falls back to, not against a layout picked to fail.
  const plain = await business("hero-default-layout");
  await prisma.store.update({ where: { id: plain.id }, data: { theme: Prisma.DbNull } });
  const PLAIN_UPLOAD = "https://blob.example.test/uploads/shop-front.png";
  await ingestBusinessAsset(plain.id, {
    url: PLAIN_UPLOAD,
    originalFilename: "shop-front.png",
    contentType: "image/png",
  });
  await updateHeroExecutable.run(
    { heroHeadline: "x", heroSubheadline: "y", heroImageUrl: PLAIN_UPLOAD },
    ctx(plain.id)
  );
  check("the image really is saved", (await homepageOf(plain.id)).heroImageUrl, PLAIN_UPLOAD);

  const unseen = await updateHeroExecutable.verify(
    { heroHeadline: "x", heroSubheadline: "y", heroImageUrl: PLAIN_UPLOAD },
    ctx(plain.id),
    undefined
  );
  check("but verify refuses to call it done", (unseen.state === 'verified'), false);
  const unseenWhy = unseen.state === "failed" ? unseen.mismatches.join(" ") : "";
  assert("and says why the owner will not see it", unseenWhy.includes("layout"), unseenWhy);
  assert(
    "so J4 cannot report a photo is on a page that does not show one",
    (unseen.state === 'verified') === false,
    "saved and shown are different claims, and only one is what the owner asked for"
  );

  // ==========================================================================
  console.log("\n=== 6. One writer, two doors ===\n");
  // ==========================================================================
  // A text-only hero edit must leave an existing image alone — "not mentioned"
  // is not "remove it".
  await updateHeroExecutable.run({ heroHeadline: "A", heroSubheadline: "B", heroImageUrl: UPLOAD }, ctx(store.id));
  await updateHeroExecutable.run({ heroHeadline: "C", heroSubheadline: "D" }, ctx(store.id));
  const kept = await homepageOf(store.id);
  check("a text-only edit leaves the image in place", kept.heroImageUrl, UPLOAD);
  check("while the text does change", kept.heroHeadline, "C");

  // An explicit null is a real instruction, and must be told apart from absence.
  await updateHeroExecutable.run({ heroHeadline: "E", heroSubheadline: "F", heroImageUrl: null }, ctx(store.id));
  check("an explicit null clears the image", (await homepageOf(store.id)).heroImageUrl, null);

  // The design door writes the same field through the same writer.
  await setStorefrontHeroImage(store.id, UPLOAD);
  const viaDesign = await homepageOf(store.id);
  check("the design door reaches the same field", viaDesign.heroImageUrl, UPLOAD);
  check("without dropping the conversational door's headline", viaDesign.heroHeadline, "E");
  check("or anything else on the page", viaDesign.aboutUs, "A real about-us paragraph nobody should lose.");

  await reset();
  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All hero-asset assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
