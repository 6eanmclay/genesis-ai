"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePermission } from "@/lib/permissions";
import { performApproveGenesisAction, performRejectGenesisAction } from "@/app/dashboard/ai-actions";
import { withJ4CopyRules } from "@/lib/j4CopyRules";
import { PROPOSAL_STATUS, parseDirections, reviseProposal } from "@/lib/storefront/proposals";

// Deciding a proposal without leaving the conversation (2026-08-14).
//
// Sean: "there must only be ONE J4 conversation... that entire exchange
// belongs to the same conversation history." And: "close proposal → I'm
// exactly where I was. Same scroll position. Same page. Same context. Same
// conversation. Nothing else moved."
//
// TWO REAL BUGS THIS FIXES, both introduced by binding the dashboard's own
// approve/reject actions straight onto a card inside the layer:
//
// 1. approveGenesisAction and rejectGenesisAction both end in
//    redirect("/dashboard"). Approving a proposal from the persistent layer
//    therefore threw the owner onto the dashboard — the exact navigation the
//    layer exists to prevent, triggered by the one control most likely to be
//    pressed.
//
// 2. Neither writes anything into the conversation. The discussion that
//    produced a proposal was recorded; the outcome of it was not. Office
//    would have shown "I'd try a warmer editorial direction" and then
//    silence, with no record that it was ever applied or verified. That is
//    two different stories about one exchange, which is precisely the
//    fragmentation Sean is ruling out.
//
// So these run the same underlying perform* functions the dashboard uses —
// same execution, same verification, same audit trail — and then write the
// real outcome into the one StoreMessage history before revalidating in
// place. No redirect anywhere.

async function recordOutcome(storeId: string, content: string) {
  await prisma.storeMessage.create({
    data: { storeId, role: "assistant", content: withJ4CopyRules(content) },
  });
}

/**
 * Applies a proposal from inside the conversation.
 *
 * The reply is written from the real result, never assumed: an execution that
 * fails says so in the conversation rather than leaving the owner believing a
 * change landed. Verification is the executable's own, unchanged.
 */
export async function approveProposalInConversation(approvalRequestId: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const result = await performApproveGenesisAction(approvalRequestId);

  if (result.outcome === "executed") {
    await recordOutcome(storeId, result.message ? `Done. ${result.message}` : "Done, and verified.");
  } else if (result.outcome === "execution_failed") {
    await recordOutcome(
      storeId,
      `I tried to apply that and it did not go through. ${result.message ?? ""} Nothing on your storefront changed.`.trim()
    );
  } else {
    // not_found — the proposal was already decided somewhere else, or is gone.
    // Said plainly rather than silently doing nothing, which would read as the
    // button being broken.
    await recordOutcome(storeId, "That proposal is no longer open, so there was nothing for me to apply.");
  }

  // Revalidate rather than redirect. The layer picks up both the new message
  // and the now-settled proposal exactly where the owner is standing.
  revalidatePath("/dashboard");
}

/**
 * Picks one of the directions a revision offered.
 *
 * This does NOT mutate the revision. It writes the next revision carrying only
 * the chosen direction's changes, which keeps revisions immutable and makes
 * "I like B, but warmer" an ordinary refinement of B rather than a special
 * case. Sean: "a single revision can contain a visual comparison... that does
 * not mean we need two independent proposal chains."
 *
 * The choice is spoken into the conversation too, because a decision the owner
 * made is part of the exchange and Office must be able to show it later.
 */
export async function chooseDirectionInConversation(approvalRequestId: string, directionId: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);

  const row = await prisma.approvalRequest.findFirst({
    where: { storeId, id: approvalRequestId, status: PROPOSAL_STATUS.pending },
    select: { proposalId: true, id: true, target: true, directions: true, summary: true },
  });
  if (!row) {
    await recordOutcome(storeId, "That proposal is no longer open.");
    revalidatePath("/dashboard");
    return;
  }

  const chosen = parseDirections(row.directions).find((d) => d.id === directionId);
  if (!chosen) {
    await recordOutcome(storeId, "I could not find that direction any more. Tell me which one you meant.");
    revalidatePath("/dashboard");
    return;
  }

  // A chainless row (written before revision lineage existed) is adopted into
  // a chain of one before being revised. Without this, reviseProposal's own
  // lookup by proposalId finds nothing and returns null, and this action would
  // announce a choice it never actually recorded.
  let chainId = row.proposalId;
  if (!chainId) {
    await prisma.approvalRequest.update({ where: { id: row.id }, data: { proposalId: row.id } });
    chainId = row.id;
  }

  const revised = await reviseProposal(storeId, chainId, {
    summary: `${row.summary} (${chosen.label})`,
    rationale: chosen.rationale ?? `You chose ${chosen.label}.`,
    target: row.target,
    input: { target: row.target, summary: row.summary, reason: chosen.rationale ?? "", changes: chosen.changes },
  });

  // Never claim a choice was recorded when it was not.
  await recordOutcome(
    storeId,
    revised
      ? `${chosen.label} it is. I have it ready below. Tell me if you want anything adjusted, or apply it as it stands.`
      : "Something went wrong recording that choice and nothing has changed. Tell me which direction you wanted and I will set it up again."
  );
  revalidatePath("/dashboard");
}

/** Turns a proposal down from inside the conversation. */
export async function rejectProposalInConversation(approvalRequestId: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.ANALYTICS_VIEW);
  const result = await performRejectGenesisAction(approvalRequestId);

  await recordOutcome(
    storeId,
    result.outcome === "not_found"
      ? "That proposal is no longer open."
      : "Understood, I have set that aside. Tell me what you would rather do and we can try another direction."
  );

  revalidatePath("/dashboard");
}
