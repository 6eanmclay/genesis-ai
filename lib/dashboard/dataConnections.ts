import { prisma } from "@/lib/prisma";
import { CONNECTOR_CATALOG, type CatalogEntry } from "@/lib/integrations/catalog";
import { connectionHealthOf, type ConnectionHealth } from "@/lib/integrations/connectionHealth";
import type { ConnectedSummaries } from "@/lib/businessModel/understanding";

// WHAT J4 KNOWS, AND WHERE IT CAME FROM — assembled once, for one screen.
//
// See DATA_AND_CONNECTIONS.md, which is the contract this implements. The
// short version of why this module exists at all:
//
// The reference design's "Feed the Brain" composition shows every connected
// tool flowing into one intelligence. That argument is right and the current
// connector list cannot make it — but the picture is also wrong about this
// codebase in a specific, important way, and copying it would reintroduce a
// defect we already fixed:
//
//   MOST CONNECTIONS ARE NOT SOURCES. Stripe, PayPal, Printful, Twilio and
//   AliExpress deliberately implement no `sync` — stripe.ts says "the absence
//   of `sync` here is the answer". They are payment, fulfilment, messaging and
//   sourcing rails. A rail that has written no records is working perfectly.
//
// Seven production connections were once told "Connected and syncing. This
// provider has not returned any business data yet", which was false on both
// halves; `ConnectionEvidence.syncs` was added to stop it. A single flow
// diagram with everything pouring into a brain would say the same false thing
// again, in a prettier way. So this module separates the two populations and
// the screen labels them differently.
//
// NOTHING HERE DECIDES HEALTH. connectionHealthOf is the one answer, and a
// second opinion computed on this screen is exactly the divergence its own
// header comment describes.

/** A connector that can write business records, and what it has written. */
export interface KnowledgeSource {
  entry: CatalogEntry;
  health: ConnectionHealth;
  /** Real rows this provider has written for this store. Zero is an answer. */
  recordsProduced: number;
  lastSyncedAt: Date | null;
}

/** A connector that is not a source, and never will be. */
export interface ConnectionRail {
  entry: CatalogEntry;
  health: ConnectionHealth;
}

/** One kind of thing J4 knows, counted from the rows themselves. */
export interface KnowledgeKind {
  entityType: string;
  label: string;
  count: number;
  /** Which providers actually wrote these rows — derived, not assumed. */
  providers: string[];
}

/** A capability that exists only because something is connected. */
export interface DerivedCapability {
  label: string;
  /** What J4 can say right now, or null when nothing is connected for it. */
  available: boolean;
  /** The sentence to show. Either the real finding, or what would enable it. */
  detail: string;
}

export interface DataConnectionsModel {
  /** What J4 knows from connections, by kind. Empty is a real state. */
  knows: KnowledgeKind[];
  totalRecords: number;
  /** Connectors that can feed the knowledge base. */
  sources: KnowledgeSource[];
  /** Connectors that deliberately never will. */
  rails: ConnectionRail[];
  /** Anything a connection is asking the owner to deal with. */
  needsAttention: KnowledgeSource[] | ConnectionRail[];
  /** What connecting more would unlock, in J4's own consumption terms. */
  capabilities: DerivedCapability[];
}

/**
 * Owner-facing names for the entity types real connectors actually write.
 *
 * Not exhaustive on purpose: anything unlabelled falls back to a readable form
 * of its own key, so a new entity type appears named rather than not at all.
 */
const ENTITY_LABELS: Record<string, string> = {
  transaction: "Transactions",
  document: "Invoices & bills",
  contact: "Contacts",
  item: "Catalogue items",
  appointment: "Appointments",
  campaign: "Campaigns",
  shipment: "Shipments",
};

function entityLabel(entityType: string): string {
  const explicit = ENTITY_LABELS[entityType];
  if (explicit) return explicit;
  const words = entityType.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Which provider names the owner sees for a set of record rows.
 *
 * BusinessRecord.sourceProvider is lowercase ("quickbooks"); the catalog
 * carries the real display name. Resolved rather than title-cased, because
 * "Quickbooks" is not what QuickBooks is called.
 */
function providerLabel(sourceProvider: string): string {
  const entry = CONNECTOR_CATALOG.find(
    (e) => e.provider && e.provider.toLowerCase() === sourceProvider.toLowerCase(),
  );
  return entry?.name ?? sourceProvider;
}

export async function buildDataConnections(
  storeId: string,
  // THE REAL SUMMARY TYPES, passed in rather than re-fetched: the caller
  // already has them from the one canonical getBusinessUnderstanding(), and a
  // second fetch here would be a second answer to a question that has one.
  summaries: ConnectedSummaries,
): Promise<DataConnectionsModel> {
  // THE ROWS THEMSELVES, grouped by what they are and who sent them. One
  // query, so the counts on screen and the rows in the table cannot disagree.
  const grouped = await prisma.businessRecord.groupBy({
    by: ["entityType", "sourceProvider"],
    where: { storeId },
    _count: { _all: true },
  });

  const byEntity = new Map<string, { count: number; providers: Set<string> }>();
  for (const row of grouped) {
    const seen = byEntity.get(row.entityType) ?? { count: 0, providers: new Set<string>() };
    seen.count += row._count._all;
    // "internal" is this codebase's own mapper, not a connection. It is
    // excluded from the provider list rather than shown as a source, because
    // a goal the owner set is not something a tool told us.
    if (row.sourceProvider !== "internal") seen.providers.add(providerLabel(row.sourceProvider));
    byEntity.set(row.entityType, seen);
  }

  const knows: KnowledgeKind[] = [...byEntity.entries()]
    .map(([entityType, v]) => ({
      entityType,
      label: entityLabel(entityType),
      count: v.count,
      providers: [...v.providers].sort(),
    }))
    // Only what a connection produced. A record with no connected provider
    // behind it is internal knowledge and belongs on a different screen.
    .filter((k) => k.providers.length > 0)
    .sort((a, b) => b.count - a.count);

  const integrations = await prisma.storeIntegration.findMany({ where: { storeId } });
  const rowFor = (provider: string | null) =>
    provider ? integrations.find((i) => i.provider === provider) ?? null : null;

  const counts = await prisma.businessRecord.groupBy({
    by: ["sourceProvider"],
    where: { storeId },
    _count: { _all: true },
  });
  const recordsBy = new Map(counts.map((c) => [c.sourceProvider, c._count._all]));

  const sources: KnowledgeSource[] = [];
  const rails: ConnectionRail[] = [];

  for (const entry of CONNECTOR_CATALOG) {
    // A catalog entry with no connector is a real thing — something in the
    // catalogue that has not been built. connectionHealthOf's "unavailable"
    // already says so, and it stays in the rails column rather than being
    // presented as an unfed input.
    const connector = entry.connector;
    const integration = rowFor(entry.provider ?? null);
    const recordsProduced = entry.provider
      ? recordsBy.get(entry.provider.toLowerCase()) ?? 0
      : 0;
    // THE SAME EVIDENCE THE CONNECTIONS PAGE ALREADY BUILDS, deliberately —
    // two screens computing health differently is the divergence that
    // connectionHealth.ts exists to have ended.
    const syncs = typeof connector?.sync === "function";
    const health = connectionHealthOf({
      available: connector?.configured?.() ?? !!connector,
      row: integration
        ? {
            status: integration.status,
            syncFailureCount: integration.syncFailureCount,
            lastSyncedAt: integration.lastSyncedAt,
            lastError: integration.lastError,
          }
        : null,
      recordsProduced,
      syncs,
    });

    if (syncs) {
      sources.push({ entry, health, recordsProduced, lastSyncedAt: integration?.lastSyncedAt ?? null });
    } else {
      rails.push({ entry, health });
    }
  }

  const totalRecords = knows.reduce((sum, k) => sum + k.count, 0);

  // WHAT IS ACTUALLY WRONG. raisesAttention is the health model's own answer
  // to "should this interrupt the owner" — not a threshold invented here.
  const needsAttention = [...sources, ...rails].filter((c) => c.health.raisesAttention) as
    | KnowledgeSource[]
    | ConnectionRail[];

  // WHAT THE CONNECTIONS BUY, in J4's own terms. These are the real
  // consumption points on the one canonical understanding — connect a
  // calendar and J4 can say what is ahead; connect nothing and it cannot.
  // When a summary is null the capability is named anyway, with what would
  // produce it, because hiding a capability an owner could have is its own
  // kind of dishonesty.
  const capabilities: DerivedCapability[] = [
    // ============ ZERO IS NOT A SENTENCE (2026-09-12) =================
    //
    // "0 still ahead" was technically accurate and read like a database value
    // rather than anything an owner could use. Sean's rule: communicate
    // availability without implying activity, and never invent activity or
    // soften the underlying truth.
    //
    // So the connected-but-empty case gets its own wording and keeps its
    // available state — the capability really is working; there is simply
    // nothing in it. What it must not become is a number dressed up as news.
    {
      label: "Money owed to you",
      available: summaries.invoice !== null,
      detail: !summaries.invoice
        ? "Connect QuickBooks or Xero and J4 can tell you what is outstanding and overdue."
        : summaries.invoice.outstandingCount === 0
          ? "Nothing outstanding. J4 watches your invoices as they come in."
          : `${summaries.invoice.outstandingCount} outstanding, ${summaries.invoice.overdueCount} overdue.`,
    },
    {
      label: "What is ahead",
      available: summaries.appointment !== null,
      detail: !summaries.appointment
        ? "Connect Google Calendar and J4 can plan around what is booked."
        : summaries.appointment.upcomingCount === 0
          ? "Nothing upcoming. J4 plans around your calendar as things are booked."
          : `${summaries.appointment.upcomingCount} still ahead. J4 plans around what is booked.`,
    },
    {
      label: "How your campaigns did",
      available: summaries.campaign !== null,
      detail: summaries.campaign
        ? `${summaries.campaign.campaignCount} campaign${summaries.campaign.campaignCount === 1 ? "" : "s"} J4 can weigh when it advises on marketing.`
        : "Connect Mailchimp and J4 can use real campaign performance when it advises on marketing.",
    },
  ];

  return { knows, totalRecords, sources, rails, needsAttention, capabilities };
}
