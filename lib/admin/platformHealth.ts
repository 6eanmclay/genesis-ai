import { prismaSystem } from "@/lib/prisma";
import { queueDepth } from "@/lib/jobs/queue";
import { deliveryHealth } from "@/lib/webhooks/delivery";
import { indeterminateOperations } from "@/lib/outbound/runOnce";
import { tallySignals } from "@/lib/security/signals";
import { telemetryFootprint } from "@/lib/telemetry/retention";
import { schedulerHealth, schedulerNeedsAttention } from "@/lib/scheduler/health";

// WHAT THE PLATFORM IS DOING, FOR THE PERSON WHO OPERATES IT.
//
// ============ NOTHING NEW IS COMPUTED HERE (2026-08-30) ================
//
// Every number below already existed as a read function written alongside the
// system that produces it — queueDepth, deliveryHealth, indeterminateOperations,
// tallySignals, telemetryFootprint. All seven were computable and none were
// visible, which is the entire gap this closes.
//
// So this assembles rather than calculates. A second implementation of "how
// deep is the queue" living here would be the mirrored-registry problem in a
// new place: two answers to one question, agreeing until the day they did not.
//
// ============ WHAT AN OPERATOR ACTUALLY NEEDS TO SEE ==================
//
// Not everything. Four questions, in the order somebody asks them when
// something is wrong:
//
//   is the scheduler even running?           scheduled task health
//   is work flowing, or piling up?           queue depth, dead letters
//   is anything stuck that nobody can see?   indeterminate operations
//   are providers reaching us, and signed?   delivery health
//   is somebody attacking us?                 security tally
//
// The counts that matter most are the ones that should be zero: dead letters,
// indeterminate operations, rejected deliveries. A dashboard whose interesting
// numbers are all zero on a healthy day is one where a non-zero means something.

export interface DeadLetter {
  id: string;
  kind: string;
  storeId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

export interface PlatformHealth {
  generatedAt: string;
  queue: {
    depth: Awaited<ReturnType<typeof queueDepth>>;
    /** Work that gave up. Should be empty; a row here is somebody's problem. */
    deadLetters: DeadLetter[];
    /** Claimed but not finished for longer than a runner should take. */
    stalled: number;
  };
  /**
   * External effects nobody can explain.
   *
   * The most important list on this page. Each one is a call we made to a
   * provider whose outcome we never learned — possibly a charge, possibly
   * nothing — and it is deliberately never retried automatically.
   */
  indeterminate: Awaited<ReturnType<typeof indeterminateOperations>>;
  webhooks: {
    health: Awaited<ReturnType<typeof deliveryHealth>>;
    /** Verified, handled, failed, and never redelivered by the provider. */
    replayable: number;
  };
  security: Awaited<ReturnType<typeof tallySignals>>;
  telemetry: Awaited<ReturnType<typeof telemetryFootprint>>;
  /**
   * Whether the scheduled layer is alive.
   *
   * ============ THE FAILURE THAT USED TO BE INVISIBLE (2026-08-30) ===
   *
   * A cron that stopped firing and a cron where every task found nothing to do
   * produced identical evidence: none. Everything else on this page describes
   * work that HAPPENED; this is the only entry that can report work that
   * silently did not.
   */
  scheduler: Awaited<ReturnType<typeof schedulerHealth>>;
}

/** How long a running job may hold its claim before it is worth looking at. */
const STALL_MS = 15 * 60 * 1000;

export async function platformHealth(since?: Date): Promise<PlatformHealth> {
  const window = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stalledBefore = new Date(Date.now() - STALL_MS);

  const [depth, deadLetters, stalled, indeterminate, health, replayable, security, telemetry] =
    await Promise.all([
      queueDepth(),
      prismaSystem.job.findMany({
        where: { status: "dead" },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, kind: true, storeId: true, attempts: true, lastError: true, createdAt: true },
      }),
      prismaSystem.job.count({ where: { status: "running", lockedAt: { lt: stalledBefore } } }),
      indeterminateOperations(50),
      deliveryHealth(window),
      prismaSystem.webhookDelivery.count({ where: { status: "failed", signatureValid: true } }),
      tallySignals(window),
      telemetryFootprint(),
    ]);

  const scheduler = await schedulerHealth();

  return {
    generatedAt: new Date().toISOString(),
    queue: { depth, deadLetters, stalled },
    indeterminate,
    webhooks: { health, replayable },
    security,
    telemetry,
    scheduler,
  };
}

/**
 * Whether anything here needs a person.
 *
 * DELIBERATELY NARROW. Everything on this page is interesting to read; only
 * these four mean somebody should act, and a health check that says "attention
 * needed" about routine traffic is one nobody trusts twice.
 */
export function needsAttention(health: PlatformHealth): string[] {
  const reasons: string[] = [];
  if (health.queue.deadLetters.length > 0) {
    reasons.push(`${health.queue.deadLetters.length} job(s) gave up entirely`);
  }
  if (health.queue.stalled > 0) {
    reasons.push(`${health.queue.stalled} job(s) claimed and never finished`);
  }
  if (health.indeterminate.length > 0) {
    reasons.push(`${health.indeterminate.length} external operation(s) with an unknown outcome`);
  }
  if (health.webhooks.replayable > 0) {
    reasons.push(`${health.webhooks.replayable} webhook deliver(ies) failed and awaiting replay`);
  }
  // The scheduler speaks for itself — overdue, stuck, or failing — and stays
  // silent about a task that is deliberately switched off.
  reasons.push(...schedulerNeedsAttention(health.scheduler));

  const critical = health.security.filter((s) => s.severity === "critical");
  if (critical.length > 0) {
    reasons.push(`${critical.reduce((n, s) => n + s.count, 0)} critical security signal(s)`);
  }
  return reasons;
}
