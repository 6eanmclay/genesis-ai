import { speakNewFindings } from "./proactive";
import { reportIssue } from "@/lib/observability/reportIssue";
import { proposeStaffPolicyGap } from "@/lib/businessModel/staffPolicyGap";
import { prisma, prismaSystem } from "@/lib/prisma";
import { computeInsights, INSIGHT_ENGINE_CONSUMER, type Insight } from "./insights";
import { distillBeliefs } from "./learn";
import { notifyFromInsights } from "./notify";
import { runOpportunisticAiReviewIfStale } from "@/lib/dashboard/genesisObservations";

// Business Intelligence Engine M1 (2026-08-18) — the reachable cycle.
//
// THE ENGINE WAS ALREADY BUILT. Collection, change detection, interpretation,
// insight, recommendation, notification and belief distillation are all real
// code in this directory and none of them are touched here. The only thing that
// was missing was a way in.
//
// scheduler.ts only ever added a store to `touchedStoreIds` inside the
// successful-connector-sync branch, and every downstream stage ran inside that
// loop. A store whose entire business is first-party Genesis commerce — real
// orders, real products, real decisions — has no StoreIntegration at all, so it
// was never "touched", so the whole engine never ran for it on any schedule.
// See BI_ENGINE.md §2, Defect 1.
//
// This file changes nothing about WHAT the engine concludes. It only changes
// WHICH stores get to run it, and the answer is now "the ones where something
// actually happened," which needs no connector.

// One place, one definition of the chain — scheduler.ts's connector path and
// the first-party path below both call runIntelligenceCycle, so the two can
// never drift into different ideas of what a cycle is.
export interface IntelligenceCycleSummary {
  storeId: string;
  ok: boolean;
  /** Insights computed this pass. Zero is a real, valid result. */
  insights: number;
  /**
   * Findings J4 spoke about in the conversation this pass.
   *
   * Zero is the ordinary outcome and not a failure — it means nothing new
   * became true, or everything true had already been said.
   */
  spoken: number;
  /**
   * Which stages did not complete, by name (2026-08-24).
   *
   * Empty is the ordinary outcome. A named stage here is the difference
   * between "the engine ran and found nothing" and "the engine did not
   * finish", which a bare `ok: false` cannot tell apart — the same
   * distinction `stageErrors` already draws one level up in the cron route.
   */
  failedStages: string[];
}

/** The stages of one pass, in order. Named so a failure can say which. */
export type CycleStage =
  | "insights"
  | "notify"
  | "learn"
  | "ai_review"
  | "staff_policy_gap"
  | "speak";

/**
 * What one pass actually does, as functions.
 *
 * SEPARATED FROM ITS OWN PLUMBING for the same reason selectDueStoreIds below
 * is: this is the part with real semantics — which failures are survivable,
 * which stage genuinely depends on which — and it should be provable against
 * engineered inputs rather than only observable through whatever a live
 * database and a live provider happen to do on the day.
 */
export interface CycleStages {
  insights: () => Promise<Insight[]>;
  notify: (insights: Insight[]) => Promise<void>;
  learn: () => Promise<void>;
  aiReview: (insights: Insight[] | null) => Promise<void>;
  staffPolicyGap: () => Promise<void>;
  speak: () => Promise<{ spoken: number }>;
}

/**
 * Where a stage failure is reported. Injectable for the same reason
 * lib/observability/reportIssue.ts's own IssueSink is: "this reported, with
 * this stage, tagged with this tenant" cannot be checked by reading.
 */
export type CycleIssueSink = (
  message: string,
  error: unknown,
  context: { subsystem: "scheduler"; stage: string; storeId: string }
) => void;

/**
 * One pass, with one stage's failure isolated from the stages behind it.
 *
 * ONE STAGE'S FAILURE DOES NOT TAKE THE STAGES BEHIND IT (2026-08-24).
 *
 * This chain used to be six bare awaits. The AI review is the one stage that
 * needs a provider, and this file already said so — "the AI review stage is the
 * usual one, since it needs a provider". What that meant in practice was that a
 * provider outage silently killed the two stages AFTER it, both of which are
 * documented below as needing no provider at all: the staff-policy ask
 * ("deterministic and cheap — two reads") and J4 speaking what it noticed ("No
 * model, no session"). With Anthropic credit exhausted, that was not a
 * hypothetical — it was every daily pass.
 *
 * The cron route learned exactly this on 2026-08-20 and isolated its five
 * stages from each other. `speakNewFindings` was added to this cycle three days
 * later, behind the throw. The route was isolated; the cycle inside it was not.
 * This applies the same pattern one level down.
 */
export async function runCycleStages(
  storeId: string,
  stages: CycleStages,
  sink: CycleIssueSink = reportIssue
): Promise<IntelligenceCycleSummary> {
  const failedStages: CycleStage[] = [];

  // RETURNS THE VALUE rather than assigning into a closure. The closure form
  // typechecked as `never` downstream: TypeScript cannot see an assignment that
  // happens inside a callback, so `insights` stayed narrowed to null and the
  // non-null branch became unreachable. Returning keeps the flow visible.
  const runStage = async <T>(stage: CycleStage, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (error) {
      failedStages.push(stage);
      // BOUND AND REPORTED, not discarded. The catch that used to hold this
      // path took no parameter at all, so a failing cycle produced `ok: false`
      // and no error anywhere — on Vercel, a console line at best. scheduler.ts
      // already reports its connector failures this way; the first-party path,
      // which is the only path with data in it today, did not.
      sink(`intelligence cycle stage "${stage}" failed`, error, {
        subsystem: "scheduler",
        stage: `intelligence.${stage}`,
        storeId,
      });
      return null;
    }
  };

  // Insight Engine -> Notifications -> Learn -> Reason, in that order. Insights
  // include time-based conditions (trend windows crossing a week boundary,
  // overdue thresholds) that can become newly significant purely from time
  // passing, so a pass is still worth running for a store whose newest events
  // individually produced nothing.
  const computed = await runStage("insights", stages.insights);

  // NOT RUN WITH AN EMPTY LIST WHEN INSIGHTS FAILED. notifyFromInsights
  // resolves anything absent from the set it is given, so passing [] after a
  // failure would retract every standing finding the owner is looking at —
  // silently, and as though the engine had decided they were no longer true.
  // Recorded as failed rather than skipped: it did not run, and "did not run"
  // and "ran and found nothing" must not look alike.
  if (computed === null) {
    failedStages.push("notify");
  } else {
    await runStage("notify", () => stages.notify(computed));
  }

  // Growth Engine M1's rule, preserved exactly: Learn runs unconditionally
  // alongside computeInsights, never collapsed into Reason's own 24h cadence.
  // It is deterministic and cheap, and it must stay continuous/ambient.
  //
  // M1 HONESTY NOTE: on a first-party store this will mostly produce nothing
  // yet, because all three of learn.ts's detectors filter on
  // `topicKey: { not: null }` and chat-originated proposals leave it null (5 of
  // 37 on the real store). That is Defect 2, deliberately deferred to M2 — the
  // cycle running and finding little is the honest state, not a bug to paper
  // over here.
  await runStage("learn", () => stages.learn());

  // The recommendation stage. Self-gated on its own staleness/claim check, so
  // this is usually a cheap no-op and never a per-pass AI cost. No briefing is
  // composed from here — that stays owner-attended, exactly as before.
  //
  // THE ONE STAGE THAT NEEDS A PROVIDER. runCognitiveReview writes its own
  // durable FAILED ExecutionLog and then throws; that log is the owner-facing
  // half and is unchanged. What changed is that its throw no longer reaches the
  // two stages below.
  await runStage("ai_review", () => stages.aiReview(computed));

  // WHAT J4 IS MISSING AND CAN JUSTIFY ASKING FOR (2026-08-23). Deterministic
  // and cheap — two reads — so it runs unconditionally here rather than inside
  // the stale-gated AI review, and before the speaking step below so a newly
  // justified ask can be raised and said in the same pass.
  await runStage("staff_policy_gap", () => stages.staffPolicyGap());

  // J4 SAYS WHAT IT NOTICED, last and deterministically (Proactive J4).
  //
  // After the findings sweep above, so it speaks about the set that is true
  // NOW rather than the one from before this pass. No model, no session, no
  // active-business pointer — the storeId this function was called with is the
  // business, all the way down.
  //
  // Silence is an ordinary outcome: a business where nothing changed hears
  // nothing, however often this runs.
  const spoke = await runStage("speak", stages.speak);

  // `ok` still means "this pass completed", exactly as before — it is now
  // derived from the named stages rather than from whether anything threw, so
  // the two can never disagree.
  return {
    storeId,
    ok: failedStages.length === 0,
    insights: computed?.length ?? 0,
    // Zero when the stage failed, never a number it did not produce. If it
    // spoke before failing, that message and its delivery row are already real
    // and durable — this is what THIS summary can honestly attest to, not a
    // retraction.
    spoken: spoke?.spoken ?? 0,
    failedStages,
  };
}

/**
 * One full pass of the existing engine for one store.
 *
 * The wiring only. Every stage is the same function it always was, called in
 * the same order; what changed is that runCycleStages decides what a failure
 * does. The connector path and the first-party path both call this, so the two
 * can never drift into different ideas of what a cycle is.
 */
export async function runIntelligenceCycle(storeId: string): Promise<IntelligenceCycleSummary> {
  const summary = await runCycleStages(storeId, {
    insights: () => computeInsights(storeId),
    notify: (insights) => notifyFromInsights(storeId, insights),
    learn: () => distillBeliefs(storeId),
    aiReview: async (insights) => {
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { userId: true },
      });
      await runOpportunisticAiReviewIfStale(storeId, store?.userId ?? null, insights ?? undefined);
    },
    staffPolicyGap: () => proposeStaffPolicyGap(storeId),
    speak: () => speakNewFindings(storeId),
  });

  // ============ ONLY A COMPLETED PASS COUNTS AS AN EVALUATION ==========
  //
  // Written when every stage ran without failing, and at no other time — not
  // because the store was selected, and never on a pass that failed partway.
  //
  // The consequence is deliberate: a store whose cycle keeps failing never
  // records a success, stays due, and is retried every run. A failure must
  // never be able to masquerade as a healthy pass that found nothing, which is
  // exactly what a "last attempted" timestamp would have allowed.
  //
  // The bound that follows is stated in ARCHITECTURE.md rather than
  // discovered later: a persistently failing store holds one slot of each
  // batch, which is self-limiting for a few and visible through `due` vs
  // `processed` if it ever stopped being a few.
  //
  // Failing to record it must not fail the pass — the work really did happen.
  if (summary.ok) {
    try {
      await prisma.store.updateMany({
        where: { id: storeId },
        data: { lastIntelligenceAt: new Date() },
      });
    } catch (error) {
      reportIssue("could not record lastIntelligenceAt", error, {
        subsystem: "scheduler",
        stage: "intelligence.cycle",
        storeId,
      });
    }
  }

  return summary;
}


export interface StoreEventActivity {
  storeId: string;
  maxSequence: bigint;
}

/** Every store, with when J4 last completed an evaluation of it. */
export interface StoreEvaluationState {
  storeId: string;
  /** Null means never evaluated. */
  lastIntelligenceAt: Date | null;
}

export interface ConsumerCursorState {
  storeId: string;
  lastProcessedSequence: bigint;
}

/**
 * Which stores have unconsumed BusinessEvent activity — the pure decision.
 *
 * Separated from its own database plumbing for the same reason
 * nextBestAction.ts separates pickNextBestAction: this is the part with real
 * semantics ("due", "already consumed", "leave alone"), and it should be
 * provable against engineered inputs rather than only observable through
 * whatever a live database happens to contain.
 *
 * A store is due when its highest event sequence is beyond where the Insight
 * Engine's cursor stopped. A store with no cursor row yet compares against 0,
 * matching BusinessEventCursor's own default, so a store that has never been
 * processed is due rather than invisible.
 *
 * A store with no new activity is absent from the result entirely. Not skipped
 * later, not processed and discarded — never selected.
 */
export function selectDueStoreIds(
  activity: StoreEventActivity[],
  cursors: ConsumerCursorState[],
  opts: {
    limit: number;
    skipStoreIds?: Iterable<string>;
    /**
     * Every store and when it was last evaluated. Omitted entirely and the
     * behaviour is exactly what it was before elapsed time counted: activity
     * only.
     */
    evaluations?: StoreEvaluationState[];
    /** How long a store may go unevaluated before it is due anyway. */
    maxAgeMs?: number;
    now?: Date;
  }
): string[] {
  const consumed = new Map(cursors.map((c) => [c.storeId, c.lastProcessedSequence]));
  const skip = new Set(opts.skipStoreIds ?? []);
  const now = opts.now ?? new Date();

  // ---- due because something happened ------------------------------------
  //
  // Unchanged. Largest backlog first, store id as a deterministic tie-break so
  // the same inputs always produce the same order. Self-correcting: a
  // processed store's lag returns to zero, so it yields to others next pass.
  const byActivity = activity
    .filter((a) => !skip.has(a.storeId))
    .map((a) => ({ storeId: a.storeId, lag: a.maxSequence - (consumed.get(a.storeId) ?? BigInt(0)) }))
    .filter((a) => a.lag > BigInt(0))
    .sort((a, b) => (a.lag === b.lag ? a.storeId.localeCompare(b.storeId) : a.lag > b.lag ? -1 : 1))
    .map((a) => a.storeId);

  // ---- due because time passed -------------------------------------------
  //
  // ============ WHY THIS NEEDED ITS OWN ORDERING (2026-09-02) ==========
  //
  // The rule above is fair because lag returns to zero when a store is
  // processed, so nobody can hold the front of the queue. A store due by
  // ELAPSED TIME has no lag to reset, so that argument does not carry over —
  // sorting the time-due set the same way would return the same head every
  // run and the tail would never be reached.
  //
  // Oldest-evaluated first restores exactly the property that was lost:
  // evaluating a store moves it to the back. Never-evaluated (null) sorts
  // first, which is also what makes the first run after the migration correct
  // rather than arbitrary.
  const seen = new Set(byActivity);
  const byAge =
    opts.evaluations === undefined || opts.maxAgeMs === undefined
      ? []
      : opts.evaluations
          .filter((e) => !skip.has(e.storeId) && !seen.has(e.storeId))
          .filter(
            (e) =>
              e.lastIntelligenceAt === null ||
              now.getTime() - e.lastIntelligenceAt.getTime() >= opts.maxAgeMs!,
          )
          .sort((a, b) => {
            const at = a.lastIntelligenceAt?.getTime() ?? -Infinity;
            const bt = b.lastIntelligenceAt?.getTime() ?? -Infinity;
            return at === bt ? a.storeId.localeCompare(b.storeId) : at - bt;
          })
          .map((e) => e.storeId);

  // ACTIVITY OUTRANKS AGE, deliberately. A store where something genuinely
  // happened has new information to interpret; a store due only because a day
  // passed has, by definition, nothing new. Under a tight limit the one with
  // something to say goes first.
  return [...byActivity, ...byAge].slice(0, Math.max(0, opts.limit));
}

/**
 * Cross-tenant, like getDueSyncs and for the same reason: the question is
 * "which stores across the platform are due", which no single store's scoped
 * client can ask. Only ever reached from the CRON_SECRET-gated cron route.
 *
 * Reads the same BusinessEventCursor consumer the Insight Engine already
 * advances, rather than inventing a second progress marker. Note the boundary
 * this respects: the cursor decides WHEN a store is processed; computeInsights
 * still decides what counts as unprocessed for its own purposes via
 * processedAt. Phase 1's independence invariant is intact — nothing here can
 * change what the Insight Engine treats as real.
 */
/**
 * How long a business may go unevaluated before it is due regardless of
 * whether anything happened.
 *
 * NOT A NEW NUMBER. `intelligence.cycles` already declares `everyMs: DAY`,
 * `intelligence.syncs` declares the same, and STALE_REVIEW_MS — the AI
 * review's own gate — is 24 hours. This is that same day, named once here so
 * the three cannot drift apart silently.
 */
export const INTELLIGENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function getStoresDueForIntelligence(
  limit: number,
  skipStoreIds?: Iterable<string>,
  now: Date = new Date()
): Promise<string[]> {
  const [activity, cursors, evaluations] = await Promise.all([
    prismaSystem.businessEvent.groupBy({
      by: ["storeId"],
      _max: { sequence: true },
    }),
    prismaSystem.businessEventCursor.findMany({
      where: { consumerName: INSIGHT_ENGINE_CONSUMER },
      select: { storeId: true, lastProcessedSequence: true },
    }),
    // CROSS-TENANT, and gated the same way everything else here is: this asks
    // "which stores across the platform are due", which no store-scoped client
    // can ask, and is reachable only from the CRON_SECRET-gated route.
    prismaSystem.store.findMany({
      select: { id: true, lastIntelligenceAt: true },
    }),
  ]);

  return selectDueStoreIds(
    activity
      .filter((a) => a._max.sequence !== null)
      .map((a) => ({ storeId: a.storeId, maxSequence: a._max.sequence as bigint })),
    cursors,
    {
      limit,
      skipStoreIds,
      evaluations: evaluations.map((s) => ({ storeId: s.id, lastIntelligenceAt: s.lastIntelligenceAt })),
      maxAgeMs: INTELLIGENCE_MAX_AGE_MS,
      now,
    }
  );
}

/**
 * The first-party entry point. Runs the existing engine for every store with
 * genuinely new activity, connector or not.
 *
 * `skipStoreIds` is how the cron pass avoids running a store twice in one
 * invocation when a connector sync already ran its cycle.
 *
 * Each store is isolated: one store's failure must not abort the pass for
 * every store behind it in the queue.
 */
export interface IntelligenceBatchSummary {
  /** Stores selected as due by this pass. */
  due: number;
  /** Stores actually evaluated before the deadline arrived. */
  processed: number;
  /** Of those, how many completed every stage. */
  completed: number;
  /** True when the deadline stopped the pass with stores still due. */
  stoppedEarly: boolean;
  summaries: IntelligenceCycleSummary[];
}

export async function runDueIntelligenceCycles(
  limit = 50,
  opts: { skipStoreIds?: Iterable<string>; deadlineAt?: number } = {}
): Promise<IntelligenceBatchSummary> {
  const due = await getStoresDueForIntelligence(limit, opts.skipStoreIds);

  const summaries: IntelligenceCycleSummary[] = [];
  let stoppedEarly = false;

  for (const storeId of due) {
    // STOP BEFORE STARTING ONE IT CANNOT FINISH.
    //
    // The deadline is the invocation's, and honouring it is this task's own
    // responsibility — nothing kills it (see ARCHITECTURE.md, *a scheduled
    // task declares its minimum, not its worst case*). Checked BEFORE a store
    // rather than during it, so a store is either evaluated properly or not
    // touched at all; a half-run cycle would be the one outcome that could
    // write a misleading lastIntelligenceAt.
    //
    // The stores not reached are not lost: they keep their older
    // lastIntelligenceAt, so they sort ahead of everyone evaluated today and
    // are first in line on the next invocation.
    if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
      stoppedEarly = true;
      break;
    }
    try {
      summaries.push(await runIntelligenceCycle(storeId));
    } catch (error) {
      // REACHED ONLY BY SOMETHING OUTSIDE THE NAMED STAGES now — every stage
      // inside runIntelligenceCycle catches and reports its own failure. A
      // throw arriving here is therefore unexpected in a way a stage failure is
      // not, and says so.
      reportIssue("intelligence cycle threw outside its stages", error, {
        subsystem: "scheduler",
        stage: "intelligence.cycle",
        storeId,
      });
      // Left honestly as a failed pass rather than swallowed silently.
      //
      // WHAT A FAILED PASS DOES AND DOES NOT UNDO (corrected 2026-08-21 — this
      // comment previously claimed "the cursor does not advance on a throw, so
      // the same events are retried next pass", which is not what happens and
      // would have someone assume a failed pass is fully retried).
      //
      // The cursor belongs to the INSIGHT ENGINE, and computeInsights advances
      // it once it has genuinely processed its events. A throw after that point
      // — the AI review stage is the usual one, since it needs a provider —
      // leaves the cursor advanced, correctly: those events really were
      // consumed by the consumer that owns the cursor. What failed was a later
      // stage that owns no cursor of its own.
      //
      // So `ok: false` means "this pass did not complete", never "nothing
      // happened". Insights may already have been recorded and beliefs already
      // distilled, both of which are real and durable. The one thing a failed
      // pass never does is claim insights it did not produce.
      // Same honesty as `insights: 0` above: a failed pass never claims to
      // have said something. If it spoke before failing, the message and its
      // delivery row are already real and durable — this number is what THIS
      // summary can honestly attest to, not a retraction.
      summaries.push({ storeId, ok: false, insights: 0, spoken: 0, failedStages: ["insights"] });
    }
  }

  return {
    due: due.length,
    processed: summaries.length,
    completed: summaries.filter((s) => s.ok).length,
    stoppedEarly,
    summaries,
  };
}
