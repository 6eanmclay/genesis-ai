import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { communicateFindingExecutable } from "@/lib/execution/executables/communicateFinding";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import { PERMISSIONS } from "@/lib/permissions";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// RECORDING A FINDING, AND THE ONE EXEMPTION IN THE WHOLE REGISTRY:
//
//   npx tsx scripts/run-db-suites.ts
//
// communicate_finding exists to close a bypass. Reason's output "used to be
// written directly via a raw Prisma call, bypassing execute() entirely, exactly
// the shape of bypass the chat-vs-manual fork used to be." Making it an
// Executable means communicating a finding gets the same authorization check and
// uniform recording as every other mechanic. Nothing covered it.
//
// SECTION 1 IS THE ONE THAT MATTERS, and it guards a mistake that would be
// entirely reasonable to make. This is "the ONLY action registered with
// authorityExempt: true — deliberately, because its run() has zero effect beyond
// this one record write. That exemption is a property of THIS executable's
// behavior, not of the 'communication' category in general — a future
// communication action that sends an email, posts externally, or triggers any
// effect beyond recording must never reuse authorityExempt."
//
// The registry already enforces the narrow half of that at module load: an
// authorityExempt action must be category "communication" with maxAuthorityTier
// "auto". What it cannot check is the sentence that actually matters — whether
// the executable DOES anything. So a second communication action, correctly
// categorised and correctly tiered, could carry the exemption while sending
// real email, and the existing guard would let it through. This asserts the
// carve-out stays a carve-out of one.
//
// SECTION 3 is the honest-absence rule at the storage layer, and it is
// invisible through the ORM: Prisma returns `null` for a SQL NULL and for a
// JSON `null` alike. Only raw SQL can tell them apart, and the difference is
// real — "no data was attached" and "data was attached, and it was null" are
// different facts about what Genesis found.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  await requireTestDatabase(prismaSystem);

  // ==========================================================================
  console.log("\n=== 1. The exemption is a carve-out of exactly one ===\n");
  // ==========================================================================
  const exempt = Object.entries(GENESIS_ACTIONS)
    .filter(([, d]) => (d as { authorityExempt?: boolean }).authorityExempt)
    .map(([a]) => a);
  check("exactly one action is authorityExempt", exempt.length === 1, JSON.stringify(exempt));
  check("and it is communicate_finding", exempt[0] === "communicate_finding", String(exempt[0]));

  // The registry's own load-time guard covers category and tier. This covers
  // the half it cannot: that no OTHER communication action has taken the
  // exemption, whatever its effects are.
  const communication = Object.entries(GENESIS_ACTIONS).filter(([, d]) => d.category === "communication");
  const otherExempt = communication
    .filter(([a]) => a !== "communicate_finding")
    .filter(([, d]) => (d as { authorityExempt?: boolean }).authorityExempt)
    .map(([a]) => a);
  check("no other communication action inherited it", otherExempt.length === 0, JSON.stringify(otherExempt));
  check(
    "so a future action that sends an email cannot skip a grant by being 'communication'",
    otherExempt.length === 0,
    "the registry checks the category and the tier; it cannot check whether run() does anything"
  );

  // And the narrow conditions the registry does enforce, asserted rather than
  // trusted — a load-time throw is only a guarantee if it is the right one.
  const definition = GENESIS_ACTIONS.communicate_finding;
  check("it is a communication action", definition.category === "communication", definition.category);
  check("at the tier the exemption requires", definition.maxAuthorityTier === "auto", String(definition.maxAuthorityTier));

  // ==========================================================================
  console.log("\n=== 2. It is still a real mechanic, not a back door ===\n");
  // ==========================================================================
  check("it names a real execution action",
    communicateFindingExecutable.action === EXECUTION_ACTIONS.GENESIS_COMMUNICATE_FINDING,
    String(communicateFindingExecutable.action));
  check("and still requires store:manage",
    communicateFindingExecutable.requiredPermission === PERMISSIONS.STORE_MANAGE,
    String(communicateFindingExecutable.requiredPermission));
  check("the exemption skips the grant check, never the permission",
    communicateFindingExecutable.requiredPermission !== null,
    "an exemption from delegated authority is not an exemption from who may act");

  // ==========================================================================
  console.log("\n=== 3. Nothing attached is a real absence ===\n");
  // ==========================================================================
  const user = await prisma.user.create({
    data: { email: `finding-${Date.now()}@test.local`, name: "Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `finding-${Date.now()}` },
  });

  try {
    const bare = await communicateFindingExecutable.run(
      { kind: "insight", summary: "Wax melts outsold everything else last week." },
      { storeId: store.id } as never
    );
    const bareId = (bare.metadata as { cognitiveOutputId: string }).cognitiveOutputId;
    check("a finding with nothing attached is recorded", Boolean(bareId), String(bareId));

    // THE ASSERTION THE ORM CANNOT MAKE. Prisma returns `null` for a SQL NULL
    // and for a JSON `null` alike, so this reads the column's actual state.
    const [raw] = await prisma.$queryRaw<{ data_is_sql_null: boolean; proposed_is_sql_null: boolean }[]>`
      SELECT "data" IS NULL AS data_is_sql_null,
             "proposedAction" IS NULL AS proposed_is_sql_null
      FROM "CognitiveOutput" WHERE id = ${bareId}
    `;
    check("absent data is a real SQL NULL", raw.data_is_sql_null === true, JSON.stringify(raw));
    check("and so is an absent proposed action", raw.proposed_is_sql_null === true, JSON.stringify(raw));
    check(
      "so 'nothing was attached' never reads back as 'null was attached'",
      raw.data_is_sql_null === true,
      "Prisma.DbNull rather than Prisma.JsonNull — two different facts about what Genesis found"
    );

    const bareRow = await prisma.cognitiveOutput.findUniqueOrThrow({ where: { id: bareId } });
    check("every unset field is null rather than a default",
      bareRow.priority === null && bareRow.confidence === null && bareRow.actionLabel === null &&
        bareRow.actionHref === null && bareRow.recordId === null && bareRow.entityType === null &&
        bareRow.topicKey === null,
      JSON.stringify({ priority: bareRow.priority, confidence: bareRow.confidence }));
    check("and it belongs to the store that was acting on", bareRow.storeId === store.id, bareRow.storeId);

    // ==========================================================================
    console.log("\n=== 4. What was said is what is stored ===\n");
    // ==========================================================================
    const full = await communicateFindingExecutable.run(
      {
        kind: "recommendation",
        summary: "Raise the wax melt price to £14.",
        data: { evidence: ["sold out twice"] },
        priority: "high",
        confidence: 0.8,
        actionLabel: "Review pricing",
        actionHref: "/b/x/products",
        recordId: "rec_1",
        entityType: "product",
        topicKey: "pricing.wax_melts",
        proposedAction: { actionType: "update_product" },
      },
      { storeId: store.id } as never
    );
    const fullId = (full.metadata as { cognitiveOutputId: string }).cognitiveOutputId;
    const fullRow = await prisma.cognitiveOutput.findUniqueOrThrow({ where: { id: fullId } });

    check("the kind is recorded as given", fullRow.kind === "recommendation", fullRow.kind);
    check("the summary is stored verbatim",
      fullRow.summary === "Raise the wax melt price to £14.", fullRow.summary);
    check("priority and confidence are both kept",
      fullRow.priority === "high" && Number(fullRow.confidence) === 0.8,
      JSON.stringify({ p: fullRow.priority, c: fullRow.confidence }));
    check("the grounding fields survive",
      fullRow.recordId === "rec_1" && fullRow.entityType === "product" && fullRow.topicKey === "pricing.wax_melts",
      JSON.stringify({ r: fullRow.recordId, e: fullRow.entityType, t: fullRow.topicKey }));
    check("and the attached data is real JSON, not a string",
      JSON.stringify(fullRow.data) === JSON.stringify({ evidence: ["sold out twice"] }),
      JSON.stringify(fullRow.data));

    // The proposed action is recorded and NOT acted on here — "communicating
    // the finding and proposing an action are two distinct, independently
    // recordable mechanics, not one."
    check("a proposed action is recorded",
      JSON.stringify(fullRow.proposedAction) === JSON.stringify({ actionType: "update_product" }),
      JSON.stringify(fullRow.proposedAction));
    const approvals = await prisma.approvalRequest.count({ where: { storeId: store.id } });
    check("but no approval request is created by recording it", approvals === 0, String(approvals));
    check(
      "so communicating a finding never quietly proposes one",
      approvals === 0,
      "whether the proposed action is executed is decided separately, downstream, by the caller"
    );

    // The returned message names what happened, for the execution log.
    check("the result says what was communicated",
      full.message.includes("recommendation") && full.message.includes("Raise the wax melt price"),
      full.message);

    // ==========================================================================
    console.log("\n=== 5. One finding is one row ===\n");
    // ==========================================================================
    const total = await prisma.cognitiveOutput.count({ where: { storeId: store.id } });
    check("two findings wrote exactly two rows", total === 2, String(total));
    check("and run() had no other effect on the store",
      (await prisma.businessEvent.count({ where: { storeId: store.id } })) === 0,
      "its run() has zero effect beyond this one record write — which is the entire basis of the exemption");
  } finally {
    await prisma.store.deleteMany({ where: { id: store.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
