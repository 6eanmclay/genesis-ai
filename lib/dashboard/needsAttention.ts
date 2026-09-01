import { prisma } from "@/lib/prisma";
import type { AttentionItem } from "./types";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { connectionHealthOf } from "@/lib/integrations/connectionHealth";
import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { getOperationalIssues } from "./operationalIssues";

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

/**
 * Connections that need the owner to do something.
 *
 * READS connectionHealthOf RATHER THAN DECIDING FOR ITSELF (2026-08-25). This
 * used to ask `status in (FAILED, NEEDS_ATTENTION)`, which is the last
 * verification result and is never re-run on a schedule — so QuickBooks, with 14
 * consecutive sync failures and no sync since 2026-08-01, read CONNECTED and
 * raised nothing for 24 days. It then briefly asked its own separate question
 * about syncFailureCount, which fixed the miss but created a second definition
 * of connection health sitting beside the screen's.
 *
 * Now there is one definition and this is a consumer of it, so what the owner is
 * shown on the Connections screen and what J4 raises here cannot disagree.
 *
 * `raisesAttention` is the whole filter. Notably `connected_no_data` does NOT
 * raise: a provider returning nothing is an ordinary state, not a fault.
 */
/**
 * Where an owner can actually fix this connection.
 *
 * Every integration issue used to link to /dashboard/payments. That is right for
 * the two payment rails and wrong for everything else — and the two connections
 * currently telling owners to reconnect, QuickBooks and Google Calendar, are
 * both managed on /dashboard/connections. So the system said "it needs
 * reconnecting" and sent them to a screen with nothing to click.
 *
 * Derived from the catalog rather than a second hand-kept list: a provider is
 * managed on the Connections screen exactly when it has a catalog entry.
 */
function whereToFix(provider: string): string {
  // Stripe and PayPal are deliberately NOT in the connector catalog — they are
  // payment rails with their own screen, which is where reconnecting them
  // actually happens.
  if (provider === "STRIPE" || provider === "PAYPAL") return "/dashboard/payments";
  if (CONNECTOR_CATALOG.some((e) => e.provider === provider)) return "/dashboard/connections";
  // PRINTFUL and EASYPOST reach here: connected during onboarding, with no
  // dashboard screen that manages them at all. Connections is the least wrong
  // destination, and that gap is recorded rather than papered over — inventing
  // a link to a screen that does not exist would be worse than an imperfect one.
  return "/dashboard/connections";
}

export async function getIntegrationIssues(storeId: string): Promise<AttentionItem[]> {
  const rows = await prisma.storeIntegration.findMany({ where: { storeId } });
  if (rows.length === 0) return [];

  // One grouped count rather than a query per connection.
  const produced = await prisma.businessRecord.groupBy({
    by: ["sourceProvider"],
    where: { storeId },
    _count: { _all: true },
  });
  const recordsBySource = new Map(produced.map((p) => [p.sourceProvider, p._count._all]));

  const items: AttentionItem[] = [];
  for (const row of rows) {
    const health = connectionHealthOf({
      // Availability is a question about the deployment, not about this store's
      // row. A connection that already exists was connectable when it was made,
      // so it is judged on its own evidence.
      available: true,
      row,
      recordsProduced: recordsBySource.get(row.provider.toLowerCase()) ?? 0,
    });
    if (!health.raisesAttention) continue;

    // A verification failure IS the provider's sentence — it names the account
    // and what is wrong with it, and nothing this codebase could write would be
    // more useful. Everything else is phrased by connectionHealthOf and only
    // needs the provider's name in front of it.
    const message =
      health.state === "failed"
        ? (health.providerError ?? `${row.provider} needs attention`)
        : `${row.provider} ${health.detail}`;

    items.push({
      id: row.id,
      kind: "integration-issue" as const,
      severity: health.state === "failed" ? ("FAILED" as const) : ("WARNING" as const),
      message,
      // A stale connection has no meaningful lastVerifiedAt — nothing verified
      // it. The last time it actually worked is the honest timestamp.
      occurredAt: health.state === "failed" ? row.lastVerifiedAt : (row.lastSyncedAt ?? row.lastVerifiedAt),
      actionHref: whereToFix(row.provider),
    });
  }
  return items;
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
  const [recentFailures, staleExecutions, integrationIssues, operationalIssues] = await Promise.all([
    getRecentNegativeOutcomes(storeId),
    getStaleExecutions(storeId),
    getIntegrationIssues(storeId),
    // The machinery failing at this business (2026-08-31). Folded into the same
    // list as everything else rather than given its own zone: an owner should
    // not have to learn a second place to look for bad news, and a dead
    // notification job is the same kind of fact as a broken connection.
    getOperationalIssues(storeId),
  ]);

  const unsellableStoreIssue = getUnsellableStoreIssue(currentStateParams);

  const sortedOutcomes = [
    ...recentFailures,
    ...staleExecutions,
    ...integrationIssues,
    ...operationalIssues,
    ...(unsellableStoreIssue ? [unsellableStoreIssue] : []),
  ].sort((a, b) => (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0));

  return { recentOutcomes: dedupeAttentionItemsByMessage(sortedOutcomes), currentState: getStateIssues(currentStateParams) };
}
