import { readFileSync } from "fs";
import { join } from "path";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { getBusinessProfile } from "@/lib/businessModel/profile";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { stateRelationship } from "@/lib/businessModel/statements";
import {
  sourceOf,
  withSource,
  groundingRules,
  unsourcedCount,
} from "@/lib/businessModel/grounding";
import { RECORD_PROVENANCE, PROVENANCE_GROUNDING } from "@/lib/businessModel/provenance";
import { STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT } from "@/lib/dashboard/storeChatUnified";

// WHAT REASONING IS ACTUALLY TOLD ABOUT ITS OWN FACTS:
//
//   npx tsx scripts/run-db-suites.ts grounded-reasoning
//
// Provenance reached the database in the morning and stopped at the serialiser.
// cognitiveLayer handed Reason `goals.map((g) => ({ id: g.id, ...g.data }))` —
// the fact with its origin stripped off — so a goal the owner stated yesterday
// and one a model inferred from a photograph in March arrived as the same two
// lines of JSON and were reasoned about identically.
//
// THE LIMIT OF THIS FILE, STATED PLAINLY. Whether a real model reasons BETTER
// with this cannot be verified here: ANTHROPIC_API_KEY is not available, and no
// assertion could stand in for it honestly. What is provable, and what this
// covers, is everything deterministic — that the source reaches the payload,
// that it says the right thing, that the rules sent match the facts sent, that
// nothing internal leaks into a prompt, and that unknown stays unknown.
//
// That boundary is the same one every AI-adjacent suite in this codebase draws,
// and it is worth being exact about: this proves the model is told the truth,
// not that it listens.

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
const NOW = new Date("2026-08-22T12:00:00.000Z");

const goalData = (description: string) => ({
  description, category: "revenue", priority: "high", targetDate: null,
  targetValueInCents: null, status: "active", identifiedAt: "2026-03-02",
  relatedChallengeIds: [] as string[],
});

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({ data: { email: `gr-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `gr-${uniq()}` },
  });

  // ==========================================================================
  console.log("\n=== 1. A fact describes its own origin ===\n");
  // ==========================================================================
  const owned = sourceOf(
    {
      provenance: "OWNER", provenanceDetail: "chat",
      statedAt: new Date("2026-03-02T10:00:00.000Z"), statedById: user.id, modelExtracted: true,
    },
    NOW
  );
  check("who asserted it", owned?.from, "OWNER");
  check("through what", owned?.via, "chat");
  check("and how long ago", owned?.stated, "5 months ago");
  // THE HALF THAT CHANGES HOW J4 SPEAKS, not just how much it trusts: the owner
  // is the author, and the sentence stored is a model's reading of what they
  // said. Quoting it back as their words would be a fabrication.
  check("noting the wording is a paraphrase", owned?.interpreted, true);
  check("and it is not a claim that might be false", owned?.couldBeWrong, undefined);

  // NO INTERNAL IDENTIFIERS. statedById is on the record and deliberately not
  // here: a user id in a prompt is noise at best, and the chat prompt's own
  // standing rule forbids describing internal ids to an owner.
  assert("no internal identifier travels with the source",
    !JSON.stringify(owned).includes(user.id), JSON.stringify(owned));

  const concluded = sourceOf(
    { provenance: "INFERENCE", provenanceDetail: null, statedAt: NOW, statedById: null, modelExtracted: true },
    NOW
  );
  check("J4's own conclusion is flagged as possibly wrong", concluded?.couldBeWrong, true);
  // "interpreted" on J4's own output is noise — of course a model was involved.
  check("and does not announce that a model was involved", concluded?.interpreted, undefined);

  const made = sourceOf(
    { provenance: "GENERATED", provenanceDetail: "design composition", statedAt: NOW, statedById: null, modelExtracted: true },
    NOW
  );
  // THE DISTINCTION GENERATED EARNED. A design J4 composed is a file that
  // exists; hedging it would be as dishonest as stating an inference flatly.
  check("something J4 made is not a claim that might be false", made?.couldBeWrong, undefined);

  const derived = sourceOf(
    { provenance: "DERIVED", provenanceDetail: "order", statedAt: NOW, statedById: null, modelExtracted: false },
    NOW
  );
  check("arithmetic over the store's own orders needs no hedging", derived?.couldBeWrong, undefined);

  // ==========================================================================
  console.log("\n=== 2. A fact nobody sourced says nothing, rather than 'unknown' ===\n");
  // ==========================================================================
  // A literal "unknown" on hundreds of historical facts would read to a model as
  // a positive claim that the origin was investigated and could not be found,
  // which is a stronger statement than nobody having recorded it.
  check("no provenance produces no source object",
    sourceOf({ provenance: null, provenanceDetail: null, statedAt: NOW, statedById: null, modelExtracted: null }, NOW),
    null);

  const bare = withSource(
    { id: "g1", description: "Open a second workshop" },
    { provenance: null, provenanceDetail: null, statedAt: null, statedById: null, modelExtracted: null },
    NOW
  );
  check("and the serialised fact is unchanged, not decorated with empty structure",
    Object.keys(bare), ["id", "description"]);

  const sourced = withSource(
    { id: "g2", description: "Reach £5,000 a month" },
    { provenance: "OWNER", provenanceDetail: "chat", statedAt: NOW, statedById: null, modelExtracted: false },
    NOW
  );
  assert("while a sourced fact gains exactly one key", "source" in sourced);
  // The spread must not clobber the fact itself.
  check("and keeps everything it already had", sourced.description, "Reach £5,000 a month");

  // ==========================================================================
  console.log("\n=== 3. The rules sent match the facts sent ===\n");
  // ==========================================================================
  // A prompt carrying six paragraphs about document extraction, for a business
  // that has uploaded nothing, spends context teaching care about facts that do
  // not exist — and every unnecessary rule dilutes the ones that matter.
  const envelope = (p: (typeof RECORD_PROVENANCE)[number] | null) => ({
    provenance: p, provenanceDetail: null, statedAt: null, statedById: null, modelExtracted: null,
  });

  const twoKinds = groundingRules([envelope("OWNER"), envelope("CONNECTOR"), envelope("OWNER")]);
  check("only the kinds present get a rule", twoKinds.length, 2);
  assert("the owner rule is there", twoKinds.some((r) => r.startsWith("OWNER:")));
  assert("the connector rule is there", twoKinds.some((r) => r.startsWith("CONNECTOR:")));
  assert("and nothing about documents, which this business has none of",
    !twoKinds.some((r) => r.startsWith("DOCUMENT:")), twoKinds.join(" / "));

  check("no facts means no rules", groundingRules([]), []);
  check("and facts with no recorded origin produce none either",
    groundingRules([envelope(null), envelope(null)]), []);

  // STABLE ORDER, so the same business produces the same prompt twice. A block
  // that reorders itself between runs defeats prompt caching for no benefit and
  // makes two otherwise-identical passes impossible to compare.
  const forward = groundingRules([envelope("CONNECTOR"), envelope("OWNER"), envelope("INFERENCE")]);
  const backward = groundingRules([envelope("INFERENCE"), envelope("OWNER"), envelope("CONNECTOR")]);
  check("the order does not depend on the order facts arrived in", forward, backward);

  // Every rule is the real sentence from the one vocabulary, not a second copy.
  for (const p of RECORD_PROVENANCE) {
    const rule = groundingRules([envelope(p)])[0];
    assert(`the ${p} rule is the canonical one`, rule === `${p}: ${PROVENANCE_GROUNDING[p]}`, rule);
  }

  check("facts with no recorded origin are counted, not hidden",
    unsourcedCount([envelope(null), envelope("OWNER"), envelope(null)]), 2);

  // ==========================================================================
  console.log("\n=== 4. It survives the real read path ===\n");
  // ==========================================================================
  // Written and read back the way the product does it, because the gap this
  // milestone closed was in a serialiser, not in a pure function.
  await persistSyncedRecords(store.id, "genesis_chat", [
    { entityType: "goal", externalId: "g-owner", data: goalData("Open a second workshop") as never },
  ], {
    provenance: "OWNER", provenanceDetail: "chat", statedById: user.id,
    statedAt: new Date("2026-03-02T10:00:00.000Z"), modelExtracted: true,
  });
  await persistSyncedRecords(store.id, "quickbooks", [
    { entityType: "goal", externalId: "g-conn", data: goalData("Collect on outstanding invoices") as never },
  ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", modelExtracted: false });
  // The legacy case: a row written straight to the table, as every record
  // before 2026-08-22 was.
  await prisma.businessRecord.create({
    data: {
      storeId: store.id, entityType: "goal", sourceProvider: "quickbooks",
      externalId: "g-legacy", data: goalData("A goal from before any of this") as never,
    },
  });

  const profile = await getBusinessProfile(store.id);
  check("all three goals are read back", profile.goals.length, 3);

  // THE ACTUAL SERIALISATION cognitiveLayer performs, reproduced here so this
  // asserts on the shape a prompt receives rather than on a helper in isolation.
  const serialised = profile.goals.map((g) => withSource({ id: g.id, ...g.data }, g, NOW));
  const byDescription = new Map(serialised.map((g) => [g.description, g]));

  const stated = byDescription.get("Open a second workshop");
  check("the owner's goal names them as the source", stated?.source?.from, "OWNER");
  check("with its real age", stated?.source?.stated, "5 months ago");
  check("and says the wording is a paraphrase", stated?.source?.interpreted, true);

  const fromConnector = byDescription.get("Collect on outstanding invoices");
  check("the connector's goal names the connector", fromConnector?.source?.from, "CONNECTOR");
  check("through the specific system", fromConnector?.source?.via, "quickbooks");
  check("and is not a paraphrase of anybody", fromConnector?.source?.interpreted, undefined);

  const legacy = byDescription.get("A goal from before any of this");
  // THE ASSERTION THAT MATTERS MOST HERE. sourceProvider says "quickbooks", and
  // concluding CONNECTOR from that is exactly the guess the migration refused to
  // make — it cannot distinguish a bank's figure from a model's reading of a
  // voice memo when both arrive through a pipe whose name happens to differ.
  check("a pre-existing goal claims no source at all", legacy?.source, undefined);
  assert("even though its sourceProvider would make one easy to guess",
    profile.goals.some((g) => g.sourceProvider === "quickbooks" && g.provenance === null));

  // THE WHOLE POINT, IN ONE LINE: three goals that were previously identical in
  // shape now answer differently.
  const distinctSources = new Set(serialised.map((g) => g.source?.from ?? "none"));
  check("three goals, three different answers to 'where did this come from'",
    [...distinctSources].sort(), ["CONNECTOR", "OWNER", "none"]);

  const rules = groundingRules(profile.goals);
  check("and the rules sent cover exactly those two real kinds", rules.length, 2);
  check("with the third counted as unsourced", unsourcedCount(profile.goals), 1);

  // ==========================================================================
  console.log("\n=== 4b. Reasoning can finally say what is in the way ===\n");
  // ==========================================================================
  // U2's whole point. goals and challenges were BOTH already in the prompt, as
  // two lists with nothing between them — so "this is the thing standing between
  // you and that", the most useful sentence J4 could offer an owner, was
  // unsayable no matter how good the reasoning was.
  const goalRow = profile.goals.find((g) => g.data.description === "Open a second workshop")!;

  const before = await getBusinessUnderstanding(store.id);
  // EMPTY IS ORDINARY AND IS NOT A CLAIM. No link recorded does not mean the
  // goal is unobstructed, and the prompt says so in as many words.
  check("with nothing recorded, nothing is claimed to be blocking", before.blockedGoals, []);

  await persistSyncedRecords(store.id, "genesis_chat", [
    {
      entityType: "challenge", externalId: "c-lease",
      data: {
        description: "The lease on the current unit ends in December",
        category: "operations", severity: "high", status: "active",
        identifiedAt: "2026-03-02", resolvedAt: null, relatedGoalIds: [goalRow.id],
      } as never,
    },
  ], { provenance: "OWNER", provenanceDetail: "chat", statedById: user.id, modelExtracted: true });

  const after = await getBusinessUnderstanding(store.id);
  check("one goal is now blocked", after.blockedGoals.length, 1);
  check("the right one", after.blockedGoals[0]?.goal, "Open a second workshop");
  // RESOLVED TO A DESCRIPTION, not left as an id. A blocker an owner cannot read
  // is worse than a connection left unstated.
  check("by something readable",
    after.blockedGoals[0]?.blockedBy.map((b) => b.challenge),
    ["The lease on the current unit ends in December"]);

  // THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG THIS SECTION SHIPPED WITH.
  // The relationship read was inserted mid-Promise.all while its binding was
  // appended, so blockedGoals was silently paired with the owner-understanding
  // read. Everything else in the object has to still be itself.
  assert("and the rest of understanding is still itself",
    after.profile.goals.length === 3 && Array.isArray(after.ownerUnderstanding),
    `${after.profile.goals.length} goals, ownerUnderstanding is ${typeof after.ownerUnderstanding}`);

  // A goal blocked by something the profile does not carry is skipped rather
  // than rendered as an id.
  await stateRelationship({
    storeId: store.id, userId: user.id,
    fromId: (await prisma.businessRecord.findFirstOrThrow({
      where: { storeId: store.id, entityType: "challenge" },
    })).id,
    fromType: "challenge",
    toId: goalRow.id, toType: "goal", kind: "blocks",
  });
  const stillOne = await getBusinessUnderstanding(store.id);
  check("re-stating the same link does not duplicate the blocker",
    stillOne.blockedGoals[0]?.blockedBy.length, 1);

  // ==========================================================================
  console.log("\n=== 5. Both reasoning paths are told the same thing ===\n");
  // ==========================================================================
  // "Both paths draw on identical understanding or neither can be trusted"
  // (J4_FOUNDATION.md Gap B). A fallback that explained provenance less well
  // would answer the same question with different confidence depending on which
  // path happened to serve it.
  const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");
  const streaming = read(join("app", "api", "chat", "route.ts"));
  const fallback = read(join("app", "dashboard", "ai-actions.ts"));
  const reason = read(join("lib", "intelligence", "cognitiveLayer.ts"));
  // WHERE THIS NOW LIVES (2026-08-23, Unified Intelligence UI4). Both chat
  // paths used to build this payload themselves, and this section asserted
  // each copy separately — which is the weaker property, because two copies
  // asserted identically today are still two copies tomorrow. They now answer
  // a data question through one handler, so the invariant is stronger and the
  // assertion follows it: built once, and neither path builds its own.
  const handler = read(join("lib", "execution", "toolHandlers.ts"));

  for (const [name, source] of [
    ["the shared data-question handler", handler],
    ["Reason's own pass", reason],
  ] as const) {
    assert(`${name} sends the grounding rules`, source.includes("sourceGuidance: groundingRules("));
    assert(`${name} sends the unsourced count`, source.includes("factsWithNoRecordedSource: unsourcedCount("));
  }

  for (const [name, source] of [
    ["the streaming chat path", streaming],
    ["the non-streaming fallback", fallback],
  ] as const) {
    // A second construction is how the two paths would start explaining
    // provenance differently again — which is the whole thing Gap B names.
    assert(`${name} does not build a second grounding payload`,
      !source.includes("sourceGuidance: groundingRules("),
      "two copies of this will eventually disagree");
    assert(`${name} answers data questions through the shared handler`,
      source.includes("await runPlannedTools({"),
      "otherwise there is a path that never sees the grounding rules at all");
  }
  // Reason serialises per-fact sources too; the chat paths pass the profile
  // records whole, so the provenance is already on them.
  assert("Reason attaches a source to each goal and challenge",
    reason.includes("withSource({ id: g.id, ...g.data }, g)") &&
      reason.includes("withSource({ id: c.id, ...c.data }, c)"));
  // A representation reasoning cannot see is an inert one.
  assert("and sends what is blocking what", reason.includes("blockedGoals,"));

  // ==========================================================================
  console.log("\n=== 6. The prompts actually explain what they are sending ===\n");
  // ==========================================================================
  // Data with no rule for reading it is just more JSON. Both prompts must name
  // the field AND say the thing that makes it worth carrying.
  const reasonPrompt = reason.slice(reason.indexOf("const SYSTEM_PROMPT"), reason.indexOf("const SYSTEM_PROMPT") + 20_000);
  for (const [name, prompt] of [
    ["Reason's prompt", reasonPrompt],
    ["the chat prompt", STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT],
  ] as const) {
    assert(`${name} names the source field`, prompt.includes("sourceGuidance"));
    assert(`${name} explains what interpreted means`, prompt.includes("interpreted"));
    assert(`${name} explains what couldBeWrong means`, prompt.includes("couldBeWrong"));
    // THE INSTRUCTION SEAN'S U6 APPROVAL TURNS ON: not every fact is equally
    // authoritative merely because it is in the data.
    assert(`${name} says a conclusion must not be attributed to anybody`,
      /never be (spoken about as though somebody had told you|presented as something they or a connected system told you)/.test(prompt) ||
        prompt.includes("never be presented as something they"),
      prompt.slice(prompt.indexOf("couldBeWrong"), prompt.indexOf("couldBeWrong") + 200));
    assert(`${name} tells the reader an unsourced fact predates this`,
      prompt.includes("predates this being recorded"));
  }

  // AN EMPTY LIST IS NOT EVIDENCE OF ABSENCE, and the prompt has to say so:
  // nothing populates a goal's reference arrays automatically yet, so an empty
  // blockedGoals is the ordinary case rather than a finding.
  assert("Reason's prompt explains what is blocking what",
    reasonPrompt.includes("blockedGoals names which stated challenges"));
  assert("and refuses to read an empty one as 'nothing is blocking anything'",
    reasonPrompt.includes("never present an empty blockedGoals as evidence"));

  await prisma.store.deleteMany({ where: { id: store.id } });
  await prisma.user.deleteMany({ where: { id: user.id } });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  console.log(
    "\nNOT verified here (no ANTHROPIC_API_KEY): whether a real model reasons BETTER with this. " +
      "Everything deterministic — what reaches the payload, what it says, and what the prompts " +
      "instruct — is covered above."
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
