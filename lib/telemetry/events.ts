import { prisma } from "@/lib/prisma";
import { correlationId } from "@/lib/observability/correlation";

// Family-beta behavioral/friction instrumentation (v20) — the one generic,
// append-only writer every instrumentation call site uses. See
// prisma/schema.prisma's ProductEvent comment and the v20 plan for the full
// architecture: `name` is a plain, freely-growing string catalog (same
// reasoning as lib/execution/actions.ts's EXECUTION_ACTIONS), `attemptKey`
// is always a real, already-meaningful identity (topicKey/groupId/
// dedupeKey/a storeDraftId/a fixed flow name) rather than an invented
// counter, and `metadata` only ever holds small allow-listed fields plus
// *references* to other rows' own ids — never raw chat/form content.
export type ProductEventCategory =
  | "navigation"
  | "chat"
  | "approval"
  | "integration"
  | "creation"
  | "performance"
  | "journey";

export interface LogProductEventInput {
  userId?: string | null;
  storeId?: string | null;
  storeDraftId?: string | null;
  sessionInstanceId: string;
  name: string;
  category: ProductEventCategory;
  attemptKey?: string | null;
  outcome?: "success" | "failure" | "abandoned" | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

// Telemetry must never break the real feature it's attached to — every call
// site fires this without awaiting a meaningful result, and a write failure
// here is swallowed (logged, not thrown) rather than surfacing as a
// user-facing failure in an unrelated flow (a chat reply, an approval
// decision, a Stripe connect attempt).
export async function logProductEvent(input: LogProductEventInput): Promise<void> {
  try {
    await prisma.productEvent.create({
      data: {
        // sessionInstanceId and attemptKey stay exactly as they are — they
        // answer "which browser session" and "which retry of this attempt".
        // The correlation id answers a third question neither could: what else
        // happened because of this.
        correlationId: correlationId(),
        userId: input.userId ?? null,
        storeId: input.storeId ?? null,
        storeDraftId: input.storeDraftId ?? null,
        sessionInstanceId: input.sessionInstanceId,
        name: input.name,
        category: input.category,
        attemptKey: input.attemptKey ?? null,
        outcome: input.outcome ?? null,
        durationMs: input.durationMs ?? null,
        metadata: input.metadata == null ? undefined : (input.metadata as object),
      },
    });
  } catch (err) {
    console.error("logProductEvent failed:", input.name, err);
  }
}

// A deliberately simple, explainable, deterministic "likely rephrase"
// signal — normalized word-overlap (Jaccard) between a new user message and
// the immediately preceding user message in the same conversation, only
// within a short window. No embeddings, no AI call. Always surfaced as
// "likely," never asserted as fact, per the explicit "don't turn raw data
// into fake conclusions" instruction — this is a hint for a human
// reconstructing a session, not an automatic classification.
const REPHRASE_WINDOW_MS = 10 * 60 * 1000;
const REPHRASE_OVERLAP_THRESHOLD = 0.5;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function findLikelyRephraseOf(
  newMessageContent: string,
  priorUserMessages: { id: string; content: string; createdAt: Date }[]
): string | null {
  const now = Date.now();
  const recentPrior = priorUserMessages
    .filter((m) => now - m.createdAt.getTime() <= REPHRASE_WINDOW_MS)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (recentPrior.length === 0) return null;

  const newTokens = tokenize(newMessageContent);
  const mostRecent = recentPrior[0];
  const overlap = jaccard(newTokens, tokenize(mostRecent.content));
  return overlap >= REPHRASE_OVERLAP_THRESHOLD ? mostRecent.id : null;
}
