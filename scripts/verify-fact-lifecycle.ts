import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { readFileSync } from "fs";
import { join } from "path";

// THE BUSINESS FACT LIFECYCLE — acceptance.
//
//   npx tsx scripts/verify-fact-lifecycle.ts
//
// BUSINESS_FACT_LIFECYCLE_CONTRACT.md §5, against a real Postgres because the
// contract's whole subject is persisted state: what is current, what is
// preserved, and what a reader gets back.
//
// BRINGS ITS OWN DATABASE, so it is NOT in the shared runner — the
// "own-infrastructure" lane. A green 41/41 does not include this file.
//
// Every invariant has both directions. The one that matters most is D2's: a
// reader asking for the current fact must not receive a superseded one, and the
// control for that is to supersede a fact and then ask.

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
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const life = await import("@/lib/businessModel/factLifecycle");
  const { stateFact } = await import("@/lib/businessModel/statements");
  const { recordOwnerFacts, readOwnerFacts } = await import("@/lib/businessModel/ownerFacts");

  try {
    const user = await prisma.user.create({ data: { email: `fl-${Date.now()}@test.local` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Lifecycle Co", slug: `lifecycle-${Date.now()}` },
    });
    const other = await prisma.store.create({
      data: { userId: user.id, name: "Neighbour", slug: `neighbour-${Date.now()}` },
    });

    // ====================================================================
    console.log("\n=== D3 — the owner-authoritative types, and only those ===\n");
    // ====================================================================
    // SIX BECAME TEN (2026-08-24, D1-A), and this assertion is why the change
    // could not be made quietly: it names the whole set rather than checking
    // that the ones it knows about are present, so growing the set failed here
    // and had to be looked at. The four additions are the identity claims that
    // used to sit in Store.blueprint.brandIdentity with no author and no
    // correction path — the owner is authoritative about who their business is
    // for, and a content-generation pass is not.
    eq("exactly ten types accept owner testimony",
      [...life.OWNER_AUTHORITATIVE_TYPES],
      ["goal", "challenge", "employee", "location", "offering", "intent",
       "targetAudience", "brandPersonality", "brandVoice", "sellingProposition"]);
    assert("and every one is a registered entity type", life.ownerAuthoritativeTypesAreRegistered());

    assert("a connector-owned type is NOT owner-authoritative",
      !life.isOwnerAuthoritative("transaction"),
      "correcting a QuickBooks transaction here would be overwritten by the next sync");
    assert("nor is a generated artifact", !life.isOwnerAuthoritative("design"));
    assert("nor is a platform-derived type", !life.isOwnerAuthoritative("item"));
    assert("CONTROL: the check is not simply always false", life.isOwnerAuthoritative("offering"));

    // ====================================================================
    console.log("\n=== D5 — a first statement is not a contradiction ===\n");
    // ====================================================================
    const firstGoal = await stateFact({
      storeId: store.id, userId: user.id, entityType: "goal",
      data: { description: "Reach 1,000 customers", category: "growth", priority: "high", targetDate: null, targetValueInCents: null, status: "active", identifiedAt: "2026-08-24", relatedChallengeIds: [] },
      modelExtracted: true, context: "chat",
    });
    assert("a first goal is recorded", firstGoal.ok);
    assert("and supersedes nothing",
      firstGoal.ok && firstGoal.value.supersededRecordId === undefined,
      "nothing existed to contradict");

    // A SECOND, UNRELATED goal. No target named, plural type — so a NEW fact,
    // never a silent correction of whichever one looked closest.
    const secondGoal = await stateFact({
      storeId: store.id, userId: user.id, entityType: "goal",
      data: { description: "Open a second location", category: "expansion", priority: "medium", targetDate: null, targetValueInCents: null, status: "active", identifiedAt: "2026-08-24", relatedChallengeIds: [] },
      modelExtracted: true, context: "chat",
    });
    assert("an untargeted second goal supersedes nothing",
      secondGoal.ok && secondGoal.value.supersededRecordId === undefined,
      "a plural type with no named target is a NEW fact, not an inferred correction");
    eq("so the business now has two current goals",
      (await life.currentFacts(store.id, "goal")).length, 2);

    // ====================================================================
    console.log("\n=== D5 — an explicit correction, and only an explicit one ===\n");
    // ====================================================================
    const firstGoalId = firstGoal.ok ? firstGoal.value.recordId : "";
    const corrected = await stateFact({
      storeId: store.id, userId: user.id, entityType: "goal",
      data: { description: "Reach 2,000 customers", category: "growth", priority: "high", targetDate: null, targetValueInCents: null, status: "active", identifiedAt: "2026-08-24", relatedChallengeIds: [] },
      modelExtracted: true, context: "chat",
      supersedesRecordId: firstGoalId,
    });
    assert("a named correction is recorded", corrected.ok);
    eq("and says which record it replaced",
      corrected.ok ? corrected.value.supersededRecordId : null, firstGoalId);

    // D2 — THE INVARIANT THAT MATTERS MOST.
    const currentGoals = await life.currentFacts(store.id, "goal");
    eq("the corrected goal is no longer current", currentGoals.length, 2);
    assert("and specifically the OLD one is gone from current",
      !currentGoals.some((g) => g.id === firstGoalId),
      "this is the control for 'a reader asking for current cannot receive a superseded one'");
    assert("while the correction IS current",
      corrected.ok && currentGoals.some((g) => g.id === corrected.value.recordId));

    // D2 — and history is preserved.
    const history = await life.factHistory(store.id, "goal");
    eq("history still holds all three statements", history.length, 3);
    const old = history.find((g) => g.id === firstGoalId);
    assert("the superseded statement still exists", Boolean(old));
    eq("with its original text untouched",
      (old?.data as { description?: string })?.description, "Reach 1,000 customers");
    assert("and it is marked superseded", old ? life.isSuperseded(old) : false);

    // ====================================================================
    console.log("\n=== D1 — supersession is ADDITIVE to status ===\n");
    // ====================================================================
    const achieved = await stateFact({
      storeId: store.id, userId: user.id, entityType: "goal",
      data: { description: "Ship the first ring", category: "product", priority: "high", targetDate: null, targetValueInCents: null, status: "achieved", identifiedAt: "2026-08-24", relatedChallengeIds: [] },
      modelExtracted: false, context: "chat",
    });
    const achievedId = achieved.ok ? achieved.value.recordId : "";
    const achievedRow = (await life.currentFacts(store.id, "goal")).find((g) => g.id === achievedId);
    eq("a goal marked achieved keeps that status",
      (achievedRow?.data as { status?: string })?.status, "achieved");
    assert("and is still CURRENT, because achieved is not corrected",
      Boolean(achievedRow),
      "D1: status says what became of it in the world; supersession says it is no longer believed");

    // ====================================================================
    console.log("\n=== D5 — a target that cannot be confirmed is refused ===\n");
    // ====================================================================
    const bogus = await stateFact({
      storeId: store.id, userId: user.id, entityType: "goal",
      data: { description: "Correcting nothing", category: null, priority: null, targetDate: null, targetValueInCents: null, status: "active", identifiedAt: "2026-08-24", relatedChallengeIds: [] },
      modelExtracted: true, context: "chat",
      supersedesRecordId: "rec_does_not_exist",
    });
    assert("a correction naming an unknown record is refused",
      !bogus.ok && bogus.refusal === "unknown_target",
      "writing it as an unrelated fact would leave the owner believing they had corrected something");

    // CROSS-TENANT. A record id from another store must not be correctable.
    const neighbourGoal = await stateFact({
      storeId: other.id, userId: user.id, entityType: "goal",
      data: { description: "Not your goal", category: null, priority: null, targetDate: null, targetValueInCents: null, status: "active", identifiedAt: "2026-08-24", relatedChallengeIds: [] },
      modelExtracted: true, context: "chat",
    });
    const cross = await stateFact({
      storeId: store.id, userId: user.id, entityType: "goal",
      data: { description: "Reaching across", category: null, priority: null, targetDate: null, targetValueInCents: null, status: "active", identifiedAt: "2026-08-24", relatedChallengeIds: [] },
      modelExtracted: true, context: "chat",
      supersedesRecordId: neighbourGoal.ok ? neighbourGoal.value.recordId : "",
    });
    assert("a record from ANOTHER store cannot be superseded",
      !cross.ok && cross.refusal === "unknown_target",
      "a model-supplied id is untrusted input, and this is the difference between a correction and a cross-tenant write");
    eq("and the neighbour's goal is untouched",
      (await life.currentFacts(other.id, "goal")).length, 1);

    // ====================================================================
    console.log("\n=== The singleton types — correction without a named target ===\n");
    // ====================================================================
    await recordOwnerFacts({
      storeId: store.id, userId: user.id,
      facts: { offering: "hand-wound copper rings", intent: "a quiet workshop", modelExtracted: false, source: "onboarding_form" },
    });
    eq("onboarding records what the owner said", (await readOwnerFacts(store.id)).offering, "hand-wound copper rings");

    // "We sell something different now" — the case that started the milestone.
    const restated = await stateFact({
      storeId: store.id, userId: user.id, entityType: "offering",
      data: { statement: "brass cuffs, not rings" },
      modelExtracted: true, context: "chat",
    });
    assert("restating a singleton supersedes the previous one WITHOUT a named target",
      restated.ok && Boolean(restated.value.supersededRecordId),
      "a business has one answer to what it sells, so the target is unambiguous by construction");
    eq("and the current offering is the new one",
      (await readOwnerFacts(store.id)).offering, "brass cuffs, not rings");
    eq("exactly one offering is current", (await life.currentFacts(store.id, "offering")).length, 1);
    eq("and the previous answer is still in history",
      (await life.factHistory(store.id, "offering")).length, 2);
    assert("so 'they used to sell rings' is still answerable",
      (await life.factHistory(store.id, "offering")).some(
        (r) => (r.data as { statement?: string }).statement === "hand-wound copper rings"
      ),
      "which is the whole of D2");

    // PROVENANCE SURVIVES A CORRECTION.
    const currentOffering = (await life.currentFacts(store.id, "offering"))[0];
    eq("the correction carries OWNER provenance", currentOffering.provenance, "OWNER");
    eq("and records that a model stood between", currentOffering.modelExtracted, true);
    const originalOffering = (await life.factHistory(store.id, "offering")).find(
      (r) => (r.data as { statement?: string }).statement === "hand-wound copper rings"
    );
    eq("while the superseded one keeps ITS provenance", originalOffering?.modelExtracted, false,
      );
    assert("so a typed statement stays distinguishable from a distilled one",
      originalOffering?.modelExtracted === false && currentOffering.modelExtracted === true,
      "the previous milestone's provenance work is what makes the accepted D5 consequence recoverable");

    // ====================================================================
    console.log("\n=== The profile reads current, not everything ===\n");
    // ====================================================================
    const { getBusinessProfile } = await import("@/lib/businessModel/profile");
    const profile = await getBusinessProfile(store.id);
    assert("the understanding layer does not show the superseded goal",
      !profile.goals.some((g) => g.id === firstGoalId),
      "two answers to one question is what this milestone removes");
    eq("and shows the corrected offering", profile.identity.offering, "brass cuffs, not rings");

    // ====================================================================
    console.log("\n=== Source-level invariants ===\n");
    // ====================================================================
    const handlers = codeOnly(read("lib", "execution", "toolHandlers.ts"));
    assert("captureBusinessFact goes through stateFact",
      handlers.includes("await stateFact({"),
      "one path for owner testimony, so provenance cannot be asserted from a caller");
    assert("and no longer mints a fresh identity for every capture",
      !handlers.includes("externalId: randomUUID(), data: parsed.data"),
      "that is why restating a goal used to produce a second goal");

    const facts = codeOnly(read("lib", "businessModel", "factLifecycle.ts"));
    assert("nothing infers a correction target from text",
      !/similar|fuzzy|levenshtein|includes\(.*description/i.test(facts),
      "D5: resolved explicitly, never inferred");
    assert("currentFacts filters in the database, not in a loop",
      /findMany\([\s\S]{0,400}SUPERSEDED_BY/.test(facts) && !/for \(const .* of rows\)/.test(facts),
      "D2: the current fact is readable without any consumer traversing the chain");

    const beliefs = codeOnly(read("lib", "businessModel", "factLifecycle.ts"));
    assert("D6: no confidence model reaches a Fact",
      !/confidence|evidenceCount/.test(beliefs));
    assert("and the Belief model is untouched by this milestone",
      !/prisma\.belief/.test(beliefs));
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
