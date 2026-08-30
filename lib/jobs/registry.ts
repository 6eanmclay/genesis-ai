import type { JobHandler } from "./queue";

// WHICH HANDLER RUNS WHICH KIND.
//
// ============ A MIRRORED REGISTRY, AND TREATED AS ONE ==================
//
// ARCHITECTURE.md's standing invariant: a registry keyed by a string that
// something else produces cannot be checked by the compiler, so it needs a
// runtime cross-check. Here the two sides are JOB_KINDS — what an enqueuer may
// ask for — and HANDLERS — what a runner can actually do.
//
// The failure without one is specific and quiet: a job enqueued under a kind
// nobody handles is claimed, fails, backs off, and eventually dead-letters,
// which looks like a broken handler rather than a missing one. Worse, it looks
// like nothing at all until somebody reads the dead-letter list.
//
// scripts/verify-jobs-db.ts asserts the two sides match exactly, in both
// directions. A kind with no handler fails; a handler for a kind nobody
// declared fails too, because that is a handler nothing can ever reach.
//
// ============ WHY IT IS EMPTY TODAY ====================================
//
// The queue is the foundation, and the first users of it are the paths this
// codebase already has private fragments of — order notifications, syncs,
// webhook processing. Moving those onto it is a change to working code with
// its own risk and its own approval, so the queue lands first and proves
// itself, and each migration is its own decision.
//
// The `noop` kind is real and is not a placeholder: a queue with no registered
// kind at all cannot be exercised end to end, and an untested queue is worse
// than none. It does nothing, on purpose, and is the shape every real handler
// takes.

/**
 * Every kind an enqueuer may name.
 *
 * Adding one here without a handler below is a failing test, which is the
 * point — the alternative is discovering it from a dead-lettered job.
 */
export const JOB_KINDS = ["noop"] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/**
 * The do-nothing handler.
 *
 * Exists so the queue itself is exercisable — claim, run, complete — without
 * borrowing a real side effect to test with. It is also the reference shape:
 * a handler takes a context, does its work, and returns. It does not report
 * success; completing without throwing IS success, and throwing IS failure.
 * There is no third answer, deliberately, because a handler that could return
 * "partly done" would need the queue to decide what that means.
 */
const noop: JobHandler = async () => {};

export const HANDLERS: Record<string, JobHandler> = {
  noop,
};
