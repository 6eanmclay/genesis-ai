import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import type { Challenge } from "@/lib/businessModel/entities";
import { resolveMissingObservations } from "@/lib/dashboard/genesisObservations";

// Phase 3 Milestone 6 (J4 Cognitive Layer) — the second "operations"
// action, same reasoning as updateGoalStatus.ts. Reuses the exact
// challenge:-prefixed GenesisObservation clear the M5 chat-capture write
// path already established — resolving a challenge through an approved
// action correctly clears its ambient Red badge the same way stating
// "that's resolved" in chat already does, one real hook, two real callers.

export interface ResolveChallengeInput {
  challengeRecordId: string;
}

export const resolveChallengeExecutable: Executable<ResolveChallengeInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.CHALLENGE_RESOLVE,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const record = await prisma.businessRecord.findFirstOrThrow({
      where: { id: input.challengeRecordId, storeId: ctx.storeId },
    });
    const data = record.data as Challenge;
    const updated: Challenge = {
      ...data,
      status: "resolved",
      resolvedAt: new Date().toISOString(),
    };
    await prisma.businessRecord.update({
      where: { id: record.id, storeId: ctx.storeId },
      data: { data: updated as object, syncedAt: new Date() },
    });
    await resolveMissingObservations(ctx.storeId, [], "urgent", `challenge:${record.id}`);
    return { message: `Marked "${data.description}" as resolved` };
  },
};
