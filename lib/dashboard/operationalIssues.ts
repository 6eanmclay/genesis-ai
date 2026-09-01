import { prisma } from "@/lib/prisma";
import type { AttentionItem } from "./types";
import { STALL_MS } from "@/lib/admin/platformHealth";

// WHEN THE MACHINERY FAILS, THE OWNER IS THE ONE IT HAPPENED TO.
//
// ============ WHAT WAS ALREADY BUILT (2026-08-31) ======================
//
// All of it, on the operator's side. platformHealth() computes dead-lettered
// jobs, stalled jobs, external operations with an unknown outcome, and webhook
// deliveries waiting to be replayed. needsAttention() decides which of those
// need a person. ops.alerts runs them hourly and sends what it finds to Sentry.
//
// And the owner's side is equally built: getAttentionItems() reads a business's
// recent failures, its stale executions and its broken connections, and
// buildAttentionCards renders them on the dashboard.
//
// ============ WHAT WAS MISSING WAS THE JOIN ===========================
//
// Every one of those four conditions carries a storeId. Every one of them was
// computed platform-wide, reported to an operator as a count — "3 job(s) gave
// up entirely" — and never attributed to the business it happened to.
//
// So a customer's order confirmation could fail five times, give up, be
// reported to Sentry, and the merchant whose customer never heard from them
// would see nothing at all. There was a mature attention system on their
// dashboard and nothing fed it.
//
// This is that join, and deliberately nothing more: the same queries, filtered
// by storeId, mapped into the AttentionItem shape that already exists. No new
// table, no new surface, no new notification channel.
//
// ============ WHAT STAYS WITH THE OPERATOR ============================
//
// A stopped scheduler, a critical security signal, and any row whose storeId is
// null. Those are facts about the platform rather than about a business, and
// showing a merchant "the scheduler is overdue" would be telling them something
// alarming they cannot act on. Named here so their absence is a decision.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What a job kind means to the person whose business it happened to.
 *
 * Keyed on the kinds that carry a storeId. A kind with no entry falls back to
 * something honest and vague rather than printing an internal name at somebody
 * — but it is also very unlikely to appear, because the platform-maintenance
 * kinds (telemetry.prune, retention.sweep, security.prune) all run with a null
 * storeId and are filtered out before they reach here.
 */
const JOB_MEANING: Record<string, { affects: string; whatToDo: string; href: string }> = {
  "notification.order": {
    affects: "an order email we could not send",
    whatToDo: "Check the order and contact the customer yourself so they are not left waiting.",
    href: "/dashboard/orders",
  },
};

/** What an external operation whose outcome is unknown means. */
function describeOperation(operation: string): { affects: string; whatToDo: string; href: string } {
  if (operation.startsWith("email.")) {
    return {
      affects: "an email we cannot confirm was sent",
      // The honest instruction, and the reason this is a WARNING rather than a
      // failure: it may well have arrived. Telling somebody twice is a smaller
      // harm than telling them never, but it is still a harm, so the wording
      // sends them to check rather than to resend blindly.
      whatToDo: "We do not know whether it arrived. Check with the customer before sending it again.",
      href: "/dashboard/orders",
    };
  }
  return {
    affects: "an external operation we cannot confirm finished",
    whatToDo: "Check the provider before retrying, so nothing happens twice.",
    href: "/dashboard/connections",
  };
}

/**
 * Everything operational that went wrong for THIS business.
 *
 * Bounded the same way the rest of the attention system is: the last seven days
 * and a cap, so a long-broken deployment produces a readable dashboard rather
 * than an unreadable one.
 *
 * Messages deliberately carry no row ids. The attention system already groups
 * items by identical message text, so three failed order emails become one card
 * saying so with three occurrences behind it — reusing that rather than
 * inventing a second grouping concept, and the reason a message must describe
 * the CONDITION rather than the instance.
 */
export async function getOperationalIssues(storeId: string): Promise<AttentionItem[]> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const stalledBefore = new Date(Date.now() - STALL_MS);
  const items: AttentionItem[] = [];

  const [dead, stalled, indeterminate, deliveries] = await Promise.all([
    // Out of attempts. The work is not going to happen on its own.
    prisma.job.findMany({
      where: { storeId, status: "dead", updatedAt: { gte: since } },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, kind: true, updatedAt: true },
    }),
    // Claimed by a worker that never came back.
    prisma.job.findMany({
      where: { storeId, status: "running", lockedAt: { lt: stalledBefore } },
      orderBy: { lockedAt: "desc" },
      take: 20,
      select: { id: true, kind: true, lockedAt: true },
    }),
    prisma.outboundOperation.findMany({
      where: { storeId, status: "indeterminate", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, operation: true, createdAt: true },
    }),
    // Signature-valid only, matching platformHealth's own replayable count: a
    // delivery that never verified is not a lost order, it is somebody
    // knocking, and it belongs on the security stream rather than on a
    // merchant's dashboard.
    prisma.webhookDelivery.findMany({
      where: { storeId, status: "failed", signatureValid: true, receivedAt: { gte: since } },
      orderBy: { receivedAt: "desc" },
      take: 20,
      select: { id: true, provider: true, receivedAt: true },
    }),
  ]);

  for (const job of dead) {
    const meaning = JOB_MEANING[job.kind];
    items.push({
      id: `job-dead:${job.id}`,
      kind: "operational-failure",
      severity: "FAILED",
      message: meaning
        ? `We tried several times and could not finish ${meaning.affects}. ${meaning.whatToDo}`
        : "Something we were doing for you failed repeatedly and has stopped. We have been told about it.",
      occurredAt: job.updatedAt,
      actionHref: meaning?.href,
    });
  }

  for (const job of stalled) {
    const meaning = JOB_MEANING[job.kind];
    items.push({
      id: `job-stalled:${job.id}`,
      kind: "operational-failure",
      // A WARNING rather than a failure: it started, and it may yet be
      // retried by the sweep. Saying "failed" about work still in flight is
      // the kind of wrong that teaches people to ignore the card.
      severity: "WARNING",
      message: meaning
        ? `Work on ${meaning.affects} started and did not finish. It will be retried.`
        : "Something we started for you did not finish. It will be retried.",
      occurredAt: job.lockedAt,
      actionHref: meaning?.href,
    });
  }

  for (const operation of indeterminate) {
    const meaning = describeOperation(operation.operation);
    items.push({
      id: `outbound-unknown:${operation.id}`,
      kind: "operational-failure",
      severity: "WARNING",
      message: `There is ${meaning.affects}. ${meaning.whatToDo}`,
      occurredAt: operation.createdAt,
      actionHref: meaning.href,
    });
  }

  for (const delivery of deliveries) {
    items.push({
      id: `delivery-failed:${delivery.id}`,
      kind: "operational-failure",
      severity: "FAILED",
      // ============ WHAT AN OWNER CAN HONESTLY DO HERE ==========
      //
      // Not replay it. Replay is a platform-operator action behind
      // assertPlatformAdmin, and it stays there — handing a merchant a button
      // that re-runs a payment provider's event is not a feature, it is a way
      // to charge somebody twice.
      //
      // So the card does the one useful thing it can: names the provider,
      // says an order may be missing, and points at the provider's own record
      // — which is the copy the merchant can actually check against.
      message:
        `We received something from ${delivery.provider} and could not process it. ` +
        `An order may be missing from your list. Check your ${delivery.provider} account for a ` +
        `payment with no matching order here, and let us know — we can re-run it.`,
      occurredAt: delivery.receivedAt,
      actionHref: "/dashboard/orders",
    });
  }

  return items;
}
