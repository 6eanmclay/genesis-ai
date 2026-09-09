import { prisma } from "@/lib/prisma";

/**
 * Writes the outcome of a decision into the owner's conversation, once.
 *
 * ============ THE SAME SENTENCE TEN TIMES (2026-09-09) =================
 *
 * Production, 2026-09-06: this exact failure message was written TEN times in
 * 78 seconds -
 *
 *     "I tried to apply that and it did not go through. 'warm cream base with
 *      copper-toned section bands' is not a re..."
 *
 * with gaps of 273ms, 441ms, 618ms, 722ms, 752ms, 763ms, then 3s and 71s.
 * Sub-second gaps are not somebody deciding to try again; they are a control
 * that stays live, because a FAILED execution leaves the proposal still
 * approvable. Every attempt ran, failed, and appended the same sentence.
 *
 * THE RETRY IS LEGITIMATE. The owner is entitled to try again, and silently
 * refusing the attempt would be the worse bug. What is not legitimate is ten
 * copies stacking up in their conversation - and then J4 reading all ten back
 * as context on later turns, which is why he kept raising the same warm-up
 * proposal for days afterwards.
 *
 * ============ WHY THIS LIVES IN lib AND NOT IN THE ACTION ==============
 *
 * app/j4/proposal-actions.ts is "use server", so a helper inside it cannot be
 * exported for a test without becoming a server action itself. The rule is
 * real and worth proving against a real database, so it moved here. That is
 * the same reason the spoken-reply rule moved to lib/voice/spokenReplies.
 */
export async function recordConversationOutcome(storeId: string, content: string): Promise<"written" | "duplicate"> {
  // Never append an outcome identical to the one already at the end of this
  // conversation. Nothing is hidden: the message the owner needs is already
  // the last thing J4 said, word for word. A DIFFERENT outcome still writes,
  // and so does the same outcome once J4 has said something else in between -
  // which is what makes this a de-duplication rather than a silence.
  const latest = await prisma.storeMessage.findFirst({
    where: { storeId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  if (latest?.content === content) return "duplicate";

  await prisma.storeMessage.create({
    data: { storeId, role: "assistant", content },
  });
  return "written";
}
