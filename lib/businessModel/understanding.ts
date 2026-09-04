import { prisma } from "@/lib/prisma";
import {
  getActionTypeTrackRecord,
  getInvoiceSummary,
  getCampaignPerformanceSummary,
  getAppointmentSummary,
  getUpcomingAppointments,
  recentRecords,
} from "./reasoning";
import { getOrderSummary, getRecentActivity } from "@/lib/dashboard/whatHappened";
import { getCustomerSummaries } from "@/lib/dashboard/customers";
import { ENTITY_TYPES } from "./entities";
import { getCommitments, type CommitmentHorizon } from "@/lib/businessAssets/commitments";
import { getOwnerUnderstanding } from "@/lib/intelligence/learn";
import { getBusinessProfile, type BusinessProfile } from "./profile";
import { getBeliefs } from "@/lib/intelligence/learn";
import { getRecentDecisionOutcomes, type RecentDecisionOutcome } from "./reasoning";
import { currentAssetsByRole, type DesignatedAsset } from "./assets";
import { relationsByKind } from "./relationships";

// J4 Foundation — the canonical representation of what J4 knows about a
// business at any point in time (J4_FOUNDATION.md, Gap A). Combines the
// three things Reason already assembled for itself, in one reusable place:
// current facts (getBusinessProfile), learned patterns (getBeliefs), and
// recent human decisions (getRecentDecisionOutcomes) — plus what J4 has
// already said (active CognitiveOutput rows), so a fresh consumer doesn't
// repeat or contradict a still-open conversation.
//
// Deliberately read-only, no side effects — this must be safe to call from
// a conversational turn (chat) as often as an owner asks a question,
// unlike lib/intelligence/learn.ts's distillBeliefs, which writes. A
// caller that needs freshly-distilled beliefs (lib/intelligence/
// cognitiveLayer.ts's runCognitiveReview) calls distillBeliefs itself
// first, then this — same ordering guarantee that file already documented
// before this function existed, just no longer duplicated inline there.
//
// "There should only be one J4" (Sean, 2026-08-04): this is the one real
// answer to "what does J4 know," reused by every future consumer —
// recommendations, chat, the eventual meeting-with-J4 opener — rather than
// each assembling its own subset of the same underlying facts and beliefs.

export interface ActiveThought {
  id: string;
  kind: string;
  summary: string;
  priority: string | null;
  // The confidence signal (2026-08-04) — evidential certainty, distinct
  // from priority (business importance). recommendation/opportunity only;
  // null for every other kind, and null for rows written before this
  // column existed.
  confidence: number | null;
  generatedAt: string;
}

// J4 Foundation, Gap C (J4_FOUNDATION.md, closed 2026-08-05) — the store's
// own relationship with the platform itself, a genuinely different axis
// from the four categories above: not a fact about the owner's business,
// a fact about the owner's relationship with Genesis. Real as of the
// Growth Points pricing freeze; previously fetched ad hoc and
// independently by both cognitiveLayer.ts and ai-actions.ts (the same
// duplicated-assembly problem Gap A eliminated for facts/beliefs,
// recurring here until now).
export interface PlatformRelationship {
  planId: string | null;
  planName: string | null;
  growthPointBalance: number;
  subscriptionStatus: string | null;
  businessPartnerTrialEndsAt: string | null;
  /**
   * How this store's own proposals of each action type have actually fared.
   *
   * Here rather than among the business facts because it is J4's history WITH
   * this business, not a fact ABOUT it — which is what platformRelationship
   * already holds. cognitiveLayer fetched it for itself until 2026-08-24.
   */
  actionTypeTrackRecord: Awaited<ReturnType<typeof getActionTypeTrackRecord>>;
}

/**
 * WHAT IS STANDING IN THE WAY OF WHAT (2026-08-22, U2).
 *
 * A goal and the challenges actually blocking it, resolved to real descriptions
 * rather than left as ids for each consumer to join.
 *
 * WHY THIS IS PART OF UNDERSTANDING RATHER THAN A SEPARATE LOOKUP: the reason
 * stated at the top of this file — there is one answer to "what does J4 know",
 * and a connection between two facts is part of that answer as much as either
 * fact is. Typed relationships that reasoning cannot see are an inert
 * representation; the whole point of naming the `blocks` kind was that J4 could
 * finally say "this is the thing standing between you and that", and it can only
 * say it if it is told.
 *
 * Empty is the ordinary state and an honest one: nothing in the product
 * populates a goal's or challenge's reference arrays automatically yet, so today
 * these come from links the owner drew (lib/businessModel/statements.ts) or from
 * a connector that supplies them.
 */
export interface BlockedGoal {
  goalId: string;
  goal: string;
  blockedBy: { challengeId: string; challenge: string }[];
}

/**
 * A section of the understanding that costs real money to assemble.
 *
 * OPT-IN, AND STILL THE SAME ASSEMBLER. Naming a section asks
 * getBusinessUnderstanding for MORE of the same understanding — it does not
 * compose a second one. Invariant 1 holds: exactly one thing turns providers
 * into an understanding.
 *
 * Why sections exist at all: `recentRecords` is one query per entity type, and
 * there are seventeen. Folding it into the core would make all eleven consumers
 * pay seventeen extra reads for a map only the data answer reads — and that
 * fan-out is not hypothetical, it has already exhausted PGlite's single
 * connection and killed an unrelated verification suite three positions later.
 */
export type UnderstandingSection = "recentRecords";

/** Summaries of what the connected systems say, when any are connected. */
export interface ConnectedSummaries {
  invoice: Awaited<ReturnType<typeof getInvoiceSummary>>;
  campaign: Awaited<ReturnType<typeof getCampaignPerformanceSummary>>;
  appointment: Awaited<ReturnType<typeof getAppointmentSummary>>;
}

/**
 * A discount the owner is running right now.
 *
 * `id` is carried so a later tool can name WHICH promotion to change without
 * asking the owner for one — and `name` is what may be shown. A cuid has been
 * put in front of a customer in this codebase before; these two fields are
 * deliberately not interchangeable.
 */
export interface ActivePromotion {
  id: string;
  name: string;
  kind: "SALE" | "CODE";
  /** The code a customer types, for a CODE. Null for a storewide SALE. */
  code: string | null;
  percentOff: number | null;
  amountOffInCents: number | null;
  scope: string;
  startsAt: Date | null;
  endsAt: Date | null;
  /** How many products it applies to, when its scope is specific ones. */
  productCount: number;
}

/**
 * An order recent enough for the owner to still be talking about it.
 *
 * NO ORDER NUMBER EXISTS. The Order model has a cuid and Stripe's session
 * id, and neither is something a person says out loud. So an order is
 * identified here the way an owner actually refers to one - what was bought,
 * who bought it, when - and the id is carried for a handler to resolve that
 * description to a row. Inventing a customer-facing order number to fill the
 * gap would be a new identifier nobody asked for.
 */
export interface RecentOrder {
  id: string;
  productName: string;
  buyerEmail: string;
  quantity: number;
  amountInCents: number;
  placedAt: Date;
  status: string;
  fulfillmentStatus: string | null;
  /** Null when nothing has been attached yet - which is what makes it attachable. */
  trackingNumber: string | null;
  carrier: string | null;
}

export interface BusinessUnderstanding {
  profile: BusinessProfile;
  /**
   * WHAT THE CONNECTED SYSTEMS SAY (2026-08-24, One Canonical Understanding).
   *
   * Folded in because two reasoning consumers had independently decided they
   * needed it — buildChatDataContext for the data answer, cognitiveLayer for
   * proactive reasoning — each fetching the same three summaries by its own
   * route. Two consumers reaching the same conclusion separately is the
   * strongest available evidence that it belongs in the shared understanding
   * rather than in either of them.
   */
  connectedSummaries: ConnectedSummaries;
  /** Appointments still ahead, from a connected calendar. */
  upcomingAppointments: Awaited<ReturnType<typeof getUpcomingAppointments>>;
  /** What has happened lately: orders, customers, and the activity feed. */
  recentBusiness: {
    orders: Awaited<ReturnType<typeof getOrderSummary>>;
    customers: Awaited<ReturnType<typeof getCustomerSummaries>>;
    activity: Awaited<ReturnType<typeof getRecentActivity>>;
  };
  /**
   * The N most recent records of every entity type.
   *
   * OPT-IN — null unless the caller asked for "recentRecords". Seventeen
   * queries; see UnderstandingSection.
   */
  recentRecords: Record<string, unknown[]> | null;
  /**
   * WHEN THIS IS TRUE AS OF, and how far through the event stream (D5).
   *
   * The understanding has always been a snapshot with no "as of" — so nothing
   * reading it could ask what changed since, and every consumer wanting that
   * invented its own cursor. BusinessEvent.sequence is a monotonic
   * autoincrement, so a later reader asks for everything after this number
   * without comparing timestamps across clocks.
   *
   * This is the temporal ANCHOR, not history: the point from which history can
   * be asked about. Reasoning over it is the intelligence engine's job, not
   * this one's.
   *
   * A CORRECTION TO THE PROPOSAL THAT ASKED FOR THIS: the understanding already
   * carried `asOf`. What it lacked was the event mark — the half that makes
   * "what changed since" answerable without comparing clocks. Only that was
   * added.
   */
  throughEventSequence: string | null;
  /**
   * THE DISCOUNTS CURRENTLY RUNNING (2026-09-03).
   *
   * Added because J4 could CREATE a promotion and then never see it again:
   * `Promotion` was not referenced in this file at all, and the Business Map's
   * "On sale in your storefront" is a PRODUCT's active flag, not a discount.
   * So J4 could not answer "what sales am I running?", and could not stop a
   * sale because it could not name one. An owner asking either of those is
   * asking about money.
   *
   * ACTIVE ONLY, and bounded. Every promotion ever run is history, and history
   * belongs to the intelligence engine reasoning over BusinessEvent, not to a
   * snapshot that every turn pays for.
   */
  activePromotions: ActivePromotion[];
  /**
   * THE STORE'S OWN CURRENCY (2026-09-04).
   *
   * Added because a promotion reached the model as "5.00 off" - a bare
   * number with no currency at all, which is worse than the wrong symbol: a
   * model handed an unlabelled figure will supply a symbol itself, and the
   * owner hears a currency nobody chose. Every amount in this understanding
   * is denominated in this.
   *
   * NULL ONLY IF THE STORE ROW IS GONE, in which case there is no business to
   * describe and nothing to format. It is not a default, and specifically not
   * "USD" - inventing one here is the exact failure the rule exists to stop.
   */
  currency: string | null;
  /**
   * THE ORDERS THE OWNER MIGHT STILL MENTION (2026-09-03, P1).
   *
   * getOrderSummary counts orders and sums revenue; it returns no individual
   * ones. So J4 knew a store had eleven orders and could not name a single
   * one of them - which makes "add this tracking number to the mug order"
   * unanswerable, and tracking is the most ordinary thing an owner does all
   * day.
   *
   * BOUNDED AND RECENT, not the order history. Everything ever sold belongs
   * to the intelligence engine reasoning over BusinessEvent, not to a snapshot
   * assembled on every turn.
   */
  recentOrders: RecentOrder[];
  /** What is standing in the way of what. See BlockedGoal. */
  blockedGoals: BlockedGoal[];
  beliefs: Awaited<ReturnType<typeof getBeliefs>>;
  recentDecisions: RecentDecisionOutcome[];
  // Everything J4 currently considers still-open — every ACTIVE
  // CognitiveOutput kind (explanation/recommendation/opportunity/insight/
  // prediction), not just the two kinds the dashboard's own recommendation
  // feed surfaces (lib/dashboard/recommendations.ts's genesisProducer) —
  // a conversational consumer needs the fuller picture. Capped at the 20
  // most recent so this stays a real, current snapshot, not an
  // ever-growing unbounded history for a long-lived store.
  activeThoughts: ActiveThought[];
  platformRelationship: PlatformRelationship;
  // What J4 can point at (2026-08-16) — the asset currently holding each
  // role, keyed by role. This is what makes "that logo" resolvable: before
  // it, the only real answer to "what is the brand logo" was Store.logoUrl,
  // a column that renders but cannot be referred to, versioned, or handed to
  // a design step. Part of Understand rather than a separate lookup for the
  // reason stated at the top of this file — there is one answer to "what
  // does J4 know", and a designated asset is part of that answer.
  currentAssets: Record<string, DesignatedAsset>;
  /**
   * Dated commitments read out of the owner's own documents (2026-08-21).
   *
   * J4_FOUNDATION.md's last non-blocked coverage gap: a lease expiring in
   * December was a sentence in Asset.summary and nothing J4 could act on weeks
   * later. Part of Understand for the reason stated at the top of this file —
   * there is one answer to "what does J4 know", and a deadline the business is
   * bound by belongs in it.
   *
   * Empty is the ordinary state and an honest one: most files state no dates.
   */
  commitments: CommitmentHorizon;
  /**
   * What J4 has learned about the PERSON, not the business (2026-08-21).
   *
   * J4_OWNER_UNDERSTANDING.md's bar: "if two businesses were identical but
   * owned by different people, J4 would advise each owner differently."
   *
   * Empty unless the reader IS the owner — these are patterns about one named
   * person's decision-making, and an employee of the same store has no reading
   * of them. Separate from `beliefs` rather than mixed into it so a consumer
   * can tell a pattern about the business from a pattern about the person; the
   * two must never blend, per that document's own one-direction rule.
   */
  ownerUnderstanding: Awaited<ReturnType<typeof getOwnerUnderstanding>>;
  asOf: string;
}

export async function getBusinessUnderstanding(
  storeId: string,
  opts?: {
    /**
     * Who is reading this. Owner-scoped beliefs and `ownerUnderstanding` are
     * populated only when this is the store's own owner — omitted means a
     * business-level view, which is the safe default for the more sensitive of
     * the two categories.
     */
    viewerUserId?: string | null;
    /**
     * Expensive sections this caller actually needs.
     *
     * Omitted means the core, which is what every consumer gets and what every
     * consumer can reason from. A section is not a second source of truth — it
     * is the same assembler, asked for more.
     */
    include?: readonly UnderstandingSection[];
  }
): Promise<BusinessUnderstanding> {
  const wantsRecentRecords = opts?.include?.includes("recentRecords") ?? false;
  const [
    profile,
    beliefs,
    recentDecisions,
    activeOutputs,
    store,
    currentAssets,
    commitments,
    // POSITIONAL, and the order below must match exactly. Appending this binding
    // while inserting its query mid-array silently paired blockedGoals with the
    // owner-understanding read — which typechecked far enough to be confusing.
    blocking,
    ownerUnderstanding,
    // FOLDED IN 2026-08-24. Each of these was previously fetched by a consumer
    // for itself — three of them by two consumers independently.
    invoiceSummary,
    campaignSummary,
    appointmentSummary,
    upcomingAppointments,
    orderSummary,
    customerSummaries,
    recentActivity,
    actionTypeTrackRecord,
    // OPT-IN. Seventeen queries when asked for, one cheap no-op when not.
    // Named apart from the imported recentRecords helper it calls.
    recentRecordsSection,
    // The high-water mark this assembly reflects. One indexed read.
    latestEvent,
    // Appended LAST to match its query. See the note beside it.
    activePromotionRows,
    recentOrderRows,
  ] = await Promise.all([
    getBusinessProfile(storeId),
    getBeliefs(storeId, { viewerUserId: opts?.viewerUserId }),
    getRecentDecisionOutcomes(storeId),
    prisma.cognitiveOutput.findMany({
      where: { storeId, status: "ACTIVE" },
      orderBy: { generatedAt: "desc" },
      take: 20,
      select: { id: true, kind: true, summary: true, priority: true, confidence: true, generatedAt: true },
    }),
    prisma.store.findUnique({
      where: { id: storeId },
      select: {
        // THE MONEY THIS BUSINESS IS DENOMINATED IN. Not a platform detail:
        // it belongs to the business, and anything that turns one of its
        // figures into a string needs it.
        currency: true,
        planId: true,
        growthPointBalance: true,
        subscriptionStatus: true,
        businessPartnerTrialEndsAt: true,
        plan: { select: { name: true } },
      },
    }),
    currentAssetsByRole(storeId),
    getCommitments(storeId),
    // ONE INDEXED QUERY, not a traversal. The convention this replaced answered
    // the same question by loading every record of all fifteen entity types and
    // scanning their keys in memory.
    relationsByKind(storeId, "blocks"),
    opts?.viewerUserId ? getOwnerUnderstanding(storeId, opts.viewerUserId) : Promise.resolve([]),
    // POSITIONAL — the destructuring above must match, and the file's own
    // comment explains what happens when it does not.
    getInvoiceSummary(storeId),
    getCampaignPerformanceSummary(storeId),
    getAppointmentSummary(storeId),
    getUpcomingAppointments(storeId),
    getOrderSummary(storeId, { includeRevenue: true }),
    getCustomerSummaries(storeId, { includeRevenue: true, limit: 10 }),
    getRecentActivity(storeId, 10),
    getActionTypeTrackRecord(storeId),
    // SEVENTEEN QUERIES, OR NONE. Not "cheap when unused" by accident — the
    // whole reason this is a section is that its cost is real.
    wantsRecentRecords
      ? (Promise.all(ENTITY_TYPES.map((t) => recentRecords(storeId, t))).then((lists) =>
          Object.fromEntries(
            ENTITY_TYPES.map((t, i) => [t, lists[i].map((r: { data: unknown }) => r.data)])
          )
        ) as Promise<Record<string, unknown[]> | null>)
      : Promise.resolve(null),
    prisma.businessEvent.findFirst({
      where: { storeId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    }),
    // APPENDED LAST, with its binding appended last too. This file's own
    // comment above records what happens when a binding is added at the end
    // while its query goes in the middle: it typechecks far enough to be
    // confusing. One indexed read on (storeId, active).
    prisma.promotion.findMany({
      where: { storeId, active: true },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        name: true,
        kind: true,
        code: true,
        percentOff: true,
        amountOffInCents: true,
        scope: true,
        startsAt: true,
        endsAt: true,
        _count: { select: { products: true } },
      },
    }),
    // Appended last, with its binding appended last. One indexed read on
    // (storeId, createdAt).
    prisma.order.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        productName: true,
        buyerEmail: true,
        quantity: true,
        amountInCents: true,
        createdAt: true,
        status: true,
        fulfillmentStatus: true,
        trackingNumber: true,
        carrier: true,
      },
    }),
  ]);

  // Resolved against the goals and challenges ALREADY fetched, so naming what
  // blocks what costs no further reads. A relationship pointing at a record this
  // profile does not carry is silently skipped rather than rendered as an id: a
  // description an owner cannot read is worse than a connection left unstated.
  const challengeById = new Map(profile.challenges.map((c) => [c.id, c.data.description]));
  const blockedGoals: BlockedGoal[] = profile.goals
    .map((g) => ({
      goalId: g.id,
      goal: g.data.description,
      blockedBy: blocking
        .filter((r) => r.toId === g.id)
        .map((r) => ({ challengeId: r.fromId, challenge: challengeById.get(r.fromId) }))
        .filter((b): b is { challengeId: string; challenge: string } => b.challenge !== undefined),
    }))
    .filter((entry) => entry.blockedBy.length > 0);

  return {
    profile,
    blockedGoals,
    currency: store?.currency ?? null,
    activePromotions: activePromotionRows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      code: row.code,
      percentOff: row.percentOff,
      amountOffInCents: row.amountOffInCents,
      scope: row.scope,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      productCount: row._count.products,
    })),
    recentOrders: recentOrderRows.map((row) => ({
      id: row.id,
      productName: row.productName,
      buyerEmail: row.buyerEmail,
      quantity: row.quantity,
      amountInCents: row.amountInCents,
      placedAt: row.createdAt,
      status: row.status,
      fulfillmentStatus: row.fulfillmentStatus,
      trackingNumber: row.trackingNumber,
      carrier: row.carrier,
    })),
    connectedSummaries: {
      invoice: invoiceSummary,
      campaign: campaignSummary,
      appointment: appointmentSummary,
    },
    upcomingAppointments,
    recentBusiness: {
      orders: orderSummary,
      customers: customerSummaries,
      activity: recentActivity,
    },
    recentRecords: recentRecordsSection,
    // BigInt does not survive JSON, and this reaches prompts and payloads.
    throughEventSequence: latestEvent ? String(latestEvent.sequence) : null,
    beliefs,
    recentDecisions,
    currentAssets,
    commitments,
    ownerUnderstanding,
    activeThoughts: activeOutputs.map((o) => ({
      id: o.id,
      kind: o.kind,
      summary: o.summary,
      priority: o.priority,
      confidence: o.confidence,
      generatedAt: o.generatedAt.toISOString(),
    })),
    platformRelationship: {
      planId: store?.planId ?? null,
      planName: store?.plan?.name ?? null,
      growthPointBalance: store?.growthPointBalance ?? 0,
      subscriptionStatus: store?.subscriptionStatus ?? null,
      businessPartnerTrialEndsAt: store?.businessPartnerTrialEndsAt?.toISOString() ?? null,
      actionTypeTrackRecord,
    },
    asOf: new Date().toISOString(),
  };
}
