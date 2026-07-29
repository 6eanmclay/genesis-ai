import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrderSummary, getRecentActivity } from "./whatHappened";
import { getCustomerSummaries } from "./customers";
import { getInventorySnapshot } from "./inventory";
import { getRecentGenesisHistory } from "./genesisLearning";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import { GENESIS_ACTIONS, type BlueprintContextSubset } from "@/lib/execution/genesisActions";
import { tryExecuteAutonomousAction } from "@/lib/execution/genesisAutonomy";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";

// Real section routes, not the single-page anchors this used to be (see
// ARCHITECTURE.md / the nav plan) — "/dashboard#attention" is the one
// exception, since the Attention Panel still lives directly on Home.
// "/dashboard/website" is where publish/unpublish and storefront visibility
// live (moved off Settings during the Home IA cleanup); "/dashboard/settings"
// is left for genuine store-identity recommendations only.
const GENESIS_ACTION_HREFS = [
  "/dashboard/website",
  "/dashboard/settings",
  "/dashboard/products",
  "/dashboard/payments",
  "/dashboard#attention",
] as const;

// PH-07 Layer 4 — a recommendation may optionally propose a concrete,
// ready-to-apply action from the GENESIS_ACTIONS registry. Discriminated
// union so a third registered action type is one more member here, not a
// schema rewrite — see lib/execution/genesisActions.ts.
const ProposedActionSchema = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("update_seo"),
    input: z.object({ seoTitle: z.string(), seoMetaDescription: z.string() }),
  }),
  z.object({
    actionType: z.literal("update_hero"),
    input: z.object({ heroHeadline: z.string(), heroSubheadline: z.string() }),
  }),
]);

const GenesisRecommendationSchema = z.object({
  priority: z.enum(["high", "medium", "low"]),
  message: z.string(),
  actionLabel: z.string(),
  actionHref: z.enum(GENESIS_ACTION_HREFS),
  // Phase 4 — a short, stable slug identifying the underlying observation
  // (e.g. "declining_repeat_purchases"), so a future review can recognize
  // "this is the same finding as last time" even though the free-text
  // message itself will likely be worded differently each time. This is
  // the only thing that makes AI-generated opportunity dedup possible —
  // rule-based observations already have stable ids for free.
  topicKey: z.string(),
  proposedAction: ProposedActionSchema.nullable(),
});

const GenesisRecommendationsOutputSchema = z.object({
  recommendations: z.array(GenesisRecommendationSchema).max(4),
});

const SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant reviewing this specific business's real, current data — not offering generic advice a merchant could get from any business blog.

You are shown: the store's brand identity and homepage copy, its product catalog, a recent order/revenue summary, customer history, current inventory (active/inactive product counts), and a log of recent account activity.

A separate deterministic system on this dashboard already flags: an unpublished store with ready products, zero active products, no connected payment method, a stale/incomplete payment connection attempt, recent failures or warnings, and zero orders in the last 30 days. Do not repeat any of these — assume the merchant already sees them elsewhere. Your job is the insight a fixed rule can't produce: something specific to this business's actual products, customers, or activity.

Prioritize impact over count. Identify only the highest-impact opportunities — typically one to three. Only include a fourth if it is genuinely a distinct, strong opportunity, never padding to reach a number. If the supplied data doesn't support a specific, useful recommendation, return fewer, including zero — never invent generic advice to fill space.

Ground every recommendation in the data you were actually given. Never invent a customer complaint, review, statistic, or trend that isn't in the supplied data. State assumptions as assumptions, not facts, and frame advice as guidance ("consider...", "this may be worth...") rather than certainty — especially anything about what customers want or will do.

Each recommendation's message must be self-contained: state both what to do and why it matters, in 1-2 sentences — unlike this dashboard's rule-based recommendations, there is no separate "explain" step for these.

Also assign each recommendation a topicKey: a short, stable, lowercase_snake_case slug identifying the underlying finding (e.g. "declining_repeat_purchases", "seo_title_too_generic"), independent of the exact wording of message. A future review of this same business should reuse the identical topicKey if it's genuinely the same underlying finding, even if you phrase the message differently next time — this is how the dashboard recognizes "you already told me this" versus a genuinely new observation.

Write like a business partner sharing an observation, not an admin system issuing a task. Favor phrasing like "Genesis noticed..." or "Worth considering..." over bare imperatives — the merchant should feel like something was actually noticed about their business, not handed a checklist item. This is tone only — every requirement above (grounded in real data, self-contained, no invented facts) still applies exactly the same.

You are also shown, under recentGenesisHistory, up to 5 of your own recent proposals from the last 60 days and, where applicable, what happened afterward. An entry with decision "executed" includes a plain before/after order comparison for the 14 days after that change — treat this strictly as correlated timing, never as proof that specific change caused the difference, especially when the entry's outcome text mentions other concurrent changes. An executed entry's decisionMode tells you HOW it was decided: "human" means the owner personally reviewed and approved it; "autonomous" means you handled it yourself under authority the owner had previously granted for that action type, without asking first — this is informational context about how confident a prior review's judgment turned out to be in practice, nothing more; it never changes what you are currently allowed to do, and you have no ability to grant yourself more authority by citing past outcomes. An entry with decision "rejected" means the owner declined that specific proposal — this does not necessarily mean the underlying issue is wrong; it may have been the wording, timing, or exact implementation rather than the idea itself. Do not simply repeat a recently rejected proposal unchanged. You may raise the same underlying topicKey again if the current data gives you a genuinely new or stronger reason to — if you do, acknowledge that a similar idea was recently declined rather than presenting it as first-time news.

actionHref must be exactly one of: "/dashboard#attention" (needs-attention items), "/dashboard/website" (publishing/unpublishing, storefront visibility), "/dashboard/settings" (store name/description), "/dashboard/payments" (Stripe/PayPal), "/dashboard/products" (the product catalog) — whichever dashboard section the recommendation relates to.

If, and only if, a recommendation maps directly onto one of these two actions the merchant could approve exactly as you propose it, attach a proposedAction with the precise, ready-to-apply new values:
- "update_seo": rewrite the store's SEO title and meta description. input: { seoTitle: string, seoMetaDescription: string }.
- "update_hero": rewrite the homepage hero headline and subheadline. input: { heroHeadline: string, heroSubheadline: string }.
Most recommendations should NOT include a proposedAction — only attach one when you can specify the exact new copy, not just general advice to "improve your SEO" or "update your hero." Leave proposedAction null otherwise.`;

// The one place that both queries the store's real business data and calls
// Claude — mirrors explainRecommendation.ts's role as the isolated
// AI-calling service for Layer 2. Deliberately does its own fetch rather
// than receiving RecommendationContext: this runs from an explicit
// "Ask Genesis to Review My Business" action, not from a page render.
// Return value added for Phase 4 — the caller (runOpportunisticAiReviewIfStale
// in genesisObservations.ts) uses it to mirror high-priority findings into
// GenesisObservation rows. Deliberately returned rather than this file
// importing genesisObservations.ts itself, which would create a circular
// import (that file already imports this one) — the recommendation engine
// stays unaware the Observation model even exists.
export interface GeneratedRecommendationSummary {
  topicKey: string;
  priority: "high" | "medium" | "low";
  message: string;
  actionHref: string;
}

export async function generateGenesisRecommendations(params: {
  storeId: string;
  userId: string;
}): Promise<GeneratedRecommendationSummary[]> {
  const { storeId, userId } = params;

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new Error("Store not found");
  }

  const products = await prisma.product.findMany({
    where: { storeId },
    orderBy: { position: "asc" },
    select: { name: true, description: true, priceInCents: true, active: true },
  });

  const [orderSummary, customerSummaries, recentActivity, recentGenesisHistory] = await Promise.all([
    getOrderSummary(storeId, { includeRevenue: true }),
    getCustomerSummaries(storeId, { includeRevenue: true, limit: 10 }),
    getRecentActivity(storeId, 10),
    getRecentGenesisHistory(storeId),
  ]);
  const inventorySnapshot = getInventorySnapshot(products);
  const blueprint = store.blueprint as BlueprintContextSubset | null;

  const contextForPrompt = {
    storeName: store.name,
    published: store.published,
    brandPersonality: blueprint?.brandIdentity?.brandPersonality ?? null,
    brandVoiceAndTone: blueprint?.brandIdentity?.brandVoiceAndTone ?? null,
    targetAudience: blueprint?.brandIdentity?.targetAudience ?? null,
    uniqueSellingProposition: blueprint?.brandIdentity?.uniqueSellingProposition ?? null,
    heroHeadline: blueprint?.homepageContent?.heroHeadline ?? null,
    heroSubheadline: blueprint?.homepageContent?.heroSubheadline ?? null,
    aboutUs: blueprint?.homepageContent?.aboutUs ?? null,
    seoTitle: blueprint?.marketingAssets?.seoTitle ?? null,
    seoMetaDescription: blueprint?.marketingAssets?.seoMetaDescription ?? null,
    products: products.map((p) => ({
      name: p.name,
      description: p.description,
      price: p.priceInCents / 100,
      active: p.active,
    })),
    orderSummary,
    customers: customerSummaries.map((c) => ({
      orderCount: c.orderCount,
      totalSpent: c.totalSpentInCents !== null ? c.totalSpentInCents / 100 : null,
      lastOrderAt: c.lastOrderAt,
    })),
    inventorySnapshot,
    recentActivity: recentActivity.map((a) => ({
      action: a.action,
      status: a.status,
      message: a.message,
      createdAt: a.createdAt,
    })),
    // Phase 5 — bounded (<=5, <=60 days), deterministic learning context, see
    // lib/dashboard/genesisLearning.ts and the prompt instructions above.
    recentGenesisHistory,
  };

  const outcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `This business's current data (JSON):\n${JSON.stringify(contextForPrompt, null, 2)}\n\nReview this business and identify the highest-impact opportunities.`,
      },
    ],
    output_config: {
      effort: "medium",
      format: zodOutputFormat(GenesisRecommendationsOutputSchema),
    },
  });

  if (!outcome.ok) {
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
      status: "FAILED",
      verified: false,
      message: `Provider error (${outcome.kind}): ${outcome.message}`,
      retryable: outcome.retryable,
      userId,
      storeId,
      metadata: { providerErrorKind: outcome.kind, providerStatus: outcome.status },
    });
    throw new Error(genesisModelFailureMessage(outcome.kind));
  }

  const result = outcome.message.parsed_output;
  if (!result) {
    await recordGenesisExecution({
      action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
      status: "FAILED",
      verified: false,
      message: "Genesis couldn't generate recommendations",
      retryable: true,
      userId,
      storeId,
      metadata: {},
    });
    throw new Error("Genesis couldn't generate recommendations");
  }

  // Individual creates (not createMany) inside the transaction — each
  // returns its row, so a recommendation carrying a proposedAction can
  // reference its own GeneratedRecommendation.id below.
  const [, ...createdRecommendations] = await prisma.$transaction([
    prisma.generatedRecommendation.deleteMany({ where: { storeId } }),
    ...result.recommendations.map((r) =>
      prisma.generatedRecommendation.create({
        data: {
          storeId,
          priority: r.priority,
          message: r.message,
          actionLabel: r.actionLabel,
          actionHref: r.actionHref,
        },
      })
    ),
  ]);

  // A fresh review supersedes any earlier still-pending proposal of the same
  // actionType — without this, two "Ask Genesis to Review My Business" runs
  // (e.g. because the underlying issue wasn't resolved yet) would each add
  // their own ApprovalRequest, silently piling up duplicate pending
  // approvals for the same action. Only PENDING_APPROVAL rows are cleared —
  // an already-EXECUTED or REJECTED row is resolved history and untouched,
  // same "don't rewrite the past" discipline as ExecutionLog. Tracked per
  // run so two recommendations proposing the same actionType in one batch
  // (not expected today, but not impossible) don't each re-clear.
  const supersededActionTypes = new Set<string>();

  // Phase 4 — shared across every ApprovalRequest this one review run
  // creates, so the Website/Settings pages can present them as one
  // reviewed-together group rather than N unrelated cards. Presentational
  // only — each still has its own independent Approve/Reject.
  const groupId = randomUUID();

  let approvalRequestsCreated = 0;
  let autonomouslyHandledCount = 0;
  for (let i = 0; i < result.recommendations.length; i++) {
    const recommendation = result.recommendations[i];
    if (!recommendation.proposedAction) continue;

    const definition = GENESIS_ACTIONS[recommendation.proposedAction.actionType];
    if (!definition) continue; // model proposed an unregistered actionType — skip, don't throw

    // Defense in depth: re-validate the model's proposed input against the
    // registered action's own schema, even though the discriminated union
    // already constrained its shape at the SDK layer.
    const parsedInput = definition.inputSchema.safeParse(recommendation.proposedAction.input);
    if (!parsedInput.success) continue;

    // Phase 6 — if the owner has delegated authority for this exact action
    // type, Genesis handles it now instead of waiting for a human decision.
    // Self-contained: performs its own eligibility/grant/owner-permission
    // checks and, on success, creates AND executes the ApprovalRequest
    // itself (one lineage, not a parallel one). Falls through to the
    // existing human-approval path below on any "no."
    const executedAutonomously = await tryExecuteAutonomousAction({
      storeId,
      actionType: recommendation.proposedAction.actionType,
      input: parsedInput.data,
      summary: recommendation.message,
      topicKey: recommendation.topicKey,
      recommendationId: createdRecommendations[i].id,
      groupId,
    });
    if (executedAutonomously) {
      autonomouslyHandledCount++;
      continue;
    }

    // previousValues is computed from the real, already-fetched blueprint
    // data — never from the model's own restatement of what it was shown.
    const previousValues = definition.getCurrentValues({ blueprint });

    if (!supersededActionTypes.has(recommendation.proposedAction.actionType)) {
      await prisma.approvalRequest.deleteMany({
        where: { storeId, actionType: recommendation.proposedAction.actionType, status: "PENDING_APPROVAL" },
      });
      supersededActionTypes.add(recommendation.proposedAction.actionType);
    }

    await prisma.approvalRequest.create({
      data: {
        storeId,
        recommendationId: createdRecommendations[i].id,
        actionType: recommendation.proposedAction.actionType,
        input: parsedInput.data as object,
        previousValues: previousValues as object,
        summary: recommendation.message,
        authorizationTier: definition.authorizationTier,
        groupId,
        // Phase 5 — this is the one path where topicKey (stable business-
        // issue identity, see the ApprovalRequest schema comment) can be
        // populated honestly: recommendation.topicKey is exactly that
        // identity, already produced by this same Claude call.
        topicKey: recommendation.topicKey,
      },
    });
    approvalRequestsCreated++;
  }

  await recordGenesisExecution({
    action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
    status: "SUCCESS",
    verified: false,
    message:
      result.recommendations.length > 0
        ? `Genesis generated ${result.recommendations.length} recommendation${result.recommendations.length === 1 ? "" : "s"}${
            approvalRequestsCreated > 0
              ? `, ${approvalRequestsCreated} with a proposed action awaiting approval`
              : ""
          }${
            autonomouslyHandledCount > 0
              ? `, ${autonomouslyHandledCount} handled automatically under delegated authority`
              : ""
          }`
        : "Genesis reviewed the business and found nothing specific to flag right now",
    retryable: false,
    userId,
    storeId,
    // The full generated batch (not just a count) is deliberately recorded
    // here — ExecutionLog is append-only, so this becomes real history a
    // future "don't repeat what was already suggested" feature could read,
    // even though GeneratedRecommendation itself only ever holds the
    // current live batch. Nothing reads this yet.
    metadata: { recommendations: result.recommendations },
  });

  return result.recommendations.map((r) => ({
    topicKey: r.topicKey,
    priority: r.priority,
    message: r.message,
    actionHref: r.actionHref,
  }));
}
