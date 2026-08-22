import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { queryRecords, getRevenue, getAverageOpenRate } from "@/lib/businessModel/reasoning";
import { communicateFinding } from "@/lib/execution/genesisAutonomy";
import { getNewEventsForConsumer, advanceConsumerCursor } from "./businessEvents";
import { detectStorefrontReadiness } from "./storefrontReadiness";

// Phase 3 Milestone 3 (Business Intelligence Engine) — Part 3, the Insight
// Engine. Deliberately 100% deterministic — no AI call anywhere in this
// file. Every insight is a real computed number, never a model's guess
// about whether something is significant; AI enters only in the
// Recommendation Engine (generateGenesisRecommendations.ts), reasoning
// over insights this stage has already grounded in real data.
//
// Significance thresholds are real, named constants, not implicit magic
// numbers — the bar for "worth mentioning" should be visible and
// defensible, not buried.

export interface Insight {
  type: string;
  severity: "opportunity" | "urgent";
  summary: string;
  metrics: Record<string, unknown>;
}

const REVENUE_TREND_THRESHOLD = 0.15; // 15% week-over-week
const ENGAGEMENT_TREND_THRESHOLD = 0.2; // 20% change in average open rate
const OVERDUE_INVOICE_COUNT_THRESHOLD = 3;
const LOW_STOCK_COUNT_THRESHOLD = 1; // even one depleted item is worth mentioning
const CANCELLATION_TREND_RATIO = 2; // "doubled"

// TWO DIFFERENT MONIES, DELIBERATELY TOLD APART (2026-08-22).
//
// Revenue in this file is the business's OWN, and is formatted in the currency
// the business trades in. Invoice totals are not: they come from QuickBooks,
// whose own currency this pipeline never captured, so Store.currency is the
// WRONG answer to that question rather than a missing one — the same
// distinction lib/intelligence/changeDetection.ts documents at length.
//
// Formatting a QuickBooks total as pounds would convert an unknown into a
// confident value, which is worse than a dollar sign because it looks decided.
function quickbooksAmount(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function pct(ratio: number): string {
  return `${Math.round(Math.abs(ratio) * 100)}%`;
}

async function detectRevenueTrend(storeId: string): Promise<Insight | null> {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [thisWeek, lastWeek] = await Promise.all([
    getRevenue(storeId, { since: oneWeekAgo, until: now }),
    getRevenue(storeId, { since: twoWeeksAgo, until: oneWeekAgo }),
  ]);

  // The business's own currency. Read here rather than threaded through every
  // detector: this is the only one of them that states a figure belonging to
  // the store itself.
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { currency: true } });
  const storeCurrency = store?.currency ?? "USD";

  if (lastWeek === 0) return null; // no baseline — avoid a meaningless "infinite % change"
  const change = (thisWeek - lastWeek) / lastWeek;
  if (Math.abs(change) < REVENUE_TREND_THRESHOLD) return null;

  const direction = change > 0 ? "increased" : "decreased";
  return {
    type: change > 0 ? "revenue.increased" : "revenue.decreased",
    severity: change > 0 ? "opportunity" : "urgent",
    summary: `Revenue ${direction} ${pct(change)} this week (${formatMoney(thisWeek, storeCurrency)} vs ${formatMoney(lastWeek, storeCurrency)} last week)`,
    metrics: { thisWeekInCents: thisWeek, lastWeekInCents: lastWeek, change },
  };
}

async function detectEngagementTrend(storeId: string): Promise<Insight | null> {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

  const [recent, baseline] = await Promise.all([
    getAverageOpenRate(storeId, { since: oneWeekAgo, until: now }),
    getAverageOpenRate(storeId, { since: fourWeeksAgo, until: oneWeekAgo }),
  ]);

  if (recent === null || baseline === null || baseline === 0) return null;
  const change = (recent - baseline) / baseline;
  if (Math.abs(change) < ENGAGEMENT_TREND_THRESHOLD) return null;

  const direction = change > 0 ? "improved" : "dropped";
  return {
    type: change > 0 ? "engagement.improved" : "engagement.declined",
    severity: change > 0 ? "opportunity" : "urgent",
    summary: `Email open rate ${direction} ${pct(change)} this week (${pct(recent)} vs a ${pct(baseline)} recent average)`,
    metrics: { recentOpenRate: recent, baselineOpenRate: baseline, change },
  };
}

async function detectOverdueInvoiceCluster(storeId: string): Promise<Insight | null> {
  const documents = await queryRecords(storeId, "document");
  const now = Date.now();
  const overdue = documents.filter(
    (doc) =>
      doc.data.type === "invoice" &&
      doc.data.status !== "paid" &&
      doc.data.dueAt !== null &&
      new Date(doc.data.dueAt).getTime() < now
  );
  if (overdue.length < OVERDUE_INVOICE_COUNT_THRESHOLD) return null;

  const totalOwed = overdue.reduce((sum, doc) => sum + (doc.data.amountInCents ?? 0), 0);
  return {
    type: "invoices.overdue",
    severity: "urgent",
    summary: `${overdue.length} invoices are now overdue, totaling ${quickbooksAmount(totalOwed)}`,
    metrics: { count: overdue.length, totalOwedInCents: totalOwed },
  };
}

async function detectLowStockCluster(storeId: string): Promise<Insight | null> {
  const items = await queryRecords(storeId, "item");
  const depleted = items.filter((i) => i.data.quantityAvailable !== null && i.data.quantityAvailable <= 0);
  if (depleted.length < LOW_STOCK_COUNT_THRESHOLD) return null;

  return {
    type: "inventory.depleted",
    severity: "urgent",
    summary:
      depleted.length === 1
        ? `${depleted[0].data.name} is out of stock`
        : `${depleted.length} items are out of stock`,
    metrics: { count: depleted.length, items: depleted.map((i) => i.data.name) },
  };
}

// Appointment cancellations need real event *history* to trend, not just
// current record snapshots — a BusinessRecord's status only tells you
// "cancelled or not right now," never *when* it changed. This is the one
// insight genuinely reading BusinessEvent, not BusinessRecord/reasoning.ts.
async function detectCancellationTrend(storeId: string): Promise<Insight | null> {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [recentCount, priorCount] = await Promise.all([
    prisma.businessEvent.count({
      where: { storeId, eventType: "appointment.cancelled", occurredAt: { gte: oneWeekAgo, lt: now } },
    }),
    prisma.businessEvent.count({
      where: { storeId, eventType: "appointment.cancelled", occurredAt: { gte: twoWeeksAgo, lt: oneWeekAgo } },
    }),
  ]);

  if (priorCount === 0 || recentCount < priorCount * CANCELLATION_TREND_RATIO) return null;

  return {
    type: "appointments.cancellations_up",
    severity: "urgent",
    summary: `Appointment cancellations ${recentCount >= priorCount * 2 ? "doubled" : "rose sharply"} this week (${recentCount} vs ${priorCount} the week before)`,
    metrics: { recentCount, priorCount },
  };
}

// Phase 1 (Business Event Pipeline) — this consumer's identity in
// BusinessEventCursor, and the parallel-run comparison below. See
// PHASE1_DESIGN.md section 7 item 2: proving the cursor mechanism against
// real production data before it's trusted to replace processedAt.
export const INSIGHT_ENGINE_CONSUMER = "insight-engine";

// Purely observational — never feeds computeInsights' real logic. Reads the
// same "new since last pass" event set two ways (the existing processedAt
// flag vs. the new sequence-based cursor) and reports a mismatch through
// Sentry rather than silently trusting either. Must be called only after
// the real processedAt-based logic has already run to completion — see the
// independence invariant in PHASE1_DESIGN.md section 7 item 2: a bug here
// must never be able to change what computeInsights treats as real.
async function runParallelCursorCheck(storeId: string, processedAtEventIds: string[]): Promise<void> {
  const cursorEvents = await getNewEventsForConsumer(storeId, INSIGHT_ENGINE_CONSUMER);

  const processedSet = new Set(processedAtEventIds);
  const cursorSet = new Set(cursorEvents.map((event) => event.id));
  const matches =
    processedSet.size === cursorSet.size && [...processedSet].every((id) => cursorSet.has(id));

  if (!matches) {
    Sentry.captureMessage(
      `[business-event-pipeline] insight-engine cursor set diverged from processedAt set for store ${storeId} ` +
        `(processedAt=${processedSet.size}, cursor=${cursorSet.size})`,
      "warning"
    );
  }

  if (cursorEvents.length > 0) {
    await advanceConsumerCursor(storeId, INSIGHT_ENGINE_CONSUMER, cursorEvents[cursorEvents.length - 1].sequence);
  }
}

// The full Insight Engine pass for one store — called by the scheduler
// once per store's sync cycle, after Change Detection. Marks all
// currently-unprocessed BusinessEvent rows as considered regardless of
// whether they individually produced an insight, so the next pass only
// looks at genuinely new activity.
export async function computeInsights(storeId: string): Promise<Insight[]> {
  const pendingEvents = await prisma.businessEvent.findMany({
    where: { storeId, processedAt: null },
    select: { id: true },
  });

  const [revenue, engagement, overdue, lowStock, cancellations, storefront] = await Promise.all([
    detectRevenueTrend(storeId),
    detectEngagementTrend(storeId),
    detectOverdueInvoiceCluster(storeId),
    detectLowStockCluster(storeId),
    detectCancellationTrend(storeId),
    // M4 (2026-08-18) — the first detector that reads only first-party data.
    // The four above it need a connector and the fifth needs two weeks of
    // sales, which meant a pre-revenue store ran a working engine and heard
    // nothing. This adds no new capability: evaluateStorefront already existed
    // and is unmodified, it simply had one caller (the owner asking in chat).
    detectStorefrontReadiness(storeId),
  ]);

  await prisma.businessEvent.updateMany({
    where: { storeId, processedAt: null },
    data: { processedAt: new Date() },
  });

  const computed = [revenue, engagement, overdue, lowStock, cancellations, storefront].filter(
    (insight): insight is Insight => insight !== null
  );

  // Phase 3 Milestone 6 (J4 Cognitive Layer) — durability, for free, with
  // zero change to detection logic above. Insights were never persisted
  // before this — computed fresh every pass, visible nowhere durable — so
  // getEntityHistory() (M5) could never show "here's what Genesis has
  // actually noticed about this record," only its downstream observations/
  // recommendations.
  //
  // J4 Foundation Phase 1 (Execute Hardening) — routes through
  // communicateFinding() instead of a raw createMany, so each insight gets
  // the same authorization check and honest ExecutionLog record as every
  // other mechanic, closing the exact bypass this phase exists to close.
  // Sequential, not Promise.all — these are real, independently-recordable
  // acts, not a batch; a failure on one must not obscure whether the others
  // succeeded.
  for (const insight of computed) {
    await communicateFinding(storeId, {
      kind: "insight",
      summary: insight.summary,
      data: insight.metrics,
      priority: insight.severity === "urgent" ? "high" : "medium",
      // J4 Foundation Phase 2 (Learn) — insight.type ("revenue.decreased",
      // etc.) is the stable identity a recurring insight needs to be
      // recognized across weeks; topicKey is the exact existing field this
      // codebase already uses for "the underlying pattern, independent of
      // wording" (ApprovalRequest/CognitiveOutput both already lean on it
      // for recommendation/opportunity rows) — reused here rather than
      // inventing a second identity concept for the same purpose.
      topicKey: insight.type,
    });
  }

  // Phase 1 (Business Event Pipeline) — parallel run only, after the real
  // processedAt-based logic above has already run to completion. See the
  // independence invariant in PHASE1_DESIGN.md section 7 item 2.
  await runParallelCursorCheck(
    storeId,
    pendingEvents.map((event) => event.id)
  );

  return computed;
}
