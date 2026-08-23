import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import "dotenv/config";
import { prismaSystem } from "../lib/prisma";
import { persistSyncedRecords } from "../lib/businessModel/sync";
import { getBusinessProfile } from "../lib/businessModel/profile";
import { SocialAccountSchema } from "../lib/businessModel/entities";

// Real verification (2026-08-09) — IMPORTANT, honest scope: this does NOT
// verify a live Facebook/Instagram/TikTok connection, OAuth flow, or real
// API call — no credentials exist in this environment to do that (see
// SOCIAL_CONNECTIONS_SETUP.md). What this DOES verify, against the real
// database and real code, using realistic-shaped data modeled on the
// connectors' own actual output (never claimed as "real synced data"):
//   1. SocialAccountSchema actually accepts a real connector's output shape
//      and actually rejects a malformed one (persistSyncedRecords' own
//      real validation gate).
//   2. persistSyncedRecords really upserts a socialAccount BusinessRecord
//      and a re-sync really updates in place (never duplicates).
//   3. getBusinessProfile() really surfaces socialAccounts — the real gap
//      this session's own research found for Campaign records, deliberately
//      not repeated here.
// "Do not use fake credentials, mocked success states... to claim the
// integration works" (Sean) — this script makes no such claim. It proves
// the data pipeline downstream of a real sync is wired correctly; the
// live OAuth/API-calling code in facebook.ts/instagram.ts/tiktok.ts still
// needs a real account once credentials exist (see SOCIAL_CONNECTIONS_SETUP.md).
async function main() {
  // Refuses to run against anything but an isolated test database. These
  // suites create, mutate and delete rows — without this, a production
  // DATABASE_URL in the shell was enough to rename a real merchant's product.
  // See scripts/lib/requireTestDatabase.ts.
  await requireTestDatabase(prismaSystem);
  const store = await prismaSystem.store.findFirst({ select: { id: true } });
  if (!store) throw new Error("No real store found to test against");

  // Case 1: a realistic Instagram sync record — modeled on instagram.ts's
  // own real output shape, including a genuinely unavailable metric named
  // honestly (never fabricated to look complete).
  const instagramRecord = {
    platform: "instagram",
    accountName: "Cúbit & Coil",
    accountUsername: "cubitandcoil",
    profileUrl: "https://instagram.com/cubitandcoil",
    followerCount: 3421,
    followingCount: 180,
    mediaCount: 96,
    engagementRate: null,
    audienceDemographics: {
      ageRanges: { "18-24": 0.28, "25-34": 0.41, "35-44": 0.19 },
      genderSplit: null,
      topCountries: { US: 0.72, CA: 0.11 },
      topCities: null,
    },
    recentDailyMetrics: [
      { date: "2026-08-07", followerCount: null, reach: 812, impressions: 1204, profileViews: 44 },
      { date: "2026-08-08", followerCount: null, reach: 903, impressions: 1350, profileViews: 51 },
    ],
    topContent: [
      { externalId: "ig-1", caption: "New tensor ring drop", postedAt: "2026-08-05T14:00:00Z", permalink: null, metrics: { reach: 2100, engagement: 340 } },
    ],
    unavailableMetrics: ["engagementRate"],
    syncedFromApiAt: new Date().toISOString(),
  };

  const parsed = SocialAccountSchema.safeParse(instagramRecord);
  if (!parsed.success) throw new Error(`Case 1 FAILED: realistic Instagram shape rejected: ${parsed.error.message}`);
  console.log("Case 1 (SocialAccountSchema accepts a realistic connector output shape): PASS");

  // Case 2: schema genuinely rejects a malformed record (wrong type for
  // followerCount) — persistSyncedRecords' own real validation gate must
  // actually gate, not just typecheck.
  const malformed = { ...instagramRecord, followerCount: "a lot" };
  const rejectedResult = SocialAccountSchema.safeParse(malformed);
  if (rejectedResult.success) throw new Error("Case 2 FAILED: schema accepted a malformed record");
  console.log("Case 2 (schema genuinely rejects malformed data): PASS");

  const testExternalId = `verify-tmp-ig-${Date.now()}`;
  try {
    // Case 3: persistSyncedRecords really writes a real BusinessRecord.
    const firstSync = await persistSyncedRecords(
      store.id,
      "instagram",
      [{ entityType: "socialAccount", externalId: testExternalId, data: instagramRecord }],
      { provenance: "CONNECTOR", provenanceDetail: "instagram", statedById: null, modelExtracted: false }
    );
    if (firstSync.written !== 1 || firstSync.errors.length !== 0) {
      throw new Error(`Case 3 FAILED: expected 1 written, 0 errors, got ${JSON.stringify(firstSync)}`);
    }
    const afterFirst = await prismaSystem.businessRecord.findUnique({
      where: { storeId_entityType_sourceProvider_externalId: { storeId: store.id, entityType: "socialAccount", sourceProvider: "instagram", externalId: testExternalId } },
    });
    if (!afterFirst) throw new Error("Case 3 FAILED: record was not actually persisted");
    console.log("Case 3 (persistSyncedRecords writes a real BusinessRecord): PASS —", afterFirst.id);

    // Case 4: a re-sync with an updated follower count updates in place,
    // never duplicates — the real "don't re-create on every sync" guarantee.
    const updatedRecord = { ...instagramRecord, followerCount: 3450 };
    const secondSync = await persistSyncedRecords(
      store.id,
      "instagram",
      [{ entityType: "socialAccount", externalId: testExternalId, data: updatedRecord }],
      { provenance: "CONNECTOR", provenanceDetail: "instagram", statedById: null, modelExtracted: false }
    );
    if (secondSync.written !== 1) throw new Error("Case 4 FAILED: re-sync did not report a write");
    const allMatching = await prismaSystem.businessRecord.findMany({
      where: { storeId: store.id, entityType: "socialAccount", sourceProvider: "instagram", externalId: testExternalId },
    });
    if (allMatching.length !== 1) throw new Error(`Case 4 FAILED: expected exactly 1 row after re-sync, got ${allMatching.length}`);
    if ((allMatching[0].data as { followerCount: number }).followerCount !== 3450) {
      throw new Error("Case 4 FAILED: re-sync did not actually update the stored data");
    }
    console.log("Case 4 (re-sync updates in place, never duplicates): PASS");

    // Case 5: getBusinessProfile() really surfaces it — the real gap this
    // session's own research found for Campaign, deliberately not repeated.
    const profile = await getBusinessProfile(store.id);
    const found = profile.socialAccounts.find((r) => r.id === allMatching[0].id);
    if (!found) throw new Error("Case 5 FAILED: getBusinessProfile().socialAccounts did not include the synced record");
    if ((found.data as { followerCount: number }).followerCount !== 3450) {
      throw new Error("Case 5 FAILED: getBusinessProfile() returned stale data");
    }
    console.log("Case 5 (getBusinessProfile().socialAccounts surfaces real synced data): PASS");

    console.log("\nAll social-connections data-pipeline assertions passed.");
    console.log("NOT verified by this script (needs real credentials — see SOCIAL_CONNECTIONS_SETUP.md): the live OAuth flow, real Meta/TikTok API calls, and real account data.");
  } finally {
    await prismaSystem.businessRecord.deleteMany({
      where: { storeId: store.id, entityType: "socialAccount", sourceProvider: "instagram", externalId: testExternalId },
    });
  }
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
