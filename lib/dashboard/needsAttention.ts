import { prisma } from "@/lib/prisma";
import type { AttentionItem } from "./types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

// FAILED/WARNING ExecutionLog rows from the last week — recent negative
// outcomes, time-windowed so a long-since-resolved issue naturally ages out
// even without full lifecycle-resolution tracking.
export async function getRecentNegativeOutcomes(storeId: string): Promise<AttentionItem[]> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const rows = await prisma.executionLog.findMany({
    where: { storeId, status: { in: ["FAILED", "WARNING"] }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return rows.map((row) => ({
    id: row.id,
    kind: "recent-failure" as const,
    severity: row.status as "FAILED" | "WARNING",
    message: row.message,
    occurredAt: row.createdAt,
  }));
}

// PENDING rows older than an hour whose executionId has no newer row —
// i.e. genuinely abandoned (an OAuth handoff nobody finished), not just a
// PENDING row that was already resolved to SUCCESS/FAILED under the same
// executionId (append-only design — resolution is a new row, never an
// update to this one).
export async function getStaleExecutions(storeId: string): Promise<AttentionItem[]> {
  const cutoff = new Date(Date.now() - ONE_HOUR_MS);
  const pendingRows = await prisma.executionLog.findMany({
    where: { storeId, status: "PENDING", createdAt: { lt: cutoff } },
    orderBy: { createdAt: "desc" },
  });
  if (pendingRows.length === 0) return [];

  const executionIds = [...new Set(pendingRows.map((r) => r.executionId))];
  const allRowsForIds = await prisma.executionLog.findMany({
    where: { executionId: { in: executionIds } },
    orderBy: { createdAt: "desc" },
  });
  const latestIdByExecutionId = new Map<string, string>();
  for (const row of allRowsForIds) {
    if (!latestIdByExecutionId.has(row.executionId)) {
      latestIdByExecutionId.set(row.executionId, row.id); // first seen per id = most recent (desc order)
    }
  }

  return pendingRows
    .filter((row) => latestIdByExecutionId.get(row.executionId) === row.id)
    .map((row) => ({
      id: row.id,
      kind: "stale-pending" as const,
      severity: "WARNING" as const,
      message: `${row.message} — still pending since ${row.createdAt.toLocaleDateString()}`,
      occurredAt: row.createdAt,
    }));
}

export async function getIntegrationIssues(storeId: string): Promise<AttentionItem[]> {
  const rows = await prisma.storeIntegration.findMany({
    where: { storeId, status: { in: ["NEEDS_ATTENTION", "FAILED"] } },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: "integration-issue" as const,
    severity: row.status === "FAILED" ? ("FAILED" as const) : ("WARNING" as const),
    message: row.lastError ?? `${row.provider} needs attention`,
    occurredAt: row.lastVerifiedAt,
    actionHref: "/dashboard/payments",
  }));
}

// The one definition of "does this store have a working payment method" —
// used both by getStateIssues below and directly by BusinessJourney.tsx, so
// the two never disagree. Previously this check (inlined in getStateIssues)
// looked at Stripe only, meaning a store that connected PayPal but never
// Stripe was told forever that no payment method was connected — a real
// bug, not a hypothetical. Fixed here at the shared source rather than
// re-derived per caller.
export function isPaymentConnected(params: {
  stripeIntegration: { status: string } | null;
  paypalIntegration: { status: string } | null;
}): boolean {
  return params.stripeIntegration?.status === "CONNECTED" || params.paypalIntegration?.status === "CONNECTED";
}

// Pure — reuses store/products/stripeIntegration/paypalIntegration the
// caller already fetched for other sections, no new queries. Current
// bad/incomplete state, not a past event, so occurredAt is always null.
export function getStateIssues(params: {
  store: { published: boolean };
  products: { active: boolean }[];
  stripeIntegration: { status: string } | null;
  paypalIntegration: { status: string } | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (!params.store.published) {
    items.push({
      id: "state.unpublished",
      kind: "state-issue",
      severity: "WARNING",
      message: "Your store isn't published yet — customers can't see it.",
      occurredAt: null,
      actionHref: "/dashboard/website",
    });
  }

  if (!params.products.some((p) => p.active)) {
    items.push({
      id: "state.no_products",
      kind: "state-issue",
      severity: "WARNING",
      message: "You have no active products.",
      occurredAt: null,
      actionHref: "/dashboard/products",
    });
  }

  if (!isPaymentConnected(params)) {
    items.push({
      id: "state.no_payments",
      kind: "state-issue",
      severity: "WARNING",
      message: "No payment method is connected.",
      occurredAt: null,
      actionHref: "/dashboard/payments",
    });
  }

  return items;
}

// Phase 1 Beta Excellence #4 — a genuinely urgent condition (real customers
// hitting a dead end right now), not routine incomplete setup like
// state.no_payments above — so this belongs in the Red "Needs your
// attention" panel via recentOutcomes, not just Business Journey's calm
// checklist. No separate schema/query: every input here is already fetched
// for getStateIssues by every caller today.
function getUnsellableStoreIssue(params: {
  store: { published: boolean };
  products: { active: boolean }[];
  stripeIntegration: { status: string } | null;
  paypalIntegration: { status: string } | null;
}): AttentionItem | null {
  if (params.store.published && params.products.some((p) => p.active) && !isPaymentConnected(params)) {
    return {
      id: "state.unsellable",
      kind: "unsellable-store",
      severity: "FAILED",
      message:
        "Customers can't complete a purchase — your store is live with products for sale, but no payment method is connected.",
      occurredAt: null,
      actionHref: "/dashboard/payments",
    };
  }
  return null;
}

// Combines all four sources into the two UI groups AttentionPanel renders
// — never blended, per the design: "Recent issues" (timestamped, things
// that happened) vs. "Needs fixing now" (ongoing conditions).
export async function getAttentionItems(
  storeId: string,
  currentStateParams: Parameters<typeof getStateIssues>[0]
): Promise<{ recentOutcomes: AttentionItem[]; currentState: AttentionItem[] }> {
  const [recentFailures, staleExecutions, integrationIssues] = await Promise.all([
    getRecentNegativeOutcomes(storeId),
    getStaleExecutions(storeId),
    getIntegrationIssues(storeId),
  ]);

  const unsellableStoreIssue = getUnsellableStoreIssue(currentStateParams);

  const recentOutcomes = [
    ...recentFailures,
    ...staleExecutions,
    ...integrationIssues,
    ...(unsellableStoreIssue ? [unsellableStoreIssue] : []),
  ].sort((a, b) => (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0));

  return { recentOutcomes, currentState: getStateIssues(currentStateParams) };
}
