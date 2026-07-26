import { prisma } from "@/lib/prisma";
import type {
  ActivityItem,
  AttentionItem,
  CustomerSummary,
  InventorySnapshot,
  OrderSummary,
  Recommendation,
} from "./types";

export interface RecommendationContext {
  storeId: string; // new (PH-07 Layer 3) — required for genesisProducer's own query
  storeName: string; // new — prompt framing, unused by ruleBasedProducer
  store: { published: boolean };
  products: { name: string; description: string | null; priceInCents: number; active: boolean }[]; // upgraded from {active}[] for Layer 3
  stripeIntegration: { status: string } | null;
  attentionItems: AttentionItem[]; // reused from needsAttention.ts, no duplicate queries
  orderSummary: OrderSummary; // reused from whatHappened.ts
  customerSummaries: CustomerSummary[]; // new
  inventorySnapshot: InventorySnapshot | null; // new
  recentActivity: ActivityItem[]; // new
  // Minimal subset of Store.blueprint relevant to grounding a recommendation
  // in the store's actual brand voice — see generateGenesisRecommendations.ts
  // for why this isn't the full Blueprint type.
  blueprint: {
    brandPersonality: string;
    brandVoiceAndTone: string;
    targetAudience: string;
    uniqueSellingProposition: string;
    heroHeadline: string;
    aboutUs: string;
  } | null;
}

// Each producer only ever sees RecommendationContext — never another
// producer's output. getRecommendations() alone owns merging/dedup/
// sorting. This is what lets a future Genesis-generated producer (PH-07)
// plug in as a new array entry rather than needing to know what the
// rule-based one already said.
export interface RecommendationProducer {
  name: string;
  produce(ctx: RecommendationContext): Promise<Recommendation[]>;
}

// The canonical text for every rule-based recommendation, keyed by its
// stable id. ruleBasedProducer reads from this map instead of duplicating
// literals, and PH-07's explanation service resolves a recommendationId to
// its message from this same map — so the two can never drift apart.
// Phrased as a partner's observation, not a task-list directive — this is
// what a merchant sees framed as "Genesis noticed...", not an admin queue.
export const RECOMMENDATION_MESSAGES: Record<string, string> = {
  "recommend.publish_store":
    "Your store is ready to go, but it isn't published yet — customers can't find it until it's live.",
  "recommend.add_first_product": "Once your first product is up, Genesis can help you start selling.",
  "recommend.connect_stripe": "Connecting Stripe means payments land directly in your own account.",
  "recommend.finish_stripe_connect": "Stripe setup got interrupted partway through — worth finishing when you get a chance.",
  "recommend.review_recent_issues": "A couple of recent hiccups are worth a second look.",
  "recommend.no_recent_orders":
    "It's been quiet lately — no orders in the last 30 days. A promotion or a fresh look at your storefront might help.",
};

export const ruleBasedProducer: RecommendationProducer = {
  name: "rules",
  async produce(ctx) {
    const recs: Recommendation[] = [];
    const activeProducts = ctx.products.filter((p) => p.active).length;

    if (!ctx.store.published && activeProducts > 0) {
      recs.push({
        id: "recommend.publish_store",
        priority: "high",
        message: RECOMMENDATION_MESSAGES["recommend.publish_store"],
        actionLabel: "Publish your store",
        actionHref: "/dashboard/website",
        source: "rules",
      });
    }

    if (activeProducts === 0) {
      recs.push({
        id: "recommend.add_first_product",
        priority: "high",
        message: RECOMMENDATION_MESSAGES["recommend.add_first_product"],
        actionLabel: "Add a product",
        actionHref: "/dashboard/products",
        source: "rules",
      });
    }

    if (!ctx.stripeIntegration || ctx.stripeIntegration.status === "DISCONNECTED") {
      recs.push({
        id: "recommend.connect_stripe",
        priority: "high",
        message: RECOMMENDATION_MESSAGES["recommend.connect_stripe"],
        actionLabel: "Connect Stripe",
        actionHref: "/dashboard/payments",
        source: "rules",
      });
    }

    // Today's only PENDING-producing executable is Stripe connect, so any
    // stale-pending attention item is safely assumed to be about it.
    if (ctx.attentionItems.some((item) => item.kind === "stale-pending")) {
      recs.push({
        id: "recommend.finish_stripe_connect",
        priority: "medium",
        message: RECOMMENDATION_MESSAGES["recommend.finish_stripe_connect"],
        actionLabel: "Finish connecting Stripe",
        actionHref: "/dashboard/payments",
        source: "rules",
      });
    }

    if (ctx.attentionItems.some((item) => item.kind === "recent-failure" || item.kind === "integration-issue")) {
      recs.push({
        id: "recommend.review_recent_issues",
        priority: "medium",
        message: RECOMMENDATION_MESSAGES["recommend.review_recent_issues"],
        actionLabel: "Review issues",
        actionHref: "/dashboard#attention",
        source: "rules",
      });
    }

    if (ctx.store.published && activeProducts > 0 && ctx.orderSummary.orderCount === 0) {
      recs.push({
        id: "recommend.no_recent_orders",
        priority: "medium",
        message: RECOMMENDATION_MESSAGES["recommend.no_recent_orders"],
        actionLabel: "Review your storefront",
        actionHref: "/dashboard/products",
        source: "rules",
      });
    }

    return recs;
  },
};

// PH-07 Layer 3 — a cheap indexed DB read, not an AI call, so it's safe to
// run on every getRecommendations() invocation exactly like
// ruleBasedProducer. Actual generation happens separately, via an explicit
// "Ask Genesis to Review My Business" action — see
// generateGenesisRecommendations.ts. This producer only ever reads the
// cached result of that action.
export const genesisProducer: RecommendationProducer = {
  name: "genesis",
  async produce(ctx) {
    const [rows, approvalRequests] = await Promise.all([
      prisma.generatedRecommendation.findMany({
        where: { storeId: ctx.storeId },
        orderBy: { generatedAt: "desc" },
      }),
      // PH-07 Layer 4 — a recommendation with an attached ApprovalRequest
      // (pending, executed, or rejected) surfaces in the Awaiting Approval
      // section instead, not here, so the same suggestion never appears in
      // two places at once. In practice resolved ones are deleted at
      // decision time (see ai-actions.ts) — this exclusion mainly covers
      // the brief window one is still PENDING_APPROVAL.
      prisma.approvalRequest.findMany({
        where: { storeId: ctx.storeId, recommendationId: { not: null } },
        select: { recommendationId: true },
      }),
    ]);
    const recommendationIdsWithApproval = new Set(approvalRequests.map((a) => a.recommendationId));

    return rows
      .filter((row) => !recommendationIdsWithApproval.has(row.id))
      .map((row) => ({
        // Real DB id — trivially stable, satisfies the future dismiss/track
        // need noted (not built) since PH-05.
        id: row.id,
        priority: row.priority as Recommendation["priority"],
        message: row.message,
        actionLabel: row.actionLabel,
        actionHref: row.actionHref,
        source: "genesis",
      }));
  },
};

const PRIORITY_ORDER: Record<Recommendation["priority"], number> = { high: 0, medium: 1, low: 2 };

export async function getRecommendations(
  ctx: RecommendationContext,
  producers: RecommendationProducer[] = [ruleBasedProducer, genesisProducer]
): Promise<Recommendation[]> {
  const results = await Promise.all(producers.map((p) => p.produce(ctx)));

  const seen = new Set<string>();
  const merged: Recommendation[] = [];
  for (const rec of results.flat()) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    merged.push(rec);
  }

  return merged.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}
