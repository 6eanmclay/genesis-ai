import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { emit } from "@/lib/telemetry/emit";
import { EVENTS, EVENT_NAMES, SUBSYSTEMS, ACTOR_KINDS } from "@/lib/telemetry/taxonomy";
import { pruneTelemetry, SHORT_RETENTION, DEFAULT_RETENTION_DAYS, telemetryFootprint } from "@/lib/telemetry/retention";
import { JOB_KINDS, HANDLERS } from "@/lib/jobs/registry";
import { withCorrelation, correlationId } from "@/lib/observability/correlation";
import { enqueue, drain } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/outbound/runOnce";

// TELEMETRY, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts telemetry-db
//
// ============ WHAT NEEDED PROVING (2026-08-30) =========================
//
// The audit found the old system emitted from seven files and from none of the
// systems built after it. So the assertions that matter are not "an event was
// written" — they are:
//
//   the blind spots now emit, exercised through the REAL code paths rather than
//     by calling emit() directly, because calling emit() proves only that emit
//     works
//   metadata cannot carry a key the event did not declare, which is the privacy
//     boundary
//   a telemetry failure cannot break the thing it observes
//   retention touches ProductEvent and NOTHING authoritative

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

const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `tel-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Tel", slug: `tel-${stamp}`, tagline: "t", description: "d" },
  });

  console.log("\n--- the taxonomy is closed and self-consistent ---\n");
  {
    for (const name of EVENT_NAMES) {
      const def = EVENTS[name];
      assert(`${name} declares a real subsystem`, (SUBSYSTEMS as readonly string[]).includes(def.subsystem), def.subsystem);
      // An event that cannot say why it exists is instrumentation for its own
      // sake, which is what produced 1,604 page-view rows and no execution rows.
      // A REAL CHECK. The first version of this line read
      // `def.purpose.includes("?") === def.purpose.includes("?")` — a
      // tautology that could not fail, which is precisely the shape of
      // assertion this milestone keeps catching. A purpose has to be a
      // sentence about a question somebody would ask, not a restatement of
      // the function name.
      assert(`${name} states a real purpose`,
        def.purpose.length > 30 && /\s/.test(def.purpose) && !def.purpose.includes(name),
        def.purpose);
      assert(`${name} declares its metadata keys`, Array.isArray(def.metadataKeys));
    }
    assert("every actor kind is a known one", ACTOR_KINDS.length === 5, JSON.stringify(ACTOR_KINDS));
  }

  console.log("\n--- metadata cannot carry what the event did not declare ---\n");
  {
    await emit({
      name: "job.completed", actorKind: "system", storeId: store.id,
      metadata: {
        kind: "noop", attempts: 1,
        // THE PRIVACY BOUNDARY. None of these were declared, and a table nobody
        // prunes is the last place any of them should land.
        customerEmail: "someone@real.test",
        brandCopy: "our secret positioning",
        accessToken: "sk_live_abcdef",
      },
    });
    const row = await prismaSystem.productEvent.findFirst({
      where: { name: "job.completed", storeId: store.id }, orderBy: { createdAt: "desc" },
    });
    const meta = (row?.metadata ?? {}) as Record<string, unknown>;
    eq("declared keys survive", [meta.kind, meta.attempts], ["noop", 1]);
    assert("an undeclared email is dropped", !("customerEmail" in meta), JSON.stringify(meta));
    assert("undeclared business copy is dropped", !("brandCopy" in meta), JSON.stringify(meta));
    assert("and an undeclared credential is dropped", !("accessToken" in meta), JSON.stringify(meta));
    const serialised = JSON.stringify(meta);
    assert("nothing sensitive survives serialisation",
      !serialised.includes("someone@real.test") && !serialised.includes("sk_live"), serialised);
  }

  console.log("\n--- the blind spots emit, through their real code paths ---\n");
  {
    // NOT by calling emit() — that would prove only that emit works. Each of
    // these runs the actual subsystem and then looks for what it left behind.
    const before = await prismaSystem.productEvent.count();

    // Jobs: enqueue and drain for real.
    await enqueue({ kind: "noop", idempotencyKey: `tel-job-${stamp}`, storeId: store.id });
    await drain(HANDLERS, { maxJobs: 5 });

    // Outbound: perform, then replay.
    await runOnce({
      key: `tel-out-${stamp}`, operation: "test.op", storeId: store.id,
      perform: async () => ({ result: { ok: true }, externalRef: "X-1" }),
    });
    await runOnce({
      key: `tel-out-${stamp}`, operation: "test.op", storeId: store.id,
      perform: async () => ({ result: { ok: true }, externalRef: "X-1" }),
    });

    // Give the fire-and-forget emits a moment to land.
    await new Promise((r) => setTimeout(r, 250));

    const after = await prismaSystem.productEvent.count();
    assert("running real subsystems produced telemetry", after > before, `${before} -> ${after}`);

    // ============ FOUND BY BREAKING IT (2026-08-30) ================
    //
    // This used to look for any `job.completed` row for this store — and the
    // metadata test above emits exactly that name directly, so removing the
    // queue's instrumentation entirely left this assertion green. It was
    // finding the earlier row.
    //
    // attemptKey is the job's own idempotencyKey and is set by NOTHING else, so
    // matching on it means only the real queue path can satisfy this.
    const jobDone = await prismaSystem.productEvent.findFirst({
      where: { name: "job.completed", attemptKey: `tel-job-${stamp}` },
      orderBy: { createdAt: "desc" },
    });
    assert("the queue emits when work completes", !!jobDone,
      "no event carrying the job's own idempotency key");
    eq("tagged with its subsystem", jobDone?.subsystem, "jobs");
    eq("and its actor", jobDone?.actorKind, "system");

    const performed = await prismaSystem.productEvent.count({ where: { name: "outbound.performed", storeId: store.id } });
    const replayed = await prismaSystem.productEvent.count({ where: { name: "outbound.replayed", storeId: store.id } });
    eq("an external effect that happened is recorded once", performed, 1);
    // THE MOST REASSURING EVENT THIS SYSTEM CAN EMIT: a retry that correctly
    // did not repeat an external effect, which was previously invisible.
    eq("and the retry that correctly did not repeat it is recorded too", replayed, 1);
  }

  console.log("\n--- telemetry joins the chain, and is not the record itself ---\n");
  {
    const traced = await withCorrelation({ origin: "http" }, async () => {
      const id = correlationId()!;
      await emit({ name: "execution.completed", actorKind: "genesis", storeId: store.id, metadata: { action: "x", status: "SUCCESS" } });
      return id;
    });
    eq("the event carries the correlation id",
      await prismaSystem.productEvent.count({ where: { correlationId: traced } }), 1);

    // Telemetry is an OBSERVATION. It must not be mistaken for the audit trail:
    // emitting one must never create an ExecutionLog row.
    eq("emitting telemetry writes no execution row",
      await prismaSystem.executionLog.count({ where: { correlationId: traced } }), 0);
  }

  console.log("\n--- a telemetry failure cannot break what it observes ---\n");
  {
    let threw = false;
    try {
      // A store that does not exist violates the foreign key.
      await emit({ name: "job.completed", actorKind: "system", storeId: "cl_not_a_store" });
      // A name outside the registry, forced past the type.
      await emit({ name: "not.an.event" as never, actorKind: "system", storeId: store.id });
    } catch {
      threw = true;
    }
    assert("an unwritable event does not propagate", !threw);
  }

  console.log("\n--- retention is designed, and touches nothing authoritative ---\n");
  {
    const old = new Date(Date.now() - 200 * DAY);
    const recent = new Date(Date.now() - 3 * DAY);
    const mk = (name: string, createdAt: Date) =>
      prismaSystem.productEvent.create({
        data: { name, category: "navigation", sessionInstanceId: "s", storeId: store.id, createdAt },
      });
    await mk("nav.section_view", new Date(Date.now() - 30 * DAY)); // past its short horizon
    await mk("nav.section_view", recent);                          // inside it
    await mk("execution.completed", old);                          // past the default
    await mk("execution.completed", recent);                       // inside it

    const dry = await pruneTelemetry();
    assert("a dry run reports without deleting", dry.applied === false && dry.total >= 2, JSON.stringify(dry));
    const stillThere = await prismaSystem.productEvent.count({ where: { storeId: store.id, name: "nav.section_view" } });
    eq("nothing was removed by looking", stillThere, 2);

    // ============ ALSO FOUND BY BREAKING IT ========================
    //
    // The boundary assertion below could not fail: every authoritative row in
    // this database was created seconds ago, so a prune that wrongly reached
    // SecuritySignal found nothing older than its horizon and deleted nothing.
    // The test was asserting over an empty set.
    //
    // These are deliberately ANCIENT, so a prune that crosses the boundary
    // removes something and the assertion notices.
    const ancient = new Date(Date.now() - 400 * DAY);
    await prismaSystem.securitySignal.create({
      data: { kind: "authz.denied", actorKind: "system", storeId: store.id, occurredAt: ancient },
    });
    await prismaSystem.webhookDelivery.create({
      data: { provider: `tel-old-${stamp}`, signatureValid: true, payload: "{}", receivedAt: ancient },
    });
    await prismaSystem.storageEvent.create({
      data: { pathname: `old-${stamp}.png`, kind: "deleted", actor: "test", reason: "old", occurredAt: ancient },
    });

    // What is authoritative, before and after.
    const authoritativeBefore = {
      executions: await prismaSystem.executionLog.count(),
      signals: await prismaSystem.securitySignal.count(),
      outbound: await prismaSystem.outboundOperation.count(),
      deliveries: await prismaSystem.webhookDelivery.count(),
      storageEvents: await prismaSystem.storageEvent.count(),
    };

    const applied = await pruneTelemetry({ apply: true });
    assert("applying removes the aged rows", applied.total >= 2, JSON.stringify(applied));
    eq("the recent page view survives its shorter horizon",
      await prismaSystem.productEvent.count({ where: { storeId: store.id, name: "nav.section_view" } }), 1);

    const authoritativeAfter = {
      executions: await prismaSystem.executionLog.count(),
      signals: await prismaSystem.securitySignal.count(),
      outbound: await prismaSystem.outboundOperation.count(),
      deliveries: await prismaSystem.webhookDelivery.count(),
      storageEvents: await prismaSystem.storageEvent.count(),
    };
    // THE BOUNDARY. Telemetry is safe to forget; none of these are.
    eq("no authoritative table was touched", authoritativeAfter, authoritativeBefore);

    assert("page views have a shorter horizon than everything else",
      SHORT_RETENTION["nav.section_view"] < DEFAULT_RETENTION_DAYS,
      `${SHORT_RETENTION["nav.section_view"]} vs ${DEFAULT_RETENTION_DAYS}`);

    const footprint = await telemetryFootprint();
    assert("the footprint is measurable, so the window can be argued with numbers",
      footprint.total > 0 && footprint.byName.length > 0, JSON.stringify(footprint.total));
  }

  console.log("\n--- the prune job exists and is dark ---\n");
  {
    assert("the kind is registered", (JOB_KINDS as readonly string[]).includes("telemetry.prune"));
    assert("with a handler", typeof HANDLERS["telemetry.prune"] === "function");
    // NOTHING ENQUEUES IT. Enabling retention is a decision about a window,
    // not a build.
    eq("and nothing has enqueued it",
      await prismaSystem.job.count({ where: { kind: "telemetry.prune" } }), 0);

    // Even when run, it defaults to a dry run.
    await enqueue({ kind: "telemetry.prune", idempotencyKey: `prune-${stamp}`, storeId: store.id });
    const beforeRun = await prismaSystem.productEvent.count();
    await drain(HANDLERS, { maxJobs: 5 });
    await new Promise((r) => setTimeout(r, 150));
    const afterRun = await prismaSystem.productEvent.count();
    assert("running it without an explicit apply deletes nothing",
      afterRun >= beforeRun, `${beforeRun} -> ${afterRun}`);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
