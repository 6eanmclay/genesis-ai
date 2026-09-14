import { prisma } from "@/lib/prisma";

// WHICH UNFINISHED WORK THIS TURN IS ABOUT — OR NONE.
//
// ============ THE PROBLEM THIS EXISTS TO END (2026-09-14) =============
//
// Task is the durable record of multi-step work: status, context, the action
// it is waiting on. But nothing put it in front of J4. The ONLY way J4 knew
// what an owner was working toward was the seed turn startTaskConversation
// writes — an ordinary message, read back out of a 50-message window.
//
// So continuity had a cliff. Past fifty messages the seed turn falls out of the
// prompt and J4 silently stops knowing, while Task.status still reads
// IN_PROGRESS. Nothing detects it, and the owner discovers it by being asked
// something they already answered.
//
// This reads the same fact from the row instead of from the transcript, so
// resumption stops depending on a message surviving a window.
//
// ============ RELEVANCE, NOT INVENTORY ================================
//
// Sean's decision, and the shape of this whole module: "Do not inject every
// IN_PROGRESS/AWAITING_INPUT task into every turn... surface only the task that
// is contextually relevant. If there is no demonstrably relevant task, do not
// volunteer unrelated unfinished work."
//
// Two durable signals decide it, in order, and NOTHING ELSE:
//
//   1. The conversation says so. Conversation.taskId, set when the owner opened
//      a conversation about a task. Explicit and owner-made.
//
//   2. The thread says so. A StoreMessage in this same bucket carries taskId —
//      which is exactly what startTaskConversation writes. Queried rather than
//      read from the prompt window, which is the whole point: the link survives
//      however long the conversation runs.
//
// AMBIGUITY IS SILENCE. Two different tasks in the thread is not a reason to
// pick one. Zero is not a reason to offer the newest. Both return null, and J4
// says nothing about unfinished work — which is the honest answer and the one
// that keeps this from becoming an inventory nobody asked for.
//
// RECENCY IS NEVER PROOF. There is deliberately no "most recent task" fallback.
// An owner who finished with something an hour ago and is now asking about
// something else must not be answered about the old thing.
//
// ============ WHAT IS DELIBERATELY NOT A SIGNAL YET ===================
//
// Record and surface context. TurnContextInput declares `selectedNodeIds` and
// NO CALLER PASSES IT — SelectionContext is empty in both the streaming route
// and the server-action path — so a branch matching Task.relatedRecordId
// against a selection would be a branch nothing exercises. It is a real signal
// and it is not a live one, so it is named here rather than written.

/** What J4 is told about the work in progress. Never the whole list. */
export interface RelevantTask {
  id: string;
  title: string;
  summary: string;
  /** OPEN | IN_PROGRESS | AWAITING_INPUT — never a finished one. */
  status: string;
  /** What the owner still owes, when the task is blocked on them. */
  requiredInput: unknown;
}

/** In-flight means unfinished. A completed or dismissed task is not resumable. */
const IN_FLIGHT = ["IN_PROGRESS", "AWAITING_INPUT"] as const;

function shape(row: {
  id: string;
  title: string;
  summary: string;
  status: string;
  requiredInput: unknown;
}): RelevantTask {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    requiredInput: row.requiredInput ?? null,
  };
}

/**
 * The one piece of unfinished work this turn is about, or null.
 *
 * `conversationId` null means the ungrouped history — the bucket task turns are
 * written into today — and is matched as null rather than ignored, because
 * "every message in this business" would pull another conversation's task into
 * this one. Same scoping rule the chat route's own history read follows.
 */
export async function relevantTaskFor(params: {
  storeId: string;
  conversationId: string | null;
}): Promise<RelevantTask | null> {
  const { storeId, conversationId } = params;

  // ---- 1. the conversation was opened about a task -----------------------
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, storeId },
      select: { task: { select: { id: true, title: true, summary: true, status: true, requiredInput: true } } },
    });
    const task = conversation?.task;
    // A finished task on an old conversation is history, not work in progress.
    if (task && (IN_FLIGHT as readonly string[]).includes(task.status)) return shape(task);
  }

  // ---- 2. a turn in this same thread is linked to one ---------------------
  //
  // DISTINCT TASKS, not messages. One task seeded three turns is still one
  // task; two different tasks in one thread is the ambiguity this refuses.
  const linked = await prisma.storeMessage.findMany({
    where: { storeId, conversationId, taskId: { not: null } },
    select: { taskId: true },
    distinct: ["taskId"],
    // Bounded so a very long thread cannot make this read unbounded. Above two
    // the answer is silence anyway, so three is enough to know that.
    take: 3,
  });
  const taskIds = linked.map((m) => m.taskId!).filter(Boolean);
  if (taskIds.length !== 1) return null;

  const task = await prisma.task.findFirst({
    where: { id: taskIds[0], storeId, status: { in: [...IN_FLIGHT] } },
    select: { id: true, title: true, summary: true, status: true, requiredInput: true },
  });
  return task ? shape(task) : null;
}

/**
 * The line J4 is given, or null when there is nothing honest to say.
 *
 * NO RECORD IDS AND NO TASK ID. verify-j4-selection asserts an internal record
 * id never reaches the prompt, and the same rule holds here — what J4 needs is
 * what the work IS, in the owner's words, not a handle it cannot speak.
 */
export function describeRelevantTask(task: RelevantTask | null): string | null {
  if (!task) return null;
  const waiting =
    task.status === "AWAITING_INPUT"
      ? " This is waiting on the owner — do not act on it until they answer."
      : "";
  return (
    `(Work in progress, and this conversation is about it: "${task.title}" — ${task.summary}` +
    `${waiting} Continue it rather than starting over, and do not re-ask what they have already told you.)`
  );
}
