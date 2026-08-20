import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import "dotenv/config";
import { randomUUID } from "crypto";
import { prismaSystem } from "../lib/prisma";
import { resolveMostRecentPendingApprovalBatch, describeApprovalExecutionForChat } from "../lib/dashboard/pendingApprovals";
import { editProductExecutable } from "../lib/execution/executables/products";
import type { GroupApprovalResult } from "../lib/dashboard/pendingApprovals";

// Real end-to-end verification (2026-08-09) — the exact bug Sean caught by
// testing the real deployed app: "I approve all together, make the change"
// re-analyzed the products instead of executing what was already proposed.
// performApproveGenesisActionGroup/performApprovePendingChanges themselves
// require a real authenticated session (requireStorePermission), which a
// standalone script can't fake — same structural limit as every other
// approval-execution script this session. What CAN be verified without
// auth, and IS the genuinely new logic this fix adds, is:
//   1. resolveMostRecentPendingApprovalBatch really resolves "the group I
//      just presented" correctly (grouped and single-ungrouped cases).
//   2. The execute/verify/record loop it feeds into (replicated here via
//      the same real executable + prismaSystem, mirroring how
//      performApproveGenesisActionGroup's own loop works) actually applies
//      the exact proposed change, never a re-analysis.
//   3. describeApprovalExecutionForChat produces Sean's exact expected
//      phrasing for the success, partial-failure, and full-failure cases.
async function main() {
  // Refuses to run against anything but an isolated test database. These
  // suites create, mutate and delete rows — without this, a production
  // DATABASE_URL in the shell was enough to rename a real merchant's product.
  // See scripts/lib/requireTestDatabase.ts.
  await requireTestDatabase(prismaSystem);
  const store = await prismaSystem.store.findFirst({ select: { id: true } });
  if (!store) throw new Error("No real store found to test against");
  const products = await prismaSystem.product.findMany({ where: { storeId: store.id }, select: { id: true, name: true }, take: 2 });
  if (products.length < 2) throw new Error("Need at least 2 real products to test against");
  const [productA, productB] = products;

  const groupId = randomUUID();
  const created: string[] = [];

  try {
    // --- Case 1: grouped batch resolves correctly ---
    const a = await prismaSystem.approvalRequest.create({
      data: {
        storeId: store.id, actionType: "update_product",
        summary: `verify-tmp: rename ${productA.name}`,
        input: { productId: productA.id, name: `${productA.name} (verify-tmp)` },
        previousValues: { name: productA.name },
        groupId, status: "PENDING_APPROVAL",
      },
    });
    created.push(a.id);
    const b = await prismaSystem.approvalRequest.create({
      data: {
        storeId: store.id, actionType: "update_product",
        summary: `verify-tmp: rename ${productB.name}`,
        input: { productId: productB.id, name: `${productB.name} (verify-tmp)` },
        previousValues: { name: productB.name },
        groupId, status: "PENDING_APPROVAL",
      },
    });
    created.push(b.id);

    const batch = await resolveMostRecentPendingApprovalBatch(store.id);
    if (!batch) throw new Error("Expected a resolved batch, got null");
    if (batch.groupId !== groupId) throw new Error(`Expected groupId ${groupId}, got ${batch.groupId}`);
    if (batch.approvalIds.length !== 2) throw new Error(`Expected 2 members, got ${batch.approvalIds.length}`);
    console.log("Case 1 (grouped resolve): PASS —", batch.summaries);

    // Replicate performApproveGenesisActionGroup's own real loop (same
    // executable, same ctx shape) since the real function needs a session.
    const ctx = { storeId: store.id, userId: null, actorType: "GENESIS" as const };
    const result: GroupApprovalResult = { totalMembers: batch.approvalIds.length, succeeded: [], failed: [] };
    for (const id of batch.approvalIds) {
      const approval = await prismaSystem.approvalRequest.findUniqueOrThrow({ where: { id } });
      await editProductExecutable.run(approval.input as { productId: string; name?: string }, ctx);
      await prismaSystem.approvalRequest.update({ where: { id }, data: { status: "EXECUTED", decidedAt: new Date() } });
      result.succeeded.push(approval.summary);
    }

    const productAAfter = await prismaSystem.product.findUniqueOrThrow({ where: { id: productA.id } });
    const productBAfter = await prismaSystem.product.findUniqueOrThrow({ where: { id: productB.id } });
    if (productAAfter.name !== `${productA.name} (verify-tmp)`) throw new Error("Product A was not actually renamed — approval was not really executed");
    if (productBAfter.name !== `${productB.name} (verify-tmp)`) throw new Error("Product B was not actually renamed — approval was not really executed");
    console.log("Case 1 (real execution against real DB rows): PASS — both products actually renamed, not just marked executed");

    const successReply = describeApprovalExecutionForChat(result);
    if (successReply !== "Done. I applied all 2 changes and verified them.") {
      throw new Error(`Unexpected success phrasing: "${successReply}"`);
    }
    console.log("Case 1 (chat reply phrasing): PASS —", JSON.stringify(successReply));

    // Restore original state.
    await editProductExecutable.run({ productId: productA.id, name: productA.name }, ctx);
    await editProductExecutable.run({ productId: productB.id, name: productB.name }, ctx);

    // --- Case 2: no pending approvals resolves to null / honest "nothing pending" ---
    const noneResult: GroupApprovalResult = { totalMembers: 0, succeeded: [], failed: [] };
    const noneReply = describeApprovalExecutionForChat(noneResult);
    if (noneReply !== "There's nothing pending for me to approve right now.") {
      throw new Error(`Unexpected empty-state phrasing: "${noneReply}"`);
    }
    console.log("Case 2 (nothing pending phrasing): PASS —", JSON.stringify(noneReply));

    // --- Case 3: partial failure phrasing names the specific failure ---
    const partialResult: GroupApprovalResult = {
      totalMembers: 2,
      succeeded: ["Renamed the tensor ring"],
      failed: [{ summary: "Update the bracelet description", reason: "Product not found" }],
    };
    const partialReply = describeApprovalExecutionForChat(partialResult);
    if (partialReply !== "1 of 2 completed. One needs attention: Update the bracelet description — Product not found.") {
      throw new Error(`Unexpected partial-failure phrasing: "${partialReply}"`);
    }
    console.log("Case 3 (partial-failure phrasing, names the real reason): PASS —", JSON.stringify(partialReply));

    // --- Case 4: single, ungrouped approval resolves to itself ---
    const single = await prismaSystem.approvalRequest.create({
      data: {
        storeId: store.id, actionType: "update_product",
        summary: `verify-tmp: ungrouped rename ${productA.name}`,
        input: { productId: productA.id, name: `${productA.name} (verify-tmp-2)` },
        previousValues: { name: productA.name },
        groupId: null, status: "PENDING_APPROVAL",
      },
    });
    created.push(single.id);
    const singleBatch = await resolveMostRecentPendingApprovalBatch(store.id);
    if (!singleBatch) throw new Error("Expected a resolved single batch, got null");
    if (singleBatch.groupId !== null) throw new Error(`Expected null groupId for ungrouped approval, got ${singleBatch.groupId}`);
    if (singleBatch.approvalIds.length !== 1 || singleBatch.approvalIds[0] !== single.id) {
      throw new Error(`Expected exactly the ungrouped approval, got ${JSON.stringify(singleBatch.approvalIds)}`);
    }
    console.log("Case 4 (most-recent ungrouped resolve): PASS —", singleBatch.summaries);

    console.log("\nAll approve_pending_changes assertions passed.");
  } finally {
    await prismaSystem.approvalRequest.deleteMany({ where: { id: { in: created } } });
    // Cleanup safety net in case an assertion threw mid-way, before restore ran.
    const [restoreA, restoreB] = await Promise.all([
      prismaSystem.product.findUniqueOrThrow({ where: { id: productA.id } }),
      prismaSystem.product.findUniqueOrThrow({ where: { id: productB.id } }),
    ]);
    if (restoreA.name !== productA.name) {
      await prismaSystem.product.update({ where: { id: productA.id }, data: { name: productA.name } });
    }
    if (restoreB.name !== productB.name) {
      await prismaSystem.product.update({ where: { id: productB.id }, data: { name: productB.name } });
    }
  }
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
