import { readOwnerFacts } from "./ownerFacts";
import { currentFacts } from "./factLifecycle";
import { prisma } from "@/lib/prisma";
import { getProfitability, type Profitability } from "./profitability";
import { getObligations, type Obligations } from "./obligations";
import { getAudience, type Audience } from "./audience";
import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { businessCategoryLabel, revenueStreamLabel } from "@/lib/businessTaxonomy";
import type { BlueprintContextSubset } from "@/lib/execution/genesisActions";
import {
  queryRecords,
  getRevenue,
  getTopContacts,
  getCustomerSegments,
  getItemPerformance,
  getItemPerformanceTrend,
  getCustomerSegmentTrend,
  type TopContact,
  type CustomerSegments,
  type ItemPerformance,
  type ItemPerformanceTrend,
  type CustomerSegmentTrends,
} from "./reasoning";
import type { CanonicalRecord } from "./entities";

// Phase 3 Milestone 5 (J4 Business Understanding Model) — the actual
// "single source of truth" read API Sean asked for. Nothing in here is a
// second copy of anything: every field is read live from whichever real
// source already owns it (Store's own columns/blueprint JSON, StoreMember,
// StoreIntegration + CONNECTOR_CATALOG, and the canonical entity registry
// via reasoning.ts's queryRecords/getRevenue/getTopContacts/
// getCustomerSegments). This function is what closes the gap between the
// two independent context-assembly stacks that existed before this
// milestone (generateGenesisRecommendations.ts's bespoke helpers vs.
// reasoning.ts's canonical layer) — both are wired to read from this going
// forward for the fields it covers, rather than each re-deriving its own
// subset of the same underlying facts.
//
// This does not try to precompute a canned answer to "what is important
// about this business" — it hands back real, current goals/challenges/
// top-customers/USP/brand-promise so whatever consumes it (chat, the
// Recommendation Engine, and eventually the future AI-reasoning layer this
// milestone was explicitly asked to set up for) can synthesize that
// narrative from real material — the same "give the model real computed
// data, let it write the prose" discipline already used everywhere else in
// this codebase.

export interface BusinessProfile {
  identity: {
    name: string;
    tagline: string | null;
    // GENERATED COPY, all of it — what the storefront says about itself.
    description: string | null;
    brandStory: string | null;
    missionStatement: string | null;
    visionStatement: string | null;
    brandPromise: string | null;
    coreValues: string[];
    /**
     * The four claims J4 reasons from, read from owner-authoritative facts
     * rather than from the blueprint (D1-A). Null means nobody has stated one.
     */
    targetAudience: string | null;
    brandPersonality: string | null;
    brandVoiceAndTone: string | null;
    uniqueSellingProposition: string | null;
    // SOURCE INFORMATION — what the owner told us, never generated and never
    // rendered to a customer. Null means they have not said, which is a real
    // answer and is never filled in from the copy above.
    offering: string | null;
    intent: string | null;
  };
  classification: {
    businessCategories: { slug: string; label: string }[];
    revenueStreams: { slug: string; label: string }[];
  };
  /**
   * THE CATALOGUE — what this business actually lists and how it sells.
   *
   * Not to be confused with `identity.offering`, which is the owner's own
   * sentence about what they do. A business can have said what it offers and
   * have nothing listed yet, or list ten things and never have described
   * itself; these answer different questions and neither substitutes.
   */
  offerings: {
    items: CanonicalRecord<"item">[];
    activeCount: number;
    // Tier 4 validation, Stage B — wired here (not a new query elsewhere)
    // so this stays the one place any future consumer reads item-level
    // business facts, same "single source of truth" discipline the rest of
    // this file already follows.
    performance: ItemPerformance[];
    trends: ItemPerformanceTrend[];
  };
  revenue: {
    last30DaysInCents: number;
    allTimeInCents: number;
  };
  customers: {
    topContacts: TopContact[];
    segments: CustomerSegments;
    segmentTrends: CustomerSegmentTrends;
    totalContactCount: number;
  };
  people: {
    owner: { name: string | null; email: string } | null;
    members: { name: string | null; email: string; role: string }[];
    employees: CanonicalRecord<"employee">[];
  };
  suppliers: CanonicalRecord<"contact">[];
  connectedSystems: {
    provider: string;
    displayName: string;
    status: string;
    lastSyncedAt: Date | null;
    // Integrations (Chapter 4, continued) — a real, deterministic freshness
    // read, not left to the model's own date arithmetic. null means never
    // synced. isStale means the real sync cadence (see
    // SYNC_INTERVAL_FOR_STALENESS_MS below) has been exceeded — this is
    // what tells a prompt when a "as of your last sync" qualifier is
    // actually warranted versus just noise on data that's genuinely fresh.
    syncedAgoLabel: string | null;
    isStale: boolean;
  }[];
  goals: CanonicalRecord<"goal">[];
  challenges: CanonicalRecord<"challenge">[];
  locations: CanonicalRecord<"location">[];
  // Business Assets M5 — every real owner-uploaded photo/document, so this
  // single "current facts" object is what makes uploaded knowledge actually
  // reach planning, the Business Intelligence Engine, and the future "What
  // J4 Knows" review UI, not just the chat turn it arrived in. Includes
  // unclassified/low-confidence assets too (never filtered out here) —
  // consumers decide how to treat confidence, this is just the real facts.
  assets: CanonicalRecord<"asset">[];
  // Social Connections & Business Intelligence (2026-08-09) — real,
  // currently-synced Facebook/Instagram/TikTok account data, reaching
  // getBusinessUnderstanding() the moment it's connected (unlike Campaign,
  // whose own gap this deliberately avoids repeating — see this field's
  // own read site in lib/dashboard/storeChatUnified.ts for how J4 is
  // instructed to interpret, not just relay, this data).
  socialAccounts: CanonicalRecord<"socialAccount">[];
  // M5 (2026-08-18) — what the owner actually KEEPS, not just what came in.
  // Product.costInCents and getProfitSummary were both already real; they had
  // one caller (the Analytics page), so J4 could not answer "I sold $400, what
  // did I keep?" while the number sat computed one page away.
  //
  // Carries its own coverage, deliberately: profitInCents is null when no
  // order has a known cost, and a product with no recorded cost has a null
  // margin rather than an assumed one. Nothing here may be read as zero cost.
  // Same revenue tier as revenue30d/revenueAllTime above — a dollar figure,
  // gated by whoever gates those, not newly exposed by this field.
  profitability: Profitability;
  // M6 (2026-08-18) — what the owner OWES, not just what came in. Order has
  // carried fulfillmentStatus/trackingNumber/createdAt for a while and
  // getFulfillmentBreakdown already counted them, for the Analytics page
  // alone; J4 could see that money arrived and never whether anything shipped.
  //
  // Four distinct facts, kept distinct: paid-and-unfulfilled is owed, refunded
  // is not, fulfillmentStatus is the owner's own acknowledgment rather than
  // proof of shipment, and a tracking number means a label exists rather than
  // a parcel delivered. No shipping address is carried here at all.
  obligations: Obligations;
  // M8 (2026-08-19) — interest, not just purchases. NewsletterSignup is written
  // by the live storefront and was read by one dashboard page; contacts are
  // derived from ORDERS ONLY, so someone who gave their email but hasn't bought
  // did not exist in J4's understanding at all.
  //
  // Counts and timestamps only — no email addresses are read from the database.
  // Kept strictly separate from contacts/segments: a subscriber is evidence of
  // interest, never a customer, and nothing here touches the canonical contact
  // model.
  audience: Audience;
  asOf: string;
}

const CATALOG_NAME_BY_PROVIDER = new Map(
  CONNECTOR_CATALOG.filter((entry) => entry.provider).map(
    (entry) => [entry.provider as string, entry.name] as const
  )
);

// Mirrors lib/intelligence/scheduler.ts's own DEFAULT_SYNC_INTERVAL_MS (6h)
// — that constant isn't exported (scheduler.ts owns *when* a sync runs,
// this only judges staleness for prompt framing), so this is a deliberate,
// small, independent copy of the same real cadence rather than a shared
// import across an otherwise unrelated module boundary.
const SYNC_INTERVAL_FOR_STALENESS_MS = 6 * 60 * 60 * 1000;

function describeSyncAge(lastSyncedAt: Date | null): { syncedAgoLabel: string | null; isStale: boolean } {
  if (!lastSyncedAt) return { syncedAgoLabel: null, isStale: false };
  const ageMs = Date.now() - lastSyncedAt.getTime();
  const ageMinutes = Math.round(ageMs / 60_000);
  const ageHours = Math.round(ageMs / 3_600_000);
  const ageDays = Math.round(ageMs / 86_400_000);
  const syncedAgoLabel =
    ageMinutes < 60
      ? `${Math.max(ageMinutes, 0)} minute${ageMinutes === 1 ? "" : "s"} ago`
      : ageHours < 48
        ? `${ageHours} hour${ageHours === 1 ? "" : "s"} ago`
        : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`;
  return { syncedAgoLabel, isStale: ageMs > SYNC_INTERVAL_FOR_STALENESS_MS };
}

export async function getBusinessProfile(
  storeId: string
): Promise<BusinessProfile> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    store,
    members,
    integrations,
    items,
    contacts,
    employees,
    goals,
    challenges,
    locations,
    assets,
    socialAccounts,
    ownerFacts,
    revenue30d,
    revenueAllTime,
    topContacts,
    segments,
    itemPerformance30d,
    itemTrends,
    segmentTrends,
    profitability,
    obligations,
    audience,
  ] = await Promise.all([
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      include: { user: { select: { name: true, email: true } } },
    }),
    prisma.storeMember.findMany({
      where: { storeId },
      include: { user: { select: { name: true, email: true } } },
    }),
    prisma.storeIntegration.findMany({ where: { storeId } }),
    queryRecords(storeId, "item"),
    queryRecords(storeId, "contact"),
    // CURRENT, NOT ALL, for the owner-authoritative types (D2, 2026-08-24).
    // A superseded goal is still a real row and is no longer what the owner
    // believes; showing it beside the correction would be the understanding
    // layer reporting two answers to one question.
    currentFacts(storeId, "employee"),
    currentFacts(storeId, "goal"),
    currentFacts(storeId, "challenge"),
    currentFacts(storeId, "location"),
    queryRecords(storeId, "asset"),
    queryRecords(storeId, "socialAccount"),
    readOwnerFacts(storeId),
    getRevenue(storeId, { since: thirtyDaysAgo }),
    getRevenue(storeId),
    getTopContacts(storeId),
    getCustomerSegments(storeId),
    getItemPerformance(storeId, { since: thirtyDaysAgo }),
    getItemPerformanceTrend(storeId),
    getCustomerSegmentTrend(storeId),
    getProfitability(storeId),
    getObligations(storeId),
    getAudience(storeId),
  ]);

  const blueprint = store.blueprint as BlueprintContextSubset | null;
  const brandIdentity = blueprint?.brandIdentity;

  return {
    identity: {
      name: store.name,
      tagline: store.tagline,
      description: store.description,
      // WHAT THE OWNER SAID, BESIDE WHAT GENESIS WROTE — never merged into it.
      //
      // `description` and the brandIdentity fields below are storefront copy: a
      // model's words, for customers to read. These two are the owner's own
      // answers to what do you sell and what do you want this to be. They are
      // different kinds of thing with different provenance, and the whole
      // reason they are separate fields is that a reader must be able to tell
      // which one it is holding.
      //
      // Null means the owner never told us. It is never filled from
      // `description` or from `visionStatement`, whatever those happen to say.
      offering: ownerFacts.offering,
      intent: ownerFacts.intent,
      // THE FOUR CLAIMS, READ FROM FACTS (2026-08-24, D1-A). They used to be
      // read out of blueprint.brandIdentity, where they had no author and could
      // not be corrected. Everything that reasons from them reads them here.
      targetAudience: ownerFacts.targetAudience,
      brandPersonality: ownerFacts.brandPersonality,
      brandVoiceAndTone: ownerFacts.brandVoice,
      uniqueSellingProposition: ownerFacts.sellingProposition,
      brandStory: brandIdentity?.brandStory ?? null,
      missionStatement: brandIdentity?.missionStatement ?? null,
      visionStatement: brandIdentity?.visionStatement ?? null,
      brandPromise: brandIdentity?.brandPromise ?? null,
      coreValues: brandIdentity?.coreValues ?? [],

    },
    classification: {
      businessCategories: store.businessCategories.map((slug) => ({
        slug,
        label: businessCategoryLabel(slug),
      })),
      revenueStreams: store.revenueStreams.map((slug) => ({
        slug,
        label: revenueStreamLabel(slug),
      })),
    },
    offerings: {
      items,
      activeCount: items.filter((r) => r.data.active !== false).length,
      performance: itemPerformance30d,
      trends: itemTrends,
    },
    revenue: {
      last30DaysInCents: revenue30d,
      allTimeInCents: revenueAllTime,
    },
    customers: {
      topContacts,
      segments,
      segmentTrends,
      totalContactCount: contacts.length,
    },
    people: {
      owner: store.user ? { name: store.user.name, email: store.user.email } : null,
      members: members.map((m) => ({
        name: m.user.name,
        email: m.user.email,
        role: m.role,
      })),
      employees,
    },
    // A supplier is just a Contact tagged with the "vendor" role, per the
    // reference convention M1 already established — no separate query, no
    // separate storage, filtered from the same contacts already fetched.
    suppliers: contacts.filter((r) => r.data.roles.includes("vendor")),
    connectedSystems: integrations.map((integration) => ({
      provider: integration.provider,
      displayName: CATALOG_NAME_BY_PROVIDER.get(integration.provider) ?? integration.provider,
      status: integration.status,
      lastSyncedAt: integration.lastSyncedAt,
      ...describeSyncAge(integration.lastSyncedAt),
    })),
    goals,
    challenges,
    locations,
    assets,
    socialAccounts,
    profitability,
    obligations,
    audience,
    asOf: new Date().toISOString(),
  };
}
