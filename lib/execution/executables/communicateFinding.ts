import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

// J4 Foundation Phase 1 (Execute Hardening) — the first "communication"-
// category mechanic. Reason's own output — insights, goal-trajectory
// predictions, explanations, recommendations, opportunities — used to be
// written directly via a raw Prisma call, bypassing execute() entirely,
// exactly the shape of bypass the chat-vs-manual fork used to be. This
// Executable closes that gap: it does nothing but create the
// CognitiveOutput row, so that "communicating a finding" gets the same
// authorization check and honest, uniform recording as every other mechanic.
//
// This is also the ONLY action registered with authorityExempt: true (see
// genesisActions.ts) — deliberately, because its run() has zero effect
// beyond this one record write. That exemption is a property of THIS
// executable's behavior, not of the "communication" category in general — a
// future communication action that sends an email, posts externally, or
// triggers any effect beyond recording must never reuse authorityExempt;
// it must go through the normal DelegatedAuthority grant path like every
// other real mechanic.
export interface CommunicateFindingInput {
  kind: "insight" | "prediction" | "explanation" | "recommendation" | "opportunity";
  summary: string;
  data?: object | null;
  priority?: "high" | "medium" | "low" | null;
  actionLabel?: string | null;
  actionHref?: string | null;
  recordId?: string | null;
  entityType?: string | null;
  topicKey?: string | null;
  // Durability only — recorded on the row exactly as before, but never read
  // back by this turn's own logic. Whether the proposed action is actually
  // executed (autonomously or via human approval) is decided separately,
  // downstream, by the caller — communicating the finding and proposing an
  // action are two distinct, independently-recordable mechanics, not one.
  proposedAction?: object | null;
}

export const communicateFindingExecutable: Executable<
  CommunicateFindingInput,
  { cognitiveOutputId: string }
> = {
  action: EXECUTION_ACTIONS.GENESIS_COMMUNICATE_FINDING,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const created = await prisma.cognitiveOutput.create({
      data: {
        storeId: ctx.storeId,
        kind: input.kind,
        summary: input.summary,
        data: input.data ? (input.data as Prisma.InputJsonValue) : Prisma.DbNull,
        priority: input.priority ?? null,
        actionLabel: input.actionLabel ?? null,
        actionHref: input.actionHref ?? null,
        recordId: input.recordId ?? null,
        entityType: input.entityType ?? null,
        topicKey: input.topicKey ?? null,
        proposedAction: input.proposedAction
          ? (input.proposedAction as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    });
    return {
      message: `Communicated a ${input.kind} finding: "${input.summary}"`,
      metadata: { cognitiveOutputId: created.id },
    };
  },
};
