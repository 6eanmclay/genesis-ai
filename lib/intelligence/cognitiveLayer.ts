import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrderSummary, getRecentActivity } from "@/lib/dashboard/whatHappened";
import { getCustomerSummaries } from "@/lib/dashboard/customers";
import { getInventorySnapshot } from "@/lib/dashboard/inventory";
import { getRecentGenesisHistory } from "@/lib/dashboard/genesisLearning";
import { computeInsights, type Insight } from "./insights";
import { distillBeliefs } from "./learn";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import { GENESIS_ACTIONS, type BlueprintContextSubset } from "@/lib/execution/genesisActions";
import { tryExecuteAutonomousAction, communicateFinding } from "@/lib/execution/genesisAutonomy";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";
import { getBusinessProfile } from "@/lib/businessModel/profile";
import { predictGoalTrajectory, type GoalTrajectory } from "@/lib/businessModel/reasoning";

// Phase 3 Milestone 6 — the J4 Cognitive Layer's own reasoning pipeline.
// Was generateGenesisRecommendations.ts (lib/dashboard/), relocated here
// (lib/intelligence/, alongside scheduler.ts/changeDetection.ts/insights.ts/
// notify.ts — this is reasoning/BI-adjacent infrastructure now, not a
// dashboard-page helper) and rewritten around the standard lifecycle Sean
// specified: Observe -> Explain -> Recommend -> Execute, applicable
// regardless of domain (marketing, finance, operations, hiring, inventory,
// compliance, or anything future).
//
// Per Sean's explicit framing: "the Opportunity Engine should become one
// output of the J4 Cognitive Layer, not the layer itself." This file
// produces multiple real output kinds (explanation/recommendation/
// opportunity — insight is persisted separately, see insights.ts's own
// computeInsights, unchanged detection logic), all written as CognitiveOutput
// rows, the durable, queryable record of everything Genesis has reasoned
// about the business.
//
// Explicitly NOT rebuilding Milestone 3's deterministic Insight Engine,
// Change Detection, or Scheduler — those stay exactly as they are. Observe
// here means reading their real output (computeInsights, getBusinessProfile,
// predictGoalTrajectory), never recomputing it.

const GENESIS_ACTION_HREFS = [
  "/dashboard/website",
  "/dashboard/settings",
  "/dashboard/products",
  "/dashboard/payments",
  "/dashboard#attention",
] as const;

// A recommendation/opportunity may optionally propose a concrete,
// ready-to-apply action from the GENESIS_ACTIONS registry — same
// discriminated-union discipline as before, now including the two new
// record-scoped operations actions (Milestone 6).
const ProposedActionSchema = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("update_seo"),
    input: z.object({ seoTitle: z.string(), seoMetaDescription: z.string() }),
  }),
  z.object({
    actionType: z.literal("update_hero"),
    input: z.object({ heroHeadline: z.string(), heroSubheadline: z.string() }),
  }),
  z.object({
    actionType: z.literal("update_goal_status"),
    input: z.object({
      goalRecordId: z.string(),
      status: z.enum(["achieved", "abandoned"]),
    }),
  }),
  z.object({
    actionType: z.literal("resolve_challenge"),
    input: z.object({ challengeRecordId: z.string() }),
  }),
]);

// Per-kind item shapes — a discriminated union, not a generic bag, the same
// fix M5's business-fact classifier proved live against the real API: a
// loose schema lets the model skip fields; per-kind required fields make
// the structured-output grammar itself enforce them.
const CognitiveOutputItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("explanation"),
    summary: z.string(),
    relatedRecordId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("recommendation"),
    summary: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    actionLabel: z.string(),
    actionHref: z.enum(GENESIS_ACTION_HREFS),
    topicKey: z.string(),
    relatedRecordId: z.string().nullable(),
    proposedAction: ProposedActionSchema.nullable(),
  }),
  z.object({
    kind: z.literal("opportunity"),
    summary: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    actionLabel: z.string(),
    actionHref: z.enum(GENESIS_ACTION_HREFS),
    topicKey: z.string(),
    relatedRecordId: z.string().nullable(),
    proposedAction: ProposedActionSchema.nullable(),
  }),
]);

const CognitiveReviewOutputSchema = z.object({
  outputs: z.array(CognitiveOutputItemSchema).max(8),
});

const SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant and business partner reasoning over this specific business's real, current understanding — not offering generic advice a merchant could get from any business blog. You work in a consistent lifecycle: first understand what's actually happening (already done for you — see the data below), then explain why it matters when it isn't obvious, then recommend what to do about it, distinguishing corrective recommendations from genuine opportunities worth pursuing.

You are shown the business's full profile (identity, industry, revenue model, customers and real computed segments, team, suppliers, connected systems, goals, challenges, locations), a recent order/revenue summary, inventory, recent account activity, your own recent proposal history, real pre-computed insights (already-crossed significance thresholds — revenue swings, overdue invoices, engagement changes, cancellation spikes), and — when a revenue-category goal has a real stated target — a real computed trajectory (actual progress so far vs. expected pace vs. projected final total). None of these numbers are yours to recalculate; they're already correct. Your job is reasoning about what they mean together, not arithmetic.

A separate deterministic system on this dashboard already flags: an unpublished store with ready products, zero active products, no connected payment method, a stale/incomplete payment connection attempt, recent failures or warnings, and zero orders in the last 30 days. Do not repeat any of these — assume the merchant already sees them elsewhere.

Produce up to 8 outputs total, choosing freely among three kinds:

1. "explanation" — a standalone "why" for something non-obvious in the data (e.g. why revenue might be down, why a challenge is worsening). Only produce one when there's a real, grounded reason to point to — connecting two or more real signals (an insight, a goal trajectory, a stated challenge, a connected-system fact) is what makes an explanation valuable; never explain the obvious, and never speculate beyond what the data actually supports.
2. "recommendation" — corrective or general guidance addressing a problem, gap, or risk.
3. "opportunity" — a favorable, growth-oriented action worth pursuing, distinct in tone from a recommendation (not "fix this," but "this is working, consider doing more of it" or "here's a favorable condition worth acting on").

Prioritize impact over count for recommendations and opportunities — typically one to three of each, never padding to reach a number. Explanations are only produced when genuinely warranted, often zero. If the supplied data doesn't support something specific and useful, produce less, including nothing at all.

Ground everything in the data you were actually given. Never invent a customer complaint, review, statistic, or trend that isn't in the supplied data. State assumptions as assumptions, not facts, and frame advice as guidance ("consider...", "this may be worth...") rather than certainty.

Every summary must be self-contained: state the point (and, for recommendations/opportunities, why it matters) in 1-2 sentences.

recommendation/opportunity items need a topicKey: a short, stable, lowercase_snake_case slug identifying the underlying finding (e.g. "declining_repeat_purchases"), independent of exact wording, so a future review recognizes "you already told me this" versus a genuinely new finding.

Write like a business partner sharing an observation, not an admin system issuing a task. Favor phrasing like "Genesis noticed..." or "Worth considering..." over bare imperatives.

You are also shown, under recentGenesisHistory, up to 5 of your own recent proposals from the last 60 days and, where applicable, what happened afterward. An entry with decision "executed" includes a plain before/after order comparison for the 14 days after that change — treat this strictly as correlated timing, never as proof that change caused the difference. An executed entry's decisionMode tells you HOW it was decided: "human" means the owner personally reviewed and approved it; "autonomous" means you handled it yourself under authority the owner had previously granted, without asking first — informational context only, it never changes what you're currently allowed to do. An entry with decision "rejected" means the owner declined that specific proposal, not necessarily that the underlying issue is wrong. Do not simply repeat a recently rejected proposal unchanged; you may raise the same topicKey again with a genuinely new or stronger reason, acknowledging the prior decline rather than presenting it as first-time news.

Every business's own stated goals and challenges are shown with their real ids. When an output is genuinely about one specific stated goal, challenge, or other business record, set relatedRecordId to its real id — leave it null for anything that isn't really about one specific record, which is most outputs. When a goal has a real computed trajectory and it's off track, that's exactly the kind of thing worth an explanation and/or a recommendation, naming the real numbers directly.

actionHref must be exactly one of: "/dashboard#attention", "/dashboard/website", "/dashboard/settings", "/dashboard/payments", "/dashboard/products" — whichever dashboard section a recommendation/opportunity relates to.

If, and only if, a recommendation or opportunity maps directly onto one of these actions the merchant (or, if delegated, Genesis itself) could apply exactly as proposed, attach a proposedAction with the precise, ready-to-apply values:
- "update_seo": input: { seoTitle: string, seoMetaDescription: string }.
- "update_hero": input: { heroHeadline: string, heroSubheadline: string }.
- "update_goal_status": input: { goalRecordId: string, status: "achieved" | "abandoned" } — only when a goal's real data (its own trajectory, or something else in context) clearly shows it's been achieved or is no longer viable. Use the goal's own real id.
- "resolve_challenge": input: { challengeRecordId: string } — only when the data clearly shows the challenge is no longer a real problem. Use the challenge's own real id.
Most recommendations/opportunities should NOT include a proposedAction — only attach one when you can specify the exact values, never a vague intent. Leave proposedAction null otherwise.`;

// Home Redesign (v30) — Goal progress becomes a real, standalone Discovery
// item: a deterministic "prediction" CognitiveOutput row, built in code
// (never by the model), matching the Insight Engine's own "100%
// deterministic, no AI judgment" principle extended to this kind.
function describeTrajectory(description: string, t: GoalTrajectory): string {
  const target = `$${(t.targetValueInCents / 100).toLocaleString()}`;
  const actual = `$${(t.actualSoFarInCents / 100).toLocaleString()}`;
  const pace = `${t.paceRatio.toFixed(1)}x`;
  return t.onTrack
    ? `"${description}" is on track — ${actual} so far toward a ${target} goal, running at ${pace} the expected pace.`
    : `"${description}" is behind pace — ${actual} so far toward a ${target} goal, running at ${pace} the expected pace.`;
}

export interface CognitiveReviewSummary {
  topicKey: string;
  priority: "high" | "medium" | "low";
  message: string;
  actionHref: string;
}

export async function runCognitiveReview(params: {
  storeId: string;
  // Nullable so the scheduler's unattended review pass (no human session)
  // can call this too; see recordGenesisExecution's own comment for why
  // actorType stays "GENESIS" regardless.
  userId: string | null;
  // Pre-computed by the scheduler when this call is part of a sync cycle
  // (computeInsights has a real side effect, marking BusinessEvent rows
  // processed, so it must not run twice in one pass); the human-triggered
  // "Ask Genesis to Review My Business" path has no pre-computed batch, so
  // it computes fresh here instead.
  recentInsights?: Insight[];
}): Promise<CognitiveReviewSummary[]> {
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

  const [orderSummary, customerSummaries, recentActivity, recentGenesisHistory, businessProfile] =
    await Promise.all([
      getOrderSummary(storeId, { includeRevenue: true }),
      getCustomerSummaries(storeId, { includeRevenue: true, limit: 10 }),
      getRecentActivity(storeId, 10),
      getRecentGenesisHistory(storeId),
      getBusinessProfile(storeId),
    ]);
  const recentInsights = params.recentInsights ?? (await computeInsights(storeId));
  // J4 Foundation Phase 2 (Learn) — a separate call, deliberately not folded
  // into the reasoning below: distillBeliefs reads its own persisted
  // evidence fresh (all of it, never just recentInsights or this one call's
  // window), so it runs unconditionally here rather than depending on
  // whether computeInsights happened to run fresh this call. Read-only from
  // this function's perspective — its output isn't consumed yet (Phase 3
  // wires Reason to actually read getBeliefs()); this phase only proves the
  // distillation itself is real and keeps running every time Observe does.
  await distillBeliefs(storeId);
  const inventorySnapshot = getInventorySnapshot(products);
  const blueprint = store.blueprint as BlueprintContextSubset | null;

  // Observe, continued — a real, deterministic projection for every active
  // revenue-category goal with a real target (predictGoalTrajectory returns
  // null, never a fabricated number, when there's nothing real to project).
  const goalTrajectories = (
    await Promise.all(
      businessProfile.goals
        .filter((g) => g.data.status === "active")
        .map((g) => predictGoalTrajectory(storeId, g))
    )
  ).filter((t) => t !== null);

  // Persist each trajectory as its own durable, deterministic "prediction"
  // row — prior ACTIVE prediction rows are superseded first (status update,
  // not delete, same convention every other supersede in this file already
  // uses), so a re-run never duplicates a goal's progress. The model still
  // separately sees goalTrajectories as prompt context above/below and may
  // reference it in an Explanation/Recommendation's own prose — these
  // aren't mutually exclusive, one is the deterministic fact, the other is
  // Genesis's reasoning about what to do with it.
  if (goalTrajectories.length > 0) {
    const descriptionByGoalId = new Map(businessProfile.goals.map((g) => [g.id, g.data.description]));
    // Superseding prior predictions is bookkeeping on existing rows, not a
    // new finding being communicated — stays a direct write. Each NEW
    // prediction, below, is a real communicated finding and routes through
    // communicateFinding() like every other one, one execute() call per
    // trajectory (never a batch) for the same reason computeInsights does.
    await prisma.cognitiveOutput.updateMany({
      where: { storeId, kind: "prediction", status: "ACTIVE" },
      data: { status: "SUPERSEDED" },
    });
    for (const t of goalTrajectories) {
      await communicateFinding(storeId, {
        kind: "prediction",
        summary: describeTrajectory(descriptionByGoalId.get(t.goalId) ?? "Goal", t),
        priority: t.onTrack ? "low" : "medium",
        recordId: t.goalId,
        entityType: "goal",
        data: t as unknown as object,
      });
    }
  }

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
    recentGenesisHistory,
    recentInsights: recentInsights.map((i) => ({
      type: i.type,
      severity: i.severity,
      summary: i.summary,
    })),
    goals: businessProfile.goals.map((g) => ({ id: g.id, ...g.data })),
    challenges: businessProfile.challenges.map((c) => ({ id: c.id, ...c.data })),
    revenueStreams: businessProfile.classification.revenueStreams,
    connectedSystems: businessProfile.connectedSystems,
    goalTrajectories,
  };

  const outcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `This business's current data (JSON):\n${JSON.stringify(contextForPrompt, null, 2)}\n\nReview this business: explain anything non-obvious, then recommend and flag opportunities.`,
      },
    ],
    output_config: {
      effort: "medium",
      format: zodOutputFormat(CognitiveReviewOutputSchema),
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
      message: "Genesis couldn't complete its review",
      retryable: true,
      userId,
      storeId,
      metadata: {},
    });
    throw new Error("Genesis couldn't complete its review");
  }

  // relatedRecordId is never trusted directly — only an id that genuinely
  // matches a real, already-fetched goal or challenge is persisted, same
  // defense-in-depth discipline proposedAction.input already gets below.
  const entityTypeByRecordId = new Map<string, "goal" | "challenge">([
    ...businessProfile.goals.map((g) => [g.id, "goal"] as const),
    ...businessProfile.challenges.map((c) => [c.id, "challenge"] as const),
  ]);

  // J4 Foundation Phase 1 (Execute Hardening) — one communicateFinding()
  // call per item, sequential rather than a batched $transaction: each of
  // Reason's outputs is its own real, independently-recordable act, exactly
  // the fidelity the Constitution asks for, not a single opaque write. This
  // is also what makes each item's ExecutionLog row genuinely traceable to
  // its own authorization check, even though that check always trivially
  // clears for this authority-exempt action.
  const createdOutputs: { id: string; recordId: string | null; entityType: "goal" | "challenge" | null }[] = [];
  for (const item of result.outputs) {
    const recordId =
      item.relatedRecordId && entityTypeByRecordId.has(item.relatedRecordId)
        ? item.relatedRecordId
        : null;
    const entityType = recordId ? (entityTypeByRecordId.get(recordId) ?? null) : null;
    const { cognitiveOutputId } = await communicateFinding(storeId, {
      kind: item.kind,
      summary: item.summary,
      priority: "priority" in item ? item.priority : null,
      actionLabel: "actionLabel" in item ? item.actionLabel : null,
      actionHref: "actionHref" in item ? item.actionHref : null,
      recordId,
      entityType,
      topicKey: "topicKey" in item ? item.topicKey : null,
      proposedAction: "proposedAction" in item && item.proposedAction ? item.proposedAction : null,
    });
    createdOutputs.push({ id: cognitiveOutputId, recordId, entityType });
  }

  // A fresh review supersedes any earlier still-pending proposal of the
  // same actionType — without this, two review runs would each add their
  // own ApprovalRequest, silently piling up duplicates. Only
  // PENDING_APPROVAL rows are cleared — already-decided history stays.
  const supersededActionTypes = new Set<string>();
  // Shared across every ApprovalRequest this run creates, so pages can
  // present them as one reviewed-together group — presentational only.
  const groupId = randomUUID();

  let approvalRequestsCreated = 0;
  let autonomouslyHandledCount = 0;
  for (let i = 0; i < result.outputs.length; i++) {
    const item = result.outputs[i];
    if (!("proposedAction" in item) || !item.proposedAction) continue;
    const cognitiveOutputId = createdOutputs[i].id;

    const definition = GENESIS_ACTIONS[item.proposedAction.actionType];
    if (!definition) continue; // model proposed an unregistered actionType — skip, don't throw

    const parsedInput = definition.inputSchema.safeParse(item.proposedAction.input);
    if (!parsedInput.success) continue;

    const recordId = createdOutputs[i].recordId;
    const entityType = createdOutputs[i].entityType;

    // If the owner has delegated authority for this exact action type,
    // Genesis handles it now instead of waiting for a human decision.
    // Self-contained — falls through to the human-approval path on any "no."
    const executedAutonomously = await tryExecuteAutonomousAction({
      storeId,
      actionType: item.proposedAction.actionType,
      input: parsedInput.data,
      summary: item.summary,
      topicKey: item.topicKey,
      cognitiveOutputId,
      recordId,
      entityType,
      groupId,
    });
    if (executedAutonomously) {
      autonomouslyHandledCount++;
      continue;
    }

    // previousValues is computed from the real, current row — never from
    // the model's own restatement of what it was shown. Fetched fresh here
    // (not reused from businessProfile's own earlier snapshot) since that
    // snapshot could be stale by the time this loop runs.
    const currentRecord =
      recordId && entityType
        ? await prisma.businessRecord.findFirst({
            where: { id: recordId, storeId, entityType },
            select: { id: true, entityType: true, data: true },
          })
        : null;
    const previousValues = definition.getCurrentValues({
      blueprint,
      businessRecord: currentRecord,
    });

    if (!supersededActionTypes.has(item.proposedAction.actionType)) {
      await prisma.approvalRequest.deleteMany({
        where: { storeId, actionType: item.proposedAction.actionType, status: "PENDING_APPROVAL" },
      });
      supersededActionTypes.add(item.proposedAction.actionType);
    }

    const approval = await prisma.approvalRequest.create({
      data: {
        storeId,
        cognitiveOutputId,
        actionType: item.proposedAction.actionType,
        input: parsedInput.data as object,
        previousValues: previousValues as object,
        summary: item.summary,
        authorizationTier: definition.authorizationTier,
        groupId,
        topicKey: item.topicKey,
      },
    });
    await prisma.cognitiveOutput.update({
      where: { id: cognitiveOutputId },
      data: { status: "SUPERSEDED", approvalRequestId: approval.id },
    });
    approvalRequestsCreated++;
  }

  await recordGenesisExecution({
    action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
    status: "SUCCESS",
    verified: false,
    message:
      result.outputs.length > 0
        ? `Genesis produced ${result.outputs.length} output${result.outputs.length === 1 ? "" : "s"}${
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
    metadata: { outputs: result.outputs },
  });

  return result.outputs
    .filter((item): item is Extract<typeof item, { kind: "recommendation" | "opportunity" }> =>
      item.kind === "recommendation" || item.kind === "opportunity"
    )
    .map((item) => ({
      topicKey: item.topicKey,
      priority: item.priority,
      message: item.summary,
      actionHref: item.actionHref,
    }));
}
