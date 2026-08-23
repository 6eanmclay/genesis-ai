import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { recoverStuckApprovals, ATTEMPT_GRACE_MS } from "@/lib/dashboard/approvalRecovery";

// D4 — AN APPROVAL WHOSE EXECUTION STARTED AND NEVER RESOLVED:
//
//   npx tsx scripts/run-db-suites.ts approval-recovery
//
// The row read PENDING_APPROVAL for the whole duration of an external call, so
// two callers both passed the read and both executed — a double change and a
// double growth-point deduction. Claiming it closes that and creates the state
// this suite is about: a process that dies mid-execute.
//
// THE POLICY IS EVIDENCE, THEN TIME. Nothing is released because time elapsed.
// An attempt is settled or released on whether the execution row for THAT
// attempt exists, which is answerable because the claim mints the executionId
// and hands it to execute(). Time only stops a sweep racing a live call.

let failures = 0;
const results: { name: string; ok: boolean }[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2, 10);
const longAgo = () => new Date(Date.now() - ATTEMPT_GRACE_MS - 60_000);

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `d4-${uniq()}@test.local` } });
  const shop = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `d4-${uniq()}` },
  });
  const neighbour = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `d4-n-${uniq()}` },
  });

  /** An attempt left mid-flight, as a crashed process would leave it. */
  const inFlight = async (storeId: string, claimedAt: Date) => {
    const attemptExecutionId = `att-${uniq()}`;
    const row = await prisma.approvalRequest.create({
      data: {
        storeId, actionType: "update_hero", input: {}, previousValues: {},
        summary: "A new hero image", status: "EXECUTING",
        claimedAt, attemptExecutionId,
      },
    });
    return { row, attemptExecutionId };
  };

  const logFor = (storeId: string, executionId: string, status: string) =>
    prisma.executionLog.create({
      data: {
        executionId, storeId, action: "product.create", status,
        verified: status === "SUCCESS", message: "m", retryable: false, actorType: "GENESIS",
      },
    });

  const statusOf = async (id: string) =>
    (await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })).status;

  // ==========================================================================
  console.log("\n=== 1. Failure BEFORE any execution row — recoverable ===\n");
  // ==========================================================================
  // The process died before the engine recorded anything. No evidence means the
  // work did not complete and nothing was charged, so the owner may decide
  // again. This is the only case where releasing is correct.
  const noEvidence = await inFlight(shop.id, longAgo());
  check("it is reconciled as released", await recoverStuckApprovals(shop.id), { settled: 0, released: 1 });
  check("and returns to the owner's hands", await statusOf(noEvidence.row.id), "PENDING_APPROVAL");
  const cleared = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: noEvidence.row.id } });
  check("with the claim cleared", cleared.claimedAt, null);
  check("and the attempt identity cleared", cleared.attemptExecutionId, null);

  // ==========================================================================
  console.log("\n=== 2. An execution row exists — it happened ===\n");
  // ==========================================================================
  // THE CASE THAT MUST NOT BE RETRIED. The engine writes this row after the
  // executable's own verification and before it charges, so its existence means
  // the work completed. Releasing here would re-run a change that really landed
  // — the defect D4 exists to remove, reintroduced with a delay on it.
  const done = await inFlight(shop.id, longAgo());
  await logFor(shop.id, done.attemptExecutionId, "SUCCESS");
  check("it is settled, not released", await recoverStuckApprovals(shop.id), { settled: 1, released: 0 });
  check("and reads as executed", await statusOf(done.row.id), "EXECUTED");
  const settled = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: done.row.id } });
  check("carrying the execution it completed", settled.executionId, done.attemptExecutionId);

  // A FAILED execution row is evidence too — of failure. The owner may retry.
  const failed = await inFlight(shop.id, longAgo());
  await logFor(shop.id, failed.attemptExecutionId, "FAILED");
  check("a failed attempt is released", await recoverStuckApprovals(shop.id), { settled: 0, released: 1 });
  check("back to pending", await statusOf(failed.row.id), "PENDING_APPROVAL");
  const withFailure = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: failed.row.id } });
  assert("keeping the failure to point at",
    withFailure.executionId === failed.attemptExecutionId,
    "the review page tells 'never acted on' from 'tried and failed' by this column");

  // ==========================================================================
  console.log("\n=== 3. Provider succeeded, local recording failed ===\n");
  // ==========================================================================
  // Two distinct sub-cases, and the difference is exactly where the process
  // died relative to recordExecution.
  //
  // (a) Died AFTER the row, before the growth-point deduction. The row exists,
  //     so this settles as EXECUTED and the owner is UNDER-CHARGED. The engine
  //     already documents under-charging as the right way to be wrong, and
  //     nothing here charges.
  const underCharged = await inFlight(shop.id, longAgo());
  await logFor(shop.id, underCharged.attemptExecutionId, "SUCCESS");
  await recoverStuckApprovals(shop.id);
  check("a success recorded but never charged still settles",
    await statusOf(underCharged.row.id), "EXECUTED");
  check("and recovery charges nothing itself",
    (await prisma.growthPointTransaction.findMany({ where: { storeId: shop.id } })).length, 0);

  // (b) Died BEFORE the row. No evidence exists, so this releases and a retry
  //     repeats the provider work. THE ONE UNRECOVERABLE WINDOW, asserted here
  //     rather than left as prose: closing it needs an idempotency key at each
  //     provider, which is deliberately out of scope.
  const invisible = await inFlight(shop.id, longAgo());
  await recoverStuckApprovals(shop.id);
  check("without a row, even a real provider success is released",
    await statusOf(invisible.row.id), "PENDING_APPROVAL");
  assert("which is the documented residual risk, not an oversight",
    true,
    "recovery cannot see what the provider did if the engine never recorded it");

  // ==========================================================================
  console.log("\n=== 4. An attempt still in flight is left alone ===\n");
  // ==========================================================================
  // TIME IS A GUARD, NOT A TRIGGER. A recent claim is an execution that is
  // probably still running — image generation and provider registration are
  // slow, and being slow is not being stuck.
  const running = await inFlight(shop.id, new Date());
  check("a fresh claim is not touched", await recoverStuckApprovals(shop.id), { settled: 0, released: 0 });
  check("and stays in flight", await statusOf(running.row.id), "EXECUTING");

  // And an old claim is not released FOR being old — only for having no
  // evidence. The distinction is the whole policy.
  const oldButDone = await inFlight(shop.id, longAgo());
  await logFor(shop.id, oldButDone.attemptExecutionId, "SUCCESS");
  await recoverStuckApprovals(shop.id);
  check("age alone never causes a retry", await statusOf(oldButDone.row.id), "EXECUTED");

  // ==========================================================================
  console.log("\n=== 5. Ineligible rows are untouched ===\n");
  // ==========================================================================
  const pending = await prisma.approvalRequest.create({
    data: {
      storeId: shop.id, actionType: "update_hero", input: {}, previousValues: {},
      summary: "Waiting", status: "PENDING_APPROVAL",
    },
  });
  const executed = await prisma.approvalRequest.create({
    data: {
      storeId: shop.id, actionType: "update_hero", input: {}, previousValues: {},
      summary: "Done", status: "EXECUTED",
    },
  });
  await recoverStuckApprovals(shop.id);
  check("an undecided approval is untouched", await statusOf(pending.id), "PENDING_APPROVAL");
  check("and a settled one is untouched", await statusOf(executed.id), "EXECUTED");

  // CROSS-BUSINESS. One business's stuck work is never another's to reconcile.
  const theirs = await inFlight(neighbour.id, longAgo());
  check("the neighbour's stuck attempt is not this store's to recover",
    await recoverStuckApprovals(shop.id), { settled: 0, released: 0 });
  check("and is still in flight", await statusOf(theirs.row.id), "EXECUTING");
  check("until its own business sweeps",
    await recoverStuckApprovals(neighbour.id), { settled: 0, released: 1 });

  // ==========================================================================
  console.log("\n=== 6. Recovering twice changes nothing twice ===\n");
  // ==========================================================================
  // Every write matches on status EXECUTING, so a second sweep — or a sweep
  // racing the execution's own resolution — finds nothing to do rather than
  // re-settling or re-releasing.
  const twice = await inFlight(shop.id, longAgo());
  await logFor(shop.id, twice.attemptExecutionId, "SUCCESS");
  check("the first sweep settles it", await recoverStuckApprovals(shop.id), { settled: 1, released: 0 });
  check("the second finds nothing", await recoverStuckApprovals(shop.id), { settled: 0, released: 0 });
  check("and it is still settled once", await statusOf(twice.row.id), "EXECUTED");

  // Concurrent sweeps: exactly one acts.
  const raced = await inFlight(shop.id, longAgo());
  await logFor(shop.id, raced.attemptExecutionId, "SUCCESS");
  const both = await Promise.all([recoverStuckApprovals(shop.id), recoverStuckApprovals(shop.id)]);
  check("exactly one of two concurrent sweeps settles it",
    both.reduce((sum, r) => sum + r.settled, 0), 1);
  check("leaving one execution recorded, not two",
    (await prisma.executionLog.findMany({
      where: { storeId: shop.id, executionId: raced.attemptExecutionId },
    })).length, 1);
  check("and no charge from recovery",
    (await prisma.growthPointTransaction.findMany({ where: { storeId: shop.id } })).length, 0);

  // ==========================================================================
  console.log("\n=== The claim itself, at its call site ===\n");
  // ==========================================================================
  // performApproveGenesisAction needs a real session, which a script cannot
  // fake — the structural limit every approval script here already names. The
  // claim's shape is what would regress, and it is asserted from source.
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const src = readFileSync(join(process.cwd(), "app", "dashboard", "ai-actions.ts"), "utf8");
  assert("the row is claimed before anything real happens",
    src.includes('data: { status: "EXECUTING", claimedAt: new Date(), attemptExecutionId },'),
    "reading PENDING and executing is the race itself");
  assert("losing the claim is the same answer as a decided row",
    src.includes("if (claim.count === 0) {"),
    "a second caller must not proceed");
  assert("and the attempt identity reaches the engine",
    src.includes("executionId: attemptExecutionId,"),
    "without it the execution row cannot be tied to this attempt and recovery is guesswork");
  assert("a throw outside execute() releases the claim rather than stranding it",
    src.includes('data: { status: "PENDING_APPROVAL", claimedAt: null, attemptExecutionId: null },'),
    "this process is alive and knows the answer; waiting for a sweep would strand a decision");
  assert("and both resolutions match on EXECUTING",
    src.split('status: "EXECUTING" },').length - 1 >= 2,
    "matching on the id alone would let a sweep and an execution both write");

  // AND THE SWEEP'S OWN WRITES MATCH ON THE CLAIM THEY ARE RESOLVING.
  //
  // The concurrent-sweeps assertion above does NOT cover this, and a negative
  // control proved it: dropping `status: "EXECUTING"` from the update left every
  // assertion green, because the second sweep's read already excluded the row
  // the first had settled. What the guard actually protects is a sweep racing
  // the EXECUTION's own resolution — two writers, one of them in a request this
  // suite cannot reach. Asserted from source, which is what is honestly
  // available.
  const recoverySrc = readFileSync(
    join(process.cwd(), "lib", "dashboard", "approvalRecovery.ts"), "utf8");
  check("every recovery write is conditional on the row still being claimed",
    recoverySrc.split('status: "EXECUTING" },').length - 1, 2);

  const approvalsSrc = readFileSync(
    join(process.cwd(), "lib", "dashboard", "pendingApprovals.ts"), "utf8");
  assert("the review read reconciles before it lists",
    approvalsSrc.includes("await recoverStuckApprovals(storeId);"),
    "a stuck row is invisible to that query, so this is the moment worth reconciling it");

  await prisma.store.deleteMany({ where: { id: { in: [shop.id, neighbour.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });

  const failed2 = results.filter((r) => !r.ok);
  console.log(`\n${failed2.length === 0 ? `ALL PASS (${results.length})` : `${failed2.length} of ${results.length} FAILED`}`);
  if (failed2.length) console.log(failed2.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
