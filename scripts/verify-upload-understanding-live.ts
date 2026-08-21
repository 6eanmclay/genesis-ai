import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// PHASE E — UPLOADS AND J4 UNDERSTANDING, ACROSS TWO BUSINESSES:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-upload-understanding-live.ts" -OutFile out.txt
//
// BUSINESS_CONTEXT.md Phase E names the surfaces adversarial coverage must
// reach: "switching, two concurrent requests naming different businesses,
// products, orders, connections, billing, Growth Points, J4 understanding,
// uploads, analytics, recommendations." The existing adversarial suite covers
// switching, the money screens and the two-tab case. Uploads and J4
// understanding were the two it never reached, and they are exactly the two the
// chat-turn migration touched — a photo uploaded from one business's workspace
// used to be attached to whichever business happened to be active.
//
// WHAT THIS SUITE HOLDS. An uploaded file belongs to the business it was
// uploaded into, everything derived from it belongs there too, and what J4
// understands about one business contains nothing from another — asserted by
// searching the whole serialized answer, not by checking the fields somebody
// remembered to check.
//
// NOT COVERED HERE, and named rather than implied: classifyAndExtractAsset
// calls a real model, so the extraction step needs provider credentials. The
// INGEST it feeds and the UNDERSTANDING it lands in are both real here, and the
// pure classification rules are proved by their own suites.

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

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { ingestBusinessAsset } = await import("@/lib/businessAssets/ingest");
  const { designateAsset, currentAssetsByRole, ASSET_ROLES, resolveOwnedImageUrl } = await import(
    "@/lib/businessModel/assets"
  );
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { getBusinessProfile } = await import("@/lib/businessModel/profile");
  const { businessFromSlug } = await import("@/lib/businessContext");
  const { planCommitments, recordCommitments, getCommitments } = await import(
    "@/lib/businessAssets/commitments"
  );
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const makeStore = (userId: string, name: string, slug: string) =>
    prisma.store.create({
      data: { userId, name, slug, tagline: `${name} tagline`, description: `${name} description`, currency: "USD" },
    });

  const owner = await prisma.user.create({ data: { email: "phase-e@example.test" } });
  const iron = await makeStore(owner.id, "Iron Gym", "iron-gym");
  const copper = await makeStore(owner.id, "Copper & Coil", "copper-coil");
  // Iron Gym is active throughout. Every assertion below about Copper & Coil is
  // therefore also an assertion that nothing fell back to the active business.
  await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: iron.id } });

  const IRON_FILE = "https://blob.example.test/uploads/iron-rack-plan.pdf";
  const COPPER_FILE = "https://blob.example.test/uploads/copper-lease.pdf";

  // ==========================================================================
  console.log("\n=== 1. An upload belongs to the business it was uploaded into ===\n");
  // ==========================================================================
  const ironAsset = await ingestBusinessAsset(iron.id, {
    url: IRON_FILE,
    originalFilename: "iron-rack-plan.pdf",
    contentType: "application/pdf",
  });
  // The one that matters: uploaded into the business that is NOT active.
  const copperAsset = await ingestBusinessAsset(copper.id, {
    url: COPPER_FILE,
    originalFilename: "copper-lease.pdf",
    contentType: "application/pdf",
  });

  const ironRows = await prisma.businessRecord.findMany({
    where: { storeId: iron.id, entityType: "asset" },
    select: { id: true, externalId: true },
  });
  const copperRows = await prisma.businessRecord.findMany({
    where: { storeId: copper.id, entityType: "asset" },
    select: { id: true, externalId: true },
  });
  check("Iron Gym holds exactly its own file", ironRows.map((r) => r.externalId), [IRON_FILE]);
  check("Copper & Coil holds exactly its own", copperRows.map((r) => r.externalId), [COPPER_FILE]);
  assert(
    "the upload into the INACTIVE business landed there",
    copperRows.length === 1,
    "not in Iron Gym, which is the active one"
  );

  // ==========================================================================
  console.log("\n=== 2. A file is only usable by the business that owns it ===\n");
  // ==========================================================================
  assert("its own business can use it", (await resolveOwnedImageUrl(copper.id, COPPER_FILE)) !== null);
  check("the other business cannot", await resolveOwnedImageUrl(iron.id, COPPER_FILE), null);
  check("and not the other way round either", await resolveOwnedImageUrl(copper.id, IRON_FILE), null);

  // ==========================================================================
  console.log("\n=== 3. Designation follows the business, not the account ===\n");
  // ==========================================================================
  await designateAsset(iron.id, ironAsset.id, ASSET_ROLES.brandLogo);
  const ironRoles = await currentAssetsByRole(iron.id);
  const copperRoles = await currentAssetsByRole(copper.id);
  assert("Iron Gym has a designated logo", Boolean(ironRoles[ASSET_ROLES.brandLogo]));
  check("Copper & Coil has none", Object.keys(copperRoles), []);

  // A designation aimed at the wrong business is a no-op, not a cross-write.
  await designateAsset(copper.id, ironAsset.id, ASSET_ROLES.brandLogo);
  check(
    "designating another business's asset changes nothing",
    Object.keys(await currentAssetsByRole(copper.id)),
    []
  );
  assert(
    "and does not disturb the real owner's designation",
    Boolean((await currentAssetsByRole(iron.id))[ASSET_ROLES.brandLogo])
  );

  // ==========================================================================
  console.log("\n=== 4. What is derived from a file stays with that file ===\n");
  // ==========================================================================
  // Commitments are the real derived-knowledge case: read out of a document,
  // written as their own records, and read back through Understanding.
  await recordCommitments(
    copper.id,
    planCommitments({
      raw: [
        {
          title: "Workshop lease renewal",
          kind: "lease",
          dueDate: "2027-03-31",
          counterparty: "Hartlepool Industrial Estates",
          amountInCents: 145_000,
          sourceQuote: "This lease shall terminate on 31 March 2027 unless renewed.",
        },
      ],
      assetRecordId: copperAsset.id,
      confidence: 0.9,
    })
  );

  const copperCommitments = await getCommitments(copper.id);
  const ironCommitments = await getCommitments(iron.id);
  check("the deadline belongs to the business whose lease it is", copperCommitments.upcoming.length, 1);
  check("and points back at that business's own document",
    copperCommitments.upcoming[0].sourceAssetRecordId, copperAsset.id);
  check("the other business has no deadline at all", ironCommitments.upcoming.length, 0);
  check("not a zero-date or a borrowed one — none", ironCommitments.nextDueDate, null);

  // ==========================================================================
  console.log("\n=== 5. J4 understands one business at a time ===\n");
  // ==========================================================================
  const ironUnderstanding = await getBusinessUnderstanding(iron.id, { viewerUserId: owner.id });
  const copperUnderstanding = await getBusinessUnderstanding(copper.id, { viewerUserId: owner.id });

  check("each is about its own business", ironUnderstanding.profile.identity.name, "Iron Gym");
  check("and the other about its own", copperUnderstanding.profile.identity.name, "Copper & Coil");

  // THE ASSERTION THAT MATTERS, and it searches the whole answer rather than
  // the fields somebody remembered to check: if any part of one business's
  // uploaded knowledge appears in the other's understanding, this fails.
  const ironSerialized = JSON.stringify(ironUnderstanding);
  const copperSerialized = JSON.stringify(copperUnderstanding);

  assert("Iron Gym's understanding knows its own file", ironSerialized.includes(IRON_FILE));
  check(
    "and contains no trace of Copper & Coil's",
    [COPPER_FILE, "Workshop lease renewal", "Hartlepool Industrial Estates", "Copper & Coil"].filter((s) =>
      ironSerialized.includes(s)
    ),
    []
  );
  assert("Copper & Coil's knows its own lease", copperSerialized.includes("Workshop lease renewal"));
  check(
    "and contains no trace of Iron Gym's",
    [IRON_FILE, "Iron Gym"].filter((s) => copperSerialized.includes(s)),
    []
  );

  // The profile's own asset list, checked separately — it is what feeds every
  // prompt, so a leak here reaches J4's actual words.
  const ironProfile = await getBusinessProfile(iron.id);
  const copperProfile = await getBusinessProfile(copper.id);
  check("each profile lists only its own assets", ironProfile.assets.length, 1);
  check("and so does the other", copperProfile.assets.length, 1);
  assert(
    "with no overlap between them",
    !JSON.stringify(ironProfile.assets).includes(COPPER_FILE) &&
      !JSON.stringify(copperProfile.assets).includes(IRON_FILE)
  );

  // ==========================================================================
  console.log("\n=== 6. Two understandings, resolved at the same time ===\n");
  // ==========================================================================
  // The two-tab case for Understanding: if either read leaned on ambient state,
  // one of these would come back as the other.
  const [tabIron, tabCopper] = await Promise.all([
    getBusinessUnderstanding(iron.id, { viewerUserId: owner.id }),
    getBusinessUnderstanding(copper.id, { viewerUserId: owner.id }),
  ]);
  check("the Iron Gym tab is Iron Gym", tabIron.profile.identity.name, "Iron Gym");
  check("the Copper & Coil tab is Copper & Coil", tabCopper.profile.identity.name, "Copper & Coil");
  check("their commitments do not cross",
    [tabIron.commitments.upcoming.length, tabCopper.commitments.upcoming.length], [0, 1]);

  // ==========================================================================
  console.log("\n=== 7. The upload path refuses a business it cannot reach ===\n");
  // ==========================================================================
  // What the chat-turn helper does with the slug the composer sent. A stranger's
  // business must be indistinguishable from one that does not exist.
  const stranger = await prisma.user.create({ data: { email: "phase-e-stranger@example.test" } });
  await makeStore(stranger.id, "Somebody Else", "somebody-else");

  check("a business you cannot reach is null", await businessFromSlug(owner.id, "somebody-else"), null);
  check("a slug naming nothing is null too", await businessFromSlug(owner.id, "no-such-business"), null);
  assert(
    "and your own resolves, so the refusal is not blanket",
    (await businessFromSlug(owner.id, "copper-coil"))?.store.id === copper.id
  );

  // NEGATIVE CONTROL, made real: an upload aimed at a business the account
  // cannot reach must not exist anywhere afterwards.
  const before = await prisma.businessRecord.count({ where: { entityType: "asset" } });
  const refused = await businessFromSlug(owner.id, "somebody-else");
  if (refused) {
    // Unreachable unless the refusal broke — and if it did, the upload would
    // have happened, so the count assertion below is what catches it.
    await ingestBusinessAsset(refused.store.id, {
      url: "https://blob.example.test/uploads/should-not-exist.pdf",
      originalFilename: "should-not-exist.pdf",
      contentType: "application/pdf",
    });
  }
  check("nothing was uploaded anywhere", await prisma.businessRecord.count({ where: { entityType: "asset" } }), before);
  check(
    "and the stranger's business is untouched",
    await prisma.businessRecord.count({
      where: { storeId: (await prisma.store.findUniqueOrThrow({ where: { slug: "somebody-else" } })).id },
    }),
    0
  );

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All upload/understanding assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
