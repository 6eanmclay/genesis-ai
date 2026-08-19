import {
  mapExecutionToEvent,
  recordExecutionEvent,
  isEventWorthyStatus,
  type ExecutionEventSink,
} from "@/lib/intelligence/executionEvents";
import { selectDueStoreIds } from "@/lib/intelligence/cycle";
import type { BusinessEventInput } from "@/lib/intelligence/businessEvents";

// Business Intelligence Engine M3 — the regression suite.
//
// Every acceptance criterion Sean set, proved against the real functions the
// production path calls, with no database and no environment:
//
//   npx tsx scripts/verify-execution-events.ts
//
// recordExecutionEvent takes its sink as a parameter (the same shape
// writeBusinessEvents takes its client), so the in-memory sink below exercises
// the actual emitter — not a reimplementation of it.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** An in-memory event log with the same contract as the Prisma sink. */
function memorySink() {
  const written: { storeId: string; event: BusinessEventInput }[] = [];
  const sink: ExecutionEventSink = {
    async hasEventForExecution(storeId, executionId) {
      return written.some(
        (w) => w.storeId === storeId && (w.event.data as { executionId?: string })?.executionId === executionId
      );
    },
    async write(storeId, event) {
      written.push({ storeId, event });
    },
  };
  return { sink, written };
}

const SUCCESSFUL_CREATE = {
  storeId: "store_1",
  executionId: "exec_1",
  actionType: "create_product",
  input: { name: "Cedar Candle", description: "Hand poured", priceInCents: 3200 },
  status: "SUCCESS",
};

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  console.log("\n1. Exactly one event per successful execution");
  {
    const { sink, written } = memorySink();
    await recordExecutionEvent(SUCCESSFUL_CREATE, sink);
    check("one event written", written.length, 1);
    check("canonical entity", written[0]?.event.entityType, "item");
    check("canonical event type", written[0]?.event.eventType, "item.created");
    check("readable summary", written[0]?.event.summary, "Product added: Cedar Candle");
    check(
      "carrying its execution as provenance",
      (written[0]?.event.data as { executionId?: string })?.executionId,
      "exec_1"
    );
  }
  {
    // An update carries the canonical record id understanding already uses,
    // so detectRecordEventRecurrence can group by it.
    const { sink, written } = memorySink();
    await recordExecutionEvent(
      { storeId: "store_1", executionId: "exec_2", actionType: "update_product", input: { productId: "p9", description: "d" }, status: "SUCCESS" },
      sink
    );
    check("points at the canonical record id", written[0]?.event.recordId, "internal:item:p9");
    check("as an update", written[0]?.event.eventType, "item.updated");
  }

  // -------------------------------------------------------------------------
  console.log("\n2. Zero events for failed executions");
  for (const status of ["FAILED", "PENDING", "WARNING", "PARTIAL"]) {
    const { sink, written } = memorySink();
    await recordExecutionEvent({ ...SUCCESSFUL_CREATE, executionId: `exec_${status}`, status }, sink);
    check(`status ${status} writes nothing`, written.length, 0);
  }
  check("only SUCCESS is event-worthy", ["SUCCESS", "FAILED", "PENDING", "WARNING", "PARTIAL"].map(isEventWorthyStatus), [true, false, false, false, false]);

  // -------------------------------------------------------------------------
  console.log("\n3. No event when there is no honest canonical mapping");
  for (const actionType of ["update_hero", "update_theme", "update_brand_identity", "update_seo", "some_future_action"]) {
    const { sink, written } = memorySink();
    await recordExecutionEvent({ storeId: "store_1", executionId: `exec_${actionType}`, actionType, input: {}, status: "SUCCESS" }, sink);
    check(`${actionType} writes nothing`, written.length, 0);
  }
  {
    const { sink, written } = memorySink();
    await recordExecutionEvent({ ...SUCCESSFUL_CREATE, actionType: null }, sink);
    check("an execution with no registry action writes nothing", written.length, 0);
  }
  {
    // No store scope is no event, rather than an event on a guessed store.
    const { sink, written } = memorySink();
    await recordExecutionEvent({ ...SUCCESSFUL_CREATE, storeId: null }, sink);
    check("an execution with no store writes nothing", written.length, 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n4. The event is written only after a successful execution");
  // The emitter itself refuses every non-SUCCESS status (proved above), and
  // execute() calls it only on the path where the outcome is already recorded
  // — a thrown execution returns from the catch block without reaching it.
  check("mapping refuses a failed execution outright", mapExecutionToEvent({ actionType: "create_product", input: {}, status: "FAILED", executionId: "e" }), null);
  assert("and accepts a successful one", mapExecutionToEvent({ actionType: "create_product", input: {}, status: "SUCCESS", executionId: "e" }) !== null);

  // -------------------------------------------------------------------------
  console.log("\n5. Idempotent per execution");
  {
    const { sink, written } = memorySink();
    await recordExecutionEvent(SUCCESSFUL_CREATE, sink);
    await recordExecutionEvent(SUCCESSFUL_CREATE, sink);
    await recordExecutionEvent(SUCCESSFUL_CREATE, sink);
    check("three calls for one execution write one event", written.length, 1);
  }
  {
    const { sink, written } = memorySink();
    await recordExecutionEvent(SUCCESSFUL_CREATE, sink);
    await recordExecutionEvent({ ...SUCCESSFUL_CREATE, executionId: "exec_other" }, sink);
    check("a genuinely different execution still writes", written.length, 2);
  }
  {
    // A broken sink must never break the execution it describes.
    const throwing: ExecutionEventSink = {
      async hasEventForExecution() { throw new Error("database is down"); },
      async write() { throw new Error("database is down"); },
    };
    let threw = false;
    try {
      await recordExecutionEvent(SUCCESSFUL_CREATE, throwing);
    } catch {
      threw = true;
    }
    assert("a failing sink never throws into the execution", !threw);
  }

  // -------------------------------------------------------------------------
  console.log("\n6. M1 can subsequently consume the resulting event");
  {
    const { sink, written } = memorySink();
    await recordExecutionEvent(SUCCESSFUL_CREATE, sink);
    assert("the execution produced an event", written.length === 1);

    // That event lands in the log as sequence 1 for a store with no sales and
    // no connector. M1's selection is what decides whether the cycle runs.
    const activity = [{ storeId: "store_1", maxSequence: BigInt(1) }];
    check("a store with no sales is now due for the cycle", selectDueStoreIds(activity, [], { limit: 50 }), ["store_1"]);

    // ...and once the cycle consumes it, the same event never selects again.
    check(
      "the consumed event does not select the store again",
      selectDueStoreIds(activity, [{ storeId: "store_1", lastProcessedSequence: BigInt(1) }], { limit: 50 }),
      []
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n7. No feedback loop or unbounded re-execution");
  {
    // The real shape of the risk: J4 executes an action autonomously, which now
    // emits an event, which can make the store due, which runs the cycle, which
    // could execute again. Simulated across a day of cron passes with the two
    // real bounds in place — one event per execution, and the recommendation
    // stage's own 24h staleness gate.
    const REVIEW_GATE_MS = 24 * 60 * 60 * 1000;
    let sequence = 0;
    let cursor = BigInt(0);
    let lastReviewAt = -Infinity;
    let executions = 0;
    const { sink, written } = memorySink();

    for (let pass = 0; pass < 12; pass++) {
      const now = pass * 60 * 60 * 1000; // hourly cron, far more often than daily
      const activity = sequence > 0 ? [{ storeId: "store_1", maxSequence: BigInt(sequence) }] : [];
      const due = selectDueStoreIds(activity, [{ storeId: "store_1", lastProcessedSequence: cursor }], { limit: 50 });

      // Seed the loop: one real owner action on the first pass.
      if (pass === 0) {
        await recordExecutionEvent({ ...SUCCESSFUL_CREATE, executionId: "seed" }, sink);
        sequence = written.length;
        continue;
      }
      if (due.length === 0) continue;

      // The cycle runs. The recommendation stage only fires when stale.
      if (now - lastReviewAt >= REVIEW_GATE_MS) {
        lastReviewAt = now;
        executions++;
        await recordExecutionEvent(
          { storeId: "store_1", executionId: `auto_${executions}`, actionType: "update_product", input: { productId: "p1", description: "d" }, status: "SUCCESS" },
          sink
        );
        sequence = written.length;
      }
      cursor = BigInt(sequence); // computeInsights advances the cursor
    }

    check("the loop settles rather than running away", executions, 1);
    check("one event per execution, no amplification", written.length, 2);
    const finalDue = selectDueStoreIds([{ storeId: "store_1", maxSequence: BigInt(sequence) }], [{ storeId: "store_1", lastProcessedSequence: cursor }], { limit: 50 });
    check("and the store comes to rest", finalDue, []);
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
