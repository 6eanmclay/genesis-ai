import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// OWNER UNDERSTANDING — the person, not the business:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-owner-understanding-live.ts" -OutFile out.txt
//
// J4_OWNER_UNDERSTANDING.md's architectural insight, taken literally: this is
// not a new mechanism, it is the existing one at a different scope. An owner
// pattern is an ordinary Belief whose entityType is "owner" and whose recordId
// is a userId. No new table, no migration, no second store of preferences.
//
// THE THREE PROPERTIES THIS SUITE EXISTS FOR, all of which were absent before:
//
//   1. A pattern knows WHO it is about. "owner_preference" was already a
//      category and carried no person, so "what has J4 learned about me" had no
//      answer at all.
//   2. A dismissal STICKS. The distill pass reactivates retired beliefs by
//      design, so an owner saying "that isn't a pattern about me" would have
//      watched it reappear within the hour. That is worse than offering no
//      control, and it is the document's one genuinely new requirement.
//   3. It is not a permanent gag. If the evidence later exceeds what the owner
//      judged, the claim is genuinely stronger than the one they rejected and
//      J4 may raise it again. A control that silenced J4 forever would trade
//      one dishonesty for another.

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

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { detectDecisionOutcomePattern, getBeliefs, getOwnerUnderstanding, dismissOwnerBelief, DISMISSED, OWNER_ENTITY_TYPE } =
    await import("@/lib/intelligence/learn");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  let n = 0;
  async function business(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}-${++n}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: slug, slug, tagline: "t", description: "d", currency: "USD" },
    });
    return { user, store };
  }

  /**
   * A proposal J4 VOLUNTEERED and the owner declined.
   *
   * cognitiveOutputId is what marks it as volunteered — learn.ts refuses to form
   * a preference from a proposal the owner asked for, and a fixture that ignored
   * that would be testing a rule that does not exist.
   */
  let seq = 0;
  async function declined(storeId: string, topicKey: string, at: Date) {
    const output = await prisma.cognitiveOutput.create({
      data: { storeId, kind: "recommendation", summary: `s${++seq}`, status: "ACTIVE" },
    });
    return prisma.approvalRequest.create({
      data: {
        storeId,
        actionType: "update_hero",
        input: {},
        previousValues: {},
        summary: `proposal ${seq}`,
        status: "REJECTED",
        topicKey,
        decidedAt: at,
        cognitiveOutputId: output.id,
      },
    });
  }

  await reset();
  const { user: owner, store } = await business("owner-store");
  const employee = await prisma.user.create({ data: { email: "employee@example.test" } });

  // ==========================================================================
  console.log("\n=== 1. A pattern that knows whose it is ===\n");
  // ==========================================================================
  await declined(store.id, "storefront_hero", daysAgo(30));
  await declined(store.id, "storefront_hero", daysAgo(10));
  await detectDecisionOutcomePattern(store.id);

  const belief = await prisma.belief.findFirstOrThrow({
    where: { storeId: store.id, topicKey: "rejection_pattern:storefront_hero" },
  });
  check("it is a preference about a person", belief.category, "owner_preference");
  check("and it names which person", belief.recordId, owner.id);
  check("under the owner entity type", belief.entityType, OWNER_ENTITY_TYPE);
  assert("grounded in the real declined proposals", belief.evidenceRefs.length === 2);
  check("counting both", belief.evidenceCount, 2);

  const mine = await getOwnerUnderstanding(store.id, owner.id);
  check("the owner can read what J4 learned about them", mine.length, 1);
  assert("with the evidence that produced it", mine[0].evidenceRefs.length === 2, "arguable, not opaque");
  assert("and a maturity computed at read time", typeof mine[0].maturity === "string");

  // ==========================================================================
  console.log("\n=== 2. Nobody else has a reading of it ===\n");
  // ==========================================================================
  check("an employee of the same store sees nothing", await getOwnerUnderstanding(store.id, employee.id), []);

  const employeeBeliefs = await getBeliefs(store.id, { viewerUserId: employee.id });
  assert(
    "and it is absent from the beliefs they reason with",
    !employeeBeliefs.some((b) => b.category === "owner_preference"),
    "it would otherwise be read back to them in chat"
  );
  const ownerBeliefs = await getBeliefs(store.id, { viewerUserId: owner.id });
  assert("while the owner still sees it", ownerBeliefs.some((b) => b.category === "owner_preference"));

  // Excluded by default: a caller who names nobody gets the business view. The
  // safe direction for the more sensitive of the two categories.
  const anonymous = await getBeliefs(store.id);
  assert("naming no viewer excludes it too", !anonymous.some((b) => b.category === "owner_preference"));

  const employeeView = await getBusinessUnderstanding(store.id, { viewerUserId: employee.id });
  check("BusinessUnderstanding gives an employee no owner profile", employeeView.ownerUnderstanding.length, 0);
  const ownerView = await getBusinessUnderstanding(store.id, { viewerUserId: owner.id });
  check("and gives the owner theirs", ownerView.ownerUnderstanding.length, 1);
  const unnamedView = await getBusinessUnderstanding(store.id);
  check("and gives an unnamed reader none", unnamedView.ownerUnderstanding.length, 0);

  // ==========================================================================
  console.log("\n=== 3. A dismissal survives the next pass ===\n");
  // ==========================================================================
  const dismissal = await dismissOwnerBelief({
    storeId: store.id,
    beliefId: belief.id,
    userId: owner.id,
    reason: "I was declining those for an unrelated reason",
  });
  check("the owner may dismiss it", dismissal, { dismissed: true });

  const afterDismiss = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
  check("it is marked dismissed, not merely retired", afterDismiss.status, DISMISSED);
  assert("and why is recorded in the owner's own words",
    (afterDismiss.retiredReason ?? "").includes("I was declining those for an unrelated reason"));
  assert("distinguishable from a system retirement",
    (afterDismiss.retiredReason ?? "").startsWith("dismissed by the owner"));
  check("it stops being something J4 reasons with", await getOwnerUnderstanding(store.id, owner.id), []);

  // THE ASSERTION THIS WHOLE FILE EXISTS FOR. Before this change, the distill
  // pass set status ACTIVE and cleared retiredAt unconditionally, so a dismissal
  // lasted until the next scheduled run.
  await detectDecisionOutcomePattern(store.id);
  const afterRederive = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
  check("re-deriving from the SAME evidence does not resurrect it", afterRederive.status, DISMISSED);
  check("the owner still sees nothing", (await getOwnerUnderstanding(store.id, owner.id)).length, 0);
  check("nor does the reasoning path", (await getBeliefs(store.id, { viewerUserId: owner.id }))
    .filter((b) => b.category === "owner_preference").length, 0);

  // ==========================================================================
  console.log("\n=== 4. But it is not a permanent gag ===\n");
  // ==========================================================================
  await declined(store.id, "storefront_hero", daysAgo(2));
  await detectDecisionOutcomePattern(store.id);
  const afterMoreEvidence = await prisma.belief.findUniqueOrThrow({ where: { id: belief.id } });
  check("genuinely stronger evidence brings it back", afterMoreEvidence.status, "ACTIVE");
  check("now standing on three declines", afterMoreEvidence.evidenceCount, 3);
  check("the dismissal reason is cleared with it", afterMoreEvidence.retiredReason, null);
  check("and the owner sees the stronger claim", (await getOwnerUnderstanding(store.id, owner.id)).length, 1);

  // ==========================================================================
  console.log("\n=== 5. Only the owner, and only their own patterns ===\n");
  // ==========================================================================
  const live = await prisma.belief.findFirstOrThrow({
    where: { storeId: store.id, topicKey: "rejection_pattern:storefront_hero" },
  });
  check("an employee cannot dismiss the owner's belief",
    await dismissOwnerBelief({ storeId: store.id, beliefId: live.id, userId: employee.id }),
    { dismissed: false, why: "not_the_owner" });
  check("and it is untouched", (await prisma.belief.findUniqueOrThrow({ where: { id: live.id } })).status, "ACTIVE");

  // A business-level belief must not be deletable through the personal door.
  const businessBelief = await prisma.belief.create({
    data: {
      storeId: store.id,
      topicKey: "event_recurrence:orders",
      claim: "Orders cluster on Fridays.",
      category: "event_recurrence",
      confidence: 0.5,
      evidenceCount: 3,
      firstObservedAt: daysAgo(40),
      lastConfirmedAt: daysAgo(1),
    },
  });
  check("a business belief cannot be dismissed as a personal one",
    await dismissOwnerBelief({ storeId: store.id, beliefId: businessBelief.id, userId: owner.id }),
    { dismissed: false, why: "not_an_owner_belief" });
  check("it stays active", (await prisma.belief.findUniqueOrThrow({ where: { id: businessBelief.id } })).status, "ACTIVE");
  assert("and everyone still sees it — it is about the business",
    (await getBeliefs(store.id, { viewerUserId: employee.id })).some((b) => b.topicKey === "event_recurrence:orders"));

  // ==========================================================================
  console.log("\n=== 6. One owner's patterns never reach another ===\n");
  // ==========================================================================
  const second = await business("second-store");
  await declined(second.store.id, "storefront_hero", daysAgo(20));
  await declined(second.store.id, "storefront_hero", daysAgo(5));
  await detectDecisionOutcomePattern(second.store.id);

  check("the second owner has their own pattern", (await getOwnerUnderstanding(second.store.id, second.user.id)).length, 1);
  check("the first owner cannot read it", await getOwnerUnderstanding(second.store.id, owner.id), []);
  check("and the second cannot read the first's", await getOwnerUnderstanding(store.id, second.user.id), []);
  // The first owner dismissed theirs; that must not have touched anyone else's.
  const theirBelief = await prisma.belief.findFirstOrThrow({
    where: { storeId: second.store.id, entityType: OWNER_ENTITY_TYPE },
  });
  check("one owner's dismissal is not another's", theirBelief.status, "ACTIVE");

  // ==========================================================================
  console.log("\n=== 7. How far back an owner pattern reaches ===\n");
  // ==========================================================================
  // J4_OWNER_UNDERSTANDING.md lists "evidence window for owner-level patterns"
  // as an open question, worrying that getRecentDecisionOutcomes' 14-day window
  // was sized for the recommendation engine and would be too short for a pattern
  // about a person. Measured here rather than assumed: that window is on a
  // DIFFERENT read, and belief formation applies no date filter at all.
  await reset();
  const { user: veteran, store: old_store } = await business("veteran-store");
  await declined(old_store.id, "storefront_hero", daysAgo(400));
  await declined(old_store.id, "storefront_hero", daysAgo(365));
  await detectDecisionOutcomePattern(old_store.id);

  const ancient = await getOwnerUnderstanding(old_store.id, veteran.id);
  check("evidence from over a year ago still forms a pattern", ancient.length, 1);
  check("counting both ancient decisions", ancient[0].evidenceCount, 2);
  assert(
    "so the 14-day window does not bound owner patterns",
    ancient.length === 1,
    "getRecentDecisionOutcomes is a different read, answering a different question"
  );
  // And the window that DOES exist still bounds what it is for.
  const { getRecentDecisionOutcomes } = await import("@/lib/businessModel/reasoning");
  check("while 'what was settled lately' stays deliberately bounded",
    (await getRecentDecisionOutcomes(old_store.id)).length, 0);

  await reset();
  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All owner-understanding assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
