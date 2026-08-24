import { prisma } from "@/lib/prisma";
import type { VerificationOutcome } from "../verification";
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

  // CLASS D — the rule's output is fixed rather than taken from the input:
  // resolving sets status "resolved" AND a resolvedAt. Both are checked, because
  // a status without its timestamp is a half-applied write.
  async verify(input, ctx): Promise<VerificationOutcome> {
    const record = await prisma.businessRecord.findFirst({
      where: { id: input.challengeRecordId, storeId: ctx.storeId },
    });
    if (!record) {
      return { state: "failed", mismatches: ["challenge: the record no longer exists"] };
    }
    const data = record.data as { status?: string; resolvedAt?: string | null };
    const mismatches: string[] = [];
    if (data.status !== "resolved") {
      mismatches.push(`challenge.status: expected resolved, stored ${data.status ?? "nothing"}`);
    }
    if (!data.resolvedAt) mismatches.push("challenge.resolvedAt: nothing was recorded");
    return mismatches.length === 0 ? { state: "verified" } : { state: "failed", mismatches };
  },
};
