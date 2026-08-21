import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// PHASE E — PROPOSALS AND RECOMMENDATIONS, ACROSS TWO BUSINESSES:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-proposals-live.ts" -OutFile out.txt
//
// THE DEFECT THIS CLOSES. The four proposal-decision actions looked a proposal
// up as findFirst({ id, storeId }) where storeId was the account's ACTIVE
// business. Safe — a stranger's id matched nothing — but wrong for exactly the
// case the multi-business work exists for: a proposal belonging to the owner's
// OTHER business returned not_found, so J4 offered a real change and clicking
// approve said it had vanished.
//
// It was fixed and could not be RUN: those actions call auth(), which a script
// cannot provide, so the fix was typechecked and built but never executed. An
// authorization rule that can only be exercised through a browser is a rule that
// mostly is not exercised — so the decision now lives in lib/permissions.ts as
// approvalAccessibleTo, and this is it, running.
//
// Also held here: the reads that feed the recommendation surfaces are
// business-scoped, and one business's pending work never appears in another's.

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

  const { approvalAccessibleTo, PERMISSIONS } = await import("@/lib/permissions");
  const { getPendingApprovals } = await import("@/lib/dashboard/pendingApprovals");
  const { setActiveBusiness } = await import("@/lib/businessContext");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const makeStore = (userId: string, name: string, slug: string) =>
    prisma.store.create({
      data: { userId, name, slug, tagline: "t", description: "d", currency: "USD" },
    });

  let seq = 0;
  const proposal = (storeId: string, summary: string, status = "PENDING_APPROVAL") =>
    prisma.approvalRequest.create({
      data: {
        storeId,
        actionType: "update_hero",
        input: {},
        previousValues: {},
        summary,
        status,
        createdAt: new Date(Date.now() - ++seq * 1000),
      },
    });

  const owner = await prisma.user.create({ data: { email: "proposals-owner@example.test" } });
  const iron = await makeStore(owner.id, "Iron Gym", "iron-gym");
  const copper = await makeStore(owner.id, "Copper & Coil", "copper-coil");
  // Iron Gym is active. Every assertion about a Copper & Coil proposal is
  // therefore also an assertion that the old active-business lookup is gone.
  await setActiveBusiness(owner.id, iron.id);

  const ironProposal = await proposal(iron.id, "Iron Gym: a new hero headline");
  const copperProposal = await proposal(copper.id, "Copper & Coil: a new hero headline");

  // ==========================================================================
  console.log("\n=== 1. A proposal in the OTHER business is reachable ===\n");
  // ==========================================================================
  // THE DEFECT, as an assertion. Before the fix this was null and the owner was
  // told their proposal did not exist.
  const reachedCopper = await approvalAccessibleTo(owner.id, copperProposal.id, {
    status: "PENDING_APPROVAL",
  });
  assert("the owner reaches their own non-active business's proposal", reachedCopper !== null);
  check("and it resolves to that business, not the active one", reachedCopper?.storeId, copper.id);
  check("with the role they hold there", reachedCopper?.role, "OWNER");
  check("carrying the real row", reachedCopper?.approval.summary, "Copper & Coil: a new hero headline");

  const reachedIron = await approvalAccessibleTo(owner.id, ironProposal.id, { status: "PENDING_APPROVAL" });
  check("the active business's own proposal still resolves", reachedIron?.storeId, iron.id);

  // ==========================================================================
  console.log("\n=== 2. Somebody else's proposal is not reachable ===\n");
  // ==========================================================================
  const stranger = await prisma.user.create({ data: { email: "proposals-stranger@example.test" } });
  const theirs = await makeStore(stranger.id, "Somebody Else", "somebody-else");
  const theirProposal = await proposal(theirs.id, "Not yours");

  check("a proposal in a business you cannot reach is null",
    await approvalAccessibleTo(owner.id, theirProposal.id, { status: "PENDING_APPROVAL" }), null);
  check("and a proposal id that does not exist is null too",
    await approvalAccessibleTo(owner.id, "no-such-proposal", { status: "PENDING_APPROVAL" }), null);
  // Deliberately the same answer, so nobody learns a proposal exists.
  assert(
    "the two are indistinguishable",
    (await approvalAccessibleTo(owner.id, theirProposal.id, { status: "PENDING_APPROVAL" })) ===
      (await approvalAccessibleTo(owner.id, "no-such-proposal", { status: "PENDING_APPROVAL" }))
  );
  // And the stranger reaches their own, so the refusal is about access rather
  // than about the row being unreachable by anyone.
  assert("its real owner reaches it",
    (await approvalAccessibleTo(stranger.id, theirProposal.id, { status: "PENDING_APPROVAL" })) !== null);

  // ==========================================================================
  console.log("\n=== 3. The status filter still holds ===\n");
  // ==========================================================================
  const executed = await proposal(copper.id, "Already done", "EXECUTED");
  check("an executed proposal is not pending",
    await approvalAccessibleTo(owner.id, executed.id, { status: "PENDING_APPROVAL" }), null);
  assert("but is reachable as executed, which is what revert asks for",
    (await approvalAccessibleTo(owner.id, executed.id, { status: "EXECUTED" })) !== null);
  // The narrower filter regenerateApprovalImage uses.
  check("and an actionType filter narrows it further",
    await approvalAccessibleTo(owner.id, copperProposal.id, {
      status: "PENDING_APPROVAL",
      actionType: "update_product_image",
    }), null);

  // ==========================================================================
  console.log("\n=== 4. Role is evaluated where the proposal lives ===\n");
  // ==========================================================================
  // A member of one business is not thereby a member of another. The role that
  // decides is the one held in the proposal's OWN business.
  const employee = await prisma.user.create({ data: { email: "proposals-employee@example.test" } });
  await prisma.storeMember.create({
    data: { storeId: copper.id, userId: employee.id, role: "EMPLOYEE" },
  });

  // EMPLOYEE does not carry ANALYTICS_VIEW, which is what deciding a proposal
  // requires — so membership alone is not enough, and that is the point: the
  // permission is evaluated against the role held in the proposal's OWN
  // business rather than against membership anywhere.
  check("membership alone does not let an employee decide a proposal",
    await approvalAccessibleTo(employee.id, copperProposal.id, { status: "PENDING_APPROVAL" }), null);

  // With a permission the role genuinely holds, the same employee reaches the
  // same proposal — so the refusal above is about the permission, not a blanket
  // denial that would hide a real access failure.
  const asChat = await approvalAccessibleTo(
    employee.id,
    copperProposal.id,
    { status: "PENDING_APPROVAL" },
    PERMISSIONS.GENESIS_CHAT
  );
  assert("a permission they do hold reaches it", asChat !== null);
  check("and reports the role they hold THERE", asChat?.role, "EMPLOYEE");
  check("resolved to that business", asChat?.storeId, copper.id);

  // Not a member of Iron Gym at all, so even a permission they hold elsewhere
  // reaches nothing there.
  check("and they reach nothing in the business they do not belong to",
    await approvalAccessibleTo(employee.id, ironProposal.id, { status: "PENDING_APPROVAL" }, PERMISSIONS.GENESIS_CHAT),
    null);

  // The owner still holds the stronger permission in both.
  assert("while the owner still decides in their own",
    (await approvalAccessibleTo(owner.id, copperProposal.id, { status: "PENDING_APPROVAL" })) !== null);

  // ==========================================================================
  console.log("\n=== 5. Pending work never crosses businesses ===\n");
  // ==========================================================================
  await proposal(copper.id, "Copper & Coil: a second idea");

  const ironPending = await getPendingApprovals(iron.id);
  const copperPending = await getPendingApprovals(copper.id);
  check("Iron Gym sees only its own", ironPending.map((p) => p.summary), ["Iron Gym: a new hero headline"]);
  check("Copper & Coil sees only its own",
    copperPending.map((p) => p.summary).sort(),
    ["Copper & Coil: a new hero headline", "Copper & Coil: a second idea"]);
  assert("and neither mentions the other",
    !JSON.stringify(ironPending).includes("Copper & Coil") &&
      !JSON.stringify(copperPending).includes("Iron Gym"));

  // Two reads at once, for the same reason the two-tab test exists.
  const [tabA, tabB] = await Promise.all([getPendingApprovals(iron.id), getPendingApprovals(copper.id)]);
  check("concurrent reads stay separate", [tabA.length, tabB.length], [1, 2]);

  // ==========================================================================
  console.log("\n=== 6. Switching the active business changes none of it ===\n");
  // ==========================================================================
  // If any of this leaned on the pointer, moving it would move the answers.
  await setActiveBusiness(owner.id, copper.id);
  check("the Iron Gym proposal still resolves to Iron Gym",
    (await approvalAccessibleTo(owner.id, ironProposal.id, { status: "PENDING_APPROVAL" }))?.storeId, iron.id);
  check("and Iron Gym's pending list is unchanged", (await getPendingApprovals(iron.id)).length, 1);
  check("as is Copper & Coil's", (await getPendingApprovals(copper.id)).length, 2);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All proposal assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
