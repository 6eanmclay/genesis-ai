import { prisma } from "@/lib/prisma";
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
    description: string | null;
    brandStory: string | null;
    missionStatement: string | null;
    visionStatement: string | null;
    brandPromise: string | null;
    coreValues: string[];
    targetAudience: string | null;
    uniqueSellingProposition: string | null;
  };
  classification: {
    businessCategories: { slug: string; label: string }[];
    revenueStreams: { slug: string; label: string }[];
  };
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
    revenue30d,
    revenueAllTime,
    topContacts,
    segments,
    itemPerformance30d,
    itemTrends,
    segmentTrends,
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
    queryRecords(storeId, "employee"),
    queryRecords(storeId, "goal"),
    queryRecords(storeId, "challenge"),
    queryRecords(storeId, "location"),
    getRevenue(storeId, { since: thirtyDaysAgo }),
    getRevenue(storeId),
    getTopContacts(storeId),
    getCustomerSegments(storeId),
    getItemPerformance(storeId, { since: thirtyDaysAgo }),
    getItemPerformanceTrend(storeId),
    getCustomerSegmentTrend(storeId),
  ]);

  const blueprint = store.blueprint as BlueprintContextSubset | null;
  const brandIdentity = blueprint?.brandIdentity;

  return {
    identity: {
      name: store.name,
      tagline: store.tagline,
      description: store.description,
      brandStory: brandIdentity?.brandStory ?? null,
      missionStatement: brandIdentity?.missionStatement ?? null,
      visionStatement: brandIdentity?.visionStatement ?? null,
      brandPromise: brandIdentity?.brandPromise ?? null,
      coreValues: brandIdentity?.coreValues ?? [],
      targetAudience: brandIdentity?.targetAudience ?? null,
      uniqueSellingProposition: brandIdentity?.uniqueSellingProposition ?? null,
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
    asOf: new Date().toISOString(),
  };
}
