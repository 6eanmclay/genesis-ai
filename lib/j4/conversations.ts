import { prisma } from "@/lib/prisma";

// CONVERSATIONS (UI6 piece 2, 2026-08-23).
//
// A conversation is an explicit, persistent thread. Not a task, not a time
// window, not a topic J4 inferred — J4 has to hold conversations about products,
// customers, documents, decisions, questions and problems, and anchoring
// identity on tasks would have forced every one of those to become a task in
// order to exist.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO, each because it was decided rather
// than forgotten:
//
//   - nothing generates a name (a J4-titled thread would make this milestone
//     depend on a model credential, and nothing else in it does);
//   - nothing closes or archives (the contract says v1 has no such behaviour,
//     and a row that could hold a closedAt is not a reason to build one);
//   - nothing groups messages automatically, by time or by subject;
//   - nothing backfills. A message written before conversations existed keeps a
//     null, which means "no conversation was recorded" rather than a
//     manufactured one.
//
// THE RULE THAT GOVERNS RESUMPTION, and the reason this file holds no
// understanding of its own:
//
//   Conversation history is a record of what was said, not a frozen snapshot of
//   what was known.
//
// Resuming feeds buildTurnContext, which rebuilds current business
// understanding for that turn. Historical messages stay historical; current
// business state stays current. J4 answering inside an old conversation answers
// with what it knows NOW.

export interface ConversationSummary {
  id: string;
  name: string | null;
  taskId: string | null;
  createdAt: Date;
  messageCount: number;
  lastMessageAt: Date | null;
}

/**
 * Start a conversation, because the owner said to.
 *
 * EXPLICIT BY CONSTRUCTION. Nothing else in this file or the turn path creates
 * one, so a conversation cannot appear as a side effect of sending a message —
 * which is what "explicit" was chosen to mean.
 *
 * `name` is whatever the owner typed, or nothing. An empty string is stored as
 * null rather than as an empty name, because "unnamed" and "named nothing" are
 * the same thing to a reader and should be the same thing in the row.
 */
export async function createConversation(input: {
  storeId: string;
  name?: string | null;
  /** Optional context. Never identity — see the model's own note. */
  taskId?: string | null;
}): Promise<{ id: string }> {
  const trimmed = input.name?.trim();
  return prisma.conversation.create({
    data: {
      storeId: input.storeId,
      name: trimmed ? trimmed : null,
      taskId: input.taskId ?? null,
    },
    select: { id: true },
  });
}

/**
 * The conversations this business has, newest first.
 *
 * Store-scoped like every other read here: one business's conversations are
 * never another's, and the guard refuses an unscoped collection read anyway.
 */
export async function listConversations(storeId: string): Promise<ConversationSummary[]> {
  const rows = await prisma.conversation.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      taskId: true,
      createdAt: true,
      messages: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { messages: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    taskId: row.taskId,
    createdAt: row.createdAt,
    messageCount: row._count.messages,
    lastMessageAt: row.messages[0]?.createdAt ?? null,
  }));
}

/**
 * Whether this conversation belongs to this business.
 *
 * Asked before a turn is appended to it, so a conversation id from a request
 * cannot move a message into another business's thread. Returns the id rather
 * than a boolean so a caller cannot forget to use the checked value.
 */
export async function conversationInBusiness(
  storeId: string,
  conversationId: string
): Promise<string | null> {
  const found = await prisma.conversation.findFirst({
    where: { id: conversationId, storeId },
    select: { id: true },
  });
  return found?.id ?? null;
}

/**
 * The messages in one conversation, oldest first.
 *
 * A conversation's own history, and nothing else's. A null `conversationId`
 * message — everything written before this existed — belongs to no conversation
 * and is never returned here; it is read by the ordinary store-wide history.
 */
export async function conversationMessages(storeId: string, conversationId: string) {
  return prisma.storeMessage.findMany({
    where: { storeId, conversationId },
    orderBy: { createdAt: "asc" },
  });
}
