import { readFileSync } from "fs";
import { join } from "path";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import {
  digestOf,
  renderDigest,
  digestIsSubstantive,
  DIGEST_CHAR_BUDGET,
} from "@/lib/businessModel/digest";
import { recordGeneratedAsset } from "@/lib/businessModel/assets";
import { buildStoreChatUnifiedTools } from "@/lib/execution/genesisTools";
import { STORE_CHAT_UNIFIED_SYSTEM_PROMPT } from "@/lib/dashboard/storeChatUnified";

// WHAT J4 KNOWS AT THE MOMENT IT DECIDES:
//
//   npx tsx scripts/run-db-suites.ts decision-context
//
// The unified call — the one that chooses what J4 does — received the message,
// the ACTIVE PRODUCT NAMES, and nothing else about the business.
// getBusinessUnderstanding was fetched inside the look_up_business_data branch,
// AFTER the tool had already been chosen. J4 picked blind and discovered the
// business afterwards.
//
// The prompts showed the strain, which is how the audit found it rather than
// guessing: generate_brand_logo's description had to say "if the merchant
// already has a logo, do NOT call this" — an instruction the model had no data
// to obey, because designated assets were not in its context at all.
//
// So the assertions below are mostly about the DIGEST SAYING TRUE THINGS, and
// about the two ways it could quietly stop being worth carrying: growing without
// bound as a business does, or leaking something a viewer is not entitled to.

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
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const goalData = (description: string) => ({
  description, category: "expansion", priority: "high", targetDate: null,
  targetValueInCents: null, status: "active", identifiedAt: "2026-03-02",
  relatedChallengeIds: [] as string[],
});
const challengeData = (description: string, relatedGoalIds: string[] = []) => ({
  description, category: "operations", severity: "high", status: "active",
  identifiedAt: "2026-03-02", resolvedAt: null, relatedGoalIds,
});

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `dc-owner-${uniq()}@test.local` } });
  const employee = await prisma.user.create({ data: { email: `dc-emp-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `dc-${uniq()}`, tagline: "Hand-wound rings" },
  });

  // ==========================================================================
  console.log("\n=== 1. An empty business says so, rather than saying nothing ===\n");
  // ==========================================================================
  // Sending a line of identity on every turn for a brand-new store teaches the
  // model nothing and costs context on every message.
  const empty = digestOf(await getBusinessUnderstanding(store.id), NOW);
  check("a new store has no products", empty.activeProductCount, 0);
  check("no goals", empty.goals, []);
  check("and no asset roles held", empty.assetRolesHeld, []);
  assert("so the digest is not worth sending yet", !digestIsSubstantive(empty));

  // ==========================================================================
  console.log("\n=== 2. It states what the business actually is ===\n");
  // ==========================================================================
  const product = await prisma.product.create({
    data: { storeId: store.id, name: "Tensor Ring", priceInCents: 8_500, active: true },
  });
  await prisma.order.create({
    data: {
      storeId: store.id, productId: product.id, productName: "Tensor Ring",
      amountInCents: 8_500, buyerEmail: "buyer@dc.test", paymentProvider: "STRIPE",
      externalOrderId: `o-${uniq()}`, createdAt: daysAgo(3),
    },
  });

  const goalWrite = await persistSyncedRecords(store.id, "genesis_chat", [
    { entityType: "goal", externalId: "g-1", data: goalData("Open a second workshop") as never },
  ], {
    provenance: "OWNER", provenanceDetail: "chat", statedById: owner.id,
    statedAt: daysAgo(150), modelExtracted: true,
  });
  const goalId = goalWrite.changes[0].recordId;

  await persistSyncedRecords(store.id, "genesis_chat", [
    {
      entityType: "challenge", externalId: "c-1",
      data: challengeData("The lease on the current unit ends in December", [goalId]) as never,
    },
  ], { provenance: "OWNER", provenanceDetail: "chat", statedById: owner.id, modelExtracted: true });

  const full = digestOf(await getBusinessUnderstanding(store.id, { viewerUserId: owner.id }), NOW);
  check("the name", full.name, "Copper & Coil");
  check("the tagline", full.tagline, "Hand-wound rings");
  check("what it sells", full.activeProductCount, 1);
  assert("named", full.productNames.includes("Tensor Ring"), full.productNames.join(", "));
  check("the goal", full.goals, ["Open a second workshop"]);
  check("the challenge", full.challenges, ["The lease on the current unit ends in December"]);
  assert("and now it is worth sending", digestIsSubstantive(full));

  // WHAT IS IN THE WAY, at the decision. Two lists with nothing between them was
  // exactly what made "this is the thing standing between you and that"
  // unsayable.
  check("what is standing in the way", full.blocked.length, 1);
  assert("naming both ends",
    full.blocked[0].includes("Open a second workshop") && full.blocked[0].includes("lease"),
    full.blocked[0]);

  // HOW OLD THE OWNER'S OWN WORDS ARE — a goal from five months ago may no
  // longer be their goal, which is a different question from a stale sync.
  check("how long ago they said it", full.oldestOwnerStatement, "5 months ago");

  // ==========================================================================
  console.log("\n=== 3. It answers 'do they already have a logo' ===\n");
  // ==========================================================================
  // THE ASSERTION THAT REPLACES A PROMPT WORKAROUND. generate_brand_logo's
  // description told the model not to offer a logo to someone who has one,
  // without giving it any way to know.
  check("nothing designated yet", full.assetRolesHeld, []);

  await recordGeneratedAsset({
    storeId: store.id,
    url: `https://example.test/logo-${uniq()}.png`,
    role: "brand.logo",
    summary: "The brand logo",
    category: "brand_asset",
    fileType: "photo",
  });

  const withLogo = digestOf(await getBusinessUnderstanding(store.id, { viewerUserId: owner.id }), NOW);
  check("the held role is stated", withLogo.assetRolesHeld, ["brand.logo"]);
  const rendered = renderDigest(withLogo);
  assert("and rendered where the model will read it",
    rendered.includes("Already has:") && rendered.includes("brand.logo"),
    rendered.slice(0, 300));

  // The instruction that needed the workaround is gone from the tool, and the
  // fact it needed is present in the context instead.
  const tools = buildStoreChatUnifiedTools();
  const logoTool = tools.find((t) => t.name === "generate_brand_logo")!;
  assert("the tool no longer tells the model not to look things up first",
    !logoTool.description!.includes("do NOT call look_up_business_data first"),
    "the deciding call has the context now");
  assert("nor asserts a fact it cannot check",
    !logoTool.description!.includes("if the merchant already has a logo they are happy with"));
  assert("it points at the context instead",
    logoTool.description!.includes("context above"), logoTool.description!.slice(-220));

  // ==========================================================================
  console.log("\n=== 4. It is bounded, whatever the business does ===\n");
  // ==========================================================================
  // A digest that quietly doubled would push conversation history out of a
  // cached prompt with nobody noticing.
  for (let i = 0; i < 40; i++) {
    await prisma.product.create({
      data: { storeId: store.id, name: `Product number ${i} with a deliberately long name`, priceInCents: 1000, active: true },
    });
  }
  await persistSyncedRecords(store.id, "genesis_chat",
    Array.from({ length: 30 }, (_, i) => ({
      entityType: "goal" as const,
      externalId: `g-bulk-${i}`,
      data: goalData(`A goal with a deliberately long description, number ${i}, ${"padding ".repeat(20)}`) as never,
    })),
    { provenance: "OWNER", statedById: owner.id, modelExtracted: true }
  );

  const big = digestOf(await getBusinessUnderstanding(store.id, { viewerUserId: owner.id }), NOW);
  const bigRendered = renderDigest(big);
  check("the product count is real", big.activeProductCount, 41);
  assert("but the list is capped", big.productNames.length <= 5, String(big.productNames.length));
  assert("and so are the goals", big.goals.length <= 5, String(big.goals.length));
  assert("the whole thing fits the budget",
    bigRendered.length <= DIGEST_CHAR_BUDGET,
    `${bigRendered.length} of ${DIGEST_CHAR_BUDGET}`);
  // A COUNT IS NOT A LIST. Truncating the names while reporting 41 is honest;
  // reporting 5 would be a lie about the business.
  assert("a capped list still reports the true total",
    bigRendered.includes("41 active products"), bigRendered.slice(0, 200));

  // ==========================================================================
  console.log("\n=== 5. It carries only what the viewer may see ===\n");
  // ==========================================================================
  // Load-bearing now rather than incidental: with the store:manage gate moved
  // onto individual tools, a member without it reaches the deciding call, so the
  // digest is built for them too.
  await prisma.belief.create({
    data: {
      storeId: store.id, topicKey: "rejection_pattern:image",
      claim: "YOU TURN DOWN IMAGE CHANGES", category: "owner_preference",
      confidence: 0.8, evidenceCount: 3,
      firstObservedAt: daysAgo(30), lastConfirmedAt: daysAgo(1),
      entityType: "owner", recordId: owner.id,
    },
  });
  await prisma.belief.create({
    data: {
      storeId: store.id, topicKey: "insight_recurrence:refunds",
      claim: "Refunds cluster on Mondays", category: "insight_recurrence",
      confidence: 0.7, evidenceCount: 4,
      firstObservedAt: daysAgo(40), lastConfirmedAt: daysAgo(2),
    },
  });

  const ownerDigest = digestOf(await getBusinessUnderstanding(store.id, { viewerUserId: owner.id }), NOW);
  const employeeDigest = digestOf(await getBusinessUnderstanding(store.id, { viewerUserId: employee.id }), NOW);

  assert("the owner sees the pattern about themselves",
    ownerDigest.beliefs.some((b) => b.claim.includes("TURN DOWN")),
    ownerDigest.beliefs.map((b) => b.claim).join(" | "));
  assert("an employee does not",
    !employeeDigest.beliefs.some((b) => b.claim.includes("TURN DOWN")),
    employeeDigest.beliefs.map((b) => b.claim).join(" | "));
  assert("and it is nowhere in what they would be sent",
    !renderDigest(employeeDigest).includes("TURN DOWN"));
  // AND STILL SEES THE BUSINESS ONES — a digest that withheld everything would
  // be its own defect, and would make the employee's newly-restored ability to
  // ask a question useless.
  assert("but does see the business's own beliefs",
    employeeDigest.beliefs.some((b) => b.claim.includes("Refunds")),
    employeeDigest.beliefs.map((b) => b.claim).join(" | "));

  // Each belief carries how well-established it is, because that changes how it
  // should be spoken about, not merely how much to trust it.
  assert("every belief carries its maturity",
    ownerDigest.beliefs.every((b) => b.maturity.length > 0),
    JSON.stringify(ownerDigest.beliefs));

  // ==========================================================================
  console.log("\n=== 6. It says how well-sourced the picture is ===\n");
  // ==========================================================================
  await prisma.businessRecord.create({
    data: {
      storeId: store.id, entityType: "challenge", sourceProvider: "quickbooks",
      externalId: "c-legacy", data: challengeData("A challenge from before any of this") as never,
    },
  });
  const mixed = digestOf(await getBusinessUnderstanding(store.id, { viewerUserId: owner.id }), NOW);
  assert("facts with a recorded source are counted",
    mixed.sourcing.withRecordedSource > 0, JSON.stringify(mixed.sourcing));
  check("and so are the ones without", mixed.sourcing.withoutRecordedSource, 1);
  assert("stated where the model reads it",
    renderDigest(mixed).includes("record where they came from"),
    renderDigest(mixed).slice(-160));

  // ==========================================================================
  console.log("\n=== 7. Both paths decide with it, and the prompt explains it ===\n");
  // ==========================================================================
  // A fallback that decided with less context than the primary would answer the
  // same question differently depending on which one served it.
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const route = read(join("app", "api", "chat", "route.ts"));
  const action = read(join("app", "dashboard", "ai-actions.ts"));

  for (const [name, source] of [["the streaming route", route], ["the Server Action", action]] as const) {
    assert(`${name} builds the digest`, source.includes("digestOf(understanding)"));
    assert(`${name} sends it with the decision`, source.includes("unifiedContextParts.push(renderDigest(digest))"));
    // FETCHED ONCE. Re-fetching in the data branch would make this a genuine
    // extra query on every turn rather than the same read moved earlier.
    // THE VIEWER, NOT THE OWNER. A negative control found nothing testing
    // this: swapping viewerUserId to store.userId builds every digest as
    // though the owner were reading it, so an employee would be handed a
    // profile of their employer's decision-making. Section 5 proves
    // getBusinessUnderstanding withholds it; this proves the call site asks.
    assert(`${name} builds the digest for the authenticated viewer`,
      source.includes("getBusinessUnderstanding(store.id, { viewerUserId: userId })"),
      "anything else builds it as though somebody else were reading");
    assert(`${name} never builds it as the store owner`,
      !source.includes("viewerUserId: store.userId"));
    assert(`${name} does not fetch understanding twice`,
      source.split("getBusinessUnderstanding(store.id").length - 1 === 1,
      `${source.split("getBusinessUnderstanding(store.id").length - 1} call sites`);
  }

  // Data with no rule for reading it is just more context.
  assert("the prompt tells the model to decide with it",
    STORE_CHAT_UNIFIED_SYSTEM_PROMPT.includes("USE IT WHEN DECIDING"));
  assert("and not to quote figures it does not contain",
    STORE_CHAT_UNIFIED_SYSTEM_PROMPT.includes("never quote a figure this summary did not give you"));
  assert("and that an absent line is not a zero",
    STORE_CHAT_UNIFIED_SYSTEM_PROMPT.includes("not the same as it being zero"));

  await prisma.store.deleteMany({ where: { id: store.id } });
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
