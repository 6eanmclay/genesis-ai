import { HANDLERS, validateJobPayload } from "@/lib/jobs/registry";
import { drain } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { releaseStaleReplays } from "@/lib/webhooks/replay";
import { runAlertSweep } from "@/lib/observability/alerts";
import { sweepAbandonedTemporaries } from "@/lib/storage/temporaryAssets";
import { pruneExpiredAttempts } from "@/lib/auth/attemptThrottle";
import { runDueOrderNotifications } from "@/lib/orders/notificationSweep";
import { runDueSyncs } from "@/lib/intelligence/scheduler";
import { runDueIntelligenceCycles } from "@/lib/intelligence/cycle";
import { runDueGrowthPointRefreshes } from "@/lib/growthPoints/refresh";
import { runDueSourcing } from "@/lib/sourcing/sourcingSchedule";
import {
  attributionSweepEnabled,
  nightlyApplies,
  nightlyEnabled,
  runAttributionSweep,
  runNightlyReconciliation,
} from "@/lib/storage/reconcile";

// EVERYTHING GENESIS DOES ON A SCHEDULE, DECLARED RATHER THAN SEQUENCED.
//
// ============ WHAT THIS REPLACES (2026-08-30) ==========================
//
// Eleven responsibilities awaited one after another inside a single route
// handler, and their cadence was an accident of the trigger. "Daily" meant
// the Vercel entry said `0 6 * * *`; "weekly" meant a stage asked
// `getUTCDay() === 0` in the middle of its own body. Changing when something
// ran meant editing an if-statement, and nothing could state what the schedule
// WAS without reading three hundred lines.
//
// Here a schedule is data: an interval, a lane, and whether it is switched on.
// The runner reads this. The routes call the runner. Adding a task is adding an
// entry, and moving one to its own real cron is changing a lane — neither is a
// rewrite, which is the whole requirement.
//
// ============ THE LANES, AND WHY THEY ARE THE DIVISION ================
//
// Not a taxonomy for its own sake. A lane is "what kind of thing is this, and
// therefore what does a delay cost":
//
//   queue        Draining durable work somebody is waiting on. The ONLY lane
//                whose delay is felt by a customer, and the one that should
//                eventually run every few minutes. It is not maintenance — it
//                is the runner for the queue the platform already depends on.
//
//   timely       Work with a deadline of its own that must not wait a day. A
//                receipt is the one thing a customer has. Today this shares the
//                daily trigger; it is a lane so that it can stop.
//
//   recompute    Idempotent passes over stored state. A failure costs nothing
//                because the next run recomputes the same thing plus whatever
//                arrived since. THESE MUST NOT ACQUIRE DURABLE STATE — Sean,
//                2026-08-30: "anything that can safely be recomputed should
//                remain recomputable rather than acquiring unnecessary durable
//                state." The run record here is evidence a run happened, never
//                a work item.
//
//   maintenance  Housekeeping nobody waits on. Stale claims, expired throttle
//                rows, abandoned uploads. Cheap, and safe to lose a day of.
//
//   outbound     Passes that call third parties on their own initiative. Their
//                own lane because they are the ones that cost money and time,
//                and the ones a budget should shed first.
//
// ============ ON NOT MOVING WORK INTO THE QUEUE =======================
//
// Almost nothing here should enqueue, and that is deliberate. A sweep that
// recomputes what is due from stored state already has the property the queue
// exists to provide: a failed run is repaired by the next one. Wrapping it in a
// job would add a retry mechanism, a payload, a dead-letter path and a second
// source of truth about what is due — state bought with nothing.
//
// The one genuine exception is telemetry.prune, below.

export type Lane = "queue" | "timely" | "recompute" | "maintenance" | "outbound";

export interface ScheduledTask {
  /** Stable. It is the key in ScheduledTaskRun and must survive renames. */
  key: string;
  lane: Lane;
  /** What it is for, in one line, for an operator who has never seen it. */
  purpose: string;
  /**
   * How often it should run, in milliseconds.
   *
   * NOT how often it is triggered. The runner compares this against the last
   * successful run in the database, so a task with a daily interval invoked
   * every minute runs once a day, and the same task invoked once a day also
   * runs once a day. That equivalence is what lets real schedules be switched
   * on later without touching a line of this.
   */
  everyMs: number;
  /**
   * Whether it is switched on at all.
   *
   * Separate from the interval on purpose: storage reconciliation is written,
   * tested and deliberately dark until its write paths are deployed, and that
   * is a different fact from "it is not due yet".
   */
  enabled: () => boolean;
  /**
   * THE LEAST TIME IN WHICH THIS TASK CAN DO SOMETHING USEFUL AND STOP.
   *
   * Not a worst case, not a limit, and not a promise about how long it will
   * actually take. The runner starts a task when at least this much of the
   * invocation remains.
   *
   * ============ WHY THIS IS NOT A RESERVATION (2026-09-02) ============
   *
   * It used to be `budgetMs`, meaning "roughly how long this is allowed to
   * take", and the runner refused to start a task unless that whole amount
   * still remained. Nothing enforced it, so it predicted a cost nobody
   * collected — and a task declaring 180s was refused with 141s free, every
   * tick, in the same order, forever. Two real tasks never ran at all.
   *
   * See ARCHITECTURE.md, *a scheduled task declares its minimum, not its
   * worst case*, for the full defect and the arithmetic that made it certain.
   *
   * ONLY intelligence.cycles HAS BEEN RE-DERIVED so far. Every other task
   * still carries the number it declared as a worst case. That is safe rather
   * than wrong — the check is identical, so their behaviour is unchanged — but
   * their numbers are conservative under the new meaning, and re-deriving them
   * is real work that belongs to whoever makes each task deadline-aware, not
   * to a rename.
   */
  minBudgetMs: number;
  /**
   * THE LONGEST THIS TASK MAY RUN BEFORE IT SHOULD STOP OF ITS OWN ACCORD.
   *
   * ============ WHY BOTH NUMBERS EXIST (2026-09-02) ==================
   *
   * `minBudgetMs` answers "is it worth starting", and this answers "how much
   * of the invocation is yours". Splitting them is what stopped a
   * self-bounding task from eating the whole tick: the deadline a task
   * receives is `min(end of invocation, now + maxBudgetMs)`, so a batch can
   * work until its own allowance runs out and the lanes behind it still get
   * the rest.
   *
   * Every value here is the number that task ALREADY declared as `budgetMs`
   * before the split — "roughly how long this is allowed to take" — recovered
   * verbatim rather than re-chosen, so no task's allowance silently changed.
   * For all but one task it equals `minBudgetMs`, which is exactly the old
   * behaviour: start only if the full allowance fits, then use it.
   *
   * Like the deadline itself, this is COOPERATIVE. Nothing kills a task that
   * runs past it; a task that batches is expected to check.
   */
  maxBudgetMs: number;
  /**
   * The work.
   *
   * `deadlineAt` is the epoch millisecond at which the invocation intends to
   * stop. It is COOPERATIVE: nothing kills a task that runs past it, because
   * killing one would abandon partial work. A task that batches over stores,
   * rows or jobs MUST honour it and stop early, reporting what it did against
   * what was due. A task that cannot bound itself simply ignores it and
   * declares a `minBudgetMs` equal to its real need.
   */
  run: (ctx: TaskContext) => Promise<unknown>;
}

export interface TaskContext {
  /** Epoch ms the invocation intends to stop at. Advisory, never enforced. */
  deadlineAt: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Always on. Named so the registry reads as a table rather than a wall of arrows. */
const always = () => true;

/**
 * SUPPLIER DISCOVERY IS OFF, AND THAT IS A CHANGE (2026-09-02).
 *
 * It was `enabled: always` and had never once run: it declares the entire
 * invocation budget, and something always runs before it. Fixing the
 * scheduler's starvation would have started it — the only task that makes
 * third-party calls on its own initiative — as a side effect of work that had
 * nothing to do with it.
 *
 * So its OBSERVED behaviour is preserved by changing its DECLARED state, which
 * is the honest way round: the alternative was shipping a silent behaviour
 * change inside a fix for something else. Turning it on is its own decision.
 */
const sourcingDiscoveryEnabled = () => process.env.SOURCING_DISCOVERY_ENABLED === "1";

export const SCHEDULED_TASKS: ScheduledTask[] = [
  // ---------------------------------------------------------------- queue
  {
    key: "queue.drain",
    lane: "queue",
    purpose: "Run durable jobs that are due — the runner for the job queue.",
    // ============ THE NUMBER THAT MATTERS MOST HERE =================
    //
    // Two minutes, and today nothing invokes it that often. That is the point:
    // the interval states what this work NEEDS, and the trigger states what the
    // infrastructure currently provides. While they disagree, the gap is
    // visible in one place instead of being invisible in a cron expression.
    //
    // Until a frequent trigger exists, a job enqueued just after the daily tick
    // waits for the next one. That is a real, stated limitation of the plan —
    // not of this design.
    everyMs: 2 * MINUTE,
    enabled: always,
    minBudgetMs: 60_000,
    maxBudgetMs: 60_000,
    run: () =>
      drain(HANDLERS, {
        maxJobs: 50,
        deadline: new Date(Date.now() + 60_000),
        validate: validateJobPayload,
      }),
  },

  // --------------------------------------------------------------- timely
  {
    key: "orders.notifications",
    lane: "timely",
    purpose: "Find paid, delivered or refunded orders with no notice sent, and queue the notice.",
    // ============ WHY THIS IS NOT DAILY ============================
    //
    // A receipt is the one thing a customer has, and the PayPal path is a
    // browser redirect nobody retries. Fifteen minutes is what this deserves;
    // the daily trigger is what it currently gets. Declaring the real interval
    // means switching it on later is a schedule entry, not a code change.
    //
    // It ENQUEUES rather than sends. The sweep decides what is missing — a
    // recomputable question — and the queue owns delivery, which is the half
    // that genuinely needs retries and idempotency.
    everyMs: 15 * MINUTE,
    enabled: always,
    minBudgetMs: 30_000,
    maxBudgetMs: 30_000,
    run: () => runDueOrderNotifications(),
  },

  // ------------------------------------------------------------ recompute
  {
    key: "intelligence.syncs",
    lane: "recompute",
    purpose: "Pull fresh data for stores whose connectors are due a sync.",
    everyMs: DAY,
    enabled: always,
    minBudgetMs: 120_000,
    maxBudgetMs: 120_000,
    run: () => runDueSyncs(50),
  },
  {
    key: "growthPoints.refresh",
    lane: "recompute",
    purpose: "Grant monthly Growth Point refreshes to stores that are due one.",
    // Its own entry rather than a stage inside another: a store needs no
    // connected integration to be due points, and the two have never had
    // anything to do with each other beyond sharing a trigger.
    everyMs: HOUR,
    enabled: always,
    minBudgetMs: 60_000,
    maxBudgetMs: 60_000,
    run: () => runDueGrowthPointRefreshes(50),
  },
  {
    key: "intelligence.cycles",
    lane: "recompute",
    purpose: "Run the first-party intelligence cycle for stores with new activity.",
    everyMs: DAY,
    enabled: always,
    // ENOUGH FOR ONE BUSINESS, not for all of them (2026-09-02).
    //
    // This declared 180_000 under the old worst-case rule and was refused
    // every single tick, because something ahead of it always left less than
    // three minutes. Under the minimum rule it declares what it takes to
    // evaluate at least one store and produce a real result, and the deadline
    // below decides how many more it gets through. A pass that reaches four of
    // sixteen is a pass that did four businesses' work, not a failure — and it
    // leaves the other twelve first in line.
    minBudgetMs: 30_000,
    maxBudgetMs: 180_000,
    // The skip list is gone, and that is a behaviour change stated rather than
    // slipped in. It existed because syncs ran immediately before this in one
    // invocation; as independent tasks with their own cadence there is no
    // "just now" to deduplicate against. runDueIntelligenceCycles already
    // selects only stores that are due, so a store whose cycle just ran is not
    // due — the deduplication it needs comes from its own due-ness, which is
    // the property that survives the two tasks being scheduled apart.
    run: (ctx) => runDueIntelligenceCycles(50, { deadlineAt: ctx.deadlineAt }),
  },
  {
    key: "storage.reconcile",
    lane: "recompute",
    purpose: "Compare the storage ledger against the provider and record drift.",
    everyMs: DAY,
    // DARK BY DECISION, not by omission. Sean, 2026-08-30: reconciliation must
    // not be activated until the ledger write paths are deployed, or its first
    // report is a pile of false orphans nobody reads past.
    enabled: nightlyEnabled,
    minBudgetMs: 120_000,
    maxBudgetMs: 120_000,
    run: async () => {
      const { vercelBlobStorage } = await import("@/lib/storage/vercelBlob");
      return runNightlyReconciliation({
        listObjects: async () => {
          const listing = await vercelBlobStorage.list();
          return {
            objects: listing.objects.map((o) => ({ pathname: o.pathname, url: o.url, size: o.size })),
            truncated: listing.truncated,
          };
        },
        // ============ REPORTS BEFORE IT CORRECTS (2026-09-01) ====
        //
        // Was a hard-coded `true`, so the act of enabling this task would
        // have taken it from never having run to writing to production on
        // its first pass. STORAGE_RECONCILE=on now runs it read-only and
        // STORAGE_RECONCILE=apply lets it act — the same look-first shape
        // the retention sweep and the security prune already have.
        apply: nightlyApplies(),
      });
    },
  },
  {
    key: "storage.attributionSweep",
    lane: "recompute",
    purpose: "Re-derive ownership for stored objects whose attribution is unclear.",
    // ============ THE getUTCDay() IS GONE ==========================
    //
    // This was weekly because its stage asked whether today was Sunday, inside
    // a daily route. The cadence is now the cadence, which means it is also
    // true when the trigger changes — a Sunday check would have run this every
    // minute on a Sunday the moment a frequent trigger existed.
    everyMs: WEEK,
    enabled: attributionSweepEnabled,
    minBudgetMs: 240_000,
    maxBudgetMs: 240_000,
    run: async () => {
      const { vercelBlobStorage } = await import("@/lib/storage/vercelBlob");
      const listing = await vercelBlobStorage.list();
      const hosts = [...new Set(listing.objects.map((o) => new URL(o.url).host))];
      return runAttributionSweep({ hosts, apply: true });
    },
  },

  // ---------------------------------------------------------- maintenance
  {
    key: "webhooks.releaseStaleReplays",
    lane: "maintenance",
    purpose: "Release deliveries a crashed replay left claimed, so they can be replayed again.",
    everyMs: HOUR,
    enabled: always,
    minBudgetMs: 15_000,
    maxBudgetMs: 15_000,
    run: () => releaseStaleReplays(),
  },
  {
    key: "storage.temporaryAssets",
    lane: "maintenance",
    purpose: "Delete uploads a crashed creation left behind.",
    everyMs: DAY,
    enabled: always,
    minBudgetMs: 60_000,
    maxBudgetMs: 60_000,
    run: () => sweepAbandonedTemporaries(),
  },
  {
    key: "auth.pruneAttempts",
    lane: "maintenance",
    purpose: "Drop sign-in throttle rows that have outlived their window.",
    everyMs: DAY,
    enabled: always,
    minBudgetMs: 15_000,
    maxBudgetMs: 15_000,
    run: () => pruneExpiredAttempts(),
  },
  {
    key: "telemetry.prune",
    lane: "maintenance",
    purpose: "Enqueue the retention pass that drops telemetry past its horizon.",
    // ============ THE ONE TASK THAT SHOULD ENQUEUE (2026-08-30) =====
    //
    // The inventory found telemetry.prune registered as a job kind, with a
    // working handler, and NO PRODUCER ANYWHERE. The retention window has never
    // run and could not run: the registry cross-check proves kinds match
    // handlers, and nothing proves a kind is ever enqueued.
    //
    // It belongs in the queue rather than being called here because it is a
    // bounded deletion that can genuinely fail halfway and wants a retry with
    // backoff — the one shape on this page the queue is actually for. So this
    // task's whole job is to produce the work; the queue's job is to run it.
    //
    // The idempotency key is the day, so a trigger firing every minute produces
    // one prune per day rather than one per minute.
    everyMs: DAY,
    enabled: always,
    minBudgetMs: 5_000,
    maxBudgetMs: 5_000,
    run: async () => {
      const day = new Date().toISOString().slice(0, 10);
      const created = await enqueue({
        kind: "telemetry.prune",
        idempotencyKey: `telemetry.prune:${day}`,
        payload: {},
      });
      return { enqueued: created !== null, day };
    },
  },

  {
    key: "retention.sweep",
    lane: "maintenance",
    purpose: "Enqueue the pass that clears old webhook payloads and operational rows.",
    // The same producer shape as the other two prunes, and the same deliberate
    // omission: no apply flag, so the handler's dry-run default stands. This
    // one clears CUSTOMER DATA — the bodies of handled provider deliveries —
    // and switching it on is a decision recorded in EXTERNAL_BLOCKERS.md.
    everyMs: DAY,
    enabled: always,
    minBudgetMs: 10_000,
    maxBudgetMs: 10_000,
    run: async () => {
      const day = new Date().toISOString().slice(0, 10);
      const created = await enqueue({
        kind: "retention.sweep",
        idempotencyKey: `retention.sweep:${day}`,
        payload: {},
      });
      return { enqueued: created !== null, day };
    },
  },

  {
    key: "security.prune",
    lane: "maintenance",
    purpose: "Enqueue the pass that drops security signals past their horizon.",
    // Enqueues rather than deletes, exactly like telemetry.prune above and for
    // the same reason: a bounded deletion that can fail halfway wants the
    // queue's retry, and this task's whole job is to produce the work.
    //
    // Keyed by the day, so a frequent trigger produces one prune per day rather
    // than one per tick.
    everyMs: DAY,
    enabled: always,
    minBudgetMs: 5_000,
    maxBudgetMs: 5_000,
    run: async () => {
      const day = new Date().toISOString().slice(0, 10);
      const created = await enqueue({
        kind: "security.prune",
        idempotencyKey: `security.prune:${day}`,
        // ============ APPLY IS DELIBERATELY ABSENT (2026-08-30) ====
        //
        // So the handler's dry-run default stands. This deletes EVIDENCE, and
        // switching it on is a decision to make once the footprint has been
        // looked at — recorded in EXTERNAL_BLOCKERS.md rather than defaulted to.
        payload: {},
      });
      return { enqueued: created !== null, day };
    },
  },

  {
    key: "ops.alerts",
    lane: "maintenance",
    purpose: "Look for anything that needs a person, and say it once.",
    // ============ THE TASK THAT WATCHES THE OTHERS (2026-08-30) =====
    //
    // Hourly, which is a deliberate compromise: often enough that a dead letter
    // does not sit unseen all day, rare enough that it costs nothing. The
    // cooldown inside the sweep is what actually decides how often anybody
    // HEARS anything, and that is six hours per distinct finding.
    //
    // Maintenance rather than timely, because a finding is already true by the
    // time this runs — being told twenty minutes later changes nothing, and the
    // timely lane is for work a customer is waiting on.
    //
    // AND IT REPORTS ON THE SCHEDULER THAT RUNS IT. That looks circular and is
    // not: a scheduler which has stopped entirely cannot report itself, which is
    // exactly why schedulerHealth measures absence rather than presence. This
    // catches the tasks that stopped; nothing inside a stopped process can
    // catch the process.
    everyMs: HOUR,
    enabled: always,
    minBudgetMs: 30_000,
    maxBudgetMs: 30_000,
    run: () => runAlertSweep(),
  },

  // ------------------------------------------------------------- outbound
  {
    key: "sourcing.discovery",
    lane: "outbound",
    purpose: "Search suppliers and refresh economics for businesses that are due it.",
    // Last, and shed first under a tight budget: the only task that makes
    // third-party calls on its own initiative, and the only one where an
    // invocation running out of time should lose this before it loses a
    // customer's receipt.
    everyMs: DAY,
    enabled: sourcingDiscoveryEnabled,
    minBudgetMs: 240_000,
    maxBudgetMs: 240_000,
    run: () => runDueSourcing(),
  },
];

/** The order tasks are considered in. Never alphabetical — cost of delay first. */
export const LANE_ORDER: Lane[] = ["queue", "timely", "recompute", "maintenance", "outbound"];

export function tasksInLane(lane: Lane): ScheduledTask[] {
  return SCHEDULED_TASKS.filter((t) => t.lane === lane);
}

export function taskByKey(key: string): ScheduledTask | undefined {
  return SCHEDULED_TASKS.find((t) => t.key === key);
}
