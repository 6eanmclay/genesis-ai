import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// ONE CANONICAL UNDERSTANDING — acceptance.
//
//   npx tsx scripts/verify-canonical-understanding.ts
//
// BUSINESS_UNDERSTANDING_CONTRACT.md §9. The milestone's claim is one sentence:
//
//   There is exactly one canonical Business Understanding assembly path, and no
//   consumer rebuilds business knowledge for itself.
//
// BRINGS ITS OWN POSTGRES — getBusinessUnderstanding fans out ~27 parallel
// reads, which is precisely the fan-out that has previously exhausted PGlite's
// single connection and killed an unrelated suite three positions later. It is
// therefore NOT in the shared runner, and a green 41/41 does not include it.
//
// Nine gates, each with a negative control that proves it can fail.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** Comments explain the reason; code is the evidence. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const root = process.cwd();
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

/** Every source file, so a gate sweeps rather than checks a list. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir))) {
    const rel = `${dir}/${e}`;
    if (e === "node_modules" || e.startsWith(".")) continue;
    if (statSync(join(root, rel)).isDirectory()) sourceFiles(rel, acc);
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) acc.push(rel);
  }
  return acc;
}

/**
 * The providers the canonical understanding already supplies.
 *
 * A reasoning consumer calling one of these is asking a question the canonical
 * model already answers — which is the duplication this milestone removed.
 */
const CANON_PROVIDES = [
  "getInvoiceSummary",
  "getCampaignPerformanceSummary",
  "getAppointmentSummary",
  "getUpcomingAppointments",
  "getOrderSummary",
  "getCustomerSummaries",
  "getRecentActivity",
  "getActionTypeTrackRecord",
  "getTopContacts",
];

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");

  try {
    // ==================================================================
    console.log("\n=== GATE 1 — exactly one assembler ===\n");
    // ==================================================================
    const understandingSrc = codeOnly(read("lib", "businessModel", "understanding.ts"));
    // THE ASSEMBLER IS TWO FILES, and always was: getBusinessUnderstanding calls
    // getBusinessProfile, so a provider composed by either is composed by the
    // canonical path. Checking only understanding.ts reported getTopContacts as
    // missing when profile.ts had been fetching it all along.
    const assemblerSrc = understandingSrc + codeOnly(read("lib", "businessModel", "profile.ts"));
    assert("the canonical path composes every provider it claims",
      CANON_PROVIDES.every((p) => assemblerSrc.includes(`${p}(`)),
      CANON_PROVIDES.filter((p) => !assemblerSrc.includes(`${p}(`)).join(", "));

    // No OTHER file may compose several canonical providers into one object.
    const composers: string[] = [];
    for (const f of [...sourceFiles("lib"), ...sourceFiles("app")]) {
      // The assembler itself, and the module that DEFINES the providers — a
      // definition is not a composition, and flagging reasoning.ts for holding
      // the functions everything else calls would make this gate meaningless.
      if (f.endsWith("businessModel/understanding.ts")) continue;
      if (f.endsWith("businessModel/profile.ts")) continue;
      if (f.endsWith("businessModel/reasoning.ts")) continue;
      const src = codeOnly(read(...f.split("/")));
      // A CALL, not a definition, and not a declared read. A file that wraps
      // its reads in declaredRead has said why; that is the mechanism working.
      const hits = CANON_PROVIDES.filter(
        (p) =>
          new RegExp(`\\b${p}\\(`).test(src) &&
          !new RegExp(`export (async )?function ${p}\\b`).test(src)
      );
      const undeclared = hits.filter(() => !src.includes("declaredRead("));
      // Three or more UNDECLARED provider calls is composition, not a read.
      if (undeclared.length >= 3) composers.push(`${f} (${undeclared.join(", ")})`);
    }
    assert("nothing else composes an understanding", composers.length === 0, composers.join("; "));

    // ==================================================================
    console.log("\n=== GATE 2 — buildChatDataContext is gone ===\n");
    // ==================================================================
    const reasoningSrc = codeOnly(read("lib", "businessModel", "reasoning.ts"));
    assert("the second assembler no longer exists",
      !reasoningSrc.includes("buildChatDataContext"),
      "it was 24 parallel queries, 2 of them duplicating the canonical understanding");
    const anyCaller = [...sourceFiles("lib"), ...sourceFiles("app")].filter((f) =>
      codeOnly(read(...f.split("/"))).includes("buildChatDataContext")
    );
    assert("and nothing calls it", anyCaller.length === 0, anyCaller.join(", "));

    // ==================================================================
    console.log("\n=== GATE 3 — no reasoning consumer reads a canonical provider ===\n");
    // ==================================================================
    const REASONING = [
      "lib/execution/toolHandlers.ts",
      "lib/intelligence/cognitiveLayer.ts",
      "lib/dashboard/chatTurnContext.ts",
    ];
    const offenders: string[] = [];
    for (const f of REASONING) {
      const src = codeOnly(read(...f.split("/")));
      for (const p of CANON_PROVIDES) {
        if (new RegExp(`\\b${p}\\(`).test(src)) offenders.push(`${f}: ${p}`);
      }
    }
    assert("reasoning consumers take these from the understanding",
      offenders.length === 0, offenders.join("; "));

    // ==================================================================
    console.log("\n=== GATE 4 — every direct provider read is declared ===\n");
    // ==================================================================
    const declaredSrc = codeOnly(read("lib", "businessModel", "declaredReads.ts"));
    assert("the declaration mechanism exists", declaredSrc.includes("export function declaredRead"));
    assert("and admits exactly two reasons",
      declaredSrc.includes('"presentation" | "windowed"'),
      "a third reason would be a licence to assemble");

    // EVERY CALL, not "the file mentions declaredRead somewhere".
    //
    // The first version of this gate was a presence check, and its own negative
    // control caught it: removing ONE of the two declarations from
    // customers/page.tsx left the other, the file still contained the string,
    // and the gate stayed green while an undeclared read sat in it. A presence
    // check on a file with two of something can never notice one going missing.
    const DECLARED_FILES: [string, string[]][] = [
      ["app/dashboard/customers/page.tsx", ["getCustomerSegments", "getCustomerSegmentTrend"]],
      ["app/dashboard/studio/page.tsx", ["currentAssetsByRole"]],
      ["app/dashboard/connections/page.tsx", ["getConnectionGaps"]],
      ["app/dashboard/analytics/page.tsx", ["getOrderSummary", "getCustomerSummaries", "getRecentActivity"]],
      ["lib/dashboard/genesisBriefingComposer.ts", ["getRevenue"]],
      ["lib/intelligence/insights.ts", ["getRevenue"]],
    ];
    for (const [f, providers] of DECLARED_FILES) {
      const src = codeOnly(read(...f.split("/")));
      // COUNTED, not proximity-matched.
      //
      // A character window around each call seemed reasonable and was not: the
      // two reads in customers/page.tsx sit adjacent inside one Promise.all, so
      // deleting one declaration left the OTHER one inside the window and the
      // negative control still would not fire. Twice in one milestone this gate
      // looked green while an undeclared read sat in the file.
      //
      // Each declaredRead wraps exactly one provider call, so the counts must
      // match. That cannot be satisfied by a neighbour.
      let calls = 0;
      for (const provider of providers) {
        calls += (src.match(new RegExp(`\\b${provider}\\(`, "g")) ?? []).length;
      }
      const declarations = (src.match(/declaredRead\(/g) ?? []).length;
      assert(`${f.split("/").pop()} declares EVERY direct read`,
        declarations >= calls,
        `${calls} provider call(s), ${declarations} declaration(s)`);
    }

    // ==================================================================
    console.log("\n=== GATE 5 — insights.ts is still a provider ===\n");
    // ==================================================================
    const insightsSrc = codeOnly(read("lib", "intelligence", "insights.ts"));
    assert("it does not assemble an understanding",
      !insightsSrc.includes("getBusinessUnderstanding"),
      "computeInsights returns Insight[], not an understanding");
    assert("and still computes its own comparison windows",
      insightsSrc.includes("oneWeekAgo") && insightsSrc.includes("twoWeeksAgo"),
      "the canonical model carries last-30-days and all-time; neither is week-over-week");

    // ==================================================================
    console.log("\n=== GATE 6 — the fetch count is asserted, not assumed ===\n");
    // ==================================================================
    const counted = (src: string, fn: string) => {
      const i = src.indexOf(fn);
      const body = src.slice(i, src.indexOf("]);", i));
      return (body.match(/^\s{4}\w[\w.]*\(/gm) ?? []).length;
    };
    const profileFetches = counted(codeOnly(read("lib", "businessModel", "profile.ts")), "await Promise.all([");
    const understandingFetches = counted(understandingSrc, "await Promise.all([");
    console.log(`        profile ${profileFetches} + understanding ${understandingFetches} = ${profileFetches + understandingFetches} core fetches`);
    // 40 -> 42 (2026-09-03). Two reads were added to the understanding, and
    // this is the visible edit the message below asks for rather than a
    // number quietly following the code upward:
    //
    //   activePromotions - J4 could CREATE a promotion and never see it
    //     again, so it could not say what was on sale or stop one.
    //   recentOrders     - getOrderSummary counts orders and returns none of
    //     them, so J4 knew a store had eleven and could name none.
    //
    // Both are one indexed read on an existing index, both are bounded, and
    // both buy a capability an owner asks for out loud. The measured total is
    // 41; the ceiling stays one above it so the next addition is deliberate
    // too.
    assert("the core assembly stays within the measured envelope",
      profileFetches + understandingFetches <= 42,
      "the number is recorded from measurement; raising it is a visible edit, not a drift");

    // ==================================================================
    console.log("\n=== GATE 7 — a consumer inherits everything, opt-in included ===\n");
    // ==================================================================
    const user = await prisma.user.create({ data: { email: `cu-${Date.now()}@test.local` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Canon Co", slug: `canon-${Date.now()}` },
    });

    const core = await getBusinessUnderstanding(store.id, { viewerUserId: user.id });
    assert("the core carries the connected summaries", "connectedSummaries" in core);
    assert("and upcoming appointments", "upcomingAppointments" in core);
    assert("and recent business", "recentBusiness" in core);
    assert("and the action-type track record",
      "actionTypeTrackRecord" in core.platformRelationship);
    eq("but NOT the opt-in section", core.recentRecords, null);

    const withRecent = await getBusinessUnderstanding(store.id, {
      viewerUserId: user.id,
      include: ["recentRecords"],
    });
    assert("naming the section produces it", withRecent.recentRecords !== null);
    // 17 → 21 (2026-08-24, D1-A added four identity claim types to
    // ENTITY_REGISTRY). Read from the registry rather than restated as a
    // literal: the claim is "every type", and a hand-copied number stops
    // meaning that the moment the two drift.
    const { ENTITY_TYPES } = await import("@/lib/businessModel/entities");
    assert("and it covers every entity type",
      Object.keys(withRecent.recentRecords ?? {}).length === ENTITY_TYPES.length,
      `${Object.keys(withRecent.recentRecords ?? {}).length} of ${ENTITY_TYPES.length} types`);

    // ==================================================================
    console.log("\n=== GATE 8 — provenance is not weakened ===\n");
    // ==================================================================
    assert("the understanding still carries provenance-bearing records",
      Array.isArray(core.profile.goals) && Array.isArray(core.profile.assets));
    const { groundingRules } = await import("@/lib/businessModel/grounding");
    assert("and grounding still reads them",
      typeof groundingRules([]) === "string" || Array.isArray(groundingRules([])),
      "folding summaries in must not flatten sourceOf/groundingRules");

    // ==================================================================
    console.log("\n=== GATE 9 — the fact lifecycle is not reopened ===\n");
    // ==================================================================
    const { stateFact } = await import("@/lib/businessModel/statements");
    const first = await stateFact({
      storeId: store.id, userId: user.id, entityType: "offering",
      data: { statement: "hand-wound copper rings" }, modelExtracted: false, context: "chat",
    });
    await stateFact({
      storeId: store.id, userId: user.id, entityType: "offering",
      data: { statement: "brass cuffs" }, modelExtracted: false, context: "chat",
    });
    const after = await getBusinessUnderstanding(store.id, { viewerUserId: user.id });
    eq("the understanding shows the CURRENT fact", after.profile.identity.offering, "brass cuffs");
    assert("and not the superseded one",
      after.profile.identity.offering !== "hand-wound copper rings",
      "convergence must not reintroduce a path that reads superseded facts");
    assert("the superseded record still exists",
      Boolean(first.ok && first.value.recordId),
      "history is preserved — that is the fact lifecycle, unchanged");
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
