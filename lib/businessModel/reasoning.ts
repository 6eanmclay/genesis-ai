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
  // Business Intelligence Engine, Tier 1 (Current Truth) — closes a
  // half-built gap: Belief.recordId/entityType have existed on the schema
  // since Learn's own Phase 2, but nothing ever read them back here
  // alongside events/observations/cognitiveOutputs. The business question
  // this answers: "What has Genesis already learned about this specific
  // goal/challenge/item?" — same kind of read as cognitiveOutputs above,
  // not a new belief-formation mechanism, so it belongs in Understand's own
  // read layer, not Learn. No status filter, matching observations'/
  // cognitiveOutputs' own behavior — full history, including retired
  // beliefs, since this is "everything Genesis has ever noticed or
  // believed about this record," not a live-only view. Returns [] honestly
  // until a Learn detector actually populates recordId on a belief — no
  // detector does yet (see plan's explicit non-goals), the same "real code
  // path, nothing to detect against yet" pattern already used for
  // Item.quantityAvailable.
  beliefs: {
    claim: string;
    category: string;
    confidence: number;
    status: string;
    lastConfirmedAt: Date;
  }[];
}

export async function getEntityHistory<T extends EntityType>(
  storeId: string,
  entityType: T,
  recordId: string
): Promise<EntityHistory> {
  const [records, related, events, observations, cognitiveOutputs, beliefs] =
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
      prisma.belief.findMany({
        where: { storeId, recordId },
        orderBy: { lastConfirmedAt: "desc" },
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
    beliefs: beliefs.map((b) => ({
      claim: b.claim,
      category: b.category,
      confidence: b.confidence,
      status: b.status,
      lastConfirmedAt: b.lastConfirmedAt,
    })),
  };
}

export interface RecentDecisionOutcome {
  topicKey: string | null;
  actionType: string;
  decision: "executed" | "rejected";
  decidedAt: string; // plain date, for prompt readability
  summary: string; // the real proposal's own summary text
}

// J4 Foundation Phase 3 (Reason) — a single recent decision is an objective,
// current-state fact ("the owner declined this proposal on this date"), not
// a generalized pattern — it belongs here, in Understand's own read layer,
// not in Learn (lib/intelligence/learn.ts), which only ever generalizes
// across 2+ real occurrences. This isn't a new kind of read: getEntityHistory
// above already reads ExecutionLog/GenesisObservation/CognitiveOutput —
// Execute's own records — as part of answering "what's currently true";
// this is the same pattern, scoped to recent proposal decisions store-wide
// rather than one record. A real, principled recency window (days), never
// an arbitrary row-count cap — the old 60-day/5-item limit this replaces
// existed to bound a PATTERN-detection read; a plain "what happened
// recently" read doesn't need that same defense, just an honest bound on
// what "recently" means.
export async function getRecentDecisionOutcomes(
  storeId: string,
  days = 14
): Promise<RecentDecisionOutcome[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const decided = await prisma.approvalRequest.findMany({
    where: { storeId, status: { in: ["EXECUTED", "REJECTED"] }, decidedAt: { gte: since } },
    orderBy: { decidedAt: "desc" },
  });
  return decided.map((a) => ({
    topicKey: a.topicKey,
    actionType: a.actionType,
    decision: a.status === "EXECUTED" ? "executed" : "rejected",
    decidedAt: a.decidedAt!.toISOString().slice(0, 10),
    summary: a.summary,
  }));
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

// Business Intelligence Engine — `asOf` generalizes this from a pure
// current-state snapshot to a point-in-time one, computing segment
// membership exactly as it existed at any moment, not just "now". Powers
// getCustomerSegmentTrend below (two snapshots compared via computeTrend)
// without duplicating any of this function's own logic. Defaults to
// `new Date()`, so the one existing caller (lib/businessModel/profile.ts)
// gets byte-identical behavior.
export async function getCustomerSegments(
  storeId: string,
  opts: { asOf?: Date } = {}
): Promise<CustomerSegments> {
  const asOf = opts.asOf ?? new Date();
  const [allContacts, saleTransactions] = await Promise.all([
    queryRecords(storeId, "contact"),
    queryRecords(storeId, "transaction", {
      until: asOf, // excludes any sale that happened after this snapshot point
      filter: (data) => data.type === "sale",
    }),
  ]);
  // contact has no DATE_FIELD entry (unlike transaction), so its own
  // existence-as-of-asOf has to be filtered here explicitly — a contact
  // whose firstSeenAt is after asOf didn't exist yet at that snapshot and
  // must not appear in it at all.
  const contacts = allContacts.filter(
    (c) => new Date((c as CanonicalRecord<"contact">).data.firstSeenAt).getTime() <= asOf.getTime()
  );

  const now = asOf.getTime();
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

// Business Intelligence Engine — the business question this answers: "Is
// my customer base actually growing — more new customers, more repeat
// business, more or less churn — or is today's revenue just one good
// week?" Distinct from getRevenueTrend, which can't tell "more customers"
// apart from "existing customers spending more."
//
// Revenue/item performance are FLOW quantities (summed over a window), so
// their trend compares two summed windows. Customer segments are
// STATE/LEVEL quantities (how many customers currently qualify) — the
// meaningful comparison is a point-in-time snapshot now vs. N days ago,
// not two summed windows. That's why this compares two getCustomerSegments
// calls at two different `asOf` moments, not two windowed sums.
//
// highValueCustomers' threshold is self-normalizing (computed fresh from
// each snapshot's own spend distribution), so the exact dollar bar can
// shift slightly between the two compared snapshots — the count is still a
// real, meaningful comparison ("how many customers are meaningfully
// above-average, and is that growing"), just not against one fixed
// absolute threshold. A known property, not a defect.
export interface CustomerSegmentTrends {
  repeatCustomers: Trend | null;
  highValueCustomers: Trend | null;
  lapsedCustomers: Trend | null;
  newCustomers: Trend | null;
}

export async function getCustomerSegmentTrend(
  storeId: string,
  opts: { windowDays?: number } = {}
): Promise<CustomerSegmentTrends> {
  const windowMs = (opts.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  const now = new Date();
  const priorAsOf = new Date(now.getTime() - windowMs);
  const [current, previous] = await Promise.all([
    getCustomerSegments(storeId, { asOf: now }),
    getCustomerSegments(storeId, { asOf: priorAsOf }),
  ]);
  return {
    repeatCustomers: computeTrend(current.repeatCustomers.length, previous.repeatCustomers.length),
    highValueCustomers: computeTrend(current.highValueCustomers.length, previous.highValueCustomers.length),
    lapsedCustomers: computeTrend(current.lapsedCustomers.length, previous.lapsedCustomers.length),
    newCustomers: computeTrend(current.newCustomers.length, previous.newCustomers.length),
  };
}

// Business Intelligence Engine, Tier 1 (Current Truth) — attributes real
// Transaction data to whichever entity its `field` value(s) reference,
// honoring the same xxxId/xxxIds convention findRelated already uses.
// getTopContacts/getCustomerSegments above already independently implement
// this exact pattern for the contactId case; this is the same mechanism,
// generalized, not a second one — getItemPerformance below is its first new
// caller. Revenue is attributed only when a transaction resolves to EXACTLY
// ONE entity via `field` — a transaction touching zero or multiple entities
// is excluded from revenue attribution rather than split evenly, since
// Transaction carries one total amount, not a per-line price. This is a
// real, named limitation of Transaction's current shape, not a bug here.
function attributeTransactions(
  transactions: CanonicalRecord<"transaction">[],
  field: "contactId" | "itemIds"
): Map<string, { orderCount: number; revenueInCents: number }> {
  const summaries = new Map<string, { orderCount: number; revenueInCents: number }>();
  for (const t of transactions) {
    const raw = t.data[field];
    const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (ids.length !== 1) continue;
    const id = ids[0];
    const existing = summaries.get(id) ?? { orderCount: 0, revenueInCents: 0 };
    existing.orderCount += 1;
    existing.revenueInCents += t.data.amountInCents;
    summaries.set(id, existing);
  }
  return summaries;
}

export interface ItemPerformance {
  item: CanonicalRecord<"item">;
  // Sale transactions only — a later refund doesn't undo that a sale
  // occurred, it only reduces net revenue (below).
  orderCount: number;
  // Sales minus refunds, mirroring getRevenue's own definition of
  // "revenue" exactly — an item's revenue should mean the same thing
  // store-wide revenue means, not a narrower sales-only number.
  revenueInCents: number;
}

// The business question this answers: "What am I actually selling, and
// what's underperforming?" — currently unanswerable in any form; Understand
// can report total revenue and top customers but nothing about what's
// actually moving. Generalizes beyond Genesis's current business types
// because `item` already means "a product, service, or SKU" per
// entities.ts's own doc comment, and this uses the same generic primitives
// (queryRecords, attributeTransactions) every other function here does.
export async function getItemPerformance(
  storeId: string,
  opts: { since?: Date; until?: Date } = {}
): Promise<ItemPerformance[]> {
  const [items, transactions] = await Promise.all([
    queryRecords(storeId, "item"),
    queryRecords(storeId, "transaction", opts),
  ]);
  const sales = attributeTransactions(
    transactions.filter((t) => t.data.type === "sale"),
    "itemIds"
  );
  const refunds = attributeTransactions(
    transactions.filter((t) => t.data.type === "refund"),
    "itemIds"
  );
  return items
    .map((item) => {
      const sale = sales.get(item.id) ?? { orderCount: 0, revenueInCents: 0 };
      const refund = refunds.get(item.id) ?? { orderCount: 0, revenueInCents: 0 };
      return {
        item: item as CanonicalRecord<"item">,
        orderCount: sale.orderCount,
        revenueInCents: sale.revenueInCents - refund.revenueInCents,
      };
    })
    .sort((a, b) => b.revenueInCents - a.revenueInCents);
}

// Business Intelligence Engine, Tier 2 (Temporal Understanding) — a
// deterministic comparison of two real windows, generalized past any one
// metric. The business question this answers: "Is this getting better or
// worse, and by how much, compared to before?" — asked generically, not
// "is revenue trending" as a one-off case. Pure function, no query — takes
// two plain numbers and has no idea what metric it's comparing, which is
// what lets it generalize to revenue, item performance, or any future
// numeric read without change. Belongs in Understand, not Learn: this is a
// deterministic computation over current facts, not a belief requiring
// repeated evidence over time — it becomes Learn's concern only if the
// *recurrence* of a trend itself needs recognizing (detectInsightRecurrence
// already covers that, reading Insight Engine output).
export interface Trend {
  currentValue: number;
  previousValue: number;
  change: number;
  changeRatio: number;
  direction: "up" | "down" | "flat";
}

const FLAT_THRESHOLD = 0.01; // change under 1% reads as flat, not noise

export function computeTrend(currentValue: number, previousValue: number): Trend | null {
  if (previousValue === 0) return null; // no honest baseline — matches insights.ts's existing "no baseline" behavior
  const change = currentValue - previousValue;
  const changeRatio = change / previousValue;
  const direction =
    Math.abs(changeRatio) < FLAT_THRESHOLD ? "flat" : changeRatio > 0 ? "up" : "down";
  return { currentValue, previousValue, change, changeRatio, direction };
}

export async function getRevenueTrend(
  storeId: string,
  opts: { windowDays?: number } = {}
): Promise<Trend | null> {
  const windowMs = (opts.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);
  const priorStart = new Date(now.getTime() - 2 * windowMs);
  const [current, previous] = await Promise.all([
    getRevenue(storeId, { since: windowStart, until: now }),
    getRevenue(storeId, { since: priorStart, until: windowStart }),
  ]);
  return computeTrend(current, previous);
}

export interface ItemPerformanceTrend {
  item: CanonicalRecord<"item">;
  trend: Trend | null;
}

// Unlocks for Reason: trend becomes a directly-callable fact for item
// performance too, not something trapped inside one hardcoded Insight
// Engine detector the way revenue trend currently is.
export async function getItemPerformanceTrend(
  storeId: string,
  opts: { windowDays?: number } = {}
): Promise<ItemPerformanceTrend[]> {
  const windowMs = (opts.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);
  const priorStart = new Date(now.getTime() - 2 * windowMs);
  const [current, previous] = await Promise.all([
    getItemPerformance(storeId, { since: windowStart, until: now }),
    getItemPerformance(storeId, { since: priorStart, until: windowStart }),
  ]);
  const previousByItemId = new Map(previous.map((p) => [p.item.id, p]));
  return current.map((c) => ({
    item: c.item,
    trend: computeTrend(c.revenueInCents, previousByItemId.get(c.item.id)?.revenueInCents ?? 0),
  }));
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

// Business Intelligence Engine, Tier 2 (Temporal Understanding) — extracted
// from predictGoalTrajectory's own projection math, unchanged behavior,
// so the same "given a rate, project forward" mechanism is available the
// moment a second real numeric target exists (a future non-revenue goal
// with a real target number) without rewriting it. Belongs in Understand:
// a projection is a computed extrapolation of current facts, not a belief
// — forecast *accuracy* becoming a belief is a separate, later Learn
// concern (Tier 3), not this. Fully metric-agnostic by construction: three
// plain numbers in, one out.
export function projectForward(
  actualSoFar: number,
  elapsedMs: number,
  totalWindowMs: number
): number {
  if (elapsedMs <= 0) return actualSoFar;
  return Math.round((actualSoFar / elapsedMs) * totalWindowMs);
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
  const projectedFinalInCents = projectForward(actualSoFarInCents, elapsedMs, totalWindowMs);

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
