import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// CHAPTER 1's GROWTH ENGINE — the recommendation the owner sees first:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-next-best-action-live.ts" -OutFile out.txt
//
// getNextBestAction decides the single thing J4 puts in front of an owner, and
// getActionTypeTrackRecord is one of the signals that decides how confident J4 is
// allowed to be about it. Both are named in VISION.md's Chapter 1 as the real
// infrastructure the Growth Engine builds on, and neither had any coverage.
//
// WHAT IS AND IS NOT REACHABLE HERE. getNextBestAction has two paths and only one
// of them is blocked: `refresh: true` runs a real AI review, so it needs provider
// credentials; `refresh: false` — the ambient path every ongoing consumer uses —
// is pure reads and is exercised in full below. The track record is pure reads
// throughout.
//
// THE HONESTY RULE THAT SHAPES THE TRACK RECORD: a rate computed from one
// occurrence is worse than no rate at all, so an action type with too little real
// history is OMITTED rather than reported at a confident 0% or 100%. J4's prompt
// is told, in as many words, that an absent action type "simply has no real
// history yet" — which is only true if this code really does omit rather than
// invent.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { pickNextBestAction, getNextBestAction } = await import("@/lib/intelligence/nextBestAction");
  const { getActionTypeTrackRecord } = await import("@/lib/businessModel/reasoning");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  let n = 0;
  const makeStore = (userId: string, name: string) =>
    prisma.store.create({
      data: {
        userId, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t", description: "d", currency: "USD",
      },
    });

  // ==========================================================================
  console.log("\n=== 1. Which candidate wins — the pure rule ===\n");
  // ==========================================================================
  check("nothing to choose from is null", pickNextBestAction([]), null);

  check(
    "the most confident candidate wins",
    pickNextBestAction([
      { actionType: "update_seo", confidence: 0.4 },
      { actionType: "update_hero", confidence: 0.9 },
      { actionType: "update_theme", confidence: 0.6 },
    ])?.actionType,
    "update_hero"
  );

  // The tie rule: within 0.1 of the top, something NEW appearing beats an edit.
  // Sean's own narrow reading — a create, not a general ranking of action types.
  check(
    "a near-tie is broken toward something the owner will SEE",
    pickNextBestAction([
      { actionType: "update_hero", confidence: 0.9 },
      { actionType: "create_product", confidence: 0.85 },
    ])?.actionType,
    "create_product"
  );
  // Outside the epsilon, confidence still wins — the tiebreak is a tiebreak,
  // not a thumb on the scale.
  check(
    "but a clearly more confident edit still wins",
    pickNextBestAction([
      { actionType: "update_hero", confidence: 0.9 },
      { actionType: "create_product", confidence: 0.5 },
    ])?.actionType,
    "update_hero"
  );
  check(
    "and a create at the top simply wins",
    pickNextBestAction([
      { actionType: "create_product", confidence: 0.95 },
      { actionType: "update_hero", confidence: 0.9 },
    ])?.actionType,
    "create_product"
  );

  // ==========================================================================
  console.log("\n=== 2. Against real rows, and only this business's ===\n");
  // ==========================================================================
  const owner = await prisma.user.create({ data: { email: "nba@example.test" } });
  const iron = await makeStore(owner.id, "Iron Gym");
  const copper = await makeStore(owner.id, "Copper and Coil");

  check("a store with no pending proposals has nothing to suggest",
    await getNextBestAction(iron.id, owner.id, { refresh: false }), null);

  const output = (storeId: string, confidence: number) =>
    prisma.cognitiveOutput.create({
      data: { storeId, kind: "recommendation", summary: "s", status: "ACTIVE", confidence },
    });

  let seq = 0;
  const proposal = (storeId: string, actionType: string, summary: string, cognitiveOutputId: string | null) =>
    prisma.approvalRequest.create({
      data: {
        storeId, actionType, input: { a: 1 }, previousValues: { a: 0 },
        summary, status: "PENDING_APPROVAL", cognitiveOutputId,
        createdAt: new Date(Date.now() - ++seq * 1000),
      },
    });

  const lowOut = await output(iron.id, 0.3);
  const highOut = await output(iron.id, 0.88);
  await proposal(iron.id, "update_seo", "Iron: tidy the SEO", lowOut.id);
  const winner = await proposal(iron.id, "update_hero", "Iron: a better hero", highOut.id);

  // The other business has a MORE confident proposal. It must never be chosen
  // for this one.
  const copperOut = await output(copper.id, 0.99);
  await proposal(copper.id, "update_hero", "Copper: a better hero", copperOut.id);

  const chosen = await getNextBestAction(iron.id, owner.id, { refresh: false });
  check("the most confident of THIS business's proposals is chosen", chosen?.approvalRequestId, winner.id);
  check("with its real confidence", chosen?.confidence, 0.88);
  check("and its real summary", chosen?.summary, "Iron: a better hero");
  assert("never the other business's more confident one",
    chosen?.summary !== "Copper: a better hero", "0.99 would have won if it were in scope");

  const forCopper = await getNextBestAction(copper.id, owner.id, { refresh: false });
  check("and the other business gets its own", forCopper?.summary, "Copper: a better hero");

  // The diff travels with it, so any UI renders it through the shared component
  // rather than a bespoke card.
  check("the real input is carried", chosen?.input, { a: 1 });
  check("and the real previous values", chosen?.previousValues, { a: 0 });

  // ==========================================================================
  console.log("\n=== 3. A proposal with no recommendation behind it ===\n");
  // ==========================================================================
  // An older row written before confidence was required. 0 is an honest,
  // conservative fallback — never a crash, and never an invented confidence.
  const bare = await makeStore(owner.id, "Bare Business");
  const orphan = await proposal(bare.id, "update_seo", "No output behind it", null);
  const bareChoice = await getNextBestAction(bare.id, owner.id, { refresh: false });
  check("it is still offered", bareChoice?.approvalRequestId, orphan.id);
  check("at zero confidence rather than an invented one", bareChoice?.confidence, 0);

  // A confidence row belonging to ANOTHER store must not supply a number here.
  const crossOut = await output(copper.id, 0.97);
  const crossed = await makeStore(owner.id, "Crossed Business");
  const crossedProposal = await proposal(crossed.id, "update_seo", "Points at another store's output", crossOut.id);
  const crossedChoice = await getNextBestAction(crossed.id, owner.id, { refresh: false });
  check("a foreign confidence row is not read", crossedChoice?.confidence, 0);
  assert("the proposal itself is still offered", crossedChoice?.approvalRequestId === crossedProposal.id);

  // ==========================================================================
  console.log("\n=== 4. The track record omits rather than invents ===\n");
  // ==========================================================================
  const decided = (storeId: string, actionType: string, status: string) =>
    prisma.approvalRequest.create({
      data: {
        storeId, actionType, input: {}, previousValues: {}, summary: "s",
        status, decidedAt: new Date(),
      },
    });

  const track = await makeStore(owner.id, "Track Business");

  // One decision only — below the threshold. A 100% approval rate from one
  // data point is worse than no rate at all.
  await decided(track.id, "update_theme", "EXECUTED");

  // Four decisions, three approved.
  await decided(track.id, "update_hero", "EXECUTED");
  await decided(track.id, "update_hero", "EXECUTED");
  await decided(track.id, "update_hero", "EXECUTED");
  await decided(track.id, "update_hero", "REJECTED");

  // Two decisions, both rejected.
  await decided(track.id, "update_seo", "REJECTED");
  await decided(track.id, "update_seo", "REJECTED");

  // Pending decides nothing.
  await proposal(track.id, "create_product", "still open", null);

  const records = await getActionTypeTrackRecord(track.id);
  const byType = new Map(records.map((r) => [r.actionType, r]));

  assert("a single decision produces no track record", !byType.has("update_theme"),
    "a rate from one occurrence is worse than none");
  assert("a still-pending proposal produces none either", !byType.has("create_product"));
  check("four decisions are counted", byType.get("update_hero")?.decidedCount, 4);
  check("with the real approval rate", byType.get("update_hero")?.approvalRate, 0.75);
  check("a consistently rejected type is reported honestly", byType.get("update_seo")?.approvalRate, 0);
  check("and counted", byType.get("update_seo")?.decidedCount, 2);
  // No measurements yet — not a 0% success rate, which would read as "this
  // always goes badly".
  check("with no measured history, the outcome rate is null", byType.get("update_hero")?.positiveOutcomeRate, null);
  check("and the measured count is honestly zero", byType.get("update_hero")?.measuredCount, 0);

  // ==========================================================================
  console.log("\n=== 5. Measured outcomes, and what neutral means ===\n");
  // ==========================================================================
  let mSeq = 0;
  async function measure(
    storeId: string,
    actionType: string,
    m: { revenueBeforeCents?: number | null; revenueAfterCents?: number | null; orderCountBefore: number; orderCountAfter: number }
  ) {
    const req = await decided(storeId, actionType, "EXECUTED");
    await prisma.postExecutionMeasurement.create({
      data: {
        approvalRequestId: req.id,
        storeId,
        actionType,
        scope: "store",
        windowDays: 7,
        summary: "measured",
        orderCountBefore: m.orderCountBefore,
        orderCountAfter: m.orderCountAfter,
        revenueBeforeCents: m.revenueBeforeCents ?? null,
        revenueAfterCents: m.revenueAfterCents ?? null,
        measuredAt: new Date(Date.now() - ++mSeq * 1000),
      },
    });
  }

  const outcome = await makeStore(owner.id, "Outcome Business");
  // Revenue decides when both sides are present.
  await measure(outcome.id, "update_hero", { revenueBeforeCents: 100, revenueAfterCents: 200, orderCountBefore: 5, orderCountAfter: 1 });
  await measure(outcome.id, "update_hero", { revenueBeforeCents: 300, revenueAfterCents: 100, orderCountBefore: 1, orderCountAfter: 9 });
  await measure(outcome.id, "update_hero", { revenueBeforeCents: 100, revenueAfterCents: 400, orderCountBefore: 2, orderCountAfter: 2 });
  // Neutral: counted as measured, excluded from the rate.
  await measure(outcome.id, "update_hero", { revenueBeforeCents: 100, revenueAfterCents: 100, orderCountBefore: 3, orderCountAfter: 3 });

  const outcomeRecords = new Map((await getActionTypeTrackRecord(outcome.id)).map((r) => [r.actionType, r]));
  const hero = outcomeRecords.get("update_hero");
  check("every measurement is counted", hero?.measuredCount, 4);
  // 2 positive of 3 non-neutral. The neutral one is not a failure.
  check("but the rate is of the non-neutral ones", hero?.positiveOutcomeRate, 2 / 3);
  assert(
    "revenue decides when it is present, not order count",
    hero?.positiveOutcomeRate === 2 / 3,
    "order counts alone would have given a different answer on all three"
  );

  // Order count decides only when revenue is unknown on either side.
  const noRevenue = await makeStore(owner.id, "No Revenue Business");
  await measure(noRevenue.id, "update_seo", { revenueBeforeCents: null, revenueAfterCents: null, orderCountBefore: 1, orderCountAfter: 4 });
  await measure(noRevenue.id, "update_seo", { revenueBeforeCents: 500, revenueAfterCents: null, orderCountBefore: 4, orderCountAfter: 9 });
  const seoRecord = (await getActionTypeTrackRecord(noRevenue.id)).find((r) => r.actionType === "update_seo");
  check("with revenue unknown, order count decides", seoRecord?.positiveOutcomeRate, 1);

  // One non-neutral measurement is not enough for a rate.
  const thin = await makeStore(owner.id, "Thin Business");
  await measure(thin.id, "update_hero", { revenueBeforeCents: 100, revenueAfterCents: 200, orderCountBefore: 1, orderCountAfter: 1 });
  await measure(thin.id, "update_hero", { revenueBeforeCents: 100, revenueAfterCents: 100, orderCountBefore: 1, orderCountAfter: 1 });
  const thinRecord = (await getActionTypeTrackRecord(thin.id)).find((r) => r.actionType === "update_hero");
  check("two decisions give a track record", thinRecord?.decidedCount, 2);
  check("but one non-neutral measurement gives no outcome rate", thinRecord?.positiveOutcomeRate, null);

  // ==========================================================================
  console.log("\n=== 6. A track record is a business's own history ===\n");
  // ==========================================================================
  check("a business with no decisions has no track record", await getActionTypeTrackRecord(copper.id), []);
  assert(
    "and one business's history never appears in another's",
    !(await getActionTypeTrackRecord(copper.id)).some((r) => r.actionType === "update_hero"),
    "Iron Gym's four update_hero decisions are next door"
  );

  const [a, b] = await Promise.all([getActionTypeTrackRecord(track.id), getActionTypeTrackRecord(outcome.id)]);
  check("concurrent reads stay separate",
    [a.find((r) => r.actionType === "update_hero")?.decidedCount, b.find((r) => r.actionType === "update_hero")?.decidedCount],
    [4, 4]);
  check("with their own measured histories",
    [a.find((r) => r.actionType === "update_hero")?.measuredCount, b.find((r) => r.actionType === "update_hero")?.measuredCount],
    [0, 4]);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All next-best-action assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
