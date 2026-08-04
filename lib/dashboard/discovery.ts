import { prisma } from "@/lib/prisma";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// Home Redesign (v30) — Discovery as the centerpiece. This is deliberately a
// new, Home-specific read layer over CognitiveOutput, not another producer
// folded into lib/dashboard/recommendations.ts's getRecommendations/
// ruleBasedProducer/genesisProducer — that older abstraction keeps serving
// Analytics completely unchanged (its DiscoveryItem needs a real
// multi-kind shape a flat single-kind Recommendation type was never built
// to hold).

export interface DiscoveryItem {
  id: string;
  kind: "recommendation" | "opportunity" | "explanation" | "prediction";
  summary: string;
  priority: "high" | "medium" | "low" | null;
  // Business Intelligence Engine M2 — "first-class, queryable" per Sean's
  // own framing (2026-08-04): real, populated on recommendation/
  // opportunity kinds (null for explanation/prediction, and for any row
  // written before the column existed). Data-only for now — DiscoveryFeed.tsx
  // is deliberately untouched; a future design pass can read this without
  // another query change or migration.
  confidence: number | null;
  actionLabel: string | null;
  actionHref: string | null;
  generatedAt: Date;
}

export async function getDiscoveryFeed(storeId: string, limit = 10): Promise<DiscoveryItem[]> {
  const rows = await prisma.cognitiveOutput.findMany({
    where: {
      storeId,
      kind: { in: ["recommendation", "opportunity", "explanation", "prediction"] },
      status: "ACTIVE",
    },
    orderBy: { generatedAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as DiscoveryItem["kind"],
    summary: r.summary,
    priority: r.priority as DiscoveryItem["priority"],
    confidence: r.confidence,
    actionLabel: r.actionLabel,
    actionHref: r.actionHref,
    generatedAt: r.generatedAt,
  }));
}

// Replaces the broken prisma.generatedRecommendation.findFirst query
// previously used on both Home and Analytics — runCognitiveReview (M6)
// stopped writing to that table, so that query has silently returned
// nothing since M6 shipped. Reads the same durable "reviewed at time T"
// signal runOpportunisticAiReviewIfStale's own staleness check already
// trusts, rather than inferring it from CognitiveOutput rows (a genuine
// zero-output review would leave no fresh row either way).
export async function getLastDiscoveryRunAt(storeId: string): Promise<Date | null> {
  const row = await prisma.executionLog.findFirst({
    where: {
      storeId,
      action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
      status: "SUCCESS",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}
