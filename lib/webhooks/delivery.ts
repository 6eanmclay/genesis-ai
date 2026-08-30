import { prismaSystem } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";
import { correlationId } from "@/lib/observability/correlation";

// THE RECORD OF WHAT A PROVIDER SENT US.
//
// ============ WHAT THIS DOES NOT DO (2026-08-30) =======================
//
// It does not change when a webhook is handled. Every live handler still runs
// inline, in the request, exactly as it does today — Stripe, PayPal and
// EasyPost move real money, and turning their side effects asynchronous is a
// behavioural change that deserves its own decision rather than arriving as
// a side effect of adding an audit trail.
//
// What it adds is the answer to questions nobody could answer before:
//
//   did the provider ever actually send that?
//   what exactly did they send?
//   has this same event arrived twice?
//   which deliveries failed, and can they be replayed?
//   is somebody hitting us with unsigned payloads?
//
// ============ RECORDING MUST NEVER BREAK A DELIVERY ====================
//
// Every function here swallows its own failure. A webhook route's job is to
// take the delivery and return; if the audit write fails, the correct outcome
// is a missing audit row and a working payment, never a 500 that makes the
// provider retry a payment we already processed. `record` returning null is a
// normal, survivable outcome and callers treat it as one.
//
// ============ A REJECTED DELIVERY IS STILL RECORDED ====================
//
// A failed signature is written down with `signatureValid: false` rather than
// dropped. One is noise; a burst is a rotated secret nobody updated, or someone
// probing the endpoint. Neither is visible if the only record of an unsigned
// delivery is a 401 in a log that rolls over.

export type DeliveryStatus = "received" | "processed" | "failed" | "rejected";

export interface RecordedDelivery {
  id: string;
  /** True when this provider+event pair had already been recorded. */
  duplicate: boolean;
}

/**
 * Write down that a delivery arrived, before anything acts on it.
 *
 * Returns null if the record could not be written — see the header. Callers
 * carry on regardless.
 */
export async function recordDelivery(input: {
  provider: string;
  rawBody: string;
  signatureValid: boolean;
  externalEventId?: string | null;
  storeId?: string | null;
  headers?: Record<string, string> | null;
  status?: DeliveryStatus;
}): Promise<RecordedDelivery | null> {
  try {
    const status: DeliveryStatus = input.status ?? (input.signatureValid ? "received" : "rejected");

    if (input.externalEventId) {
      // The provider named the event, so a retry of one we already hold is
      // recognisable. Recorded as a fact rather than a second row — and the
      // attempt count moves, so "this arrived four times" is answerable.
      const existing = await prismaSystem.webhookDelivery.findUnique({
        where: {
          provider_externalEventId: {
            provider: input.provider,
            externalEventId: input.externalEventId,
          },
        },
        select: { id: true },
      });
      if (existing) {
        await prismaSystem.webhookDelivery.update({
          where: { id: existing.id },
          data: { attempts: { increment: 1 } },
        });
        return { id: existing.id, duplicate: true };
      }
    }

    const row = await prismaSystem.webhookDelivery.create({
      data: {
        provider: input.provider,
        // A delivery, the job it enqueues and the execution that job runs are
        // one chain — the provider's retry of the same event joins it too.
        correlationId: correlationId(),
        externalEventId: input.externalEventId ?? null,
        storeId: input.storeId ?? null,
        status,
        signatureValid: input.signatureValid,
        // Verbatim. A parsed copy would be our reading of the delivery rather
        // than the delivery, and a replay has to start from what was sent.
        payload: input.rawBody,
        // Prisma's Json input has no `null` member — an absent value is the
        // field being omitted, not set to null.
        ...(input.headers ? { headers: input.headers } : {}),
        attempts: 1,
      },
      select: { id: true },
    });
    return { id: row.id, duplicate: false };
  } catch (error) {
    reportIssue(`could not record a ${input.provider} webhook delivery`, error, {
      subsystem: "integrations",
      stage: "webhook.record",
      storeId: input.storeId ?? undefined,
    });
    return null;
  }
}

/** The handler finished. */
export async function markProcessed(id: string | null, storeId?: string | null): Promise<void> {
  if (!id) return;
  try {
    await prismaSystem.webhookDelivery.update({
      where: { id },
      data: {
        status: "processed",
        processedAt: new Date(),
        error: null,
        ...(storeId ? { storeId } : {}),
      },
    });
  } catch (error) {
    reportIssue("could not mark a webhook delivery processed", error, {
      subsystem: "integrations",
      stage: "webhook.markProcessed",
    });
  }
}

/** The handler threw. The delivery is kept so it can be looked at, or replayed. */
export async function markFailed(id: string | null, error: unknown): Promise<void> {
  if (!id) return;
  try {
    await prismaSystem.webhookDelivery.update({
      where: { id },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } catch (writeError) {
    reportIssue("could not mark a webhook delivery failed", writeError, {
      subsystem: "integrations",
      stage: "webhook.markFailed",
    });
  }
}

export interface DeliveryHealth {
  provider: string;
  received: number;
  processed: number;
  failed: number;
  rejected: number;
  lastReceivedAt: Date | null;
}

/**
 * What each provider has been sending, for an operator.
 *
 * The number that matters most is `rejected`: a provider that suddenly cannot
 * sign is a rotated secret nobody updated, and today that is invisible until
 * somebody notices the business consequence instead of the cause.
 */
export async function deliveryHealth(since?: Date): Promise<DeliveryHealth[]> {
  const where = since ? { receivedAt: { gte: since } } : {};
  const grouped = await prismaSystem.webhookDelivery.groupBy({
    by: ["provider", "status"],
    where,
    _count: true,
    _max: { receivedAt: true },
  });

  const byProvider = new Map<string, DeliveryHealth>();
  for (const row of grouped) {
    const entry = byProvider.get(row.provider) ?? {
      provider: row.provider,
      received: 0,
      processed: 0,
      failed: 0,
      rejected: 0,
      lastReceivedAt: null,
    };
    if (row.status in entry) {
      (entry as unknown as Record<string, number>)[row.status] += row._count;
    }
    const seen = row._max.receivedAt;
    if (seen && (!entry.lastReceivedAt || seen > entry.lastReceivedAt)) entry.lastReceivedAt = seen;
    byProvider.set(row.provider, entry);
  }
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Deliveries that failed and could be tried again.
 *
 * READ ONLY. It hands back what was sent; deciding to re-run a handler on it is
 * a person's call and a separate action, because replaying a payment webhook is
 * not a thing a report should be able to do by being read.
 */
export async function replayableDeliveries(
  provider: string,
  limit = 50,
): Promise<{ id: string; externalEventId: string | null; payload: string; error: string | null; receivedAt: Date }[]> {
  return prismaSystem.webhookDelivery.findMany({
    where: { provider, status: "failed" },
    orderBy: { receivedAt: "desc" },
    take: limit,
    select: { id: true, externalEventId: true, payload: true, error: true, receivedAt: true },
  });
}
