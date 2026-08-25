import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { getIntegrationIssues } from "@/lib/dashboard/needsAttention";
import { readFileSync } from "fs";
import { join } from "path";

// A CONNECTION THAT STOPPED WORKING SAYS SO:
//
//   npx tsx scripts/run-db-suites.ts connection-health
//
// Two defects found in production on 2026-08-25, both of which made a dead
// thing look alive:
//
//   1. QuickBooks read CONNECTED with 14 consecutive sync failures and no sync
//      since 2026-08-01; Google Calendar the same with 11 since 2026-08-06.
//      Neither raised anything, so neither owner was told — and only the owner
//      can re-authorize, so nothing else could ever have fixed it.
//
//   2. BusinessContext reported every connector as never stale, because the
//      expression could not evaluate true.
//
// The failure mode both share is SILENCE, so most of what follows asserts that
// something is now said — and the controls assert it is not said when it
// shouldn't be, because an attention card on a healthy connection is its own
// kind of lie.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const uniq = () => Math.random().toString(36).slice(2, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `ch-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `ch-${uniq()}` },
  });

  const connect = (over: Record<string, unknown>) =>
    prisma.storeIntegration.create({
      data: {
        storeId: store.id,
        provider: "QUICKBOOKS",
        status: "CONNECTED",
        syncFailureCount: 0,
        ...over,
      } as never,
    });

  // ========================================================================
  console.log("\n=== 1. A healthy connection says nothing ===\n");
  // ========================================================================
  const healthy = await connect({ lastSyncedAt: new Date(), syncFailureCount: 0 });
  eq("nothing is raised for a connection that just synced",
    (await getIntegrationIssues(store.id)).length, 0);

  // ONE failure is ordinary. The scheduler backs off and retries, and telling
  // the owner would be noise on something that fixes itself.
  await prisma.storeIntegration.update({
    where: { id: healthy.id, storeId: store.id },
    data: { syncFailureCount: 1, lastSyncedAt: daysAgo(1) },
  });
  eq("nor for a single failed sync", (await getIntegrationIssues(store.id)).length, 0);

  await prisma.storeIntegration.update({
    where: { id: healthy.id, storeId: store.id },
    data: { syncFailureCount: 2 },
  });
  eq("nor for two", (await getIntegrationIssues(store.id)).length, 0);

  // ========================================================================
  console.log("\n=== 2. The production case: CONNECTED, and dead for weeks ===\n");
  // ========================================================================
  // Exactly QuickBooks as found: status CONNECTED, 14 consecutive failures, no
  // sync since 2026-08-01. Under the old rule this raised nothing at all.
  await prisma.storeIntegration.update({
    where: { id: healthy.id, storeId: store.id },
    data: { status: "CONNECTED", syncFailureCount: 14, lastSyncedAt: daysAgo(24), lastError: null },
  });
  const raised = await getIntegrationIssues(store.id);
  eq("a connection failing for weeks is raised", raised.length, 1);
  assert("and it says what is wrong in the owner's terms",
    raised[0].message.includes("has not synced since") && raised[0].message.includes("14 attempts"),
    raised[0].message);
  assert("and what to do about it", raised[0].message.includes("needs reconnecting"),
    "only the account holder can re-authorize, so the message has to ask them to");
  assert("dated from when it last actually worked, not from a verification that never ran",
    raised[0].occurredAt !== null && Math.abs((raised[0].occurredAt as Date).getTime() - daysAgo(24).getTime()) < 60_000);
  eq("raised as a warning, since nothing verified it as failed", raised[0].severity, "WARNING");

  // THE THRESHOLD IS REAL, not decorative.
  await prisma.storeIntegration.update({
    where: { id: healthy.id, storeId: store.id },
    data: { syncFailureCount: 3 },
  });
  eq("three consecutive failures is the line", (await getIntegrationIssues(store.id)).length, 1);

  // ========================================================================
  console.log("\n=== 3. A verification failure still reads the provider's own words ===\n");
  // ========================================================================
  await prisma.storeIntegration.update({
    where: { id: healthy.id, storeId: store.id },
    data: {
      status: "FAILED",
      syncFailureCount: 0,
      lastSyncedAt: daysAgo(6),
      lastVerifiedAt: daysAgo(6),
      lastError: "Stripe account retrieval failed: the account was a test account",
    },
  });
  const verifyFailed = await getIntegrationIssues(store.id);
  eq("a FAILED verification is still raised", verifyFailed.length, 1);
  assert("carrying the provider's own message",
    verifyFailed[0].message.includes("test account"),
    "lastError is genuinely useful here and must not be replaced by a generic sentence");
  eq("at FAILED severity", verifyFailed[0].severity, "FAILED");

  // This is the production Stripe shape: FAILED verification, zero sync
  // failures. Not a contradiction — the two fields answer different questions.
  assert("FAILED with syncFailureCount 0 is a real, coherent state",
    verifyFailed.length === 1,
    "status is the last verification; syncFailureCount is the scheduler's backoff counter");

  // ========================================================================
  console.log("\n=== 4. Tenant isolation ===\n");
  // ========================================================================
  const neighbour = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `ch-n-${uniq()}` },
  });
  eq("the neighbour is told nothing about this store's connection",
    (await getIntegrationIssues(neighbour.id)).length, 0);

  // ========================================================================
  console.log("\n=== 5. BusinessContext reports staleness that can be true ===\n");
  // ========================================================================
  const src = codeOnly(readFileSync(join(process.cwd(), "lib", "businessModel", "businessContext.ts"), "utf8"));
  assert("stale reads the profile's own computed signal",
    /stale:\s*s\.isStale/.test(src),
    "it read `Boolean(s.syncedAgoLabel && s.lastSyncedAt === null)`, whose two halves " +
      "are mutually exclusive — no connector could ever be reported stale");
  assert("CONTROL: and the impossible expression is gone",
    !/syncedAgoLabel\s*&&\s*s\.lastSyncedAt === null/.test(src));

  await prisma.store.deleteMany({ where: { id: { in: [store.id, neighbour.id] } } });
  await prisma.user.delete({ where: { id: owner.id } });

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
