import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import type { Goal } from "@/lib/businessModel/entities";

// Phase 3 Milestone 6 (J4 Cognitive Layer) — the first Executable that
// targets a specific BusinessRecord row rather than Store's own columns/
// blueprint. Genesis's own internal understanding, never customer-facing,
// the same low-stakes reasoning that already made the chat-capture write
// path (M5) a direct write rather than approval-gated — here it still goes
// through the real Executable/ApprovalRequest/DelegatedAuthority path,
// deliberately, to prove that machinery generalizes past storefront
// content, not just to skip ceremony.

export interface UpdateGoalStatusInput {
  goalRecordId: string;
  // "active" is a legitimate CURRENT value (getCurrentValues needs to be
  // able to report it honestly) even though nothing meaningfully proposes
  // setting a goal back to "active" via this action.
  status: "active" | "achieved" | "abandoned";
}

export const updateGoalStatusExecutable: Executable<UpdateGoalStatusInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.GOAL_UPDATE_STATUS,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    // Scoped to ctx.storeId, not just input.goalRecordId — the id alone is
    // a real cuid the model or a caller supplied, and without this check a
    // record belonging to a DIFFERENT store could be modified through an
    // approval that was only ever authorized against this one.
    const record = await prisma.businessRecord.findFirstOrThrow({
      where: { id: input.goalRecordId, storeId: ctx.storeId },
    });
    const data = record.data as Goal;
    const updated: Goal = { ...data, status: input.status };
    await prisma.businessRecord.update({
      where: { id: record.id, storeId: ctx.storeId },
      data: { data: updated as object, syncedAt: new Date() },
    });
    return { message: `Marked goal "${data.description}" as ${input.status}` };
  },
};
