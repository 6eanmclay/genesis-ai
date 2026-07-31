import { prisma } from "@/lib/prisma";
import {
  ENTITY_TYPES,
  type CanonicalRecord,
  type EntityType,
} from "./entities";
import {
  deriveContactsFromOrders,
  mapOrdersToTransactions,
  mapProductsToItems,
} from "./internalMapper";

// Phase 3 Milestone 1 (J4 Foundation) — the reasoning layer. A small set of
// generic primitives (queryRecords/findRelated/aggregate) that work for any
// registered entity type, including ones added later, plus a handful of
// domain convenience functions built on top. New domain questions get a new
// convenience function; the primitives themselves should never need to
// change for a new entity type or a new business question.

// Which field on an entity type's canonical data represents "the" date for
// date-window filtering — entity types with no natural date (contact, item)
// are simply never date-filtered. Adding a new entity type with its own
// date concept is one new line here, not a change to queryRecords itself.
const DATE_FIELD: Partial<Record<EntityType, string>> = {
  transaction: "date",
  appointment: "startAt",
  campaign: "sentAt",
  document: "issuedAt",
};

// Entity types the internal mapper (lib/businessModel/internalMapper.ts)
// can compute live from the store's own Order/Product data. Every other
// registered entity type has no internal equivalent — queryRecords for
// those returns only persisted BusinessRecord rows (empty until a real
// connector exists, an honest empty state, not an error).
const INTERNALLY_MAPPED: ReadonlySet<EntityType> = new Set([
  "contact",
  "transaction",
  "item",
]);

async function computeInternalRecords(
  storeId: string,
  entityType: EntityType
): Promise<CanonicalRecord<EntityType>[]> {
  if (entityType === "item") {
    const products = await prisma.product.findMany({ where: { storeId } });
    return mapProductsToItems(products);
  }
  if (entityType === "transaction" || entityType === "contact") {
    const orders = await prisma.order.findMany({ where: { storeId } });
    return entityType === "transaction"
      ? mapOrdersToTransactions(orders)
      : deriveContactsFromOrders(orders);
  }
  return [];
}

async function loadPersistedRecords(
  storeId: string,
  entityType: EntityType
): Promise<CanonicalRecord<EntityType>[]> {
  const rows = await prisma.businessRecord.findMany({
    where: { storeId, entityType },
  });
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entityType as EntityType,
    sourceProvider: row.sourceProvider,
    data: row.data as CanonicalRecord["data"],
    syncedAt: row.syncedAt,
  }));
}

export interface QueryRecordsOptions<T extends EntityType = EntityType> {
  since?: Date;
  until?: Date;
  filter?: (data: CanonicalRecord<T>["data"]) => boolean;
}

// The core generic primitive. Merges live-computed internal records (for
// the entity types the internal mapper covers) with persisted BusinessRecord
// rows (every entity type, from any connected provider) into one array,
// each item still tagged with its real sourceProvider — this merge is
// designed now even though the external side returns nothing until a real
// connector exists (Phase 3 Milestone 2), same "build the seam now, prove
// one side, prove the other later" approach already used for
// CONNECTOR_CATALOG's `connector: null` entries.
//
// Generic over T so callers querying a specific entityType (the normal
// case) get a properly narrowed CanonicalRecord<T>[] back, not the full
// cross-entity union — the cast here is safe because every record returned
// genuinely was fetched/computed for exactly this entityType.
export async function queryRecords<T extends EntityType>(
  storeId: string,
  entityType: T,
  opts: QueryRecordsOptions<T> = {}
): Promise<CanonicalRecord<T>[]> {
  const [internal, persisted] = await Promise.all([
    INTERNALLY_MAPPED.has(entityType)
      ? computeInternalRecords(storeId, entityType)
      : Promise.resolve([]),
    loadPersistedRecords(storeId, entityType),
  ]);

  let records = [...internal, ...persisted] as CanonicalRecord<T>[];

  const dateField = DATE_FIELD[entityType];
  if (dateField && (opts.since || opts.until)) {
    records = records.filter((record) => {
      const raw = (record.data as Record<string, unknown>)[dateField];
      if (typeof raw !== "string") return false;
      const value = new Date(raw).getTime();
      if (opts.since && value < opts.since.getTime()) return false;
      if (opts.until && value > opts.until.getTime()) return false;
      return true;
    });
  }

  if (opts.filter) {
    records = records.filter((record) => opts.filter!(record.data));
  }

  return records;
}

// Reverse relationship lookup: for every registered entity type, find every
// record whose data references `recordId` via the xxxId/xxxIds naming
// convention — generic over any entity type, including ones added later,
// since it never needs to know a specific schema's field names ahead of
// time. A simple in-memory scan over already-fetched records is the correct
// starting implementation for real small-business record volumes; a
// targeted JSON-path DB query is a reasonable later optimization if volume
// ever justifies it, not needed now.
export async function findRelated(
  storeId: string,
  recordId: string
): Promise<CanonicalRecord[]> {
  const allRecordSets = await Promise.all(
    ENTITY_TYPES.map((entityType) => queryRecords(storeId, entityType))
  );

  const related: CanonicalRecord[] = [];
  for (const records of allRecordSets) {
    for (const record of records) {
      if (record.id === recordId) continue;
      const data = record.data as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
        if (key.endsWith("Ids") && Array.isArray(value)) {
          if (value.includes(recordId)) {
            related.push(record);
            break;
          }
        } else if (key.endsWith("Id") && value === recordId) {
          related.push(record);
          break;
        }
      }
    }
  }
  return related;
}

// Phase 3 Milestone 5 — per Sean's explicit direction: every business
// entity should be able to accumulate observations, insights,
// recommendations, and history, and future reasoning depends more on the
// relationships between entities than on any one record in isolation. This
// is the concrete query surface for that: everything Genesis has ever
// noticed, recommended, or logged about ONE specific record, plus every
// other record connected to it via the same reference convention
// findRelated already traverses.
//
// Three real sources, no new storage: BusinessEvent (Milestone 3, already
// recordId-linked — the append-only fact log, i.e. "history"),
// GenesisObservation and GeneratedRecommendation (both just gained a
// nullable recordId/entityType pair, same honest-null convention as
// BusinessEvent's own — most existing rows predate this and are correctly
// unlinked/store-level; only rows created going forward that are genuinely
// about one entity populate it).
export interface EntityHistory {
  record: CanonicalRecord | null;
  related: CanonicalRecord[];
  events: { eventType: string; summary: string; occurredAt: Date }[];
  observations: {
    genesisState: string;
    summary: string;
    status: string;
    firstNoticedAt: Date;
  }[];
  // Phase 3 Milestone 6 — reads CognitiveOutput now, not the legacy
  // GeneratedRecommendation (superseded, see that model's own schema
  // comment). Covers every kind Genesis has reasoned about this record —
  // insights, explanations, recommendations, opportunities, predictions —
  // not just recommendations, hence the rename from this field's original
  // M5 name.
  cognitiveOutputs: {
    kind: string;
    message: string;
    priority: string | null;
    generatedAt: Date;
  }[];
}

export async function getEntityHistory<T extends EntityType>(
  storeId: string,
  entityType: T,
  recordId: string
): Promise<EntityHistory> {
  const [records, related, events, observations, cognitiveOutputs] =
    await Promise.all([
      queryRecords(storeId, entityType),
      findRelated(storeId, recordId),
      prisma.businessEvent.findMany({
        where: { storeId, recordId },
        orderBy: { occurredAt: "desc" },
      }),
      prisma.genesisObservation.findMany({
        where: { storeId, recordId },
        orderBy: { firstNoticedAt: "desc" },
      }),
      prisma.cognitiveOutput.findMany({
        where: { storeId, recordId },
        orderBy: { generatedAt: "desc" },
      }),
    ]);

  return {
    record: records.find((r) => r.id === recordId) ?? null,
    related,
    events: events.map((e) => ({
      eventType: e.eventType,
      summary: e.summary,
      occurredAt: e.occurredAt,
    })),
    observations: observations.map((o) => ({
      genesisState: o.genesisState,
      summary: o.summary,
      status: o.status,
      firstNoticedAt: o.firstNoticedAt,
    })),
    cognitiveOutputs: cognitiveOutputs.map((r) => ({
      kind: r.kind,
      message: r.summary,
      priority: r.priority,
      generatedAt: r.generatedAt,
    })),
  };
}

export function aggregate(
  records: CanonicalRecord[],
  opts: { field: string; op: "sum" | "count" | "avg" }
): number {
  if (opts.op === "count") return records.length;

  const values = records.map((record) => {
    const raw = (record.data as Record<string, unknown>)[opts.field];
    return typeof raw === "number" ? raw : 0;
  });
  const sum = values.reduce((acc, value) => acc + value, 0);
  if (opts.op === "sum") return sum;
  return values.length > 0 ? sum / values.length : 0;
}

// --- Domain convenience functions — a small, growing library built on the
// generic primitives above. A new business question gets a new function
// here, never a change to queryRecords/findRelated/aggregate themselves.

export async function getRevenue(
  storeId: string,
  opts: { since?: Date; until?: Date } = {}
): Promise<number> {
  const transactions = await queryRecords(storeId, "transaction", opts);
  const sales = aggregate(
    transactions.filter((t) => t.data.type === "sale"),
    { field: "amountInCents", op: "sum" }
  );
  const refunds = aggregate(
    transactions.filter((t) => t.data.type === "refund"),
    { field: "amountInCents", op: "sum" }
  );
  return sales - refunds;
}

export interface TopContact {
  contact: CanonicalRecord<"contact">;
  totalSpentInCents: number;
}

export async function getTopContacts(
  storeId: string,
  limit = 5
): Promise<TopContact[]> {
  const [contacts, transactions] = await Promise.all([
    queryRecords(storeId, "contact"),
    queryRecords(storeId, "transaction", {
      filter: (data) => data.type === "sale",
    }),
  ]);

  const spentByContactId = new Map<string, number>();
  for (const transaction of transactions) {
    const contactId = transaction.data.contactId;
    if (!contactId) continue;
    spentByContactId.set(
      contactId,
      (spentByContactId.get(contactId) ?? 0) + transaction.data.amountInCents
    );
  }

  return contacts
    .map((contact) => ({
      contact: contact as CanonicalRecord<"contact">,
      totalSpentInCents: spentByContactId.get(contact.id) ?? 0,
    }))
    .sort((a, b) => b.totalSpentInCents - a.totalSpentInCents)
    .slice(0, limit);
}

// Phase 3 Milestone 5 — customer segments, computed rather than stored.
// A persisted `segments: string[]` field would need active maintenance and
// could silently go stale (a "repeat customer" tag nobody removes once
// they've lapsed) — every segment here is directly derivable from existing
// Contact + Transaction data, always fresh by construction, the exact
// reasoning M1 already used to justify computing internal records live
// instead of persisting a synced copy. A new segment definition later is a
// new named-threshold block below, never a schema change.
const REPEAT_CUSTOMER_MIN_ORDERS = 2;
const HIGH_VALUE_SPEND_MULTIPLIER = 2; // at least 2x the average spending customer
const LAPSED_WINDOW_MS = 60 * 24 * 60 * 60 * 1000; // 60 days since last purchase
const NEW_CUSTOMER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days since first seen

export interface CustomerSegments {
  repeatCustomers: TopContact[];
  highValueCustomers: TopContact[];
  lapsedCustomers: TopContact[];
  newCustomers: TopContact[];
}

export async function getCustomerSegments(
  storeId: string
): Promise<CustomerSegments> {
  const [contacts, saleTransactions] = await Promise.all([
    queryRecords(storeId, "contact"),
    queryRecords(storeId, "transaction", {
      filter: (data) => data.type === "sale",
    }),
  ]);

  const now = Date.now();
  const spentByContactId = new Map<string, number>();
  const orderCountByContactId = new Map<string, number>();
  const lastSaleAtByContactId = new Map<string, number>();
  for (const transaction of saleTransactions) {
    const contactId = transaction.data.contactId;
    if (!contactId) continue;
    spentByContactId.set(
      contactId,
      (spentByContactId.get(contactId) ?? 0) + transaction.data.amountInCents
    );
    orderCountByContactId.set(
      contactId,
      (orderCountByContactId.get(contactId) ?? 0) + 1
    );
    const saleTime = new Date(transaction.data.date).getTime();
    const existing = lastSaleAtByContactId.get(contactId);
    if (existing === undefined || saleTime > existing) {
      lastSaleAtByContactId.set(contactId, saleTime);
    }
  }

  const spenders = [...spentByContactId.values()];
  const averageSpend =
    spenders.length > 0
      ? spenders.reduce((sum, v) => sum + v, 0) / spenders.length
      : 0;

  const withSpend: TopContact[] = contacts.map((contact) => ({
    contact: contact as CanonicalRecord<"contact">,
    totalSpentInCents: spentByContactId.get(contact.id) ?? 0,
  }));

  const repeatCustomers = withSpend.filter(
    (c) => (orderCountByContactId.get(c.contact.id) ?? 0) >= REPEAT_CUSTOMER_MIN_ORDERS
  );

  const highValueCustomers =
    averageSpend > 0
      ? withSpend.filter(
          (c) => c.totalSpentInCents >= averageSpend * HIGH_VALUE_SPEND_MULTIPLIER
        )
      : [];

  const lapsedCustomers = withSpend.filter((c) => {
    const lastSaleAt = lastSaleAtByContactId.get(c.contact.id);
    return lastSaleAt !== undefined && now - lastSaleAt > LAPSED_WINDOW_MS;
  });

  const newCustomers = withSpend.filter((c) => {
    const firstSeenAt = new Date(c.contact.data.firstSeenAt).getTime();
    return now - firstSeenAt <= NEW_CUSTOMER_WINDOW_MS;
  });

  const bySpendDesc = (a: TopContact, b: TopContact) =>
    b.totalSpentInCents - a.totalSpentInCents;

  return {
    repeatCustomers: repeatCustomers.sort(bySpendDesc),
    highValueCustomers: highValueCustomers.sort(bySpendDesc),
    lapsedCustomers: lapsedCustomers.sort(bySpendDesc),
    newCustomers: newCustomers.sort(bySpendDesc),
  };
}

// Phase 3 Milestone 3 — the Insight Engine's revenue/engagement trend
// detection reads this rather than recomputing open rates itself,
// matching the "generic primitives, small growing library" split already
// established for getRevenue/getTopContacts. Returns null (not 0) when
// there's no real data to average — an honest "nothing to compare," never
// a fabricated baseline.
export async function getAverageOpenRate(
  storeId: string,
  opts: { since?: Date; until?: Date } = {}
): Promise<number | null> {
  const campaigns = await queryRecords(storeId, "campaign", opts);
  const rates = campaigns
    .filter((c) => c.data.metrics?.opens != null && c.data.audienceSize)
    .map((c) => c.data.metrics!.opens / c.data.audienceSize!);
  if (rates.length === 0) return null;
  return rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}

// Phase 3 Milestone 6 (J4 Cognitive Layer) — a real, deterministic
// prediction primitive: the Insight Engine's own "100% deterministic, no AI
// judgment" principle extended to forward-looking statements. Claude never
// invents a projection — it narrates one that was actually computed here
// from real Transaction data via the already-existing getRevenue(). Returns
// null (never a fabricated number) whenever there's nothing real to project
// against: not a revenue-category goal, no targetDate, no
// targetValueInCents, or a malformed window (target before the goal was
// even identified).
export interface GoalTrajectory {
  goalId: string;
  targetValueInCents: number;
  actualSoFarInCents: number;
  expectedByNowInCents: number;
  projectedFinalInCents: number;
  onTrack: boolean;
  paceRatio: number; // actualSoFar / expectedByNow — 1.0 is exactly on pace
  deadlinePassed: boolean;
}

export async function predictGoalTrajectory(
  storeId: string,
  goal: CanonicalRecord<"goal">
): Promise<GoalTrajectory | null> {
  const { category, targetDate, identifiedAt, targetValueInCents } = goal.data;
  if (category !== "revenue" || !targetDate || targetValueInCents == null) return null;

  const start = new Date(identifiedAt).getTime();
  const end = new Date(targetDate).getTime();
  if (!(end > start)) return null; // malformed window — nothing sensible to compute

  const now = Date.now();
  const elapsedMs = Math.max(0, now - start);
  const totalWindowMs = end - start;
  const deadlinePassed = now > end;
  const expectedProgressFraction = Math.min(1, elapsedMs / totalWindowMs);

  const actualSoFarInCents = await getRevenue(storeId, {
    since: new Date(start),
    until: new Date(Math.min(now, end)),
  });

  const expectedByNowInCents = Math.round(targetValueInCents * expectedProgressFraction);
  const projectedFinalInCents =
    elapsedMs > 0
      ? Math.round((actualSoFarInCents / elapsedMs) * totalWindowMs)
      : actualSoFarInCents;

  return {
    goalId: goal.id,
    targetValueInCents,
    actualSoFarInCents,
    expectedByNowInCents,
    projectedFinalInCents,
    onTrack: actualSoFarInCents >= expectedByNowInCents,
    paceRatio: expectedByNowInCents > 0 ? actualSoFarInCents / expectedByNowInCents : 1,
    deadlinePassed,
  };
}

// Returns [] until an Appointment producer exists (Phase 3 Milestone 2) —
// an honest empty state, not an error.
export async function getUpcomingAppointments(
  storeId: string
): Promise<CanonicalRecord<"appointment">[]> {
  const now = new Date();
  const appointments = await queryRecords(storeId, "appointment", {
    since: now,
  });
  return (appointments as CanonicalRecord<"appointment">[]).sort(
    (a, b) =>
      new Date(a.data.startAt).getTime() - new Date(b.data.startAt).getTime()
  );
}

// A recent-record list, newest first, capped small — bounds prompt size for
// chat's Q&A context (see below) without needing per-question entity-type
// selection; real small-business record volumes make this cheap regardless.
const RECENT_RECORDS_CAP = 25;

async function recentRecords<T extends EntityType>(
  storeId: string,
  entityType: T
): Promise<CanonicalRecord<T>[]> {
  const records = await queryRecords(storeId, entityType);
  return records
    .slice()
    .sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())
    .slice(0, RECENT_RECORDS_CAP);
}

// The context chat's new read-only Q&A mode hands to Claude: real,
// precomputed aggregates (never asking the model to sum currency amounts
// itself — the actual trust risk this whole capability rests on) plus a
// capped, recent slice of raw records per entity type for anything more
// specific than the precomputed numbers cover. Every entity type is
// included even when empty (e.g. appointment/campaign/document, with no
// producer until Phase 3 Milestone 2) — an honest empty list, so the answer
// prompt can correctly say "I don't have that yet" instead of guessing.
export interface ChatDataContext {
  asOf: string; // ISO — when this context was assembled, always "now" since nothing here is cached
  revenue: { last30Days: number; allTimeInCents: number };
  topContacts: { email: string | null; name: string | null; totalSpentInCents: number }[];
  upcomingAppointments: CanonicalRecord<"appointment">["data"][];
  recent: Record<EntityType, CanonicalRecord["data"][]>;
}

export async function buildChatDataContext(
  storeId: string
): Promise<ChatDataContext> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [revenue30d, revenueAllTime, topContacts, upcoming, ...recentByType] =
    await Promise.all([
      getRevenue(storeId, { since: thirtyDaysAgo }),
      getRevenue(storeId),
      getTopContacts(storeId),
      getUpcomingAppointments(storeId),
      ...ENTITY_TYPES.map((entityType) => recentRecords(storeId, entityType)),
    ]);

  const recent = ENTITY_TYPES.reduce(
    (acc, entityType, index) => {
      acc[entityType] = recentByType[index].map((record) => record.data);
      return acc;
    },
    {} as Record<EntityType, CanonicalRecord["data"][]>
  );

  return {
    asOf: new Date().toISOString(),
    revenue: { last30Days: revenue30d, allTimeInCents: revenueAllTime },
    topContacts: topContacts.map((t) => ({
      email: t.contact.data.email,
      name: t.contact.data.name,
      totalSpentInCents: t.totalSpentInCents,
    })),
    upcomingAppointments: upcoming.map((a) => a.data),
    recent,
  };
}
