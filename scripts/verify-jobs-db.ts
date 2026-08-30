import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  enqueue,
  claimNext,
  complete,
  fail,
  drain,
  backoffFor,
  queueDepth,
  LOCK_TTL_MS,
  BACKOFF_BASE_MS,
  MAX_BACKOFF_MS,
  type JobHandler,
  type JobRecord,
} from "@/lib/jobs/queue";
import { JOB_KINDS, HANDLERS } from "@/lib/jobs/registry";

// THE JOB QUEUE, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts jobs-db
//
// ============ WHAT ACTUALLY NEEDS PROVING (2026-08-30) =================
//
// Not that a job runs. That a job runs ONCE, that a crashed runner does not
// park work forever, and that a retry cannot duplicate a side effect — because
// the whole reason to add retries is that a system without them loses work, and
// the whole danger of adding them is that a system without idempotency does the
// work twice.
//
// Every claim here is asserted by construction rather than by timing: the clock
// is passed in, so "the lock went stale" and "the backoff elapsed" are facts the
// test states rather than waits for.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const MINUTE = 60 * 1000;

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `job-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Jobs", slug: `jobs-${stamp}`, tagline: "t", description: "d" },
  });
  const key = (name: string) => `${name}-${stamp}`;

  // =========================================================================
  console.log("\n--- the registry mirrors itself ---\n");
  // =========================================================================
  {
    const declared: string[] = [...JOB_KINDS].sort();
    const handled = Object.keys(HANDLERS).sort();
    eq("every declared kind has a handler", declared.filter((k) => !handled.includes(k)), []);
    // The other direction matters just as much: a handler for a kind nobody
    // declares is a handler nothing can ever reach.
    eq("every handler has a declared kind", handled.filter((k) => !declared.includes(k)), []);
    assert("and there is at least one, so the queue is exercisable", declared.length > 0);
  }

  // =========================================================================
  console.log("\n--- backoff is a curve, not a constant ---\n");
  // =========================================================================
  {
    eq("the first retry waits the base", backoffFor(1), BACKOFF_BASE_MS);
    eq("the second doubles it", backoffFor(2), BACKOFF_BASE_MS * 2);
    eq("the fifth is 16x", backoffFor(5), BACKOFF_BASE_MS * 16);
    eq("and it is capped", backoffFor(50), MAX_BACKOFF_MS);
    assert("a zeroth attempt does not go backwards", backoffFor(0) === BACKOFF_BASE_MS, `${backoffFor(0)}`);
  }

  // =========================================================================
  console.log("\n--- enqueueing the same work twice enqueues it once ---\n");
  // =========================================================================
  {
    const first = await enqueue({ kind: "noop", idempotencyKey: key("dup"), storeId: store.id });
    const second = await enqueue({ kind: "noop", idempotencyKey: key("dup"), storeId: store.id });
    assert("the first creates a job", first.ok && first.created);
    assert("the second does not", second.ok && !second.created);
    eq("and both name the same row", first.id, second.id);
    eq("so there is exactly one", await prismaSystem.job.count({ where: { idempotencyKey: key("dup") } }), 1);

    // THE POINT OF ALL THIS. A retry is only safe because a second offer of the
    // same work is not a second unit of work.
    await complete(first.id);
    const afterDone = await enqueue({ kind: "noop", idempotencyKey: key("dup"), storeId: store.id });
    assert("and re-offering completed work does not resurrect it", afterDone.ok && !afterDone.created);
    eq("it is still done", (await prismaSystem.job.findUnique({ where: { id: first.id } }))?.status, "done");
  }

  // =========================================================================
  console.log("\n--- only one runner can claim a job ---\n");
  // =========================================================================
  {
    await enqueue({ kind: "noop", idempotencyKey: key("solo"), storeId: store.id });
    const a = await claimNext("runner-a");
    const b = await claimNext("runner-b");
    assert("the first runner gets it", a?.idempotencyKey === key("solo"), JSON.stringify(a));
    assert("the second gets nothing", b === null, JSON.stringify(b));
    eq("the attempt was counted", a?.attempts, 1);
    const row = await prismaSystem.job.findUnique({ where: { id: a!.id } });
    eq("and the row records who holds it", [row?.status, row?.lockedBy], ["running", "runner-a"]);
    await complete(a!.id);
  }

  // =========================================================================
  console.log("\n--- two runners racing for one job ---\n");
  // =========================================================================
  {
    // ============ THE SEQUENTIAL TEST ABOVE DOES NOT PROVE THIS =====
    //
    // Claiming one job, then claiming again, is not a race: by the second call
    // the row is already `running`, so the candidate query excludes it and the
    // guard inside the UPDATE never runs. Removing that guard left the
    // sequential test entirely green, which is how this one came to exist.
    //
    // A real race means both runners read the same pending row before either
    // writes. Then the conditional UPDATE is the only thing standing between
    // one unit of work and two — and for a handler that charges money, two is
    // the failure this whole queue is meant to prevent.
    // ============ AND THIS HARNESS CANNOT PROVE IT EITHER ==========
    //
    // Recorded rather than left to be discovered by whoever deletes the guard:
    // removing the conditional leaves this test green too. Two claimNext calls
    // in Promise.all are serialised by the pooled client, so the second's
    // candidate query already sees `running` — exactly the limitation
    // verify-storage-ledger-db records about the reservation lock.
    //
    // The guard is kept because it is the correct shape for a read-modify-write
    // against a shared row, not because a test caught its absence. Proving it
    // needs genuine parallelism against a pooled Postgres, which is a
    // load-shaped test this harness cannot express. The assertion below still
    // states the invariant, and would catch a change that broke it for any
    // reason the harness CAN reach.
    await enqueue({ kind: "noop", idempotencyKey: key("race"), storeId: store.id });
    const [a, b] = await Promise.all([claimNext("racer-a"), claimNext("racer-b")]);
    const winners = [a, b].filter((c) => c?.idempotencyKey === key("race"));
    eq("exactly one runner may hold it", winners.length, 1);
    eq("and the job was attempted once, not twice",
      (await prismaSystem.job.findUnique({ where: { idempotencyKey: key("race") } }))?.attempts, 1);
    await complete(winners[0]!.id);
  }

  // =========================================================================
  console.log("\n--- work that is not due yet is not claimed ---\n");
  // =========================================================================
  {
    const later = new Date(Date.now() + 60 * MINUTE);
    await enqueue({ kind: "noop", idempotencyKey: key("later"), storeId: store.id, runAfter: later });
    const now = await claimNext("runner-a");
    assert("nothing is claimable before its time", now === null, JSON.stringify(now));
    const then = await claimNext("runner-a", new Date(later.getTime() + 1000));
    assert("and it is claimable afterwards", then?.idempotencyKey === key("later"));
    await complete(then!.id);
  }

  // =========================================================================
  console.log("\n--- a runner that died does not park the work forever ---\n");
  // =========================================================================
  {
    await enqueue({ kind: "noop", idempotencyKey: key("crash"), storeId: store.id });
    const claimed = await claimNext("runner-that-dies");
    assert("it is claimed", !!claimed);

    // The runner is gone. Nothing releases the lock.
    const immediately = await claimNext("runner-b");
    assert("another runner cannot steal a fresh claim", immediately === null, JSON.stringify(immediately));

    // THE RECLAIM. Stated as a fact about the clock rather than waited for.
    const afterTtl = new Date(Date.now() + LOCK_TTL_MS + 1000);
    const reclaimed = await claimNext("runner-b", afterTtl);
    assert("but a stale claim is reclaimable", reclaimed?.idempotencyKey === key("crash"), JSON.stringify(reclaimed));
    eq("and the reclaim counts as a second attempt", reclaimed?.attempts, 2);
    const row = await prismaSystem.job.findUnique({ where: { id: reclaimed!.id } });
    eq("the new runner owns it", row?.lockedBy, "runner-b");
    await complete(reclaimed!.id);
  }

  // =========================================================================
  console.log("\n--- failure retries with backoff, then dead-letters ---\n");
  // =========================================================================
  {
    await enqueue({ kind: "noop", idempotencyKey: key("fails"), storeId: store.id, maxAttempts: 2 });
    const now = new Date();

    const first = await claimNext("runner-a", now);
    const outcome1 = await fail(first!, new Error("boom"), now);
    assert("the first failure retries", outcome1.retrying);
    if (outcome1.retrying) {
      eq("scheduled one backoff ahead", outcome1.runAfter.getTime() - now.getTime(), backoffFor(1));
    }
    const afterFirst = await prismaSystem.job.findUnique({ where: { id: first!.id } });
    eq("it is pending again with the error recorded", [afterFirst?.status, afterFirst?.lastError], ["pending", "boom"]);
    eq("and the lock is released", [afterFirst?.lockedAt, afterFirst?.lockedBy], [null, null]);

    const later = new Date(now.getTime() + backoffFor(1) + 1000);
    const second = await claimNext("runner-a", later);
    eq("the retry is the second attempt", second?.attempts, 2);
    const outcome2 = await fail(second!, new Error("boom again"), later);
    assert("out of attempts, it dead-letters", !outcome2.retrying);

    const dead = await prismaSystem.job.findUnique({ where: { id: second!.id } });
    eq("its status says so", dead?.status, "dead");
    eq("its last error is kept", dead?.lastError, "boom again");
    // NEVER DISCARDED. A job nobody can see is indistinguishable from work that
    // was never asked for.
    assert("and the row survives for a person to look at", dead !== null);
    const stillClaimable = await claimNext("runner-a", new Date(later.getTime() + 10 * MINUTE));
    assert("a dead job is not retried again", stillClaimable === null, JSON.stringify(stillClaimable));
  }

  // =========================================================================
  console.log("\n--- draining runs handlers and bounds itself ---\n");
  // =========================================================================
  {
    let ran = 0;
    const counting: Record<string, JobHandler> = { noop: async () => { ran++; } };
    for (let i = 0; i < 5; i++) {
      await enqueue({ kind: "noop", idempotencyKey: key(`drain-${i}`), storeId: store.id });
    }
    const result = await drain(counting, { maxJobs: 3 });
    eq("it stops at the budget", [result.claimed, result.completed], [3, 3]);
    eq("and the handler ran once per job", ran, 3);
    const rest = await drain(counting, { maxJobs: 10 });
    eq("the remainder is still there next time", rest.completed, 2);
    eq("and nothing ran twice", ran, 5);
  }

  // =========================================================================
  console.log("\n--- a handler that throws does not take the drain with it ---\n");
  // =========================================================================
  {
    let good = 0;
    const mixed: Record<string, JobHandler> = {
      noop: async ({ job }: { job: JobRecord }) => {
        if (job.idempotencyKey === key("poison")) throw new Error("handler exploded");
        good++;
      },
    };
    await enqueue({ kind: "noop", idempotencyKey: key("poison"), storeId: store.id });
    await enqueue({ kind: "noop", idempotencyKey: key("healthy"), storeId: store.id });
    const result = await drain(mixed, { maxJobs: 10 });
    eq("the healthy job still completed", good, 1);
    eq("and the failure was counted, not thrown", [result.completed, result.retried], [1, 1]);
  }

  // =========================================================================
  console.log("\n--- an unregistered kind is retried, not discarded ---\n");
  // =========================================================================
  {
    // The likeliest cause is a deploy where the enqueuer shipped before the
    // handler. Discarding would lose the work permanently for a reason that
    // fixes itself in minutes.
    await enqueue({ kind: "not-a-real-kind", idempotencyKey: key("unknown"), storeId: store.id });
    const result = await drain(HANDLERS, { maxJobs: 10 });
    eq("the kind is reported", result.unknownKinds, ["not-a-real-kind"]);
    eq("and it went back to pending rather than dying", result.retried, 1);
    const row = await prismaSystem.job.findUnique({ where: { idempotencyKey: key("unknown") } });
    eq("with the reason recorded", row?.status, "pending");
    assert("naming the missing handler", (row?.lastError ?? "").includes("not-a-real-kind"), row?.lastError ?? "");
  }

  console.log("\n--- an operator can see the queue ---\n");
  {
    const depth = await queueDepth();
    assert("depth reports every status", ["pending", "running", "done", "dead"].every((s) => s in depth), JSON.stringify(depth));
    assert("and there is real history in it", depth.done > 0 && depth.dead > 0, JSON.stringify(depth));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
