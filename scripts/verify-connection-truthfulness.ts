import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { connectionHealthOf, CONSECUTIVE_FAILURES_BEFORE_RECONNECT } from "@/lib/integrations/connectionHealth";
import { getIntegrationIssues } from "@/lib/dashboard/needsAttention";
import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { readFileSync } from "fs";
import { join } from "path";

// A CONNECTION IS WHAT IT IS, NOT WHAT ITS STATUS COLUMN SAYS:
//
//   npx tsx scripts/run-db-suites.ts connection-truthfulness
//
// Connections milestone, scope A. Every state transition, and the two rules the
// whole thing turns on:
//
//   - a connection is never shown as healthy when it is stale, dead, or unable
//     to sync
//   - "producing nothing" is NOT "broken" (C3), and must never escalate on its
//     own into a warning
//
// Most of what follows asserts SILENCE, because the expensive failures here are
// both directions of lying: telling an owner nothing is wrong when their data
// stopped arriving three weeks ago, and telling them something is broken when
// their Mailchimp account is simply empty.

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

const row = (over: Partial<{ status: string; syncFailureCount: number; lastSyncedAt: Date | null; lastError: string | null }> = {}) => ({
  status: "CONNECTED",
  syncFailureCount: 0,
  lastSyncedAt: new Date(),
  lastError: null,
  ...over,
});

async function main() {
  await requireTestDatabase(prismaSystem);

  // ========================================================================
  console.log("\n=== 1. Every state, from evidence alone ===\n");
  // ========================================================================
  eq("no implementation, or no credentials — unavailable",
    connectionHealthOf({ available: false, row: null, recordsProduced: 0 }).state, "unavailable");
  eq("never connected — not connected",
    connectionHealthOf({ available: true, row: null, recordsProduced: 0 }).state, "not_connected");
  eq("disconnected on purpose — not connected",
    connectionHealthOf({ available: true, row: row({ status: "DISCONNECTED" }), recordsProduced: 9 }).state,
    "not_connected");
  eq("verification failed — failed",
    connectionHealthOf({ available: true, row: row({ status: "FAILED", lastError: "bad key" }), recordsProduced: 9 }).state,
    "failed");
  eq("needs attention — failed",
    connectionHealthOf({ available: true, row: row({ status: "NEEDS_ATTENTION" }), recordsProduced: 9 }).state,
    "failed");
  eq("authenticated but failing to sync — needs reconnection",
    connectionHealthOf({ available: true, row: row({ syncFailureCount: 14, lastSyncedAt: daysAgo(24) }), recordsProduced: 41 }).state,
    "needs_reconnection");
  eq("working, nothing returned — connected, no data",
    connectionHealthOf({ available: true, row: row(), recordsProduced: 0 }).state, "connected_no_data");
  eq("working, data returned — connected",
    connectionHealthOf({ available: true, row: row(), recordsProduced: 41 }).state, "connected");

  // ========================================================================
  console.log("\n=== 2. The rules that decide the edges ===\n");
  // ========================================================================
  for (let n = 0; n < CONSECUTIVE_FAILURES_BEFORE_RECONNECT; n++) {
    eq(`${n} consecutive failures is still working`,
      connectionHealthOf({ available: true, row: row({ syncFailureCount: n }), recordsProduced: 5 }).state,
      "connected");
  }
  eq(`${CONSECUTIVE_FAILURES_BEFORE_RECONNECT} is the line`,
    connectionHealthOf({ available: true, row: row({ syncFailureCount: CONSECUTIVE_FAILURES_BEFORE_RECONNECT }), recordsProduced: 5 }).state,
    "needs_reconnection");

  // PRECEDENCE. A connection can be several things at once; the most specific
  // and most actionable wins.
  eq("failed verification outranks a failing sync",
    connectionHealthOf({ available: true, row: row({ status: "FAILED", syncFailureCount: 20, lastError: "x" }), recordsProduced: 0 }).state,
    "failed");
  eq("a failing sync outranks having produced nothing",
    connectionHealthOf({ available: true, row: row({ syncFailureCount: 9 }), recordsProduced: 0 }).state,
    "needs_reconnection");
  eq("unavailable outranks everything",
    connectionHealthOf({ available: false, row: row({ status: "FAILED" }), recordsProduced: 99 }).state,
    "unavailable");

  // ========================================================================
  console.log("\n=== 3. Nothing is invented, and the provider keeps its words ===\n");
  // ========================================================================
  const failed = connectionHealthOf({
    available: true,
    row: row({ status: "FAILED", lastError: "The account acct_1U0 was a test account created with a testmode key" }),
    recordsProduced: 0,
  });
  eq("the provider's message is preserved verbatim",
    failed.providerError, "The account acct_1U0 was a test account created with a testmode key");
  assert("and it is what the owner is shown",
    failed.detail === failed.providerError,
    "no sentence this codebase could write would be more useful than the provider's own");

  const noData = connectionHealthOf({ available: true, row: row(), recordsProduced: 0 });
  assert("a connection that produced nothing never claims data",
    !/\d/.test(noData.detail ?? ""),
    noData.detail ?? "");
  assert("and says plainly that nothing arrived",
    (noData.detail ?? "").includes("has not returned any business data"),
    noData.detail ?? "");
  const withData = connectionHealthOf({ available: true, row: row(), recordsProduced: 41 });
  eq("CONTROL: a connection that produced data counts it", withData.detail, "41 records received.");
  eq("and one record is singular",
    connectionHealthOf({ available: true, row: row(), recordsProduced: 1 }).detail, "1 record received.");

  // ========================================================================
  console.log("\n=== 4. C3 — producing nothing is not broken ===\n");
  // ========================================================================
  eq("a working connection with no data raises nothing",
    connectionHealthOf({ available: true, row: row(), recordsProduced: 0 }).raisesAttention, false);
  eq("nor does a healthy one",
    connectionHealthOf({ available: true, row: row(), recordsProduced: 5 }).raisesAttention, false);
  eq("nor an unavailable provider",
    connectionHealthOf({ available: false, row: null, recordsProduced: 0 }).raisesAttention, false);
  eq("nor one nobody has connected",
    connectionHealthOf({ available: true, row: null, recordsProduced: 0 }).raisesAttention, false);
  eq("but a failed one does",
    connectionHealthOf({ available: true, row: row({ status: "FAILED" }), recordsProduced: 0 }).raisesAttention, true);
  eq("and so does a stale one",
    connectionHealthOf({ available: true, row: row({ syncFailureCount: 5 }), recordsProduced: 0 }).raisesAttention, true);

  // ========================================================================
  console.log("\n=== 5. The screen and the attention path cannot disagree ===\n");
  // ========================================================================
  const owner = await prisma.user.create({ data: { email: `ct-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `ct-${uniq()}` },
  });
  const conn = await prisma.storeIntegration.create({
    data: { storeId: store.id, provider: "QUICKBOOKS", status: "CONNECTED", syncFailureCount: 0,
            lastSyncedAt: new Date() } as never,
  });

  // Mailchimp's exact production shape: syncing, zero failures, no records.
  eq("a connection producing nothing is not raised to the owner",
    (await getIntegrationIssues(store.id)).length, 0);

  // QuickBooks' exact production shape.
  await prisma.storeIntegration.update({
    where: { id: conn.id, storeId: store.id },
    data: { syncFailureCount: 14, lastSyncedAt: daysAgo(24) },
  });
  const raised = await getIntegrationIssues(store.id);
  eq("a connection dead for weeks is raised", raised.length, 1);
  assert("saying what stopped and what to do",
    raised[0].message.includes("has not synced since") && raised[0].message.includes("needs reconnecting"),
    raised[0].message);
  eq("as a warning, since nothing verified it as failed", raised[0].severity, "WARNING");

  // A verification failure keeps the provider's sentence, unprefixed.
  await prisma.storeIntegration.update({
    where: { id: conn.id, storeId: store.id },
    data: { status: "FAILED", syncFailureCount: 0, lastVerifiedAt: daysAgo(6),
            lastError: "Stripe account retrieval failed: the account was a test account" },
  });
  const failedItem = await getIntegrationIssues(store.id);
  eq("a failed verification is raised", failedItem.length, 1);
  eq("at FAILED severity", failedItem[0].severity, "FAILED");
  eq("carrying only the provider's own message",
    failedItem[0].message, "Stripe account retrieval failed: the account was a test account");

  // Having produced data does not excuse a broken connection.
  await prisma.businessRecord.create({
    data: { storeId: store.id, entityType: "transaction", sourceProvider: "quickbooks",
            externalId: `t-${uniq()}`, data: {} } as never,
  });
  eq("a connection that once produced data is still raised when it breaks",
    (await getIntegrationIssues(store.id)).length, 1);

  const neighbour = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `ct-n-${uniq()}` },
  });
  eq("and the neighbour hears nothing about it",
    (await getIntegrationIssues(neighbour.id)).length, 0);

  // ========================================================================
  console.log("\n=== 6. C2 — the catalog keeps everything, honestly ===\n");
  // ========================================================================
  eq("every catalog entry is still present", CONNECTOR_CATALOG.length, 12);
  const unbuilt = CONNECTOR_CATALOG.filter((e) => e.connector === null);
  eq("including the six with no implementation", unbuilt.length, 6);
  for (const e of unbuilt) {
    eq(`${e.id} reports itself unavailable rather than connectable`,
      connectionHealthOf({ available: false, row: null, recordsProduced: 0 }).state, "unavailable");
  }

  // A connector declares its own credential requirement — no list elsewhere.
  const declaring = CONNECTOR_CATALOG
    .filter((e) => e.connector?.configured !== undefined)
    .map((e) => e.id)
    .sort();
  eq("the OAuth connectors that need platform credentials declare it",
    declaring, ["facebook", "google-calendar", "instagram", "quickbooks", "tiktok"]);

  // ========================================================================
  console.log("\n=== 7. BusinessContext reports staleness that can be true ===\n");
  // ========================================================================
  // Folded in from verify-connection-health.ts, which this file replaces. That
  // suite tested the interim rule that lived inside getIntegrationIssues; the
  // rule now lives in connectionHealthOf and is covered above, so keeping two
  // suites on one subject would have meant two descriptions of one thing —
  // exactly what this milestone is about not doing.
  const ctx = codeOnly(readFileSync(join(process.cwd(), "lib", "businessModel", "businessContext.ts"), "utf8"));
  assert("stale reads the profile's own computed signal",
    /stale:\s*s\.isStale/.test(ctx),
    "it read `Boolean(s.syncedAgoLabel && s.lastSyncedAt === null)`, whose two halves " +
      "are mutually exclusive — no connector could ever be reported stale");
  assert("CONTROL: and the impossible expression is gone",
    !/syncedAgoLabel\s*&&\s*s\.lastSyncedAt === null/.test(ctx));

  const card = codeOnly(readFileSync(join(process.cwd(), "app", "dashboard", "ConnectorCard.tsx"), "utf8"));
  assert("the card no longer treats any non-disconnected status as connected",
    !/integrationStatus\s*&&\s*integrationStatus\s*!==\s*"DISCONNECTED"/.test(card),
    "that is what rendered a FAILED connection as a working one");
  assert("CONTROL: and decides from the health state instead",
    /health\.state\s*!==\s*"not_connected"/.test(card));

  await prisma.store.deleteMany({ where: { id: { in: [store.id, neighbour.id] } } });
  await prisma.user.delete({ where: { id: owner.id } });

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
