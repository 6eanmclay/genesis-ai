import { readFileSync } from "fs";
import { join } from "path";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { INSIGHT_PREFIX } from "@/lib/intelligence/notify";
import {
  getReviewableBeliefs,
  contradictBelief,
  restoreBelief,
  categoryLabel,
  BELIEF_CATEGORY_LABEL,
} from "@/lib/intelligence/beliefReview";
import {
  getBeliefs,
  detectInsightRecurrence,
  DISMISSED,
  OWNER_ENTITY_TYPE,
} from "@/lib/intelligence/learn";

// WHAT J4 BELIEVES, WHERE THE OWNER CAN ARGUE WITH IT:
//
//   npx tsx scripts/run-db-suites.ts belief-review
//
// getBeliefs had one consumer and it feeds prompts, so J4 reasoned from
// conclusions about a business that the owner could not read, correct, or
// contradict. This proves the other direction now exists and, more importantly,
// that it cannot go wrong in the four ways that would matter:
//
//   - a correction that appears to work and is quietly undone by the next
//     distillation pass
//   - "the owner disagreed" becoming indistinguishable from "the evidence
//     stopped supporting it"
//   - a corrected belief still reaching the reasoning that made it a problem
//   - an employee reading, or editing, a model of how their employer thinks
//
// Every one of those is silent. None throws; each just makes J4 quietly wrong
// in a way the owner has no way to detect.

const results: { name: string; ok: boolean }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `bel-owner-${uniq()}@test.local` } });
  const employee = await prisma.user.create({ data: { email: `bel-emp-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `bel-${uniq()}` },
  });
  const other = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `bel-other-${uniq()}` },
  });

  // ==========================================================================
  console.log("\n=== 1. Every category J4 writes has words for a person ===\n");
  // ==========================================================================
  // ARCHITECTURE.md's standing invariant. BELIEF_CATEGORY_LABEL mirrors the
  // categories lib/intelligence/learn.ts actually writes, the compiler cannot
  // check membership, and the failure has happened before in this exact shape:
  // a kind with no label reaching a fallback that prints the raw string at a
  // merchant. Read from learn.ts's own source, so a fifth detector added
  // tomorrow fails here rather than shipping.
  const learnSource = readFileSync(join(process.cwd(), "lib", "intelligence", "learn.ts"), "utf8");
  const written = [...learnSource.matchAll(/category:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert("learn.ts writes at least one category", written.length > 0, written.join(", "));
  check("and every one of them has a label",
    [...new Set(written)].filter((c) => !Object.hasOwn(BELIEF_CATEGORY_LABEL, c)), []);
  check("with no label left over for a category nothing writes",
    Object.keys(BELIEF_CATEGORY_LABEL).filter((c) => !written.includes(c)), []);

  // A category nobody anticipated still gets a sentence, never the raw key.
  assert("an unknown category falls back to a sentence, not the key",
    categoryLabel("something_new") !== "something_new", categoryLabel("something_new"));
  // The registry-lookup sibling rule: `"constructor" in REGISTRY` is true.
  assert("and a prototype key does not resolve to a label",
    categoryLabel("constructor") === categoryLabel("something_new"), categoryLabel("constructor"));

  // ==========================================================================
  console.log("\n=== 2. A belief comes back with what stands behind it ===\n");
  // ==========================================================================
  // REAL EVIDENCE ROWS, not ids invented for the test. Each of the four tables
  // a detector can group is represented, because resolving them is the whole
  // job and a suite that only exercised one would miss three.
  // These three remain because they are EVIDENCE ROWS the resolver has to
  // resolve — CognitiveOutput is one of the four tables evidenceRefs can point
  // at, and dropping them would leave that path untested. They no longer make
  // the belief.
  const findings = await Promise.all(
    [24, 16, 9].map((day) =>
      prisma.cognitiveOutput.create({
        data: {
          storeId: store.id, kind: "insight", topicKey: "refunds.clustered",
          summary: "Refunds cluster on Mondays", status: "ACTIVE", generatedAt: daysAgo(day),
        },
      })
    )
  );

  // ============ WHAT MAKES THE BELIEF NOW (2026-09-02) =================
  //
  // DERIVED BY THE REAL DETECTOR, not hand-written — unchanged as a principle,
  // changed as a fixture. detectInsightRecurrence used to require three
  // findings in three distinct weeks, so this suite wrote three rows. BI Slice
  // 2 replaced that signal: it now reads how long the CONDITION has stood,
  // from the GenesisObservation that owns the finding's identity, because the
  // insight dedupe means a persistent condition writes one row rather than one
  // per week.
  //
  // So the fixture supplies the evidence the detector actually consumes: a
  // standing observation, 25 days old, still ACTIVE. The belief is still
  // produced by the production detector, never inserted directly.
  const STANDING_DAYS = 25;
  await prisma.genesisObservation.create({
    data: {
      storeId: store.id,
      dedupeKey: `${INSIGHT_PREFIX}refunds.clustered`,
      genesisState: "opportunity",
      summary: "Refunds cluster on Mondays",
      status: "ACTIVE",
      firstNoticedAt: daysAgo(STANDING_DAYS),
      lastConfirmedAt: new Date(),
    },
  });
  await detectInsightRecurrence(store.id);

  const belief = await prisma.belief.findFirstOrThrow({
    where: { storeId: store.id, category: "insight_recurrence" },
  });

  // Two more real rows of the other kinds a detector can group, plus one id
  // whose row is genuinely gone. Every table resolveEvidence reads is
  // represented, because a suite exercising one would miss three.
  const event = await prisma.businessEvent.create({
    data: {
      storeId: store.id, entityType: "document", eventType: "invoice.overdue",
      sourceProvider: "quickbooks", summary: "An invoice passed its due date",
      occurredAt: daysAgo(4),
    },
  });
  const approval = await prisma.approvalRequest.create({
    data: {
      storeId: store.id, actionType: "update_product_image",
      summary: "Replace the hero image on Tensor Ring", status: "REJECTED",
      input: {}, previousValues: {}, createdAt: daysAgo(2),
    },
  });
  await prisma.belief.update({
    where: { id: belief.id, storeId: store.id },
    data: {
      evidenceRefs: [findings[2].id, event.id, approval.id, "an-id-that-no-longer-exists"],
      evidenceCount: 4,
    },
  });

  const { active } = await getReviewableBeliefs(store.id, owner.id);
  check("the belief is returned", active.length, 1);
  assert("with the claim the detector derived",
    (active[0]?.claim ?? "").includes("Refunds cluster on Mondays"), String(active[0]?.claim));
  check("its evidence count", active[0]?.evidenceCount, 4);
  check("and a category a person can read", active[0]?.categoryLabel, BELIEF_CATEGORY_LABEL.insight_recurrence);

  // THE HALF THAT DID NOT EXIST. evidenceRefs held real ids and nothing ever
  // resolved them, so "why do you think that?" had no answer anywhere.
  check("three of its four supporting rows resolve", active[0]?.evidence.length, 3);
  check("newest first", active[0]?.evidence.map((e) => e.kind),
    ["decision", "event", "finding"]);
  assert("each described the way the product already describes it",
    active[0]?.evidence.some((e) => e.summary === "Refunds cluster on Mondays") === true,
    active[0]?.evidence.map((e) => e.summary).join(" | "));
  // REPORTED, NOT HIDDEN. A list that silently shrank would make a belief look
  // thinner than the count beside it says.
  check("and the one that is gone is counted, not swallowed", active[0]?.evidenceMissing, 1);

  // The dates that say whether it still holds — all on the row, none ever shown.
  assert("first-noticed is carried",
    active[0]?.firstObservedAt.getTime() === belief.firstObservedAt.getTime());
  assert("and last-confirmed",
    active[0]?.lastConfirmedAt.getTime() === belief.lastConfirmedAt.getTime());
  // Two genuinely different dates, so "carried" is not both fields reading one
  // value — the assertion above passes either way.
  assert("and they really are different dates, not one value twice",
    belief.firstObservedAt.getTime() !== belief.lastConfirmedAt.getTime(),
    belief.firstObservedAt.toISOString() + " vs " + belief.lastConfirmedAt.toISOString());

  // ==========================================================================
  console.log("\n=== 3. Evidence never crosses a tenant boundary ===\n");
  // ==========================================================================
  // An evidence id is a bare string on a row with no foreign key behind it, so
  // a resolver that forgot storeId would print another business's finding as
  // this one's evidence, with no error and nothing to notice.
  const neighboursFinding = await prisma.cognitiveOutput.create({
    data: {
      storeId: other.id, kind: "insight", summary: "THE NEIGHBOUR'S PRIVATE FINDING",
      status: "ACTIVE",
    },
  });
  await prisma.belief.update({
    where: { id: belief.id, storeId: store.id },
    data: { evidenceRefs: [findings[2].id, neighboursFinding.id] },
  });
  // THE PLATFORM REFUSES THIS BEFORE THE SUITE CAN, which is the stronger
  // outcome: dropping storeId from resolveEvidence throws at the Prisma
  // extension ("CognitiveOutput.findMany was called without a store-scoping
  // filter") rather than returning the neighbour's row. Confirmed by negative
  // control. These assertions stay as the second line — they catch a resolver
  // that IS scoped but scoped to the wrong thing, which the guard cannot see.
  const leaky = await getReviewableBeliefs(store.id, owner.id);
  assert("a neighbour's row is not shown as this business's evidence",
    !leaky.active[0]?.evidence.some((e) => e.summary.includes("NEIGHBOUR")),
    leaky.active[0]?.evidence.map((e) => e.summary).join(" | "));
  check("it is counted as unresolved instead", leaky.active[0]?.evidenceMissing, 1);
  await prisma.belief.update({
    where: { id: belief.id, storeId: store.id },
    // RESTORED TO WHAT THE DETECTOR ITSELF PRODUCES (2026-09-02). This pinned
    // 3 — the row count under the old week-counting signal. Under BI Slice 2
    // the detector derives the count from how long the condition has stood, so
    // a hard 3 here made the very next re-derivation look like STRONGER
    // evidence and resurrected a belief the owner had dismissed. The
    // durability rule was right; the fixture was describing the old model.
    data: { evidenceRefs: findings.map((f) => f.id), evidenceCount: STANDING_DAYS },
  });

  // ==========================================================================
  console.log("\n=== 4. The owner can say it is wrong ===\n");
  // ==========================================================================
  const wrong = await contradictBelief({
    storeId: store.id, beliefId: belief.id, userId: owner.id,
    note: "Mondays are fine, that was one bad month",
  });
  assert("the correction is accepted", wrong.ok, JSON.stringify(wrong));

  const row = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
  // DISMISSED, NOT RETIRED, and the distinction is the point: RETIRED is the
  // system's own outcome (the evidence stopped supporting it), DISMISSED is a
  // person disagreeing. Collapsing them lets "the owner said no" read back later
  // as "it didn't generalise", and those call for opposite responses.
  check("it is marked dismissed, not retired", row.status, DISMISSED);
  assert("and says a person did it", (row.retiredReason ?? "").startsWith("dismissed by the owner"),
    String(row.retiredReason));
  assert("in their own words", (row.retiredReason ?? "").includes("one bad month"), String(row.retiredReason));

  // Nothing about the EVIDENCE changed, because nothing about it did. A
  // correction is a judgement on the conclusion, not a rewriting of history.
  // The literal was 3 — the row count under the old signal. The PROPERTY is
  // unchanged and is the point: dismissing a belief is a judgement on the
  // conclusion, never a rewriting of the evidence behind it.
  check("the evidence count is untouched", row.evidenceCount, STANDING_DAYS);
  check("and the confidence it was derived at", row.confidence, belief.confidence);

  // ==========================================================================
  console.log("\n=== 5. And J4 stops using it ===\n");
  // ==========================================================================
  // THE ASSERTION THAT MAKES THE FEATURE REAL. A correction that leaves the
  // belief in the prompt has changed a screen and nothing else.
  const forReasoning = await getBeliefs(store.id, { viewerUserId: owner.id });
  check("a corrected belief no longer reaches reasoning",
    forReasoning.filter((b) => b.id === belief.id).length, 0);

  // But the owner can still see what they corrected — a correction you cannot
  // see is one you cannot take back.
  const afterCorrection = await getReviewableBeliefs(store.id, owner.id);
  check("it is gone from the active list", afterCorrection.active.length, 0);
  check("and present in the corrected one", afterCorrection.contradicted.length, 1);
  assert("with the reason kept",
    (afterCorrection.contradicted[0]?.contradictedReason ?? "").includes("one bad month"));

  // ==========================================================================
  console.log("\n=== 6. And it stays corrected ===\n");
  // ==========================================================================
  // THE FAILURE THIS PREVENTS: distillBeliefs re-derives from evidence on every
  // pass, so without a durability rule the owner's correction would be undone
  // within the hour — a control that appears to work and quietly does not.
  //
  // Re-derived from the SAME evidence, exactly as the next scheduled pass would.
  await detectInsightRecurrence(store.id);
  check("re-deriving from the same evidence does not resurrect it",
    (await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } })).status, DISMISSED);

  // NOT "suppress forever", which would stop J4 learning: a dismissal holds
  // while the evidence is the evidence the owner already judged. A genuinely
  // stronger pattern than the one they rejected entitles the detector to raise
  // it again.
  //
  // WHAT "STRONGER" MEANS NOW. It was four more findings across four more
  // weeks; under BI Slice 2 the strength of this pattern IS how long the
  // condition has stood, so the same escalation is the same condition having
  // stood far longer — 25 days when they dismissed it, 60 now.
  const LONGER_STANDING_DAYS = 60;
  await prisma.genesisObservation.updateMany({
    where: { storeId: store.id, dedupeKey: `${INSIGHT_PREFIX}refunds.clustered` },
    data: { firstNoticedAt: daysAgo(LONGER_STANDING_DAYS), lastConfirmedAt: new Date() },
  });
  await detectInsightRecurrence(store.id);
  const revived = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
  check("but genuinely stronger evidence than they saw brings it back", revived.status, "ACTIVE");
  assert("and it IS stronger, not merely re-run",
    revived.evidenceCount > STANDING_DAYS,
    `${revived.evidenceCount} days standing now, against ${STANDING_DAYS} when it was dismissed`);

  // ==========================================================================
  console.log("\n=== 7. Changing your mind about a correction ===\n");
  // ==========================================================================
  await contradictBelief({ storeId: store.id, beliefId: belief.id, userId: owner.id });
  const undone = await restoreBelief({ storeId: store.id, beliefId: belief.id, userId: owner.id });
  assert("a correction can be undone", undone.ok, JSON.stringify(undone));
  const restored = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
  check("the belief is active again", restored.status, "ACTIVE");
  check("with no lingering reason", restored.retiredReason, null);
  check("and no retirement date", restored.retiredAt, null);
  // Nothing about the evidence changed, so nothing about confidence should — a
  // belief brought back is exactly the belief that was there.
  check("its evidence count is the same", restored.evidenceCount, revived.evidenceCount);

  // Restoring something that was never corrected is refused rather than silently
  // succeeding on a belief that is already active.
  const noop = await restoreBelief({ storeId: store.id, beliefId: belief.id, userId: owner.id });
  check("restoring an active belief finds nothing to restore",
    noop.ok ? "restored" : noop.refusal, "unknown_belief");

  // ==========================================================================
  console.log("\n=== 8. Only the owner, and only their own business ===\n");
  // ==========================================================================
  const byEmployee = await contradictBelief({
    storeId: store.id, beliefId: belief.id, userId: employee.id,
  });
  check("an employee cannot correct what J4 believes",
    byEmployee.ok ? "corrected" : byEmployee.refusal, "not_permitted");
  check("and the belief is untouched",
    (await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } })).status, "ACTIVE");

  // A belief id alone is unique, so scoping a write by it and checking the store
  // afterwards would be a cross-tenant edit that returns successfully.
  const crossTenant = await contradictBelief({
    storeId: other.id, beliefId: belief.id, userId: owner.id,
  });
  check("and it cannot be corrected through another business",
    crossTenant.ok ? "corrected" : crossTenant.refusal, "unknown_belief");
  check("that belief is still active",
    (await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } })).status, "ACTIVE");

  // ==========================================================================
  console.log("\n=== 9. A pattern about a PERSON is only theirs to read ===\n");
  // ==========================================================================
  // Business Understanding is about what the business sells. This is a model of
  // how one named person makes decisions, and it goes into prompts — so an
  // employee chatting with J4 would have heard it read back to them.
  await prisma.belief.create({
    data: {
      storeId: store.id, topicKey: "rejection_pattern:image", claim: "You turn down image changes",
      category: "owner_preference", confidence: 0.8, evidenceCount: 3,
      firstObservedAt: daysAgo(30), lastConfirmedAt: daysAgo(1),
      evidenceRefs: [approval.id], entityType: OWNER_ENTITY_TYPE, recordId: owner.id,
    },
  });

  const ownerSees = await getReviewableBeliefs(store.id, owner.id);
  assert("the owner sees the pattern about themselves",
    ownerSees.active.some((b) => b.claim === "You turn down image changes"));
  assert("marked as being about them",
    ownerSees.active.find((b) => b.claim === "You turn down image changes")?.aboutYou === true);

  const employeeSees = await getReviewableBeliefs(store.id, employee.id);
  assert("an employee does not see it",
    !employeeSees.active.some((b) => b.claim === "You turn down image changes"),
    employeeSees.active.map((b) => b.claim).join(" | "));
  // AND STILL SEES THE BUSINESS ONES. The `{ not: "owner" }` filter alone is a
  // known bug — in SQL, NOT (entityType = 'owner') is NULL for a row whose
  // entityType IS NULL, which is every business-level belief, so the filter
  // silently excluded all of them. learn.ts records its suite catching this.
  assert("but does see the business's own beliefs",
    employeeSees.active.some((b) => b.category === "insight_recurrence"),
    employeeSees.active.map((b) => b.claim).join(" | "));

  await prisma.store.deleteMany({ where: { id: { in: [store.id, other.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, employee.id] } } });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
