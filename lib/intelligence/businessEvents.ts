import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { EntityType } from "@/lib/businessModel/entities";

// Phase 1 (Business Event Pipeline) — the one place every BusinessEvent row
// gets written from, and the one place every consumer reads its own
// progress through that log from. See PHASE1_DESIGN.md sections 2 and 6.
//
// Deliberately not named after any one caller (not "changeDetectionEvents"
// or "commerceEvents"): the connector/sync path (changeDetection.ts's
// recordBusinessEvents, a batched createMany outside any transaction) and
// the commerce write paths (a single event, created inside the same
// $transaction as the state change it describes — see the Stripe/PayPal
// webhook handlers) both need the exact same row-shaping logic, just called
// with a different client (the shared `prisma` vs. a transaction's `tx`).

export interface BusinessEventInput {
  recordId: string | null;
  entityType: EntityType;
  eventType: string;
  summary: string;
  data?: Record<string, unknown>;
}

// Structural, not Prisma.TransactionClient — a $transaction callback's `tx`
// and the shared `prisma` export both satisfy this without needing to name
// Prisma's own (extension-dependent) transaction client type.
interface BusinessEventWriter {
  businessEvent: {
    createMany: (args: { data: Prisma.BusinessEventCreateManyInput[] }) => Promise<unknown>;
  };
}

export async function writeBusinessEvents(
  client: BusinessEventWriter,
  storeId: string,
  sourceProvider: string,
  entries: BusinessEventInput[]
): Promise<void> {
  if (entries.length === 0) return;
  await client.businessEvent.createMany({
    data: entries.map((entry) => ({
      storeId,
      entityType: entry.entityType,
      eventType: entry.eventType,
      recordId: entry.recordId,
      sourceProvider,
      summary: entry.summary,
      data: (entry.data ?? undefined) as Prisma.InputJsonValue | undefined,
    })),
  });
}

// One cursor row per (storeId, consumerName), created on first read. Not a
// guarded mutation (upsert is out of the tenant-isolation guard's scope by
// design — see lib/tenantIsolation.ts) so the composite unique key is safe
// to use here as-is.
async function getOrCreateCursor(storeId: string, consumerName: string) {
  return prisma.businessEventCursor.upsert({
    where: { storeId_consumerName: { storeId, consumerName } },
    create: { storeId, consumerName },
    update: {},
  });
}

// Every event this consumer hasn't seen yet, oldest first. Safe to call
// repeatedly without side effects — the cursor only moves via
// advanceConsumerCursor below, so a crash between reading and processing
// never skips an event on the next attempt.
export async function getNewEventsForConsumer(storeId: string, consumerName: string) {
  const cursor = await getOrCreateCursor(storeId, consumerName);
  return prisma.businessEvent.findMany({
    where: { storeId, sequence: { gt: cursor.lastProcessedSequence } },
    orderBy: { sequence: "asc" },
  });
}

// Call only after the events returned by getNewEventsForConsumer have been
// fully processed. updateMany (not the composite-key update) so the
// tenant-isolation guard sees a flat storeId directly, and so this is a
// harmless no-op on the rare case the cursor row doesn't exist yet (a
// consumer that advances without ever having read first shouldn't happen,
// but this doesn't throw if it does).
export async function advanceConsumerCursor(
  storeId: string,
  consumerName: string,
  upToSequence: bigint
): Promise<void> {
  await prisma.businessEventCursor.updateMany({
    where: { storeId, consumerName },
    data: { lastProcessedSequence: upToSequence },
  });
}
