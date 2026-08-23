import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { queryRecords, findRelated } from "@/lib/businessModel/reasoning";
import {
  RECORD_PROVENANCE,
  PROVENANCE_LABEL,
  PROVENANCE_GROUNDING,
  isFirstPartyEvidence,
  isDefeasibleClaim,
  hasHumanAuthor,
  describeStatedAge,
  describeProvenance,
} from "@/lib/businessModel/provenance";
import {
  RELATIONSHIP_KINDS,
  RELATIONSHIP_KIND_KEYS,
  PROJECTIONS,
  isRelationshipKind,
  relate,
  relationsOf,
  relationsByKind,
  describeRelation,
} from "@/lib/businessModel/relationships";
import { mapOrdersToTransactions, mapProductsToItems, deriveContactsFromOrders } from "@/lib/businessModel/internalMapper";

// WHERE A FACT CAME FROM, AND WHAT IT IS CONNECTED TO:
//
//   npx tsx scripts/run-db-suites.ts provenance
//
// J4 held facts it could not source and connections it could not name. This
// covers both halves of the fix and, more importantly, covers the ways the fix
// could quietly become a lie:
//
//   - a provenance that gets INVENTED for a record nobody sourced
//   - a model's conclusion that reads back as something the owner said
//   - a relationship stored in both directions, so "what is blocking me"
//     has two answers
//   - a tenant boundary that holds for records and not for the edges between
//     them
//
// EVERY ONE OF THOSE IS SILENT. A wrong provenance does not throw; it makes J4
// sound more certain than it has any right to be, in a sentence that reads
// perfectly well. That is why this file asserts on the CONTENT of the claim and
// not merely that a column is populated.

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

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({ data: { email: `prov-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `prov-${uniq()}` },
  });
  // A SECOND STORE, present from the first line. Every isolation assertion
  // below is worthless without a real neighbour to leak to.
  const other = await prisma.store.create({
    data: { userId: user.id, name: "Iron Gym", slug: `prov-other-${uniq()}` },
  });

  // ==========================================================================
  console.log("\n=== 1. The vocabulary mirrors the database, in both directions ===\n");
  // ==========================================================================
  // ARCHITECTURE.md's standing invariant: a hand-maintained registry mirroring
  // another must carry a runtime cross-check. RECORD_PROVENANCE is a literal
  // because the Prisma enum's type is erased and this list has to be iterated
  // and rendered at runtime — so the compiler catches a typo and cannot catch a
  // value that exists in one place and not the other.
  const dbValues: string[] = await prismaSystem
    .$queryRawUnsafe<{ label: string }[]>(
      `SELECT e.enumlabel AS label FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'RecordProvenance' ORDER BY e.enumsortorder`
    )
    .then((rows) => rows.map((r) => r.label));

  check("every database value is in the runtime list",
    dbValues.filter((v) => !(RECORD_PROVENANCE as readonly string[]).includes(v)), []);
  check("every runtime value is in the database",
    RECORD_PROVENANCE.filter((v) => !dbValues.includes(v)), []);

  check("every value has an owner-facing label",
    RECORD_PROVENANCE.filter((p) => !PROVENANCE_LABEL[p]?.trim()), []);
  check("every value has grounding for a prompt",
    RECORD_PROVENANCE.filter((p) => !PROVENANCE_GROUNDING[p]?.trim()), []);

  // A LABEL THAT IS THE ENUM NAME IS NOT A LABEL. "INFERENCE" printed at an
  // owner reads as authority in exactly the place the least is warranted — the
  // same failure ARCHITECTURE.md records for COGNITIVE_OUTPUT_KIND_LABEL, where
  // a raw kind string reached a merchant.
  assert("no label is the raw enum name",
    RECORD_PROVENANCE.every((p) => PROVENANCE_LABEL[p].toUpperCase() !== p),
    RECORD_PROVENANCE.map((p) => PROVENANCE_LABEL[p]).join(" | "));

  // ==========================================================================
  console.log("\n=== 2. The three grades of evidence stay apart ===\n");
  // ==========================================================================
  check("a connector is first-party evidence", isFirstPartyEvidence("CONNECTOR"), true);
  check("so is what the owner told us", isFirstPartyEvidence("OWNER"), true);
  check("so is a document they shared", isFirstPartyEvidence("DOCUMENT"), true);
  check("so is arithmetic over their own orders", isFirstPartyEvidence("DERIVED"), true);
  check("J4's own conclusion is NOT", isFirstPartyEvidence("INFERENCE"), false);
  check("neither is something J4 made", isFirstPartyEvidence("GENERATED"), false);

  // The distinction that earned GENERATED its own value. Both came from J4 and
  // neither is evidence — but only one of them can turn out to be untrue, and
  // hedging a file that exists is as dishonest as stating a guess flatly.
  check("an inference is a claim that could be wrong", isDefeasibleClaim("INFERENCE"), true);
  check("a generated design is not a claim at all", isDefeasibleClaim("GENERATED"), false);

  check("only an owner-stated fact has a human author",
    RECORD_PROVENANCE.filter((p) => hasHumanAuthor(p)), ["OWNER"]);

  // NULL IS NOT A GRADE. A record nobody sourced must not read as evidence.
  check("unknown provenance is not first-party evidence", isFirstPartyEvidence(null), false);
  check("and describes as nothing rather than as a placeholder",
    describeProvenance({ provenance: null, provenanceDetail: null, statedAt: new Date(), statedById: null, modelExtracted: null }),
    null);

  // ==========================================================================
  console.log("\n=== 3. A connector fact and a model's reading are told apart ===\n");
  // ==========================================================================
  const invoiceData = {
    type: "invoice", amountInCents: 42_000, status: "pending",
    contactId: null, issuedAt: "2026-08-01T00:00:00.000Z", dueAt: "2026-09-01T00:00:00.000Z",
  };
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "document", externalId: "inv-1", data: invoiceData as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", statedById: null, modelExtracted: false });

  await persistSyncedRecords(store.id, "genesis_chat", [
    {
      entityType: "goal",
      externalId: "goal-1",
      data: {
        description: "Reach £5,000 a month", category: "revenue", priority: "high",
        targetDate: null, targetValueInCents: 500_000, status: "active",
        identifiedAt: "2026-03-02", relatedChallengeIds: [],
      } as never,
    },
  ], {
    provenance: "OWNER", provenanceDetail: "chat", statedById: user.id,
    statedAt: new Date("2026-03-02T10:00:00.000Z"), modelExtracted: true,
  });

  const documents = await queryRecords(store.id, "document");
  const goals = await queryRecords(store.id, "goal");

  check("the invoice is sourced to the connector", documents[0]?.provenance, "CONNECTOR");
  check("with no human author", documents[0]?.statedById, null);
  check("and nothing interpreted it", documents[0]?.modelExtracted, false);

  check("the goal is the owner's", goals[0]?.provenance, "OWNER");
  check("and names who said it", goals[0]?.statedById, user.id);
  // THE HALF THAT IS EASY TO LOSE. The owner is the author of the goal; the
  // sentence stored is a model's reading of what they typed. A reader that saw
  // only OWNER would quote a paraphrase back as the owner's own words.
  check("while recording that a model wrote it down", goals[0]?.modelExtracted, true);

  // THE WHOLE POINT, IN ONE ASSERTION: two facts that were previously
  // indistinguishable shapes now answer differently.
  assert("so a bank's figure and a paraphrased sentence are no longer the same shape",
    documents[0]?.provenance !== goals[0]?.provenance &&
      documents[0]?.modelExtracted !== goals[0]?.modelExtracted);

  // ==========================================================================
  console.log("\n=== 4. Nothing invents a provenance nobody stated ===\n");
  // ==========================================================================
  // A row written straight to the table, the way every record in production
  // written before 2026-08-22 was. The honest answer for it is "nobody
  // recorded", and the temptation the migration deliberately refused was to
  // read "quickbooks" and backfill CONNECTOR.
  const legacy = await prisma.businessRecord.create({
    data: {
      storeId: store.id, entityType: "challenge", sourceProvider: "quickbooks",
      externalId: "legacy-1",
      data: { description: "Cash flow", category: "cash_flow", severity: "high",
              status: "active", identifiedAt: "2026-01-01", resolvedAt: null, relatedGoalIds: [] },
    },
  });
  const legacyRead = (await queryRecords(store.id, "challenge")).find((r) => r.id === legacy.id);
  check("a pre-existing record has no provenance", legacyRead?.provenance, null);
  check("nor a fabricated author", legacyRead?.statedById, null);
  // modelExtracted is NULLABLE and not defaulted for exactly this: `false` is
  // itself a claim — "nothing interpreted this" — and a historical row is not
  // entitled to make it.
  check("nor a claim that nothing interpreted it", legacyRead?.modelExtracted, null);
  assert("so unknown stays unknown rather than becoming a plausible guess",
    legacyRead?.provenance === null && legacyRead?.sourceProvider === "quickbooks",
    "sourceProvider says quickbooks; provenance still refuses to conclude CONNECTOR");

  // AND A CALLER THAT SIMPLY DOES NOT SAY. modelExtracted is optional on
  // WriteOrigin, so a write can omit it — and the tempting default is `false`,
  // which reads identically to a deliberate "nothing interpreted this". It is
  // not the same statement, and this assertion exists because a negative
  // control found nothing testing it: sync.ts was quietly free to default.
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "document", externalId: "inv-silent", data: invoiceData as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks" });
  const silent = await prisma.businessRecord.findFirst({
    where: { storeId: store.id, externalId: "inv-silent" },
  });
  check("a writer that says nothing about interpretation records nothing",
    silent?.modelExtracted, null);
  check("while still recording what it DID say", silent?.provenance, "CONNECTOR");

  // ==========================================================================
  console.log("\n=== 5. Live-computed records are DERIVED, and dated honestly ===\n");
  // ==========================================================================
  const orderedAt = new Date("2026-07-04T09:00:00.000Z");
  const product = await prisma.product.create({
    data: { storeId: store.id, name: "Tensor Ring", priceInCents: 8_500, active: true },
  });
  await prisma.order.create({
    data: {
      storeId: store.id, productId: product.id, productName: "Tensor Ring",
      amountInCents: 8_500, buyerEmail: "buyer@prov.test", paymentProvider: "STRIPE",
      externalOrderId: `o-${uniq()}`, createdAt: orderedAt,
    },
  });

  const transactions = await queryRecords(store.id, "transaction");
  check("a transaction from a real order is DERIVED", transactions[0]?.provenance, "DERIVED");
  // NOT `new Date()`. A fabricated statedAt would make every derived record
  // permanently "today", which is the one thing that could make DERIVED — the
  // most trustworthy kind here — start lying.
  check("dated when the sale happened, not when the mapping ran",
    transactions[0]?.statedAt?.toISOString(), orderedAt.toISOString());
  check("with no author, because arithmetic has none", transactions[0]?.statedById, null);

  const items = mapProductsToItems([product]);
  check("an item is DERIVED too", items[0]?.provenance, "DERIVED");
  const contacts = deriveContactsFromOrders(
    await prisma.order.findMany({ where: { storeId: store.id } })
  );
  check("and so is a customer derived from orders", contacts[0]?.provenance, "DERIVED");
  check("dated by their most recent order",
    contacts[0]?.statedAt?.toISOString(), orderedAt.toISOString());

  const mapped = mapOrdersToTransactions(await prisma.order.findMany({ where: { storeId: store.id } }));
  assert("DERIVED is not a hedge: it needs no qualifying language",
    isFirstPartyEvidence(mapped[0].provenance) && !isDefeasibleClaim(mapped[0].provenance),
    "arithmetic over rows this platform owns is as good as those rows");

  // ==========================================================================
  console.log("\n=== 6. Age is reported; staleness is not invented ===\n");
  // ==========================================================================
  const now = new Date("2026-08-22T12:00:00.000Z");
  check("today", describeStatedAge(new Date("2026-08-22T01:00:00.000Z"), now), "today");
  check("yesterday", describeStatedAge(new Date("2026-08-21T01:00:00.000Z"), now), "yesterday");
  check("days", describeStatedAge(new Date("2026-08-12T12:00:00.000Z"), now), "10 days ago");
  check("months", describeStatedAge(new Date("2026-03-02T12:00:00.000Z"), now), "5 months ago");
  check("years", describeStatedAge(new Date("2025-01-02T12:00:00.000Z"), now), "1 year ago");
  check("an unstated date has no age", describeStatedAge(null, now), null);
  // A statedAt in the future is a bad write, not an age. Saying nothing is
  // honest; "in 3 days" invites a reader to reason about it.
  check("a future date reports nothing rather than a negative age",
    describeStatedAge(new Date("2026-09-22T12:00:00.000Z"), now), null);

  // THE DELIBERATE ABSENCE. There is no isStale here and there must not be: a
  // goal stated in March may be exactly as true as the day it was said, or
  // entirely abandoned, and no threshold in a library can tell the difference.
  const described = describeProvenance(
    { provenance: "OWNER", provenanceDetail: "chat", statedAt: new Date("2026-03-02T10:00:00.000Z"), statedById: user.id, modelExtracted: true },
    now
  );
  assert("an owner-stated fact describes as theirs, aged, and interpreted",
    described === "You told me (chat) — 5 months ago (interpreted by J4)", String(described));
  // On J4's own output "interpreted by J4" is noise — of course it was.
  const gen = describeProvenance(
    { provenance: "GENERATED", provenanceDetail: "design composition", statedAt: null, statedById: null, modelExtracted: true },
    now
  );
  check("J4's own work does not announce that J4 interpreted it", gen, "I made this (design composition)");

  // ==========================================================================
  console.log("\n=== 7. Relationship kinds are closed, and cover what is projected ===\n");
  // ==========================================================================
  const projectedKinds = [...new Set(Object.values(PROJECTIONS).flat().map((p) => p!.kind))];
  check("every projected kind is a registered kind",
    projectedKinds.filter((k) => !isRelationshipKind(k)), []);
  check("every registered kind has both directions worded",
    RELATIONSHIP_KIND_KEYS.filter((k) => !RELATIONSHIP_KINDS[k].forward || !RELATIONSHIP_KINDS[k].reverse), []);

  // The registry-lookup sibling rule: `"constructor" in REGISTRY` is true, and
  // a prototype key reaching a write is how a closed vocabulary stops being
  // closed. This codebase has shipped that defect before.
  check("a prototype key is not a relationship kind", isRelationshipKind("constructor"), false);
  check("nor is toString", isRelationshipKind("toString"), false);
  check("nor an invented one", isRelationshipKind("vaguely_related"), false);

  // Deliberate exclusions, asserted so a later edit that "helpfully" adds them
  // has to argue with a failing test. Each of these fields ends in `Id` and
  // points at something that is NOT a canonical record — the exact over-match
  // the old convention could not avoid.
  const shipmentProjections = PROJECTIONS.shipment ?? [];
  assert("shipment.orderId is not projected: it holds an Order id, not a record id",
    !shipmentProjections.some((p) => p.field === "orderId"));
  const assetProjections = PROJECTIONS.asset ?? [];
  assert("asset.aiUsageEventId is not projected: it holds an AiUsageEvent id",
    !assetProjections.some((p) => p.field === "aiUsageEventId"));
  assert("asset.supersededByAssetId is not projected: it is the same edge backwards",
    !assetProjections.some((p) => p.field === "supersededByAssetId"));
  assert("campaign.groupId is not projected: it holds a provider's group id",
    !(PROJECTIONS.campaign ?? []).some((p) => p.field === "groupId"));

  // ==========================================================================
  console.log("\n=== 8. A challenge blocks a goal, and says so ===\n");
  // ==========================================================================
  const goalRecord = (await queryRecords(store.id, "goal"))[0];
  const challengeWrite = await persistSyncedRecords(store.id, "genesis_chat", [
    {
      entityType: "challenge",
      externalId: "ch-1",
      data: {
        description: "Cash flow is tight", category: "cash_flow", severity: "high",
        status: "active", identifiedAt: "2026-03-02", resolvedAt: null,
        relatedGoalIds: [goalRecord.id],
      } as never,
    },
  ], { provenance: "OWNER", provenanceDetail: "chat", statedById: user.id, modelExtracted: true });

  check("the write reports the relationship it projected", challengeWrite.relationshipsWritten, 1);

  const challengeId = challengeWrite.changes[0].recordId;
  const fromGoal = await relationsOf(store.id, goalRecord.id);
  check("the goal has exactly one relationship", fromGoal.length, 1);
  check("it points back from the challenge", fromGoal[0]?.fromId, challengeId);
  check("and it is named", fromGoal[0]?.kind, "blocks");

  // THE SENTENCE THIS MILESTONE EXISTS FOR. The old convention could say the
  // two records referenced each other. It could not say which one was the
  // problem.
  check("read from the goal, the goal is held up",
    describeRelation(fromGoal[0]), "is held up by");
  const fromChallenge = await relationsOf(store.id, challengeId);
  check("read from the challenge, the challenge is in the way",
    describeRelation(fromChallenge[0]), "is standing in the way of");

  // ONE EDGE, NOT TWO. A goal listing its challenges and a challenge listing
  // its goals are the same fact seen from two ends; storing both would make
  // "how many things are blocking me" a question with two answers.
  const goalSideWrite = await persistSyncedRecords(store.id, "genesis_chat", [
    {
      entityType: "goal",
      externalId: "goal-1",
      data: { ...(goalRecord.data as object), relatedChallengeIds: [challengeId] } as never,
    },
  ], { provenance: "OWNER", provenanceDetail: "chat", statedById: user.id, modelExtracted: true });
  check("the goal side projects the same edge", goalSideWrite.relationshipsWritten, 1);
  const blocking = await relationsByKind(store.id, "blocks");
  check("and there is still only one of it", blocking.length, 1);
  check("stored challenge-to-goal, which is the direction the sentence reads",
    [blocking[0]?.fromType, blocking[0]?.toType], ["challenge", "goal"]);

  // The edge inherits the record's own provenance: the reference arrived in the
  // same payload, from the same source, at the same moment.
  check("the relationship carries the provenance of the record that stated it",
    fromGoal[0]?.provenance, "OWNER");
  check("and who stated it", fromGoal[0]?.statedById, user.id);

  // ==========================================================================
  console.log("\n=== 9. Re-syncing does not grow the graph ===\n");
  // ==========================================================================
  const before = await prisma.recordRelationship.count({ where: { storeId: store.id } });
  await persistSyncedRecords(store.id, "genesis_chat", [
    {
      entityType: "challenge",
      externalId: "ch-1",
      data: {
        description: "Cash flow is tight", category: "cash_flow", severity: "high",
        status: "active", identifiedAt: "2026-03-02", resolvedAt: null,
        relatedGoalIds: [goalRecord.id],
      } as never,
    },
  ], { provenance: "OWNER", provenanceDetail: "chat", statedById: user.id, modelExtracted: true });
  const after = await prisma.recordRelationship.count({ where: { storeId: store.id } });
  check("an unchanged re-sync leaves the count alone", after, before);

  // A record cannot be related to itself; the old convention could produce one
  // from a self-referencing id field and call it information.
  await relate({
    storeId: store.id, fromId: challengeId, fromType: "challenge",
    toId: challengeId, toType: "challenge", kind: "about", provenance: "OWNER",
  });
  check("a self-relationship is refused rather than stored",
    await prisma.recordRelationship.count({ where: { storeId: store.id, fromId: challengeId, toId: challengeId } }), 0);

  // An unregistered kind must not reach the table. The vocabulary is closed at
  // the write, not merely documented.
  let refused = false;
  try {
    await relate({
      storeId: store.id, fromId: challengeId, fromType: "challenge",
      toId: goalRecord.id, toType: "goal", kind: "sort_of_about" as never, provenance: "OWNER",
    });
  } catch {
    refused = true;
  }
  assert("an unregistered kind is refused at the write", refused);

  // ==========================================================================
  console.log("\n=== 10. The graph is tenant-scoped ===\n");
  // ==========================================================================
  // Same record ids, different store. If the edges were not scoped, one owner's
  // "what is blocking me" would count another's.
  await relate({
    storeId: other.id, fromId: challengeId, fromType: "challenge",
    toId: goalRecord.id, toType: "goal", kind: "blocks", provenance: "OWNER",
  });
  const mine = await relationsOf(store.id, goalRecord.id);
  const theirs = await relationsOf(other.id, goalRecord.id);
  check("my store sees one edge", mine.length, 1);
  check("the other store sees its own", theirs.length, 1);
  assert("and they are different rows",
    mine[0]?.id !== theirs[0]?.id, `${mine[0]?.id} vs ${theirs[0]?.id}`);
  check("counting by kind stays inside one store",
    (await relationsByKind(store.id, "blocks")).length, 1);

  // The records themselves, checked the same way — a neighbour with a record of
  // every type must never appear in this store's reads.
  await persistSyncedRecords(other.id, "quickbooks", [
    { entityType: "document", externalId: "inv-other", data: invoiceData as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", statedById: null, modelExtracted: false });
  const myDocs = await queryRecords(store.id, "document");
  const theirDocs = await queryRecords(other.id, "document");
  // Compared by IDENTITY, not by count. A count is a fact about how many
  // fixtures this file happens to have written by now and rots the moment a
  // section above adds one; disjointness is the property actually being claimed.
  const myDocIds = new Set(myDocs.map((d) => d.id));
  assert("the neighbour has documents of its own", theirDocs.length > 0, String(theirDocs.length));
  assert("and not one of them appears in this store's reads",
    theirDocs.every((d) => !myDocIds.has(d.id)),
    `mine=${[...myDocIds].join(",")} theirs=${theirDocs.map((d) => d.id).join(",")}`);

  // ==========================================================================
  console.log("\n=== 11. The old convention still works, and still agrees ===\n");
  // ==========================================================================
  // findRelated is not removed and not broken. The typed table is a PROJECTION
  // of the same id fields, so where both can answer, they must agree — a
  // disagreement means the projection is wrong, not that there is a second
  // opinion.
  const conventional = await findRelated(store.id, goalRecord.id);
  const typed = await relationsOf(store.id, goalRecord.id);
  const conventionalIds = new Set(conventional.map((r) => r.id));
  const typedIds = new Set(typed.map((r) => (r.direction === "outgoing" ? r.toId : r.fromId)));
  assert("the challenge is found by the old scan", conventionalIds.has(challengeId));
  assert("and by the indexed lookup", typedIds.has(challengeId));
  assert("so the projection agrees with the convention it came from",
    [...typedIds].every((id) => conventionalIds.has(id)),
    `typed=${[...typedIds].join(",")} conventional=${[...conventionalIds].join(",")}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
