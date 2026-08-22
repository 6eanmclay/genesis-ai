import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import "dotenv/config";
import { randomUUID } from "crypto";
import { prismaSystem } from "../lib/prisma";
import { getPendingApprovals } from "../lib/dashboard/pendingApprovals";
import { buildPageAttentionCards, groupAttentionCards } from "../lib/dashboard/attentionCards";

// Real end-to-end verification (2026-08-09) — the new code in the "Approve
// All" pass is the groupId plumbing itself: ProposalAttentionCard.groupId,
// buildProposalCard reading approval.groupId, and groupAttentionCards()
// clustering them. approveGenesisActionGroup's own per-item execute/verify/
// record loop is pre-existing and unchanged (confirmed by direct read) and
// requires a real authenticated request (requireStorePermission -> auth())
// to exercise, which a standalone script can't fake — so this test proves
// the part that's actually new: real grouped ApprovalRequest rows flow
// through getPendingApprovals -> buildPageAttentionCards -> groupAttentionCards
// and come out clustered exactly as the UI now expects.
async function main() {
  // Refuses to run against anything but an isolated test database. These
  // suites create, mutate and delete rows — without this, a production
  // DATABASE_URL in the shell was enough to rename a real merchant's product.
  // See scripts/lib/requireTestDatabase.ts.
  await requireTestDatabase(prismaSystem);
  const store = await prismaSystem.store.findFirst({ select: { id: true } });
  if (!store) throw new Error("No real store found to test against");
  const product = await prismaSystem.product.findFirst({ where: { storeId: store.id }, select: { id: true } });
  if (!product) throw new Error("No real product found to test against");

  const groupId = randomUUID();
  const created: string[] = [];

  try {
    // Two real proposals sharing one groupId (mirrors request_product_content_change
    // resolving to 2 products from one owner request) + one real ungrouped proposal.
    const a = await prismaSystem.approvalRequest.create({
      data: {
        storeId: store.id,
        actionType: "update_product",
        summary: "verify-tmp: rename product A",
        input: { productId: product.id, name: "Verify Tmp A" },
        previousValues: { name: "Original A" },
        groupId,
        status: "PENDING_APPROVAL",
      },
    });
    created.push(a.id);
    const b = await prismaSystem.approvalRequest.create({
      data: {
        storeId: store.id,
        actionType: "update_product",
        summary: "verify-tmp: rename product B",
        input: { productId: product.id, name: "Verify Tmp B" },
        previousValues: { name: "Original B" },
        groupId,
        status: "PENDING_APPROVAL",
      },
    });
    created.push(b.id);
    const c = await prismaSystem.approvalRequest.create({
      data: {
        storeId: store.id,
        actionType: "update_product",
        summary: "verify-tmp: rename product C (ungrouped)",
        input: { productId: product.id, name: "Verify Tmp C" },
        previousValues: { name: "Original C" },
        groupId: null,
        status: "PENDING_APPROVAL",
      },
    });
    created.push(c.id);

    // The exact real chain a page uses: getPendingApprovals -> filter by
    // actionType (as every page does) -> buildPageAttentionCards -> groupAttentionCards.
    const pending = await getPendingApprovals(store.id);
    const testApprovals = pending.filter((p) => created.includes(p.id));
    if (testApprovals.length !== 3) throw new Error(`Expected 3 pending test approvals, got ${testApprovals.length}`);

    const cards = buildPageAttentionCards({ basePath: LEGACY_BUSINESS_BASE, approvals: testApprovals, observations: [] });
    if (cards.length !== 3) throw new Error(`Expected 3 cards, got ${cards.length}`);

    const groups = groupAttentionCards(cards);
    console.log(
      "Groups:",
      groups.map((g) => ({ groupId: g.groupId, memberSummaries: g.cards.map((c) => c.summary) }))
    );

    const groupedGroup = groups.find((g) => g.groupId === groupId);
    if (!groupedGroup) throw new Error("Grouped pair did not cluster under their shared groupId");
    if (groupedGroup.cards.length !== 2) throw new Error(`Expected 2 members in the shared group, got ${groupedGroup.cards.length}`);

    const ungroupedGroups = groups.filter((g) => g.groupId === null);
    if (ungroupedGroups.length !== 1) throw new Error(`Expected exactly 1 ungrouped card, got ${ungroupedGroups.length}`);
    if (ungroupedGroups[0].cards.length !== 1) throw new Error("Ungrouped card was not its own group of 1");

    console.log("\ngroupId propagation + groupAttentionCards clustering both verified correct.");
  } finally {
    await prismaSystem.approvalRequest.deleteMany({ where: { id: { in: created } } });
  }
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
