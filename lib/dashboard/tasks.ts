import { prisma } from "@/lib/prisma";

// BUSINESS_ASSETS_ARCHITECTURE.md M1 — same upsert-by-(storeId, dedupeKey)
// identity pattern as GenesisObservation's upsertObservation (lib/dashboard/
// genesisObservations.ts): re-detecting the same real condition refreshes
// this row in place rather than creating a duplicate, and reopens a
// previously COMPLETED/DISMISSED row if the same condition genuinely
// recurs, so identity survives a resolve/reappear cycle.
export interface TaskInput {
  dedupeKey: string;
  source: string;
  sourceId?: string | null;
  relatedRecordId?: string | null;
  relatedEntityType?: string | null;
  relatedAssetId?: string | null;
  title: string;
  summary: string;
  context: Record<string, unknown>;
  actionType?: string | null;
  trustLevel?: string;
  actionHref?: string | null;
  /**
   * Exactly what this task needs from the owner before its action can run.
   *
   * The column has existed since M1 and was written by nothing. First real
   * producer is the supplier-economics question (lib/sourcing/
   * economicsQuestions.ts), which puts the outstanding facts here so the card
   * asks for the half that is missing rather than both halves every time.
   *
   * Refreshed on re-detection, unlike `context`: what is still outstanding is
   * the part most likely to have changed since the question was first raised.
   */
  requiredInput?: Record<string, unknown> | null;
  priority: "FAILED" | "WARNING" | "opportunity";
}

// M3 bug found via real end-to-end testing, fixed twice: v1 was a single
// prisma.task.upsert() whose `update` branch unconditionally reset status
// to "OPEN" on every re-detection, silently stomping IN_PROGRESS/COMPLETED
// back to OPEN. v2 (a read-then-create-or-update pattern) fixed that but
// introduced a real race — two concurrent detection runs could both see
// "doesn't exist" and both call create(), tripping the real unique
// constraint (confirmed live: "Unique constraint failed on (storeId,
// dedupeKey)"). This version is fully atomic again: the upsert's own
// `update` branch never touches status at all, and reactivating a
// terminal (COMPLETED/DISMISSED) row back to OPEN on genuine recurrence —
// GenesisObservation's own real semantics — is a separate, independently
// atomic updateMany scoped by status, immune to the same race either way.
export async function upsertTask(storeId: string, task: TaskInput): Promise<void> {
  await prisma.task.upsert({
    where: { storeId_dedupeKey: { storeId, dedupeKey: task.dedupeKey } },
    create: {
      storeId,
      dedupeKey: task.dedupeKey,
      source: task.source,
      sourceId: task.sourceId ?? null,
      relatedRecordId: task.relatedRecordId ?? null,
      relatedEntityType: task.relatedEntityType ?? null,
      relatedAssetId: task.relatedAssetId ?? null,
      title: task.title,
      summary: task.summary,
      context: task.context,
      actionType: task.actionType ?? null,
      trustLevel: task.trustLevel ?? "recommend",
      actionHref: task.actionHref ?? null,
      requiredInput: task.requiredInput ?? undefined,
      priority: task.priority,
    },
    update: {
      title: task.title,
      summary: task.summary,
      context: task.context,
      relatedRecordId: task.relatedRecordId ?? null,
      relatedAssetId: task.relatedAssetId ?? null,
      actionHref: task.actionHref ?? null,
      requiredInput: task.requiredInput ?? undefined,
      priority: task.priority,
      // status intentionally absent — see this function's own comment on
      // why an already-active row is never touched here.
    },
  });

  // Atomic, race-free reactivation — see comment above.
  await prisma.task.updateMany({
    where: { storeId, dedupeKey: task.dedupeKey, status: { in: ["COMPLETED", "DISMISSED"] } },
    data: { status: "OPEN", completedAt: null, dismissedAt: null },
  });
}

// Marks every currently-OPEN task from this source that isn't in the fresh
// set as COMPLETED — same "disappears without anyone telling Genesis to
// stop mentioning it" behavior as GenesisObservation's own resolve sweep,
// scoped by source rather than a dedupeKey prefix since M1's sources each
// own a small, fully-enumerable set of dedupeKeys per call.
export async function resolveStaleTasks(storeId: string, source: string, freshDedupeKeys: string[]): Promise<void> {
  await prisma.task.updateMany({
    where: { storeId, source, status: "OPEN", dedupeKey: { notIn: freshDedupeKeys } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
}

/**
 * The statuses that mean a task is still real work.
 *
 * COMPLETED and DISMISSED are the only two endings; everything else is
 * outstanding. Spelled once here because four separate places had written this
 * same set out by hand, and a set that lives in four places is one edit away
 * from four different answers to "is this still open".
 *
 * AWAITING_INPUT is in the list because it is in the schema's non-terminal set,
 * not because anything writes it — nothing does, today. Including it in a READ
 * costs nothing and means the day something starts writing it, the owner sees
 * those rows instead of losing them the way IN_PROGRESS rows were being lost.
 */
export const ACTIVE_TASK_STATUSES = ["OPEN", "IN_PROGRESS", "AWAITING_INPUT"] as const;

/**
 * Every task still outstanding for a business — including the ones under way.
 *
 * ============ WHAT THIS EXISTS TO END (2026-09-15) =====================
 *
 * This was `getOpenTasks` and it filtered `status: "OPEN"` and nothing else,
 * while being the ONLY owner-facing task query in the product: the Office
 * (app/j4/intelligence-actions.ts) and the Business arrival
 * (app/dashboard/HomeWorkspace.tsx) both read it.
 *
 * So handing a task to J4 deleted it from the owner's world. startTaskConversation
 * writes a seed turn and sets IN_PROGRESS, then redirects to /j4 — and from that
 * moment the task appeared on no surface at all. Not moved, not marked: absent.
 *
 * AND IT COULD NOT COME BACK. upsertTask's reactivation is scoped to
 * COMPLETED/DISMISSED, and resolveStaleTasks sweeps `status: "OPEN"`, so an
 * IN_PROGRESS task that never completed was invisible AND exempt from the
 * staleness sweep. Permanently, not temporarily.
 *
 * Measured in production on 2026-09-15, before changing a line: seven Task rows
 * in total, three of them non-terminal — and TWO of those three were
 * IN_PROGRESS, handed to J4 38 and 39 days earlier, both with a real
 * destination, both invisible on every surface the owner has. One task in three
 * was visible.
 *
 * VISIBILITY ONLY, which is the whole change. A resumed task keeps the action
 * officeActionForTask already gives it and lands where that action puts it.
 * Nothing here decides it is "waiting on the owner", gives it a new section, or
 * invents a status for it — those were the other two options and Sean chose
 * this one deliberately.
 */
export async function getActiveTasks(storeId: string) {
  return prisma.task.findMany({
    where: { storeId, status: { in: [...ACTIVE_TASK_STATUSES] } },
    orderBy: { createdAt: "asc" },
  });
}

// BUSINESS_ASSETS_ARCHITECTURE.md M3 — real dashboard-updates-on-completion.
// ============ IDENTITY FIRST, RESEMBLANCE ONLY FOR LEGACY ===========
//
// Called after any successful execute() of a real GENESIS_ACTIONS type
// (conversational auto-execute in proposeAction, or a normal manual approve).
//
// TWO PATHS, AND THEY ARE NOT EQUALLY AUTHORITATIVE.
//
//   `taskId` — the approval names the exact Task it came out of, stamped at
//   creation from the conversation or the thread. This is the real answer and
//   it is used whenever it exists.
//
//   actionType — the LEGACY path, and nothing more. It completes whichever
//   IN_PROGRESS task happens to share an action type, which is a guess: two
//   tasks of one type both close, and the right one closing is luck. It exists
//   only for approvals written before taskId did, and for the creation paths
//   that genuinely have no task identity (the AI review, autonomous findings,
//   storefront proposals, marketing assets) — see the trace in the commit that
//   added the column. It is not a fallback to be relied on for new work; it is
//   a fallback to be outlived.
//
// The actionType path stays scoped to IN_PROGRESS — a task the owner actually
// opened — so an untouched task of the same type is never swept up. That
// narrows the guess; it does not make it an identity.
export async function completeTasksForAction(
  storeId: string,
  actionType: string,
  /** The task the originating approval named, when it named one. */
  taskId?: string | null,
): Promise<void> {
  if (taskId) {
    // STORE-SCOPED, so an id from another business completes nothing here.
    // Status-scoped for the same reason the legacy path is: a task already
    // finished or dismissed is not re-finished by a later action.
    await prisma.task.updateMany({
      where: { id: taskId, storeId, status: { in: [...ACTIVE_TASK_STATUSES] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return;
  }

  await prisma.task.updateMany({
    where: { storeId, actionType, status: "IN_PROGRESS" },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
}
