import { prisma } from "@/lib/prisma";

// Bounded, deterministic, zero-AI-cost — deliberately capped rather than an
// unlimited memory dump (see the Phase 5 plan, memory:
// project_architecture_pivot_audit.md). Both the row-count cap and the
// lookback window apply together, whichever is smaller.
const HISTORY_LIMIT = 5;
const HISTORY_LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export interface GenesisHistoryEntry {
  topicKey: string;
  actionType: string;
  decision: "executed" | "rejected";
  decidedAt: string; // plain date, for prompt readability
  // Present only for "executed" entries with a completed measurement — a
  // plain before/after sentence, never a causal claim (see
  // PostExecutionMeasurement.summary).
  outcome?: string;
  // Present only for "rejected" entries — the original proposal's own
  // summary text, so Claude can see what was actually declined.
  rejectedProposalSummary?: string;
  // Phase 6 — "human" (the owner explicitly approved this) vs "autonomous"
  // (Genesis handled it under previously granted authority, unasked).
  // Purely informational: this never feeds back into whether Genesis HAS
  // authority for anything — that's decided solely by a live
  // DelegatedAuthority check (lib/execution/genesisAutonomy.ts), never by
  // this history. Only present for "executed" entries — a rejection is
  // always a human decision by definition (Genesis never rejects its own
  // proposal).
  decisionMode?: "human" | "autonomous";
}

// Feeds generateGenesisRecommendations.ts's prompt so Genesis's review
// reasons from real past experience instead of starting from a blank slate
// every time — without ever growing into an unbounded history. A rejection
// is included as context, not a suppression rule: the owner may have
// declined the specific wording/timing/implementation, not necessarily the
// underlying idea, so this is deliberately not filtered out of future
// reviews, only surfaced so Claude doesn't blindly repeat itself.
export async function getRecentGenesisHistory(storeId: string): Promise<GenesisHistoryEntry[]> {
  const since = new Date(Date.now() - HISTORY_LOOKBACK_MS);

  const [measured, rejected] = await Promise.all([
    prisma.postExecutionMeasurement.findMany({
      where: { storeId, measuredAt: { gte: since }, topicKey: { not: null } },
      orderBy: { measuredAt: "desc" },
      take: HISTORY_LIMIT,
      include: { approvalRequest: { select: { decisionMode: true } } },
    }),
    prisma.approvalRequest.findMany({
      where: { storeId, status: "REJECTED", topicKey: { not: null }, decidedAt: { gte: since } },
      orderBy: { decidedAt: "desc" },
      take: HISTORY_LIMIT,
    }),
  ]);

  const tagged: { sortAt: number; entry: GenesisHistoryEntry }[] = [
    ...measured.map((m) => ({
      sortAt: m.measuredAt.getTime(),
      entry: {
        topicKey: m.topicKey as string,
        actionType: m.actionType,
        decision: "executed" as const,
        decidedAt: m.measuredAt.toISOString().slice(0, 10),
        outcome: m.summary,
        decisionMode: m.approvalRequest.decisionMode as "human" | "autonomous",
      },
    })),
    ...rejected.map((r) => ({
      sortAt: r.decidedAt!.getTime(),
      entry: {
        topicKey: r.topicKey as string,
        actionType: r.actionType,
        decision: "rejected" as const,
        decidedAt: r.decidedAt!.toISOString().slice(0, 10),
        rejectedProposalSummary: r.summary,
      },
    })),
  ];

  return tagged
    .sort((a, b) => b.sortAt - a.sortAt)
    .slice(0, HISTORY_LIMIT)
    .map((t) => t.entry);
}
