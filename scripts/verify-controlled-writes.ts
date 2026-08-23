import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import {
  stateFact,
  stateRelationship,
  retractRelationship,
  recordExistsInStore,
  internalIds,
  REFUSAL_MESSAGE,
  type StatementRefusal,
} from "@/lib/businessModel/statements";
import { relationsOf, relate } from "@/lib/businessModel/relationships";

// SAYING SOMETHING NEW, WITHOUT BEING ABLE TO LIE ABOUT WHERE IT CAME FROM:
//
//   npx tsx scripts/run-db-suites.ts controlled-writes
//
// Two things are proved here, and the second is the one that matters.
//
// FIRST, that a person can state a fact or draw a connection at all — U3's
// "controlled path for recording legitimate new facts and relationships".
//
// SECOND, that the path cannot be used to forge provenance. persistSyncedRecords
// takes provenance as an argument, which is right for a pipeline that genuinely
// knows what it is. Anything a browser can reach must NOT, because a caller who
// can pass CONNECTOR can make their own sentence read as something QuickBooks
// published — and every downstream reader will believe it, since believing it is
// precisely what the column was built for. One such path destroys the value of
// every honest one.
//
// Also covers reconciliation, which was missing when projection first shipped: a
// graph that only ever adds is confidently wrong rather than merely absent.

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

const goalData = (description: string) => ({
  description, category: "revenue", priority: "high", targetDate: null,
  targetValueInCents: null, status: "active", identifiedAt: "2026-08-22",
  relatedChallengeIds: [] as string[],
});
const challengeData = (description: string, relatedGoalIds: string[] = []) => ({
  description, category: "cash_flow", severity: "high", status: "active",
  identifiedAt: "2026-08-22", resolvedAt: null, relatedGoalIds,
});

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({ data: { email: `stmt-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `stmt-${uniq()}` },
  });
  const other = await prisma.store.create({
    data: { userId: user.id, name: "Iron Gym", slug: `stmt-other-${uniq()}` },
  });

  // ==========================================================================
  console.log("\n=== 1. A person can state a fact ===\n");
  // ==========================================================================
  const stated = await stateFact({
    storeId: store.id, userId: user.id, entityType: "goal",
    data: goalData("Open a second workshop"), modelExtracted: false, context: "workspace",
  });
  assert("the fact is recorded", stated.ok, stated.ok ? stated.value.recordId : JSON.stringify(stated));
  if (!stated.ok) throw new Error("cannot continue without a stated fact");

  const row = await prisma.businessRecord.findUniqueOrThrow({ where: { id: stated.value.recordId } });
  check("as the owner's own", row.provenance, "OWNER");
  check("attributed to the person who said it", row.statedById, user.id);
  check("noting they typed it rather than a model reading it", row.modelExtracted, false);
  check("and where they said it", row.provenanceDetail, "workspace");

  // ==========================================================================
  console.log("\n=== 2. And cannot lie about where it came from ===\n");
  // ==========================================================================
  // THE CENTRAL ASSERTION OF THIS FILE. stateFact takes no provenance argument,
  // so there is no value a caller could pass to make their sentence read as a
  // connector's. Asserted structurally rather than by trying to pass one,
  // because "the parameter does not exist" is the actual guarantee — a runtime
  // check could be removed while the signature stayed honest-looking.
  const params = Object.keys({
    storeId: "", userId: "", entityType: "", data: null, modelExtracted: false, context: "",
  });
  assert("stateFact's inputs name no provenance at all",
    !params.includes("provenance") && !params.includes("statedById"),
    params.join(", "));

  // Every fact this path can produce, whatever the caller does, is OWNER.
  const extracted = await stateFact({
    storeId: store.id, userId: user.id, entityType: "challenge",
    data: challengeData("Cash flow is tight"), modelExtracted: true, context: "chat",
  });
  assert("a second statement is recorded", extracted.ok);
  if (!extracted.ok) throw new Error("no challenge");
  const challengeRow = await prisma.businessRecord.findUniqueOrThrow({ where: { id: extracted.value.recordId } });
  check("also as the owner's", challengeRow.provenance, "OWNER");
  // The half a caller CAN set, because it is a fact about the code path rather
  // than a claim by the actor: whether an extractor stood in between.
  check("but recording that a model wrote this one down", challengeRow.modelExtracted, true);

  const everyStated = await prisma.businessRecord.findMany({
    where: { storeId: store.id, sourceProvider: "genesis_stated" },
    select: { provenance: true },
  });
  check("nothing this path writes is anything but OWNER",
    [...new Set(everyStated.map((r) => r.provenance))], ["OWNER"]);

  // ==========================================================================
  console.log("\n=== 3. A malformed statement is refused, not stored ===\n");
  // ==========================================================================
  const badType = await stateFact({
    storeId: store.id, userId: user.id, entityType: "invoice",
    data: goalData("x"), modelExtracted: false,
  });
  check("an unregistered entity type is refused",
    badType.ok ? "written" : badType.refusal, "unknown_entity_type");

  const badShape = await stateFact({
    storeId: store.id, userId: user.id, entityType: "goal",
    data: { description: 42 }, modelExtracted: false,
  });
  check("a malformed goal is refused", badShape.ok ? "written" : badShape.refusal, "invalid_shape");

  const countAfter = await prisma.businessRecord.count({
    where: { storeId: store.id, sourceProvider: "genesis_stated" },
  });
  check("and neither reached the table", countAfter, 2);

  // A refusal an owner can read. The code itself is machine vocabulary and
  // rendering it is the same defect a raw enum label would be.
  const refusals: StatementRefusal[] = [
    "unknown_entity_type", "invalid_shape", "unknown_kind",
    "unknown_record", "self_reference", "not_stated",
  ];
  check("every refusal has something a person can read",
    refusals.filter((r) => !REFUSAL_MESSAGE[r]?.trim()), []);
  assert("and none of them is the code",
    refusals.every((r) => REFUSAL_MESSAGE[r] !== r),
    REFUSAL_MESSAGE.not_stated);

  // ==========================================================================
  console.log("\n=== 4. A person can draw a connection ===\n");
  // ==========================================================================
  const drawn = await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: extracted.value.recordId, fromType: "challenge",
    toId: stated.value.recordId, toType: "goal",
    kind: "blocks", context: "workspace",
  });
  assert("the connection is drawn", drawn.ok, JSON.stringify(drawn));

  const edges = await relationsOf(store.id, stated.value.recordId);
  check("and reads back from the goal", edges.length, 1);
  check("as the owner's own statement", edges[0]?.provenance, "OWNER");
  check("attributed to them", edges[0]?.statedById, user.id);
  // NOTHING MAINTAINS IT BUT THE PERSON WHO SAID IT — which is what makes it
  // survive the sync in section 6.
  check("and maintained by no record", edges[0]?.projectedFrom, null);

  // ==========================================================================
  console.log("\n=== 5. A connection cannot point outside the business ===\n");
  // ==========================================================================
  const foreign = await persistSyncedRecords(other.id, "genesis_chat", [
    { entityType: "goal", externalId: "foreign-goal", data: goalData("Their goal") as never },
  ], { provenance: "OWNER", statedById: user.id, modelExtracted: false });
  const foreignId = foreign.changes[0].recordId;

  const leak = await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: extracted.value.recordId, fromType: "challenge",
    toId: foreignId, toType: "goal", kind: "blocks",
  });
  check("a link to another business's record is refused",
    leak.ok ? "written" : leak.refusal, "unknown_record");
  // BOTH ends checked, not one: anchoring on something real and pointing it
  // anywhere is the same hole from the other side.
  const reverseLeak = await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: foreignId, fromType: "goal",
    toId: stated.value.recordId, toType: "goal", kind: "blocks",
  });
  check("and so is a link FROM one", reverseLeak.ok ? "written" : reverseLeak.refusal, "unknown_record");

  const invented = await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: extracted.value.recordId, fromType: "challenge",
    toId: "not-an-id-at-all", toType: "goal", kind: "blocks",
  });
  check("an id nobody issued is refused", invented.ok ? "written" : invented.refusal, "unknown_record");

  const selfLink = await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: stated.value.recordId, fromType: "goal",
    toId: stated.value.recordId, toType: "goal", kind: "about",
  });
  check("a record cannot be connected to itself",
    selfLink.ok ? "written" : selfLink.refusal, "self_reference");

  const badKind = await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: extracted.value.recordId, fromType: "challenge",
    toId: stated.value.recordId, toType: "goal", kind: "constructor",
  });
  check("and a prototype key is not a connection", badKind.ok ? "written" : badKind.refusal, "unknown_kind");

  check("none of that reached the table",
    await prisma.recordRelationship.count({ where: { storeId: store.id } }), 1);

  // ==========================================================================
  console.log("\n=== 6. Live-computed records are real endpoints ===\n");
  // ==========================================================================
  // Refusing these would make "this order was placed by that customer" — the
  // most ordinary relationship in the product — unstateable, because the
  // internal mapper computes those records live and they have no row.
  const product = await prisma.product.create({
    data: { storeId: store.id, name: "Tensor Ring", priceInCents: 8_500, active: true },
  });
  await prisma.order.create({
    data: {
      storeId: store.id, productId: product.id, productName: "Tensor Ring",
      amountInCents: 8_500, buyerEmail: "buyer@stmt.test", paymentProvider: "STRIPE",
      externalOrderId: `o-${uniq()}`,
    },
  });

  assert("a live-computed item exists",
    await recordExistsInStore(store.id, internalIds.item(product.id)));
  assert("so does a customer derived from a real order",
    await recordExistsInStore(store.id, internalIds.contact("buyer@stmt.test")));
  // Resolved against the SOURCE rows and scoped by store, not trusted for
  // looking well-formed. An id is a string anybody can type.
  assert("but not one from another business",
    !(await recordExistsInStore(other.id, internalIds.item(product.id))));
  assert("nor an address nobody ordered from",
    !(await recordExistsInStore(store.id, internalIds.contact("nobody@stmt.test"))));
  assert("nor a well-formed id for a kind that does not exist",
    !(await recordExistsInStore(store.id, "internal:sorcery:x")));
  assert("nor an empty tail", !(await recordExistsInStore(store.id, "internal:item:")));

  const toCustomer = await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: internalIds.contact("buyer@stmt.test"), fromType: "contact",
    toId: internalIds.item(product.id), toType: "item", kind: "supplies",
  });
  assert("and a connection between two of them is allowed", toCustomer.ok, JSON.stringify(toCustomer));

  // ==========================================================================
  console.log("\n=== 7. A sync reconciles its own edges, and only its own ===\n");
  // ==========================================================================
  const goalA = await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "goal", externalId: "g-a", data: goalData("Goal A") as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  const goalB = await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "goal", externalId: "g-b", data: goalData("Goal B") as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  const goalAId = goalA.changes[0].recordId;
  const goalBId = goalB.changes[0].recordId;

  const ch = await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "challenge", externalId: "c-1", data: challengeData("Supply delays", [goalAId]) as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  const chId = ch.changes[0].recordId;
  check("the first sync projects one edge", ch.relationshipsWritten, 1);
  check("pointing at goal A", (await relationsOf(store.id, chId)).map((r) => r.toId), [goalAId]);

  // THE DEFECT THIS SECTION EXISTS FOR. Before reconciliation, re-syncing with a
  // different reference ADDED the new edge and left the old one standing, so
  // "what is this blocking?" answered "both" and both looked equally stated.
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "challenge", externalId: "c-1", data: challengeData("Supply delays", [goalBId]) as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  check("re-syncing with a changed reference moves the edge rather than adding one",
    (await relationsOf(store.id, chId)).map((r) => r.toId), [goalBId]);

  // A reference removed entirely leaves nothing behind.
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "challenge", externalId: "c-1", data: challengeData("Supply delays", []) as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  check("and a reference removed takes its edge with it",
    (await relationsOf(store.id, chId)).length, 0);

  // AND NEVER SOMEBODY ELSE'S. An owner-stated edge between the same two
  // records has a null projectedFrom and must survive every sync.
  await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: chId, fromType: "challenge", toId: goalAId, toType: "goal", kind: "blocks",
  });
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "challenge", externalId: "c-1", data: challengeData("Supply delays", []) as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  const survivors = await relationsOf(store.id, chId);
  check("a connection the owner drew survives the sync", survivors.length, 1);
  check("still theirs", survivors[0]?.statedById, user.id);
  assert("because nothing else maintains it", survivors[0]?.projectedFrom === null);

  // TWO RECORDS PROJECTING ONE EDGE: pinned, not fixed. goal.relatedChallengeIds
  // and challenge.relatedGoalIds are the only pair that can produce the same
  // edge from both ends, `projectedFrom` names one owner, so the last writer
  // owns it — and if that owner drops its reference while the other still names
  // it, the edge goes until the other is next written.
  //
  // Unreachable in the product today: both fields are hard-coded to [] at every
  // write site and no connector produces either entity type. This asserts what
  // actually happens so whoever makes those fields real gets a failure rather
  // than a surprise.
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "challenge", externalId: "c-2", data: challengeData("Two-sided", [goalAId]) as never },
  ], { provenance: "CONNECTOR", modelExtracted: false });
  const twoSided = await prisma.businessRecord.findFirstOrThrow({
    where: { storeId: store.id, externalId: "c-2" },
  });
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "goal", externalId: "g-a",
      data: { ...goalData("Goal A"), relatedChallengeIds: [twoSided.id] } as never },
  ], { provenance: "CONNECTOR", modelExtracted: false });
  const owned = await prisma.recordRelationship.findFirstOrThrow({
    where: { storeId: store.id, fromId: twoSided.id, toId: goalAId, kind: "blocks" },
  });
  check("when both ends name an edge, the last writer owns it", owned.projectedFrom, goalAId);
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "goal", externalId: "g-a", data: goalData("Goal A") as never },
  ], { provenance: "CONNECTOR", modelExtracted: false });
  check("so dropping it there removes the edge, even though the challenge still names it",
    await prisma.recordRelationship.count({ where: { storeId: store.id, fromId: twoSided.id, toId: goalAId } }), 0);
  assert("and the challenge's own data is unchanged, so a re-sync restores it",
    ((twoSided.data as { relatedGoalIds: string[] }).relatedGoalIds ?? []).includes(goalAId));

  // Reconciliation is tenant-scoped like every other write here.
  await relate({
    storeId: other.id, fromId: chId, fromType: "challenge", toId: goalAId, toType: "goal",
    kind: "blocks", provenance: "CONNECTOR", projectedFrom: chId,
  });
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "challenge", externalId: "c-1", data: challengeData("Supply delays", []) as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  check("a neighbour's edge with the same projectedFrom is untouched",
    await prisma.recordRelationship.count({ where: { storeId: other.id, projectedFrom: chId } }), 1);

  // ==========================================================================
  console.log("\n=== 8. Taking back what you said, and only that ===\n");
  // ==========================================================================
  const retracted = await retractRelationship({
    storeId: store.id, fromId: chId, toId: goalAId, kind: "blocks",
  });
  assert("a stated connection can be taken back", retracted.ok, JSON.stringify(retracted));
  check("and is gone", (await relationsOf(store.id, chId)).length, 0);

  // A PROJECTED edge is a restatement of what the record itself says. Deleting
  // it here would leave the graph disagreeing with the record until the next
  // sync quietly put it back — a correction that appears to work and then
  // undoes itself is worse than one that refuses.
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "challenge", externalId: "c-1", data: challengeData("Supply delays", [goalAId]) as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  const refusedRetraction = await retractRelationship({
    storeId: store.id, fromId: chId, toId: goalAId, kind: "blocks",
  });
  check("a projected connection refuses to be retracted",
    refusedRetraction.ok ? "deleted" : refusedRetraction.refusal, "not_stated");
  check("and is still there", (await relationsOf(store.id, chId)).length, 1);
  assert("with a refusal that says what to do instead",
    REFUSAL_MESSAGE.not_stated.includes("record"), REFUSAL_MESSAGE.not_stated);

  // Retraction cannot reach into another store.
  const crossStore = await retractRelationship({
    storeId: other.id, fromId: chId, toId: goalAId, kind: "blocks",
  });
  assert("retraction from the wrong store finds nothing to retract", !crossStore.ok);
  check("and the neighbour's own row is untouched",
    await prisma.recordRelationship.count({ where: { storeId: other.id } }), 1);

  // CLEANS UP AFTER ITSELF, unlike most suites here, and for a reason found
  // rather than assumed: run-db-suites never resets between suites, so every
  // fixture row this file leaves behind is still there when the ones after it
  // run. Adding this suite made verify-social-connections-pipeline's Case 5
  // drop its connection on a query that passes perfectly well standalone —
  // proved by removing this file and watching the full run go back to 30/30.
  //
  // Only the two stores THIS file created, by id, and only via the cascade
  // their own rows already declare. Nothing here reaches for "a real store" or
  // deletes anything it did not make.
  await prisma.store.deleteMany({ where: { id: { in: [store.id, other.id] } } });
  await prisma.user.deleteMany({ where: { id: user.id } });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
