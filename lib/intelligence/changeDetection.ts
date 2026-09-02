import { prisma } from "@/lib/prisma";
import { queryRecords } from "@/lib/businessModel/reasoning";
import type { EntityDataFor, EntityType } from "@/lib/businessModel/entities";
import { writeBusinessEvents } from "./businessEvents";

// Phase 3 Milestone 3 (Business Intelligence Engine) — Part 2, Change
// Detection. Two genuinely different kinds of detection, both producing
// the same EventCandidate shape:
//
// 1. Record-level rules (CHANGE_RULES below) — pure functions comparing a
//    record's before/after state, run once per synced record. Provider-
//    independent by construction: every rule reads only canonical entity
//    fields (lib/businessModel/entities.ts), never anything
//    provider-specific — a QuickBooks invoice and a future Xero invoice
//    both produce the exact same "invoice.paid" event through the exact
//    same rule.
// 2. Time-based sweeps (detectOverdueInvoices/detectLowInventory) — real
//    conditions that can become true purely from time passing, with no
//    new sync data at all (an invoice already marked pending simply
//    crosses its due date). Run once per scheduler pass over current
//    state, not diffed against a "previous" value.

export interface EventCandidate {
  eventType: string;
  summary: string;
  data?: Record<string, unknown>;
}

export type ChangeRule<T extends EntityType> = (
  previous: EntityDataFor<T> | null,
  current: EntityDataFor<T>
) => EventCandidate | null;

// DELIBERATELY NOT lib/money.ts's formatMoney, and deliberately still a dollar
// sign (2026-08-22).
//
// Every other money string in this codebase was moved to the store's own
// currency that day. These were not, and the difference is real: the amounts
// below are INVOICE TOTALS FROM QUICKBOOKS, not figures this business set. The
// currency they are actually in is QuickBooks', and this pipeline never
// captured it — Store.currency is the wrong answer to the question, not a
// missing one.
//
// Formatting them as the store's currency would be precisely the failure this
// codebase refuses elsewhere: converting an unknown into a confident value.
// "GBP 400.00" on an invoice QuickBooks raised in dollars is worse than a
// dollar sign, because it looks decided. When the connector starts storing the
// invoice's own currency, this reads it and not before.
function formatCents(amountInCents: number | null | undefined): string | null {
  return amountInCents != null ? `$${(amountInCents / 100).toFixed(2)}` : null;
}

const CONTACT_RULES: ChangeRule<"contact">[] = [
  (previous, current) =>
    previous === null
      ? {
          eventType: "contact.created",
          summary: `New contact: ${current.email ?? current.name ?? "unknown"}`,
        }
      : null,
  (previous, current) =>
    previous && (previous.name !== current.name || previous.email !== current.email)
      ? {
          eventType: "contact.updated",
          summary: `Contact updated: ${current.email ?? current.name ?? "unknown"}`,
        }
      : null,
];

const DOCUMENT_RULES: ChangeRule<"document">[] = [
  (previous, current) => {
    if (previous !== null || current.type !== "invoice") return null;
    const amount = formatCents(current.amountInCents);
    return {
      eventType: "invoice.created",
      summary: `New invoice${amount ? ` for ${amount}` : ""}`,
    };
  },
  (previous, current) => {
    if (!previous || previous.status === "paid" || current.status !== "paid") return null;
    if (current.type !== "invoice") return null;
    const amount = formatCents(current.amountInCents);
    return {
      eventType: "invoice.paid",
      summary: `Invoice marked paid${amount ? ` (${amount})` : ""}`,
    };
  },
];

const APPOINTMENT_RULES: ChangeRule<"appointment">[] = [
  (previous, current) =>
    previous === null
      ? { eventType: "appointment.created", summary: `New appointment: ${current.title}` }
      : null,
  (previous, current) =>
    previous && previous.status !== "cancelled" && current.status === "cancelled"
      ? { eventType: "appointment.cancelled", summary: `Appointment cancelled: ${current.title}` }
      : null,
];

const CAMPAIGN_RULES: ChangeRule<"campaign">[] = [
  (previous, current) =>
    !previous?.sentAt && current.sentAt
      ? { eventType: "campaign.completed", summary: `Campaign sent: ${current.name}` }
      : null,
];

// transaction/item deliberately have no per-record rules — their
// meaningful signal is aggregate-level (revenue trend, inventory
// threshold), handled by the Insight Engine and detectLowInventory below,
// not per-record diffing.
const CHANGE_RULES: { [K in EntityType]?: ChangeRule<K>[] } = {
  contact: CONTACT_RULES,
  document: DOCUMENT_RULES,
  appointment: APPOINTMENT_RULES,
  campaign: CAMPAIGN_RULES,
};

export function detectRecordChanges<T extends EntityType>(
  entityType: T,
  previous: EntityDataFor<T> | null,
  current: EntityDataFor<T>
): EventCandidate[] {
  const rules = CHANGE_RULES[entityType] as ChangeRule<T>[] | undefined;
  if (!rules) return [];
  return rules
    .map((rule) => rule(previous, current))
    .filter((candidate): candidate is EventCandidate => candidate !== null);
}

// How long a time-based sweep waits before re-flagging the same still-true
// condition on the same record — without this, "invoice X is overdue"
// would get a fresh BusinessEvent row every single scheduler cycle
// forever. BusinessEvent itself stays deliberately append-only/dedup-free
// (see its own schema comment) — this window is Change Detection's own
// concern, not a general BusinessEvent feature.
const RESWEEP_WINDOW_MS = 20 * 60 * 60 * 1000; // 20h — safely under a daily cadence

async function alreadyFlaggedRecently(
  storeId: string,
  recordId: string,
  eventType: string
): Promise<boolean> {
  const existing = await prisma.businessEvent.findFirst({
    where: {
      storeId,
      recordId,
      eventType,
      occurredAt: { gte: new Date(Date.now() - RESWEEP_WINDOW_MS) },
    },
    select: { id: true },
  });
  return existing !== null;
}

export interface SweepResult {
  recordId: string;
  entityType: EntityType;
  candidate: EventCandidate;
}

export async function detectOverdueInvoices(storeId: string): Promise<SweepResult[]> {
  const documents = await queryRecords(storeId, "document");
  const now = Date.now();
  const results: SweepResult[] = [];

  for (const doc of documents) {
    if (doc.data.type !== "invoice") continue;
    if (doc.data.status === "paid") continue;
    if (!doc.data.dueAt) continue;
    if (new Date(doc.data.dueAt).getTime() >= now) continue;
    if (await alreadyFlaggedRecently(storeId, doc.id, "invoice.overdue")) continue;

    const amount = formatCents(doc.data.amountInCents);
    results.push({
      recordId: doc.id,
      entityType: "document",
      candidate: {
        eventType: "invoice.overdue",
        summary: `Invoice overdue${amount ? ` (${amount})` : ""} — was due ${new Date(doc.data.dueAt).toLocaleDateString()}`,
      },
    });
  }
  return results;
}

const LOW_INVENTORY_THRESHOLD = 5;

export async function detectLowInventory(storeId: string): Promise<SweepResult[]> {
  const items = await queryRecords(storeId, "item");
  const results: SweepResult[] = [];

  for (const item of items) {
    const quantity = item.data.quantityAvailable;
    if (quantity === null) continue; // honest gap — no connector populates this yet
    const eventType = quantity <= 0 ? "inventory.depleted" : quantity <= LOW_INVENTORY_THRESHOLD ? "inventory.low" : null;
    if (!eventType) continue;
    if (await alreadyFlaggedRecently(storeId, item.id, eventType)) continue;

    results.push({
      recordId: item.id,
      entityType: "item",
      candidate: {
        eventType,
        summary:
          quantity <= 0
            ? `${item.data.name} is out of stock`
            : `${item.data.name} is running low (${quantity} left)`,
      },
    });
  }
  return results;
}

export async function recordBusinessEvents(
  storeId: string,
  sourceProvider: string,
  entries: { recordId: string | null; entityType: EntityType; candidates: EventCandidate[] }[]
): Promise<void> {
  const rows = entries.flatMap(({ recordId, entityType, candidates }) =>
    candidates.map((candidate) => ({
      recordId,
      entityType,
      eventType: candidate.eventType,
      summary: candidate.summary,
      data: candidate.data,
    }))
  );
  await writeBusinessEvents(prisma, storeId, sourceProvider, rows);
}

/**
 * The time-based sweeps, over current state, for one store.
 *
 * ============ WHY THIS IS ITS OWN FUNCTION (2026-09-02) ==============
 *
 * These two sweeps find conditions that become true because TIME PASSED — an
 * invoice's due date going by, stock reaching zero — and nothing about them
 * needs a connector to have synced. But their only route to being called was
 * inside `runChangeDetection`, which the scheduler runs after a sync, and only
 * when that sync returned changes. Eight of sixteen production stores have no
 * connected integration at all, so for half the platform an invoice could go
 * overdue and J4 would never emit a thing.
 *
 * So the sweeps get a second caller: the deterministic intelligence cycle.
 * This function is what both callers share, rather than each running its own
 * copy — two implementations of "run the sweeps" is the mirrored-registry
 * problem again, and the one that drifted would be the one nobody read.
 *
 * ============ AND IT CANNOT DOUBLE-EMIT ==============================
 *
 * Nothing new was needed for that. Both sweeps already refuse a record they
 * flagged inside RESWEEP_WINDOW_MS — twenty hours, deliberately under a daily
 * cadence — so a record yields at most one event per eventType per day however
 * many callers reach it. That guard is store-scoped, which makes it the tenant
 * boundary here too.
 *
 * The RECORD-LEVEL rules are deliberately not here: they compare a previous
 * value to a current one, and only a sync knows what just changed.
 */
export async function runTimeBasedDetection(
  storeId: string,
  sourceProvider: string
): Promise<void> {
  const [overdue, lowInventory] = await Promise.all([
    detectOverdueInvoices(storeId),
    detectLowInventory(storeId),
  ]);

  const sweepEntries = [...overdue, ...lowInventory].map((r) => ({
    recordId: r.recordId,
    entityType: r.entityType,
    candidates: [r.candidate],
  }));

  if (sweepEntries.length === 0) return;
  await recordBusinessEvents(storeId, sourceProvider, sweepEntries);
}

// The full Change Detection pass for one store's sync cycle — record-level
// rules over what actually just changed, plus the time-based sweeps over
// current state regardless of what changed. Called once per store by the
// scheduler after that store's connectors have synced.
export async function runChangeDetection(
  storeId: string,
  sourceProvider: string,
  changes: { recordId: string; entityType: EntityType; previous: unknown; current: unknown }[]
): Promise<void> {
  const recordLevelEntries = changes.map(({ recordId, entityType, previous, current }) => ({
    recordId,
    entityType,
    candidates: detectRecordChanges(
      entityType,
      previous as EntityDataFor<typeof entityType> | null,
      current as EntityDataFor<typeof entityType>
    ),
  }));

  if (recordLevelEntries.length > 0) {
    await recordBusinessEvents(storeId, sourceProvider, recordLevelEntries);
  }

  // THE SAME SWEEPS THE CYCLE RUNS, not a second copy of them.
  await runTimeBasedDetection(storeId, sourceProvider);
}
