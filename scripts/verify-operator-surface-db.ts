import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { isAllowedPlatformAdmin } from "@/lib/platformAdminPolicy";
import { findTraces, recentTraces, traceFor } from "@/lib/admin/trace";
import { replayableDeliveries, recordDelivery, markFailed, markProcessed } from "@/lib/webhooks/delivery";
import { withCorrelation, correlationId } from "@/lib/observability/correlation";
import { recordExecution } from "@/lib/execution/log";
import { runOnce } from "@/lib/outbound/runOnce";
import { enqueue } from "@/lib/jobs/queue";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";
import { readFileSync } from "node:fs";

// THE OPERATOR SURFACE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts operator-surface-db
//
// ============ WHAT ACTUALLY NEEDED PROVING (2026-08-30) ================
//
// Not that a page renders. Three things that would be silent failures:
//
// ONE — the platform authorization decision, which was private and untested and
// is the entire difference between an operator surface and a public one. The
// cases that matter are the ones nobody writes by hand: an unset variable, a
// trailing comma, a blank entry.
//
// TWO — that the replay ACTION carries its own check. A layout gates pages and
// gates nothing else; a server action is a POST endpoint. This is asserted
// against the source, because a test that calls the action would be testing a
// mock of auth() rather than whether the guard is written at all.
//
// THREE — that "search" stayed a search. Gap 20 asked for successful traces to
// be findable while recentTraces stayed failure-focused, and the way that goes
// wrong is a lookup quietly returning everything.

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
  const user = await prisma.user.create({ data: { email: `os-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "OS", slug: `os-${stamp}`, tagline: "t", description: "d" },
  });

  console.log("\n--- who is a platform administrator ---\n");
  {
    const list = "ops@genesis.test, second@genesis.test";
    eq("a listed operator is admitted", isAllowedPlatformAdmin("ops@genesis.test", list), true);
    eq("so is the second", isAllowedPlatformAdmin("second@genesis.test", list), true);

    // ============ THE ONE THAT MATTERS MOST ======================
    //
    // An unconfigured deployment must have NO platform admin. The opposite
    // failure — an empty allowlist admitting everybody, or admitting whoever
    // is signed in — is how a store owner reaches platform tooling.
    eq("an unset variable admits nobody", isAllowedPlatformAdmin("ops@genesis.test", ""), false);
    eq("whitespace alone admits nobody", isAllowedPlatformAdmin("ops@genesis.test", "   "), false);
    eq("a list of empty entries admits nobody", isAllowedPlatformAdmin("ops@genesis.test", " , , "), false);

    // A blank email must never match a blank list entry. This is the exact
    // shape of an accidental universal admit.
    eq("nobody is admitted by an empty email", isAllowedPlatformAdmin("", list), false);
    eq("nor by a null one", isAllowedPlatformAdmin(null, list), false);
    eq("nor by an undefined one", isAllowedPlatformAdmin(undefined, list), false);
    eq("nor by whitespace", isAllowedPlatformAdmin("   ", "ops@genesis.test, "), false);

    eq("an unlisted owner is refused", isAllowedPlatformAdmin("owner@somestore.test", list), false);
    // Real allowlists are typed by hand, so casing and spacing must not decide.
    eq("case does not decide", isAllowedPlatformAdmin("OPS@Genesis.Test", list), true);
    eq("nor does padding", isAllowedPlatformAdmin("  ops@genesis.test  ", " ops@genesis.test "), true);
    // A near-match is not a match.
    eq("a substring is not a match", isAllowedPlatformAdmin("ops@genesis.test.evil.com", list), false);
    eq("nor is a prefix", isAllowedPlatformAdmin("ops@genesis.tes", list), false);
  }

  console.log("\n--- the replay action guards itself, not by its layout ---\n");
  {
    // ============ ASSERTED AGAINST THE SOURCE ====================
    //
    // Deliberately not by calling the action: mocking auth() would prove the
    // mock. What must be true is that the guard is WRITTEN, before the work,
    // in the file that a future edit would touch.
    const src = readFileSync("app/admin/operations/actions.ts", "utf8");
    assert("the action calls assertPlatformAdmin", /assertPlatformAdmin\(/.test(src), src.slice(0, 200));
    assert("and it is a server action at all", /^"use server";/m.test(src));

    const guardAt = src.indexOf("assertPlatformAdmin(");
    const workAt = src.indexOf("replayDelivery(");
    // Order is the point. A check after the replay is not a check.
    assert("the check comes before the replay", guardAt > -1 && workAt > guardAt, `guard ${guardAt}, work ${workAt}`);
    // A guard inside a try/catch that swallows would be no guard at all.
    assert("and it is not wrapped in a swallow",
      !/try\s*{[\s\S]{0,400}assertPlatformAdmin/.test(src));

    const guard = readFileSync("lib/platformAdmin.ts", "utf8");
    // It must THROW. requirePlatformAdmin redirects, which is right for a page
    // and wrong for a POST endpoint a script may be calling.
    assert("assertPlatformAdmin throws rather than redirecting",
      /export async function assertPlatformAdmin[\s\S]{0,900}?throw new Error/.test(guard));
    // The `recordSignal` NAME also appears in the import a few lines above, so
    // matching it alone passed while the call itself was gone. Match the call.
    assert("and records the refusal before refusing",
      /assertPlatformAdmin[\s\S]{0,900}?await recordSignal\(\{[\s\S]{0,400}?throw new Error/.test(guard));

    // The action must not reimplement replay.
    const actionSrc = src;
    assert("the action does not write its own delivery status",
      !/webhookDelivery\.update/.test(actionSrc));
  }

  console.log("\n--- the operator sees failed deliveries across every provider ---\n");
  {
    const a = await recordDelivery({ provider: `os-a-${stamp}`, rawBody: "{}", signatureValid: true, storeId: store.id });
    const b = await recordDelivery({ provider: `os-b-${stamp}`, rawBody: "{}", signatureValid: true, storeId: store.id });
    const ok = await recordDelivery({ provider: `os-a-${stamp}`, rawBody: "{}", signatureValid: true, storeId: store.id });
    await markFailed(a!.id, new Error("first provider failed"));
    await markFailed(b!.id, new Error("second provider failed"));
    await markProcessed(ok!.id);

    const all = await replayableDeliveries(undefined, 200);
    const ids = new Set(all.map((d) => d.id));
    // The whole reason the provider argument was widened rather than a second
    // query being written in the page.
    assert("both providers appear in one list", ids.has(a!.id) && ids.has(b!.id));
    assert("and a processed delivery does not", !ids.has(ok!.id));

    // Narrowing still works — the existing caller relies on it.
    const justA = await replayableDeliveries(`os-a-${stamp}`, 200);
    eq("narrowing to one provider still narrows", justA.map((d) => d.id), [a!.id]);

    // The page decides "replayable" from signatureValid, so it must be present.
    assert("each row carries whether it was signed",
      all.every((d) => typeof d.signatureValid === "boolean"));
  }

  console.log("\n--- a successful chain is findable, on purpose ---\n");
  {
    const executionId = `os-exec-${stamp}`;
    const externalRef = `os-ref-${stamp}`;
    const eventId = `os-evt-${stamp}`;
    const jobKey = `os-job-${stamp}`;

    const traced = await withCorrelation({ origin: "http", surface: "test" }, async () => {
      const id = correlationId()!;
      // Everything SUCCEEDS. That is the point — this chain is invisible to
      // recentTraces by design, and must still be reachable.
      await recordExecution({
        executionId, storeId: store.id, storeDraftId: null,
        action: "os.worked", status: "SUCCESS", verified: true,
        message: "fine", retryable: false, actorType: "GENESIS", actorId: null,
        schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION, timestamp: new Date(), metadata: undefined,
      });
      await runOnce({
        key: `os-key-${stamp}`, operation: "os.effect", storeId: store.id,
        perform: async () => ({ result: { ok: true }, externalRef }),
      });
      const d = await recordDelivery({
        provider: `os-found-${stamp}`, rawBody: "{}", signatureValid: true,
        externalEventId: eventId, storeId: store.id,
      });
      await markProcessed(d!.id);
      await enqueue({ kind: "noop", idempotencyKey: jobKey, storeId: store.id });
      return id;
    });

    // ============ THE GAP-20 ASSERTION ===========================
    //
    // Invisible in the failure list, findable by name. Both halves matter: if
    // it showed up below, recentTraces became the activity feed Sean did not
    // want; if it could not be found, gap 20 is not closed.
    const recent = await recentTraces(100);
    eq("a healthy chain is absent from the failure list",
      recent.some((r) => r.correlationId === traced), false);

    for (const [label, term] of [
      ["its correlation id", traced],
      ["an execution id", executionId],
      ["a provider reference", externalRef],
      ["an idempotency key", `os-key-${stamp}`],
      ["a provider event id", eventId],
      ["a job's idempotency key", jobKey],
    ] as const) {
      const hits = await findTraces(term);
      assert(`found by ${label}`, hits.some((h) => h.correlationId === traced),
        JSON.stringify(hits.map((h) => h.correlationId)));
    }

    const matched = await findTraces(externalRef);
    eq("and it says what it matched on",
      matched.find((h) => h.correlationId === traced)?.matchedOn, "provider reference or key");

    // Following the link gives the whole chain, successes included.
    const trace = await traceFor(traced);
    assert("the chain opens with its successful entries",
      trace.entries.some((e) => e.source === "execution" && e.outcome === "SUCCESS"),
      JSON.stringify(trace.entries.map((e) => [e.source, e.outcome])));
  }

  console.log("\n--- a search is a search, not a feed ---\n");
  {
    // ============ HOW THIS WOULD GO WRONG ========================
    //
    // A lookup becomes the feed it was supposed not to be the moment an empty
    // or loose term returns rows. Every one of these must find nothing.
    eq("an empty term finds nothing", await findTraces(""), []);
    eq("whitespace finds nothing", await findTraces("     "), []);
    eq("a short fragment finds nothing", await findTraces("os-"), []);
    eq("a lone character finds nothing", await findTraces("a"), []);

    // A long-but-wrong term finds nothing rather than the nearest thing.
    eq("an unknown identifier finds nothing", await findTraces(`os-not-a-real-id-${stamp}`), []);

    // A PREFIX of a real id must not match. This is the assertion that would
    // catch a `contains` creeping in where an exact match belongs — which is
    // exactly how a targeted lookup turns into a browse.
    const real = `os-ref-${stamp}`;
    const prefix = real.slice(0, real.length - 3);
    eq("a prefix of a real identifier finds nothing", await findTraces(prefix), []);
  }

  console.log("\n--- the stale-replay sweep is scheduled, not remembered ---\n");
  {
    // Gap 19. A claim released only when somebody remembers to run a script is
    // a stall waiting to happen, so this asserts the sweep really is scheduled.
    //
    // ============ IT ASKS THE REGISTRY NOW (2026-08-30) ============
    //
    // These four read app/api/cron/sync/route.ts for the call, its correlation
    // wrapper and its catch, and all four broke when the scheduling layer
    // landed — every one right about what must hold and wrong about where. The
    // route no longer decides anything, so asserting against it was asserting
    // the spelling of an implementation detail.
    //
    // lib/scheduler/registry.ts is the one place that now states what Genesis
    // runs on a schedule. Removing or renaming the task fails this. The
    // correlation id and the per-task catch became properties of the runner,
    // proven once and sabotaged in verify-scheduler-db rather than restated in
    // every suite that cares about a task.
    const { taskByKey } = await import("@/lib/scheduler/registry");
    const task = taskByKey("webhooks.releaseStaleReplays");
    assert("the sweep is a scheduled task", !!task, "not in the scheduler registry");
    assert("switched on", !!task?.enabled());
    assert("wanting to run at least daily",
      (task?.everyMs ?? Infinity) <= 24 * 60 * 60 * 1000, `${task?.everyMs}`);
    const registry = readFileSync("lib/scheduler/registry.ts", "utf8");
    assert("and it is the one implementation that runs",
      /releaseStaleReplays\(\)/.test(registry) &&
      /from "@\/lib\/webhooks\/replay"/.test(registry));
  }

  console.log("\n--- replay handlers claim only what they can actually do ---\n");
  {
    const { replayHandlers, replayableProviders } = await import("@/lib/webhooks/replayHandlers");
    const providers = replayableProviders();

    // ============ THIS USED TO SAY "EASYPOST ONLY" (2026-08-30) =====
    //
    // And it was right to. Claiming Stripe before Rank 4 would have drawn a
    // button that always failed, because verification and handling were one
    // function and a stored signature is expired by definition.
    //
    // Rank 4 split them, so the claim is now true for all three. The assertion
    // keeps its original job — a provider may only be listed here if it can
    // ACTUALLY be replayed — and the list simply grew.
    eq("all three providers can now be replayed", providers, ["EASYPOST", "PAYPAL", "STRIPE"]);

    // A claim is only honest if something is behind it.
    const handlers = replayHandlers();
    for (const provider of providers) {
      assert(`${provider} has a handler behind the claim`, typeof handlers[provider] === "function");
    }
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
