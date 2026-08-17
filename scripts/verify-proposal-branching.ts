import { prisma } from "@/lib/prisma";
import {
  PROPOSAL_STATUS,
  branchProposal,
  getCreativeLineage,
  getProposal,
  openProposal,
  reviseProposal,
  setAsideSiblings,
} from "@/lib/storefront/proposals";

// Verifies sibling creative branching against the real database.
//
// Every assertion is a behaviour Sean named, checked by doing the thing rather
// than by reading the code:
//   1. the original stays PENDING when alternatives are created
//   2. each branch can be refined independently
//   3. approving one sets aside the siblings, as SUPERSEDED not REJECTED
//   4. the lineage can answer "option 2 came from the original", which is what
//      later composition ("symbol from the original, typography from option 2")
//      has to stand on
//
// Cleans up after itself: every row it creates is deleted at the end, and it
// only ever touches rows it created (tracked by id). It never deletes anything
// pre-existing — see memory feedback_test_data_safety.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

async function main() {
  const store = await prisma.store.findFirst({ select: { id: true, name: true } });
  if (!store) throw new Error("No store to test against.");
  console.log(`Testing against store: ${store.name}\n`);

  // Chains, not row ids. An earlier version collected ids as it went and
  // missed every row created AFTER it looked — a revision made mid-test was
  // left behind in a real database as a pending proposal the owner could have
  // seen. Recording chains and resolving their rows at cleanup time cannot
  // miss anything, however the test grows.
  const createdChains: string[] = [];
  const track = async (proposalId: string) => {
    if (!createdChains.includes(proposalId)) createdChains.push(proposalId);
  };

  try {
    const original = await openProposal(store.id, {
      actionType: "refine_storefront",
      summary: "Original direction",
      rationale: "Grounded in what J4 knows.",
      target: "hero",
      input: { heroLayout: "centered" },
      previousValues: { heroLayout: "left" },
      authorizationTier: "always_ask",
    });
    await track(original.proposalId);

    const lineage = await branchProposal(store.id, original.proposalId, [
      { label: "Warm editorial", summary: "Softer, more editorial", rationale: "If the first felt cold.", input: { heroLayout: "split" } },
      { label: "Bolder", summary: "More expressive", rationale: "If the first felt safe.", input: { heroLayout: "full-bleed" } },
    ]);
    if (!lineage) throw new Error("branchProposal returned null");
    for (const b of lineage.branches) await track(b.proposal.proposalId);

    // 1. The original survives branching.
    const afterBranch = await getProposal(store.id, original.proposalId);
    check(
      "original stays pending when alternatives are created",
      afterBranch?.current.status === PROPOSAL_STATUS.pending && !afterBranch.settled,
      `original status = ${afterBranch?.current.status}, branches = ${lineage.branches.length}`
    );

    // 2. Lineage is real and labelled.
    const labels = lineage.branches.map((b) => b.label).join(", ");
    const allPointAtOriginal = lineage.branches.every((b) => b.branchOfProposalId === original.proposalId);
    check(
      "each alternative has its own identity and points back at the original",
      lineage.branches.length === 2 && allPointAtOriginal && labels.includes("Warm editorial"),
      `labels = [${labels}], all branchOfProposalId === original = ${allPointAtOriginal}`
    );

    // 3. A branch refines independently, without touching its siblings.
    const optionTwo = lineage.branches[1].proposal;
    const revised = await reviseProposal(store.id, optionTwo.proposalId, {
      summary: "Bolder, second pass",
      rationale: "Owner said go further.",
      input: { heroLayout: "full-bleed", typeScale: "display" },
    });
    const originalStillPending = await getProposal(store.id, original.proposalId);
    const siblingStillPending = await getProposal(store.id, lineage.branches[0].proposal.proposalId);
    check(
      "a branch refines independently",
      revised?.current.revision === 2 &&
        originalStillPending?.current.status === PROPOSAL_STATUS.pending &&
        siblingStillPending?.current.status === PROPOSAL_STATUS.pending,
      `option 2 at revision ${revised?.current.revision}; original and sibling both still pending`
    );

    // 4. Choosing one sets aside the rest — superseded, never rejected.
    const setAside = await setAsideSiblings(store.id, optionTwo.proposalId);
    const originalAfter = await getProposal(store.id, original.proposalId);
    const siblingAfter = await getProposal(store.id, lineage.branches[0].proposal.proposalId);
    const chosenAfter = await getProposal(store.id, optionTwo.proposalId);
    check(
      "choosing one supersedes the siblings and leaves the chosen one pending",
      setAside === 2 &&
        originalAfter?.current.status === PROPOSAL_STATUS.superseded &&
        siblingAfter?.current.status === PROPOSAL_STATUS.superseded &&
        chosenAfter?.current.status === PROPOSAL_STATUS.pending,
      `set aside ${setAside}; original = ${originalAfter?.current.status}, sibling = ${siblingAfter?.current.status}, chosen = ${chosenAfter?.current.status}`
    );

    // 5. Composition support: both parents remain readable with their inputs.
    const full = await getCreativeLineage(store.id, lineage.groupId);
    const originalInput = full?.original.current.input;
    const optionTwoInput = full?.branches.find((b) => b.label === "Bolder")?.proposal.current.input;
    check(
      "lineage can support composition from two existing candidates",
      Boolean(originalInput && optionTwoInput),
      `original input = ${JSON.stringify(originalInput)}, option 2 input = ${JSON.stringify(optionTwoInput)}`
    );
  } finally {
    if (createdChains.length > 0) {
      const deleted = await prisma.approvalRequest.deleteMany({ where: { storeId: store.id, proposalId: { in: createdChains } } });
      console.log(`\nCleaned up ${deleted.count} row(s) across ${createdChains.length} chain(s).`);
    }
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
