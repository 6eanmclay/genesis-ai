import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrderSummary, getRecentActivity } from "@/lib/dashboard/whatHappened";
import { getCustomerSummaries } from "@/lib/dashboard/customers";
import { getInventorySnapshot } from "@/lib/dashboard/inventory";
import { computeInsights, type Insight } from "./insights";
import { distillBeliefs } from "./learn";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import { GENESIS_ACTIONS, type BlueprintContextSubset, type GenesisActionType } from "@/lib/execution/genesisActions";
import { tryExecuteAutonomousAction, communicateFinding } from "@/lib/execution/genesisAutonomy";
import { growthPointCostsFor } from "@/lib/growthPoints/catalog";
import { withJ4CopyRules } from "@/lib/j4CopyRules";
import {
  canSuggestStorefrontImprovement,
  recordStorefrontSuggestionMade,
  STOREFRONT_SUGGESTION_ACTION_TYPES,
} from "@/lib/dashboard/storefrontSuggestionGate";
import { checkAndProposeMarketingAssetsUpdate } from "@/lib/marketing/assets";
import { proposeConnectionGaps } from "@/lib/integrations/gaps";
import {
  getPreviousBriefingAnchor,
  getChangeSetSince,
  composeOwnerBriefing,
} from "@/lib/dashboard/genesisBriefingComposer";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import {
  predictGoalTrajectory,
  getActionTypeTrackRecord,
  getInvoiceSummary,
  getCampaignPerformanceSummary,
  getAppointmentSummary,
  type GoalTrajectory,
} from "@/lib/businessModel/reasoning";
import { SECTION_KEYS } from "@/lib/storefrontSections";
// Used in the SYSTEM_PROMPT string below to spell out the real, current
// section keys in prose — ProposedActionSchema itself no longer types
// sectionOrder against this (see that schema's own comment on why), so
// this prompt string is now the only place enforcing which keys are real.

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
  // Business Intelligence Engine M1 — real blocker found while widening
  // ProposedActionSchema below: update_store_identity and
  // update_marketing_assets had no valid actionHref to point to.
  "/dashboard/marketing",
  "/dashboard/brand",
] as const;

// A recommendation/opportunity may optionally propose a concrete,
// ready-to-apply action from the GENESIS_ACTIONS registry.
//
// Business Intelligence Engine M1 — real, live-tested ceiling found while
// widening this from 5 to 9 real action types, worth recording precisely
// since it constrains this milestone's actual scope:
//   1. A discriminated union of all 9 full per-type input shapes hit a
//      real 400 ("The compiled grammar is too large") — fast (694ms),
//      like a pre-flight rejection.
//   2. Replacing it with one generic z.record() for `input` "fixed" the
//      400, but broke the actual capability: with zero per-field type
//      pressure, the model satisfied the schema with `input: {}` on
//      every proposal, confirmed live by reading the raw CognitiveOutput
//      rows — every new type was reachable in name only.
//   3. Replacing THAT with one flat object covering every real field
//      across all 9 types (collision-safe field names, real per-field
//      types) hit a different real 400 ("Schema is too complex") — slow
//      (181s), meaning the API genuinely tried and failed to compile it,
//      not a cheap pre-flight check. Widening this schema's total
//      complexity, not just its shape, is the real ceiling.
// Given two consecutive genuine API rejections, this widens deliberately
// less than originally scoped: two of the four planned new types
// (update_store_identity, update_section_order — the two structurally
// smallest additions) via the same discriminated-union shape that already
// works at 5 variants. update_store_content is NOT added here — real,
// same-shaped work, left for a real follow-up.
//
// Marketing Engine (Chapter 3) — a real, live attempt to add
// update_marketing_assets here even with a fully EMPTY input
// (z.object({})) still hit the same real "compiled grammar is too large"
// 400 this comment already documents — confirming the ceiling is on total
// variant count/shape, not just per-field complexity. Per the standing
// rule this constraint already established ("a provider/API-level
// implementation constraint is never grounds to redesign a frozen
// principle — find a different implementation path instead"),
// update_marketing_assets stays OUT of this union entirely. Its real fix
// is genuinely separate from Reason's own structured-output call:
// checkAndProposeMarketingAssetsUpdate (lib/marketing/assets.ts) is a
// deterministic Understand-layer check (are the real bios missing/stale?)
// called unconditionally inside runCognitiveReview, below — zero added
// complexity to this schema, a real focused generative call only when the
// deterministic check is actually true.
//
// update_seo/update_hero/update_goal_status/resolve_challenge/
// create_product were already reachable before this milestone.
// update_theme, update_brand_identity, update_homepage_content,
// update_design_direction, and update_product_image are deliberately
// excluded regardless of the complexity ceiling — see the system prompt
// below for why (holistic creative rewrites, or a structurally different
// mechanism entirely).
// Exported for verification only (2026-08-22). This union and
// PROPOSABLE_ACTION_TYPES below are two hand-maintained spellings of the same
// seven actions, and `satisfies readonly GenesisActionType[]` checks that each
// entry is a valid action TYPE — never that the two lists agree with each
// other. scripts/verify-cognitive-proposals.ts asserts that, in both
// directions. See ARCHITECTURE.md, "Standing invariant: the mirrored registry".
export const ProposedActionSchema = z.discriminatedUnion("actionType", [
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
  z.object({
    actionType: z.literal("create_product"),
    input: z.object({ name: z.string(), description: z.string().nullable(), priceInCents: z.number().int() }),
  }),
  z.object({
    actionType: z.literal("update_store_identity"),
    input: z.object({ name: z.string(), tagline: z.string(), description: z.string() }),
  }),
  z.object({
    actionType: z.literal("update_section_order"),
    input: z.object({ sectionOrder: z.array(z.string()) }),
  }),
]);

// The real, literal actionType values ProposedActionSchema above can ever
// produce — kept as its own list (rather than derived from the schema at
// runtime) purely so growthPointCosts below can build a real cost lookup
// for exactly the actions Reason might actually propose, no more. Exported
// so chat's own data-answer context (app/dashboard/ai-actions.ts) can build
// the identical real cost lookup rather than a second, potentially
// drifting list.
export const PROPOSABLE_ACTION_TYPES = [
  "update_seo",
  "update_hero",
  "update_goal_status",
  "resolve_challenge",
  "create_product",
  "update_store_identity",
  "update_section_order",
] as const satisfies readonly GenesisActionType[];

// Per-kind item shapes — a discriminated union, not a generic bag, the same
// fix M5's business-fact classifier proved live against the real API: a
// loose schema lets the model skip fields; per-kind required fields make
// the structured-output grammar itself enforce them.
const CognitiveOutputItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("explanation"),
    summary: z.string(),
    relatedRecordId: z.string().nullable(),
    // J4 Foundation Phase 3 (Reason) — real, checkable grounding in a
    // belief, mirroring relatedRecordId's own defense-in-depth exactly:
    // only a topicKey matching a real, already-fetched belief is ever
    // persisted (see the validation below), never trusted from the model
    // blindly.
    relatedBeliefTopicKey: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("recommendation"),
    summary: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    // The confidence signal (2026-08-04) — evidential certainty, kept
    // strictly separate from priority (business importance). See the
    // system prompt below for the exact distinction given to the model.
    confidence: z.number().min(0).max(1),
    actionLabel: z.string(),
    actionHref: z.enum(GENESIS_ACTION_HREFS),
    topicKey: z.string(),
    relatedRecordId: z.string().nullable(),
    relatedBeliefTopicKey: z.string().nullable(),
    proposedAction: ProposedActionSchema.nullable(),
  }),
  z.object({
    kind: z.literal("opportunity"),
    summary: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    confidence: z.number().min(0).max(1),
    actionLabel: z.string(),
    actionHref: z.enum(GENESIS_ACTION_HREFS),
    topicKey: z.string(),
    relatedRecordId: z.string().nullable(),
    relatedBeliefTopicKey: z.string().nullable(),
    proposedAction: ProposedActionSchema.nullable(),
  }),
]);

const CognitiveReviewOutputSchema = z.object({
  outputs: z.array(CognitiveOutputItemSchema).max(8),
});

const SYSTEM_PROMPT = `You are Genesis, an expert e-commerce consultant and business partner reasoning over this specific business's real, current understanding — not offering generic advice a merchant could get from any business blog. You work in a consistent lifecycle: first understand what's actually happening (already done for you — see the data below), then explain why it matters when it isn't obvious, then recommend what to do about it, distinguishing corrective recommendations from genuine opportunities worth pursuing.

You are shown the business's full profile (identity, industry, revenue model, customers and real computed segments, team, suppliers, connected systems, goals, challenges, locations, and real uploaded business assets), a recent order/revenue summary, inventory, recent account activity, your own recent decision outcomes and generalized beliefs (see below for how these two differ), real pre-computed insights (already-crossed significance thresholds — revenue swings, overdue invoices, engagement changes, cancellation spikes), itemPerformance and itemTrends (per-product order count and revenue over the last 30 days, and which specific products are trending up or down week over week), customerSegmentTrends (whether your repeat/high-value/lapsed/new customer counts are growing or shrinking compared to a week ago), and — when a revenue-category goal has a real stated target — a real computed trajectory (actual progress so far vs. expected pace vs. projected final total). None of these numbers are yours to recalculate; they're already correct. Your job is reasoning about what they mean together, not arithmetic.

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

You are shown two distinct kinds of information about your own past reasoning, and they carry different weight — do not treat them the same way.

recentDecisionOutcomes lists real, objective facts about the last 14 days: specific proposals that were executed or rejected, each with its own topicKey and summary. This is current state, not a pattern — even a single rejection is worth respecting: do not simply repeat that exact topicKey unchanged, but one decline is not proof of a firm rule, so a genuinely new or stronger reason is enough to raise it again, acknowledging the prior decline rather than presenting it as first-time news.

beliefs lists patterns Learn has already generalized from real, repeated evidence over time — each with a claim, a category, a confidence score, and a maturity label. Maturity matters as much as confidence: an "early signal" or "an emerging pattern" belief is real but thin — mention it cautiously if at all, and never let it alone justify attaching a proposedAction that assumes strong trust. A "well-established" belief is a premise you can build a genuinely confident recommendation on. A belief "being reconsidered" means something you've relied on may be breaking down right now — that tension (what was established vs. what's newly contradicting it) is often itself worth a real explanation output, not something to quietly average away.

Every recommendation and opportunity needs both a priority and a confidence, and they answer different questions — never conflate them. priority is business importance: how much this matters to the business if true. confidence is evidential certainty: how sure you are it's actually true given what you currently know, from 0 to 1. A finding can be high-priority and low-confidence (a serious problem you only have a weak signal for — say so cautiously) or low-priority and high-confidence (a small, clearly-true thing). Ground confidence the same way you already ground everything else: more real, corroborating signals (insights, well-established beliefs, multiple consistent data points) earn a higher score; a single thin signal, an early-stage belief, or a real-but-ambiguous pattern earns a lower one. Never inflate confidence to make a finding feel more actionable than the evidence actually supports.

Every business's own stated goals and challenges are shown with their real ids. When an output is genuinely about one specific stated goal, challenge, or other business record, set relatedRecordId to its real id — leave it null for anything that isn't really about one specific record, which is most outputs. When a goal has a real computed trajectory and it's off track, that's exactly the kind of thing worth an explanation and/or a recommendation, naming the real numbers directly.

Each belief you're shown includes its own real topicKey. When an output is genuinely built on one specific belief, set relatedBeliefTopicKey to that belief's exact topicKey as shown; leave it null when no specific belief was actually used as grounding, which is most outputs.

actionTypeTrackRecord shows this store's own real history for a given action type — how often a proposal of that type has actually been approved (approvalRate), and, when there's enough real measured history, how often the result actually looked positive afterward (positiveOutcomeRate, null when there isn't enough real history yet — never treat a null here as a bad sign, it just means too little data exists so far). This is a different, complementary signal from beliefs: a belief only ever applies once the exact same finding has recurred, while a track record can inform a brand-new finding of a familiar action type. If you're about to attach a proposedAction and its actionType has a real track record here, let it genuinely inform your confidence — a type this store has consistently approved and that has measured well deserves higher confidence than the summary text alone would suggest; a type this store has often rejected, or that measured poorly, deserves real caution even if the current finding looks compelling in isolation. An actionType absent from this list simply has no real history yet on this store — reason from the evidence you do have, same as always.

growthPointBalance is this store's real current Growth Points balance, and growthPointCosts gives the real point cost of each actionType that has one assigned so far (an actionType absent from growthPointCosts has no real price yet — never invent one). Both are context only, never a gate. You must always generate every finding, opportunity, and recommendation exactly as you otherwise would, completely independent of these numbers; a store at zero balance deserves the exact same quality of thinking as one with a large balance. The only thing they ever affect is how you frame a recommendation's own summary, and only when doing so is genuinely relevant: if the highest-confidence recommendation's own actionType has a real cost in growthPointCosts that exceeds the current balance, or if multiple real candidates exist at meaningfully different real costs, name the trade-off plainly — propose the option that fits the current balance, and separately name what a higher-impact option would need, in one honest sentence. Never manufacture a comparison using a cost that isn't actually in growthPointCosts, and never let this read as pressure to buy more — you are informing a decision, not selling one. Whenever you refer to Growth Points being used, use "invest"/"investment" language ("this would invest 2 Growth Points into a new product"), never "spend"/"cost" language — Growth Points represent an owner investing in their own business, not a fee for AI usage.

invoiceSummary, campaignPerformanceSummary, and appointmentSummary are real, standing figures computed from this store's own connected systems (QuickBooks invoices, Mailchimp email campaigns, Google Calendar appointments) — not a one-off insight, but the current state of that connected data every time you're shown it. Each is null when nothing of that kind has ever synced (e.g. that connector isn't connected, or the connector is connected but has produced zero real records) — treat a null exactly as "no real basis to say anything about this," never as zero or as a problem. When one is present, use it like any other real fact: invoiceSummary's overdueCount/overdueTotalInCents is a real, concrete reason for a recommendation ("3 invoices are overdue, totaling $420"); campaignPerformanceSummary's averageOpenRate and mostRecentSentAt describe real email engagement; appointmentSummary's cancellationRate and upcomingCount describe real scheduling activity. This is what makes Genesis genuinely understand a connected system's data rather than just recommending the owner go check it themselves — translate these into plain language as part of your normal reasoning, the same way you already do for orderSummary.

Each entry in connectedSystems also carries a real, already-computed syncedAgoLabel ("14 hours ago", "3 days ago", null if it's never synced) and isStale (true once that system's own normal sync cadence has genuinely been exceeded). Your own internal commerce data (orders, products, customers) is always live — never qualify it. Data drawn from invoiceSummary/campaignPerformanceSummary/appointmentSummary or recent.document/campaign/appointment is different: it's only as current as that provider's own last sync. When you build a finding on one of these and its provider's isStale is true, name the real recency plainly ("as of your last QuickBooks sync, 3 days ago...") rather than presenting it with the same unqualified confidence as your own live data — this is honesty about the data's own freshness, not a hedge on your reasoning. When isStale is false, no qualifier is needed; don't manufacture one.

recentAssets lists real photos/documents the owner has uploaded, already confidently classified (unclassified/low-confidence ones are omitted — nothing to reason from yet). Each has a category and summary — treat these as real facts, the same as any other business record, and use relatedRecordId when a finding is genuinely about one specific uploaded asset. A newly-uploaded supplier invoice, contract, or business document is exactly the kind of real, concrete signal worth a genuine explanation or recommendation when it reveals something worth acting on (an overdue amount, an expiring term, a new obligation) — never invent detail beyond what the summary actually states.

actionHref must be exactly one of: "/dashboard#attention", "/dashboard/website", "/dashboard/settings", "/dashboard/payments", "/dashboard/products", "/dashboard/marketing", "/dashboard/brand" — whichever dashboard section a recommendation/opportunity relates to.

If, and only if, a recommendation or opportunity maps directly onto one of these actions the merchant (or, if delegated, Genesis itself) could apply exactly as proposed, attach a proposedAction with the precise, ready-to-apply values:
- "update_seo": input: { seoTitle: string, seoMetaDescription: string }.
- "update_hero": input: { heroHeadline: string, heroSubheadline: string }.
- "update_goal_status": input: { goalRecordId: string, status: "achieved" | "abandoned" } — only when a goal's real data (its own trajectory, or something else in context) clearly shows it's been achieved or is no longer viable. Use the goal's own real id.
- "resolve_challenge": input: { challengeRecordId: string } — only when the data clearly shows the challenge is no longer a real problem. Use the challenge's own real id.
- "create_product": input: { name: string, description: string | null, priceInCents: number } — only when a genuinely specific, sellable new product idea follows directly from the real business data (e.g. a natural size/variant of an existing product, or a clear gap in an otherwise-thin catalog) — never a vague "add more products." name and description must be concrete and real, never placeholders; priceInCents must be a real, reasonable price for this kind of business, not a guess disconnected from the store's existing pricing.
- "update_store_identity": input: { name: string, tagline: string, description: string } — only when the store's own name/tagline/description is genuinely missing or actively misleading, not to rephrase something that already reads fine.
- "update_section_order": input: { sectionOrder: an array containing every one of these real section keys exactly once, in the proposed order: ${SECTION_KEYS.join(", ")} } — only when the current order is a genuine, nameable problem (e.g. a section that should come earlier is buried below less important ones), never a reorder for its own sake.

Never propose update_theme, update_brand_identity, update_homepage_content, update_design_direction, update_store_content, or update_marketing_assets — the first four are holistic creative rewrites requiring every field of a large, subjective object at once, never a genuinely precise single fix; update_marketing_assets is reachable, just through a genuinely separate, deterministic path (a real schema-complexity ceiling, not a judgment call — see this file's own comment above ProposedActionSchema), never through a proposedAction here. All stay a deliberate decision for the owner (or a separate real mechanism), not something you propose quietly through this schema.

When a proposedAction fills in the owner's own customer-facing voice — update_hero's headline, or update_store_identity's name/tagline/description — your summary should read as a starting draft offered for the owner to personalize, never as their voice quietly replaced. You are not the face of this business; the owner is. Your job is removing the repetitive work that keeps them from telling their own story, not telling it for them. Say so plainly when it's genuinely relevant, in your own words, close to this spirit: "this is a starting point — your customers want to hear this in your own words." Never suggest, here or in any conversation, that the owner should step back and let you run their business or their marketing for them; if an owner asks you to fully take over, gently invite them back into it rather than simply complying.

Every recommendation and opportunity should read as a real answer to one question: if this owner does only one thing today, what has the highest real probability of improving their business? Never attach a proposedAction, and never produce a recommendation or opportunity at all, just because something is technically possible to fix — "there's honestly nothing significant to flag right now" is a completely valid, expected outcome of a review, not a shortfall to cover for. Most recommendations/opportunities should NOT include a proposedAction — only attach one when you can specify the exact values, never a vague intent. Leave proposedAction null otherwise.`;

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
  confidence: number;
  message: string;
  actionHref: string;
}

export async function runCognitiveReview(params: {
  storeId: string;
  // Nullable so the scheduler's unattended review pass (no human session)
  // can call this too; see recordGenesisExecution's own comment for why
  // actorType stays "GENESIS" regardless. Not the same signal as
  // `background` below — page.tsx's opportunistic trigger passes a real
  // session userId even though nobody explicitly asked for this call.
  userId: string | null;
  // Track 0 — AI cost governance. True (the default) for both real callers
  // of this function today: the scheduler's cron pass and the opportunistic
  // after() on dashboard page loads (lib/dashboard/genesisObservations.ts's
  // runOpportunisticAiReviewIfStale) — neither is a direct response to the
  // owner asking for AI work, even though the opportunistic path can have a
  // real session attached. Only reviewBusinessWithGenesis (the actual "Ask
  // Genesis to Review My Business" button, ai-actions.ts) passes false.
  background?: boolean;
  // Pre-computed by the scheduler when this call is part of a sync cycle
  // (computeInsights has a real side effect, marking BusinessEvent rows
  // processed, so it must not run twice in one pass); the human-triggered
  // "Ask Genesis to Review My Business" path has no pre-computed batch, so
  // it computes fresh here instead.
  recentInsights?: Insight[];
  // Daily Operating Rhythm — undefined for every existing caller (the
  // scheduler's cron pass, the manual "Ask Genesis to Review My Business"
  // button), so nothing about this function's existing behavior changes
  // for them. Only page.tsx's real owner-visit trigger ever sets this, to
  // the real session userId — the composed "briefing" CognitiveOutput is
  // deliberately never produced from an unattended pass, since its own
  // "since you were last here" framing only makes sense as something said
  // to a real person who just arrived.
  composeBriefingForUserId?: string | null;
}): Promise<CognitiveReviewSummary[]> {
  const { storeId, userId, background = true, composeBriefingForUserId } = params;

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new Error("Store not found");
  }

  const products = await prisma.product.findMany({
    where: { storeId },
    orderBy: { position: "asc" },
    select: { name: true, description: true, priceInCents: true, active: true },
  });

  const [
    orderSummary,
    customerSummaries,
    recentActivity,
    actionTypeTrackRecord,
    invoiceSummary,
    campaignPerformanceSummary,
    appointmentSummary,
  ] = await Promise.all([
    getOrderSummary(storeId, { includeRevenue: true }),
    getCustomerSummaries(storeId, { includeRevenue: true, limit: 10 }),
    getRecentActivity(storeId, 10),
    getActionTypeTrackRecord(storeId),
    getInvoiceSummary(storeId),
    getCampaignPerformanceSummary(storeId),
    getAppointmentSummary(storeId),
  ]);
  const recentInsights = params.recentInsights ?? (await computeInsights(storeId));
  // J4 Foundation Phase 2 (Learn) — a separate call, deliberately not folded
  // into the reasoning below: distillBeliefs reads its own persisted
  // evidence fresh (all of it, never just recentInsights or this one call's
  // window), so it runs unconditionally here rather than depending on
  // whether computeInsights happened to run fresh this call.
  await distillBeliefs(storeId);
  // Marketing Engine (Chapter 3) — same "runs unconditionally, cheap
  // deterministic check first" discipline as distillBeliefs above. See
  // lib/marketing/assets.ts's own comment for why this lives outside
  // Reason's own structured-output call entirely.
  await checkAndProposeMarketingAssetsUpdate(storeId);
  // J4 Foundation (2026-08-04) — the shared canonical understanding
  // (J4_FOUNDATION.md, closing Gap A: one real object combining facts,
  // beliefs, and recent decisions, reused by chat's data-answer path too —
  // see app/dashboard/ai-actions.ts). Read AFTER distillBeliefs above, so
  // this same pass's own fresh beliefs are what Reason sees, never a stale
  // snapshot from before this call's own Learn pass ran — the exact
  // ordering guarantee this file already held before this function existed
  // to share the read with other callers, unchanged.
  // REASON ADVISES THE OWNER (2026-08-21). No human is reading at this moment,
  // but the recommendations this pass produces are written for one specific
  // person — so the viewer is the store's owner, and J4 reasons with what it has
  // learned about how they decide. Passing nothing here would have quietly
  // removed owner-preference beliefs from Reason, which have fed it since M2.
  const understanding = await getBusinessUnderstanding(storeId, { viewerUserId: store.userId });
  const {
    profile: businessProfile,
    beliefs,
    recentDecisions: recentDecisionOutcomes,
    platformRelationship,
    commitments,
  } = understanding;
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

  // Integrations (Chapter 4) — same real, deterministic, zero-AI-call
  // pattern as the goal-trajectory block above: getConnectionGaps is pure
  // computation, proposeConnectionGaps supersedes prior ACTIVE rows and
  // writes fresh ones. Unconditional, cheap, runs every real review pass.
  await proposeConnectionGaps(storeId);

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
    // DATED COMMITMENTS the business is bound by, read out of its own uploaded
    // documents (2026-08-21). Reason needs these named explicitly:
    // J4_REASON_VALIDATION.md records that a new Understand capability does NOT
    // reach Reason just because Understand computed it — it takes a bounded
    // extension here, and this is it.
    //
    // A deadline is the one kind of fact where noticing late is the same as not
    // noticing, which is exactly the "here is what I noticed" case.
    commitments,
    // What J4 has learned about how THIS owner decides. Named separately from
    // beliefs so a pattern about the person is never quoted as a fact about the
    // business — J4_OWNER_UNDERSTANDING.md's one-direction rule.
    ownerUnderstanding: understanding.ownerUnderstanding,
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
    // J4 Foundation Phase 3 (Reason) — two distinctly-named fields,
    // deliberately never merged into one: recentDecisionOutcomes is
    // objective current fact (Understand), beliefs is Learn's own
    // generalized, evidence-backed, revisable pattern. See SYSTEM_PROMPT
    // below for how each should be weighed differently.
    recentDecisionOutcomes,
    beliefs: beliefs.map((b) => ({
      topicKey: b.topicKey,
      claim: b.claim,
      category: b.category,
      confidence: b.confidence,
      maturity: b.maturity,
    })),
    recentInsights: recentInsights.map((i) => ({
      type: i.type,
      severity: i.severity,
      summary: i.summary,
    })),
    goals: businessProfile.goals.map((g) => ({ id: g.id, ...g.data })),
    challenges: businessProfile.challenges.map((c) => ({ id: c.id, ...c.data })),
    // Business Assets M5 — only confidently-classified uploads (see
    // SYSTEM_PROMPT's own comment on recentAssets); an "unclassified"
    // asset is honestly nothing to reason from yet, same discipline
    // itemTrends already applies by omitting records with no real trend.
    recentAssets: businessProfile.assets
      .filter((a) => a.data.category !== "unclassified")
      .map((a) => ({ id: a.id, category: a.data.category, summary: a.data.summary })),
    revenueStreams: businessProfile.classification.revenueStreams,
    connectedSystems: businessProfile.connectedSystems,
    goalTrajectories,
    // Tier 4 validation, Stage B — wired directly from businessProfile
    // (already fetched above), not a new query. Only items with a real
    // trend (a genuine prior-window baseline) are shown, matching the same
    // honest-omission discipline recentInsights already uses — a null
    // trend means "nothing to compare yet," not "flat."
    itemPerformance: businessProfile.offerings.performance.map((p) => ({
      name: p.item.data.name,
      orderCount: p.orderCount,
      revenueLast30Days: p.revenueInCents / 100,
    })),
    itemTrends: businessProfile.offerings.trends
      .filter((t) => t.trend !== null)
      .map((t) => ({
        name: t.item.data.name,
        direction: t.trend!.direction,
        changePct: Math.round(t.trend!.changeRatio * 100),
      })),
    // Passed through as its own fixed {repeatCustomers, highValueCustomers,
    // lapsedCustomers, newCustomers} shape, nulls included — a small,
    // fixed object, not a variable list, so a null entry here just means
    // "no real baseline for this segment," not something worth filtering.
    customerSegmentTrends: businessProfile.customers.segmentTrends,
    // Growth Engine M2 — real historical performance by actionType (not
    // exact-topicKey, unlike the rejection_pattern:/outcome_pattern:
    // beliefs above — this helps calibrate confidence for a genuinely NEW
    // finding of a familiar kind, not just a repeat of an old one). Only
    // actionTypes with real, sufficient history appear at all — see
    // SYSTEM_PROMPT for how to weigh this against everything else.
    actionTypeTrackRecord,
    // Growth Points Economy — the store's real current balance, read from
    // the canonical BusinessUnderstanding object (J4_FOUNDATION.md's Gap C,
    // closed 2026-08-05) rather than a separate ad hoc fetch. Context only,
    // never a gate: see SYSTEM_PROMPT's own guidance on this — every
    // finding, opportunity, and recommendation still gets generated
    // regardless of balance; this only ever informs how a recommendation's
    // own summary is framed, when framing it that way is genuinely relevant.
    growthPointBalance: platformRelationship.growthPointBalance,
    // Real per-action costs for exactly the actionTypes Reason can actually
    // propose (PROPOSABLE_ACTION_TYPES above) — only entries with a real,
    // non-null catalog value (lib/growthPoints/catalog.ts) appear at all.
    // Today the catalog is deliberately empty, so this is an honest {}; the
    // moment real values exist, budget-aware framing has real numbers to
    // reason from with zero further code changes.
    growthPointCosts: growthPointCostsFor(PROPOSABLE_ACTION_TYPES),
    // Integrations (Chapter 4, continued) — real standing summaries of
    // connected-system data (QuickBooks invoices, Mailchimp campaigns,
    // Calendar appointments), not just an occasional threshold-triggered
    // insight. Null means honestly nothing synced yet, never a fabricated
    // zero — see SYSTEM_PROMPT for how to use these.
    invoiceSummary,
    campaignPerformanceSummary,
    appointmentSummary,
  };

  const outcome = await callGenesisModel({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: withJ4CopyRules(SYSTEM_PROMPT),
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
  }, { storeId, background, feature: "cognitive_review" });

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
  const entityTypeByRecordId = new Map<string, "goal" | "challenge" | "asset">([
    ...businessProfile.goals.map((g) => [g.id, "goal"] as const),
    ...businessProfile.challenges.map((c) => [c.id, "challenge"] as const),
    // Business Assets M5 — same defense-in-depth extended to the newly
    // real "genuinely about one specific uploaded asset" case named in
    // SYSTEM_PROMPT's own recentAssets paragraph.
    ...businessProfile.assets.map((a) => [a.id, "asset"] as const),
  ]);
  // J4 Foundation Phase 3 (Reason) — same defense-in-depth for
  // relatedBeliefTopicKey: only a topicKey that matches a real,
  // already-fetched belief is ever persisted, never trusted from the
  // model's own output blindly.
  const realBeliefTopicKeys = new Set(beliefs.map((b) => b.topicKey));

  // J4 Foundation Phase 1 (Execute Hardening) — one communicateFinding()
  // call per item, sequential rather than a batched $transaction: each of
  // Reason's outputs is its own real, independently-recordable act, exactly
  // the fidelity the Constitution asks for, not a single opaque write. This
  // is also what makes each item's ExecutionLog row genuinely traceable to
  // its own authorization check, even though that check always trivially
  // clears for this authority-exempt action.
  const createdOutputs: { id: string; recordId: string | null; entityType: "goal" | "challenge" | "asset" | null }[] = [];
  for (const item of result.outputs) {
    const recordId =
      item.relatedRecordId && entityTypeByRecordId.has(item.relatedRecordId)
        ? item.relatedRecordId
        : null;
    const entityType = recordId ? (entityTypeByRecordId.get(recordId) ?? null) : null;
    const relatedBeliefTopicKey =
      "relatedBeliefTopicKey" in item && item.relatedBeliefTopicKey && realBeliefTopicKeys.has(item.relatedBeliefTopicKey)
        ? item.relatedBeliefTopicKey
        : null;
    const { cognitiveOutputId } = await communicateFinding(storeId, {
      kind: item.kind,
      summary: item.summary,
      priority: "priority" in item ? item.priority : null,
      confidence: "confidence" in item ? item.confidence : null,
      actionLabel: "actionLabel" in item ? item.actionLabel : null,
      actionHref: "actionHref" in item ? item.actionHref : null,
      recordId,
      entityType,
      topicKey: "topicKey" in item ? item.topicKey : null,
      proposedAction: "proposedAction" in item && item.proposedAction ? item.proposedAction : null,
      data: relatedBeliefTopicKey ? { relatedBeliefTopicKey } : null,
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
  // Storefront ideas J4 had but stayed quiet about, and why. Recorded on the
  // review's own ExecutionLog metadata below rather than discarded — a
  // governor that silently drops proposals is indistinguishable from a
  // reasoning layer that stopped having ideas, and only one of those is a bug.
  const storefrontSuggestionsSuppressed: { actionType: string; reason: string; detail: string }[] = [];
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
      aiUsageEventId: outcome.ok ? outcome.aiUsageEventId : null,
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

    // Progressive storefront improvement (2026-08-12) — the frequency
    // governor and suggestion memory. This is J4's own initiative, so it is
    // exactly the path that must stay occasional: a storefront idea the
    // owner has already declined, or one raised inside the cooldown window,
    // is dropped here rather than becoming a proposal the owner has to
    // dismiss again. Nothing else J4 proposes is affected.
    //
    // Placed BEFORE the supersede/delete below on purpose: a suppressed
    // suggestion must not clear a pending proposal the owner may still be
    // considering. Suppression means "stay quiet," never "withdraw."
    const storefrontGate = await canSuggestStorefrontImprovement({
      storeId,
      actionType: item.proposedAction.actionType,
      topicKey: item.topicKey,
    });
    if (!storefrontGate.allowed) {
      storefrontSuggestionsSuppressed.push({
        actionType: item.proposedAction.actionType,
        reason: storefrontGate.reason,
        detail: storefrontGate.detail,
      });
      continue;
    }

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
        aiUsageEventId: outcome.ok ? outcome.aiUsageEventId : null,
      },
    });
    await prisma.cognitiveOutput.update({
      where: { id: cognitiveOutputId, storeId },
      data: { status: "SUPERSEDED", approvalRequestId: approval.id },
    });
    approvalRequestsCreated++;

    // Stamp the governor only once a storefront proposal genuinely exists —
    // never on the attempt, so a suppressed suggestion can't quietly start
    // the owner's cooldown on their behalf.
    if (STOREFRONT_SUGGESTION_ACTION_TYPES.has(item.proposedAction.actionType)) {
      await recordStorefrontSuggestionMade(storeId);
    }
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
    metadata: {
      outputs: result.outputs,
      // Present only when the governor actually suppressed something, so an
      // ordinary review's metadata is unchanged. This is the audit trail for
      // "why didn't J4 mention my storefront" — without it, a working
      // governor and a broken Reason pass look identical from the outside.
      ...(storefrontSuggestionsSuppressed.length > 0
        ? { storefrontSuggestionsSuppressed }
        : {}),
    },
  });

  // Daily Operating Rhythm — composed last, after everything else this pass
  // produced is already durable, so it can genuinely draw on this run's own
  // fresh findings. Never blocks or fails the rest of the review: a
  // composer failure (network, provider error) is swallowed here, same as
  // draftMarketingAssets' own "return null on failure" convention — the
  // owner simply sees no fresh briefing this pass, never a broken review.
  if (composeBriefingForUserId) {
    const anchor = await getPreviousBriefingAnchor(storeId);
    const changeSet = await getChangeSetSince(storeId, anchor);
    const descriptionByGoalId = new Map(
      businessProfile.goals.map((g) => [g.id, g.data.description] as const)
    );
    const briefingGoalTrajectories = goalTrajectories.map((t) => ({
      description: descriptionByGoalId.get(t.goalId) ?? "Goal",
      onTrack: t.onTrack,
      actualSoFarInCents: t.actualSoFarInCents,
      targetValueInCents: t.targetValueInCents,
      paceRatio: t.paceRatio,
    }));
    const freshOutputs = result.outputs
      .filter(
        (item): item is Extract<typeof item, { kind: "explanation" | "recommendation" | "opportunity" }> =>
          item.kind === "explanation" || item.kind === "recommendation" || item.kind === "opportunity"
      )
      .map((item) => ({
        kind: item.kind,
        summary: item.summary,
        priority: "priority" in item ? item.priority : null,
      }));

    const reply = await composeOwnerBriefing(storeId, {
      storeName: store.name,
      changeSet,
      freshOutputs,
      goalTrajectories: briefingGoalTrajectories,
    });

    if (reply) {
      await prisma.cognitiveOutput.updateMany({
        where: { storeId, kind: "briefing", status: "ACTIVE" },
        data: { status: "SUPERSEDED" },
      });
      await communicateFinding(storeId, {
        kind: "briefing",
        summary: reply,
        priority: null,
      });
    }
  }

  return result.outputs
    .filter((item): item is Extract<typeof item, { kind: "recommendation" | "opportunity" }> =>
      item.kind === "recommendation" || item.kind === "opportunity"
    )
    .map((item) => ({
      topicKey: item.topicKey,
      priority: item.priority,
      confidence: item.confidence,
      message: item.summary,
      actionHref: item.actionHref,
    }));
}
