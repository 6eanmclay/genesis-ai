import { prisma } from "@/lib/prisma";
import { ASSET_ROLES, recordGeneratedAsset, resolveCurrentAsset } from "@/lib/businessModel/assets";

// One-time backfill: Store.logoUrl -> a designated brand.logo Asset.
//
// Stores created before designated assets existed (830788c) have a logoUrl
// and no asset record, so "the current brand logo" resolves to nothing for
// every store that already existed — which is all of the real ones. The
// Design layer needs an Asset to point at, so this closes that gap before it
// is built rather than after.
//
// NOTHING IS CHANGED OR REMOVED. Store.logoUrl is read and left exactly as it
// is: it stays the compatible, rendering path, and the Asset becomes the
// canonical thing J4 and the Design layer refer to. This script only ever
// creates records.
//
// IDEMPOTENT ON TWO LEVELS, deliberately, because "run it twice" is a thing
// that actually happens:
//   1. A store that already holds a brand.logo Asset is skipped outright.
//   2. Even without that check, persistSyncedRecords upserts on
//      @@unique([storeId, entityType, sourceProvider, externalId]) with the
//      URL as externalId, so the same logo re-recorded updates one row rather
//      than adding a second — and designateAsset returns early when the
//      current holder is the row being designated, so a re-run cannot make an
//      asset its own predecessor and hide it from resolveCurrentAsset.
//
// DRY RUN BY DEFAULT. Pass --apply to write. A backfill that writes the
// instant someone runs it to "see what it would do" is how a good script
// becomes a bad afternoon.
//
//   npx tsx scripts/backfill-brand-logo-assets.ts
//   npx tsx scripts/backfill-brand-logo-assets.ts --apply

const APPLY = process.argv.includes("--apply");

async function main() {
  const stores = await prisma.store.findMany({
    where: { logoUrl: { not: null } },
    select: { id: true, name: true, logoUrl: true },
  });

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${stores.length} store(s) with a logoUrl\n`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const store of stores) {
    const existing = await resolveCurrentAsset(store.id, ASSET_ROLES.brandLogo);
    if (existing) {
      skipped++;
      console.log(`  skip    ${store.name} — already has brand.logo (${existing.id})`);
      continue;
    }

    if (!APPLY) {
      created++;
      console.log(`  would   ${store.name} — ${store.logoUrl}`);
      continue;
    }

    const id = await recordGeneratedAsset({
      storeId: store.id,
      url: store.logoUrl!,
      role: ASSET_ROLES.brandLogo,
      category: "brand_logo",
      summary: `Brand logo for ${store.name}`,
      originalFilename: "brand-logo.png",
      // Honest: this logo may have been generated or may have come from a
      // creative direction. The one thing that is certainly true is that this
      // record came from the backfill.
      origin: "backfilled",
    });

    if (id) {
      created++;
      console.log(`  created ${store.name} — asset ${id}`);
    } else {
      failed++;
      console.log(`  FAILED  ${store.name} — ${store.logoUrl}`);
    }
  }

  console.log(
    `\n${APPLY ? "created" : "would create"} ${created}, skipped ${skipped}, failed ${failed}` +
      (APPLY ? "" : "\nRe-run with --apply to write.")
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
