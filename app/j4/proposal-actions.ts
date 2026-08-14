"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePermission } from "@/lib/permissions";
import { performApproveGenesisAction, performRejectGenesisAction } from "@/app/dashboard/ai-actions";
import { withJ4CopyRules } from "@/lib/j4CopyRules";

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
