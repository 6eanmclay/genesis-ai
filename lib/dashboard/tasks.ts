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
  priority: "FAILED" | "WARNING" | "opportunity";
}

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
      priority: task.priority,
    },
    update: {
      title: task.title,
      summary: task.summary,
      context: task.context,
      relatedRecordId: task.relatedRecordId ?? null,
      relatedAssetId: task.relatedAssetId ?? null,
      actionHref: task.actionHref ?? null,
      priority: task.priority,
      status: "OPEN",
      completedAt: null,
      dismissedAt: null,
    },
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

export async function getOpenTasks(storeId: string) {
  return prisma.task.findMany({
    where: { storeId, status: "OPEN" },
    orderBy: { createdAt: "asc" },
  });
}
