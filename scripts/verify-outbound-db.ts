import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  runOnce,
  resolveIndeterminate,
  indeterminateOperations,
  CLAIM_TTL_MS,
  type Reconciler,
} from "@/lib/outbound/runOnce";
import { withCorrelation, correlationId } from "@/lib/observability/correlation";
import { enqueue, drain, type JobHandler } from "@/lib/jobs/queue";

// AN EXTERNAL SIDE EFFECT, PERFORMED ONCE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts outbound-db
//
// ============ THE ASSERTION THAT MATTERS MOST (2026-08-30) =============
//
// Not "it ran". That a provider was called ONCE while the caller was run twice,
// and that the case where we cannot tell is never resolved by guessing.
//
// The counter is the instrument throughout: a real closure increments it, so
// "the provider was called twice" is a fact this suite can observe rather than
// infer from a status column.

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

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `out-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Out", slug: `out-${stamp}`, tagline: "t", description: "d" },
  });
  const key = (n: string) => `${n}-${stamp}`;

  console.log("\n--- the provider is called once, however often the caller runs ---\n");
  {
    let calls = 0;
    const placeOrder = async () => {
      calls++;
      return { result: { orderId: "PF-1", total: 4200 }, externalRef: "PF-1" };
    };

    const first = await runOnce({ key: key("order"), operation: "printful.createOrder", storeId: store.id, perform: placeOrder });
    const second = await runOnce({ key: key("order"), operation: "printful.createOrder", storeId: store.id, perform: placeOrder });
    const third = await runOnce({ key: key("order"), operation: "printful.createOrder", storeId: store.id, perform: placeOrder });

    eq("the first call performs it", first.status, "performed");
    eq("the second replays", second.status, "replayed");
    eq("and so does the third", third.status, "replayed");
    // THE WHOLE POINT, observed rather than inferred.
    eq("the provider was called exactly once", calls, 1);

    // A replay must return what the FIRST call produced. Returning a second
    // call's answer would let downstream logic branch on a result that never
    // took effect.
    // FIELD BY FIELD, not by serialisation: the answer makes a round trip
    // through jsonb, which does not preserve key order, so JSON.stringify
    // compares a detail Postgres is entitled to change.
    const replayed = second.status === "replayed" ? (second.result as { orderId: string; total: number }) : null;
    eq("the replay returns the original answer",
      [replayed?.orderId, replayed?.total], ["PF-1", 4200]);
    eq("with the provider's own reference", second.status === "replayed" ? second.externalRef : null, "PF-1");
  }

  console.log("\n--- a refusal is safe to retry, and does retry ---\n");
  {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("provider said no");
      return { result: { ok: true }, externalRef: "PF-2" };
    };

    const failed = await runOnce({ key: key("flaky"), operation: "printful.createOrder", storeId: store.id, perform: flaky });
    eq("the refusal is reported as failed", failed.status, "failed");
    eq("naming the reason", failed.status === "failed" ? failed.error : null, "provider said no");

    // FAILED, NOT INDETERMINATE. The call returned — it threw — so nothing
    // landed and trying again cannot duplicate.
    const retried = await runOnce({ key: key("flaky"), operation: "printful.createOrder", storeId: store.id, perform: flaky });
    eq("a retry is allowed and performs", retried.status, "performed");
    eq("the provider saw two attempts, which is correct here", calls, 2);
    const row = await prismaSystem.outboundOperation.findUnique({ where: { idempotencyKey: key("flaky") } });
    eq("and the row counts both", row?.attempts, 2);
    eq("ending succeeded", row?.status, "succeeded");
  }

  console.log("\n--- a live claim stops a second runner dead ---\n");
  {
    let calls = 0;
    // A perform that never finishes while we ask a second time.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = async () => { calls++; await gate; return { result: { ok: true }, externalRef: "PF-3" }; };

    const inFlight = runOnce({ key: key("slow"), operation: "stripe.refund", storeId: store.id, perform: slow });
    // Give the claim a moment to land before asking again.
    await new Promise((r) => setTimeout(r, 50));
    const second = await runOnce({
      key: key("slow"), operation: "stripe.refund", storeId: store.id,
      perform: async () => { calls++; return { result: { ok: true } }; },
    });
    eq("the second caller is told it is already in progress", second.status, "in_progress");
    eq("and did not call the provider", calls, 1);

    release!();
    const done = await inFlight;
    eq("the first finishes normally", done.status, "performed");
  }

  console.log("\n--- a runner that dies mid-call leaves INDETERMINATE, not failed ---\n");
  {
    // ============ THE STATE THAT PREVENTS DUPLICATE CHARGES ========
    //
    // Collapsing this into `failed` is the mistake that places a second order.
    // Collapsing it into `succeeded` is the mistake that loses one. Neither is
    // knowable from here — only the provider knows.
    await prismaSystem.outboundOperation.create({
      data: {
        idempotencyKey: key("crash"), operation: "printful.createOrder", storeId: store.id,
        status: "in_progress", attempts: 1,
        claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 60_000),
        claimedBy: "a-runner-that-died",
      },
    });

    let calls = 0;
    const outcome = await runOnce({
      key: key("crash"), operation: "printful.createOrder", storeId: store.id,
      perform: async () => { calls++; return { result: { ok: true }, externalRef: "PF-DUP" }; },
    });

    eq("it is indeterminate", outcome.status, "indeterminate");
    // THE ASSERTION THAT PREVENTS THE DUPLICATE.
    eq("and the provider was NOT called again", calls, 0);
    const row = await prismaSystem.outboundOperation.findUnique({ where: { idempotencyKey: key("crash") } });
    eq("the row says so", row?.status, "indeterminate");
    assert("with an explanation", (row?.lastError ?? "").includes("stopped before recording"), row?.lastError ?? "");

    // And it stays that way. Asking again must not eventually give up and retry.
    const again = await runOnce({
      key: key("crash"), operation: "printful.createOrder", storeId: store.id,
      perform: async () => { calls++; return { result: { ok: true } }; },
    });
    eq("asking again is still indeterminate", again.status, "indeterminate");
    eq("and still did not call the provider", calls, 0);
  }

  console.log("\n--- only the provider can resolve indeterminate ---\n");
  {
    const landed: Reconciler = async () => ({ landed: true, externalRef: "PF-REAL", result: { recovered: true } });
    const resolved = await resolveIndeterminate(key("crash"), landed);
    eq("a provider that confirms it landed resolves to succeeded", resolved, { resolved: "succeeded", externalRef: "PF-REAL" });

    const row = await prismaSystem.outboundOperation.findUnique({ where: { idempotencyKey: key("crash") } });
    eq("the row carries the provider's real reference", row?.externalRef, "PF-REAL");
    // And a later caller now replays rather than calling.
    let calls = 0;
    const after = await runOnce({
      key: key("crash"), operation: "printful.createOrder", storeId: store.id,
      perform: async () => { calls++; return { result: {}, externalRef: "x" }; },
    });
    eq("so a subsequent call replays", after.status, "replayed");
    eq("without touching the provider", calls, 0);
  }
  {
    await prismaSystem.outboundOperation.create({
      data: { idempotencyKey: key("never"), operation: "stripe.refund", storeId: store.id, status: "indeterminate", attempts: 1 },
    });
    const never: Reconciler = async () => ({ landed: false });
    eq("a provider certain it never happened makes a retry safe again",
      await resolveIndeterminate(key("never"), never), { resolved: "failed" });

    let calls = 0;
    const retry = await runOnce({
      key: key("never"), operation: "stripe.refund", storeId: store.id,
      perform: async () => { calls++; return { result: { ok: true }, externalRef: "R-1" }; },
    });
    eq("and it does retry", retry.status, "performed");
    eq("calling the provider once", calls, 1);
  }
  {
    await prismaSystem.outboundOperation.create({
      data: { idempotencyKey: key("unknown"), operation: "stripe.refund", storeId: store.id, status: "indeterminate", attempts: 1 },
    });
    const shrug: Reconciler = async () => ({ landed: "unknown" });
    eq("a provider that cannot say leaves it alone",
      await resolveIndeterminate(key("unknown"), shrug), { resolved: "still-indeterminate" });
    // THE CORRECT OUTCOME, not a failure of the function: it waits for a person.
    const row = await prismaSystem.outboundOperation.findUnique({ where: { idempotencyKey: key("unknown") } });
    eq("still indeterminate", row?.status, "indeterminate");

    const waiting = await indeterminateOperations();
    assert("and it is visible to an operator",
      waiting.some((o) => o.key === key("unknown")), JSON.stringify(waiting.map((o) => o.key)));
  }

  console.log("\n--- it composes with the durable job queue ---\n");
  {
    // The realistic shape: a job retries, and the side effect inside it must not.
    let providerCalls = 0;
    let handlerRuns = 0;
    const handler: JobHandler = async ({ job }) => {
      handlerRuns++;
      const outcome = await runOnce({
        key: `job-effect-${job.idempotencyKey}`,
        operation: "printful.createOrder",
        storeId: store.id,
        perform: async () => { providerCalls++; return { result: { ok: true }, externalRef: "PF-JOB" }; },
      });
      // First run: performed, then the handler throws to force a retry.
      if (handlerRuns === 1) throw new Error("crashed after the provider succeeded");
      eq("the retry replays rather than re-calling", outcome.status, "replayed");
    };

    await enqueue({ kind: "noop", idempotencyKey: key("jobbed"), storeId: store.id });
    await drain({ noop: handler }, { maxJobs: 5 });
    // The job is now pending with a backoff; run it again as the next tick would.
    await prismaSystem.job.updateMany({ where: { idempotencyKey: key("jobbed") }, data: { runAfter: new Date() } });
    await drain({ noop: handler }, { maxJobs: 5 });

    eq("the handler ran twice", handlerRuns, 2);
    // THE SCENARIO THIS WHOLE SLICE EXISTS FOR.
    eq("but the provider was called once", providerCalls, 1);
  }

  console.log("\n--- an operation joins the chain that asked for it ---\n");
  {
    const traced = await withCorrelation({ origin: "http" }, async () => {
      const id = correlationId()!;
      await runOnce({
        key: key("traced"), operation: "stripe.refund", storeId: store.id,
        perform: async () => ({ result: { ok: true }, externalRef: "R-2" }),
      });
      return id;
    });
    eq("the outbound row carries the correlation id",
      await prismaSystem.outboundOperation.count({ where: { correlationId: traced } }), 1);
  }

  console.log("\n--- an operation with nothing addressable is still safe ---\n");
  {
    // A notification creates no provider-side object, so there is no
    // externalRef. It must still be exactly-once.
    let sends = 0;
    const send = async () => { sends++; return { result: { sent: true } }; };
    await runOnce({ key: key("notify"), operation: "email.orderConfirmation", storeId: store.id, perform: send });
    const replay = await runOnce({ key: key("notify"), operation: "email.orderConfirmation", storeId: store.id, perform: send });
    eq("the second send replays", replay.status, "replayed");
    eq("and nothing was sent twice", sends, 1);
    const row = await prismaSystem.outboundOperation.findUnique({ where: { idempotencyKey: key("notify") } });
    eq("with an honest null reference rather than an invented one", row?.externalRef, null);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
