import { prisma } from "@/lib/prisma";
import type { AttentionItem } from "./types";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

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
//
// PRODUCTION DEFECT FIXED HERE (2026-08-19). Found by reading real data: Cubit
// & Coil had 52 ACTIVE observations, 49 of them urgent, and 47 came from this
// function — up to 23 days old, quoting J4's own chat replies back at the owner
// as though they were failures. The one thing genuinely needing attention (a
// customer waiting 31 days for a package) had no signal at all.
//
// TWO MEANINGS OF "PENDING" HAD COLLIDED:
//   1. waiting on a human decision — normal, healthy, unbounded in time
//   2. started and never finished  — a real failure worth surfacing
// Only (2) belongs here. The three corrections below separate them without
// touching a single writer, so nothing about how executions are recorded
// changes.
const AWAITING_A_HUMAN: ReadonlySet<string> = new Set<string>([
  // A chat turn that created a proposal records PENDING meaning "the owner has
  // something to review". They may take days, and that is the flow working.
  EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
  // The opportunistic review's own concurrency CLAIM row. recordGenesisExecution
  // mints a fresh executionId per call (lib/execution/genesis.ts), so this row
  // can never be paired with the completion that follows it — every successful
  // review left one behind, and each became an urgent badge. It is an internal
  // claim, never an owner-facing failure.
  EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
]);

/**
 * Whether a still-PENDING execution means "a human hasn't acted yet" rather
 * than "this broke". Exported so the distinction is directly testable.
 */
export function isAwaitingHumanDecision(action: string): boolean {
  return AWAITING_A_HUMAN.has(action);
}
export async function getStaleExecutions(storeId: string): Promise<AttentionItem[]> {
  const cutoff = new Date(Date.now() - ONE_HOUR_MS);
  // Bounded at seven days, matching getRecentNegativeOutcomes' own stated
  // reasoning directly above — "so a long-since-resolved issue naturally ages
  // out even without full lifecycle-resolution tracking". This reader had no
  // upper bound at all, so a 23-day-old row was still shouting today.
  const ageLimit = new Date(Date.now() - SEVEN_DAYS_MS);
  const pendingRows = await prisma.executionLog.findMany({
    where: {
      storeId,
      status: "PENDING",
      createdAt: { lt: cutoff, gte: ageLimit },
      action: { notIn: [...AWAITING_A_HUMAN] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (pendingRows.length === 0) return [];

  const executionIds = [...new Set(pendingRows.map((r) => r.executionId))];
  const allRowsForIds = await prisma.executionLog.findMany({
    where: { storeId, executionId: { in: executionIds } },
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

// Notice dedup (2026-08-09) — real UX principle, not a Growth-Points-only
// patch: J4 is thorough underneath (it should keep logging every real
// occurrence), but the dashboard should present ONE signal with a count,
// not N copies of the same sentence. Groups items sharing byte-identical
// message text; a group of one is returned completely unchanged (no
// count/groupedItems set), so this is a safe no-op everywhere duplication
// genuinely isn't happening. Order-preserving: a group's position is
// wherever its first (most recent, since callers already sort desc)
// member appeared.
export function dedupeAttentionItemsByMessage(items: AttentionItem[]): AttentionItem[] {
  const order: string[] = [];
  const byMessage = new Map<string, AttentionItem[]>();
  for (const item of items) {
    if (!byMessage.has(item.message)) {
      order.push(item.message);
      byMessage.set(item.message, []);
    }
    byMessage.get(item.message)!.push(item);
  }

  return order.map((message) => {
    const group = byMessage.get(message)!;
    if (group.length === 1) return group[0];
    const mostRecent = group[0]; // callers already sort desc by occurredAt
    return {
      ...mostRecent,
      count: group.length,
      groupedItems: group.map((g) => ({ id: g.id, occurredAt: g.occurredAt })),
    };
  });
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

  const sortedOutcomes = [
    ...recentFailures,
    ...staleExecutions,
    ...integrationIssues,
    ...(unsellableStoreIssue ? [unsellableStoreIssue] : []),
  ].sort((a, b) => (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0));

  return { recentOutcomes: dedupeAttentionItemsByMessage(sortedOutcomes), currentState: getStateIssues(currentStateParams) };
}
