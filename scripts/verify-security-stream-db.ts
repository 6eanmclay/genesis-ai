import "@/scripts/lib/allowServerOnly";

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  recordSignal, readSignals, readSignalPage, signalsForCorrelation,
  tallySignals, redactDetail, SIGNAL_KINDS, MAX_PAGE,
} from "@/lib/security/signals";
import {
  pruneSignals, signalFootprint, retentionClassOf, RETENTION_DAYS, MAX_PER_RUN,
} from "@/lib/security/retention";
import { withCorrelation, correlationId } from "@/lib/observability/correlation";
import { traceFor } from "@/lib/admin/trace";
import { JOB_KINDS, HANDLERS, validateJobPayload } from "@/lib/jobs/registry";
import { taskByKey } from "@/lib/scheduler/registry";
import { readFileSync } from "node:fs";

// THE SECURITY STREAM — KEEPING IT, READING IT, AND NOT LEAKING IT:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts security-stream-db
//
// ============ WHY THE RETENTION IS NOT ONE NUMBER (2026-08-30) =========
//
// Copying telemetry's ninety days would have been the easy answer. Telemetry
// asks how a product is used, where every quarter is equally interesting. A
// security signal asks whether something happened that somebody should know
// about, and that varies enormously: an isolation violation is wanted a year
// later, a rate-limit trip is noise within a month, and a replayed payment
// webhook is an audit record of a human decision about money.
//
// So the policy is per class and the class is a pure function. Most of the
// first half of this file is that function, exhaustively, because it is the
// thing that decides what evidence still exists when somebody finally goes
// looking.
//
// ============ AND WHY DELETION IS THE DANGEROUS PART =================
//
// Everything else here can be got wrong and fixed. A prune that takes the wrong
// rows cannot be undone, so the boundary is tested from both sides: a row one
// second past its horizon goes, and a row one second inside it stays.

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

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const user = await prisma.user.create({ data: { email: `ss-${stamp}@example.test` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "SS", slug: `ss-${stamp}`, tagline: "t", description: "d" },
  });
  const other = await prisma.store.create({
    data: { userId: user.id, name: "SS2", slug: `ss2-${stamp}`, tagline: "t", description: "d" },
  });

  /** Plant a signal at an exact age. */
  const plant = async (over: {
    kind: string; severity?: string; daysAgo?: number; storeId?: string | null;
    actorId?: string | null; actorKind?: string; surface?: string | null;
    detail?: unknown; ipAddress?: string | null; correlationId?: string | null;
  }) =>
    prismaSystem.securitySignal.create({
      data: {
        kind: over.kind,
        severity: over.severity ?? "info",
        actorKind: over.actorKind ?? "user",
        actorId: over.actorId ?? null,
        storeId: over.storeId ?? null,
        surface: over.surface ?? null,
        ipAddress: over.ipAddress ?? null,
        correlationId: over.correlationId ?? null,
        occurredAt: new Date(Date.now() - (over.daysAgo ?? 0) * DAY_MS),
        ...(over.detail ? { detail: over.detail as object } : {}),
      },
    });

  console.log("\n--- the policy, as a pure function ---\n");
  {
    // ============ SEVERITY OUTRANKS KIND ======================
    //
    // A critical anything is an incident whatever it was called, so a kind
    // added later that nobody classified still gets the safe answer.
    for (const kind of Object.values(SIGNAL_KINDS)) {
      eq(`a critical ${kind} is an incident`, retentionClassOf(kind, "critical"), "INCIDENT");
    }

    eq("an isolation violation is an incident at any severity",
      retentionClassOf(SIGNAL_KINDS.isolationViolation, "info"), "INCIDENT");
    eq("a replayed webhook is an act", retentionClassOf(SIGNAL_KINDS.webhookReplayed, "info"), "ACT");
    eq("a refused replay is too", retentionClassOf(SIGNAL_KINDS.webhookReplayRefused, "info"), "ACT");

    for (const kind of [SIGNAL_KINDS.authzDenied, SIGNAL_KINDS.authzUnresolved, SIGNAL_KINDS.webhookUnsigned]) {
      eq(`${kind} is a pattern`, retentionClassOf(kind, "warning"), "PATTERN");
    }
    for (const kind of [SIGNAL_KINDS.rateLimited, SIGNAL_KINDS.boundaryRejected]) {
      eq(`${kind} is volume`, retentionClassOf(kind, "info"), "VOLUME");
    }

    // ============ AN UNKNOWN KIND IS KEPT ====================
    //
    // Keeping it too long costs storage; deleting it too early destroys
    // evidence, and only one of those is recoverable.
    eq("a kind nobody classified is kept, not dropped",
      retentionClassOf("something.invented.later", "info"), "PATTERN");

    // The horizons themselves, so a careless edit to a number is visible.
    eq("an incident is kept longest", RETENTION_DAYS.INCIDENT, 400);
    eq("an act as long", RETENTION_DAYS.ACT, 400);
    eq("a pattern half a year", RETENTION_DAYS.PATTERN, 180);
    eq("and volume a month", RETENTION_DAYS.VOLUME, 30);
    assert("volume is the shortest of the four",
      RETENTION_DAYS.VOLUME < RETENTION_DAYS.PATTERN &&
      RETENTION_DAYS.PATTERN < RETENTION_DAYS.INCIDENT);
  }

  console.log("\n--- the retention boundary, from both sides ---\n");
  {
    // ============ THE ONE THING THAT CANNOT BE UNDONE =========
    const justInside = await plant({ kind: SIGNAL_KINDS.rateLimited, daysAgo: 29 });
    const justOutside = await plant({ kind: SIGNAL_KINDS.rateLimited, daysAgo: 31 });
    const oldIncident = await plant({ kind: SIGNAL_KINDS.isolationViolation, daysAgo: 200 });
    const oldPattern = await plant({ kind: SIGNAL_KINDS.authzDenied, severity: "warning", daysAgo: 200 });
    const ancientIncident = await plant({ kind: SIGNAL_KINDS.isolationViolation, daysAgo: 500 });

    await pruneSignals({ apply: true });

    const alive = async (id: string) =>
      (await prismaSystem.securitySignal.count({ where: { id } })) === 1;

    assert("a volume signal one day inside its horizon survives", await alive(justInside.id));
    assert("and one day past it is gone", !(await alive(justOutside.id)));
    // The distinction the whole design exists for: same age, different value.
    assert("an incident at two hundred days survives", await alive(oldIncident.id));
    assert("but a pattern at two hundred days does not", !(await alive(oldPattern.id)));
    assert("and an incident past even its own horizon goes", !(await alive(ancientIncident.id)));
  }

  console.log("\n--- pruning is idempotent, bounded, and honest about stopping ---\n");
  {
    // Idempotent: a second run finds nothing, because age is the only input.
    const again = await pruneSignals({ apply: true });
    const removed = Object.values(again.deleted).reduce((a, b) => a + b, 0);
    eq("running it twice removes nothing the second time", removed, 0);

    // Dry run: reports without deleting. The default for the scheduled job.
    await plant({ kind: SIGNAL_KINDS.rateLimited, daysAgo: 90 });
    const before = await prismaSystem.securitySignal.count();
    const dry = await pruneSignals({ apply: false });
    assert("a dry run says what would go", dry.wouldDelete > 0, `${dry.wouldDelete}`);
    eq("and removes nothing", await prismaSystem.securitySignal.count(), before);

    // Bounded, and it says when it stopped early rather than looking finished.
    for (let i = 0; i < 5; i++) await plant({ kind: SIGNAL_KINDS.rateLimited, daysAgo: 60 });
    const capped = await pruneSignals({ apply: true, maxPerRun: 2 });
    eq("a capped run removes at most its cap",
      Object.values(capped.deleted).reduce((a, b) => a + b, 0), 2);
    assert("and says there is more", capped.moreRemaining);
    eq("there is a default cap", MAX_PER_RUN, 5_000);

    // ============ NOISE IS SHED BEFORE EVIDENCE =============
    //
    // A capped run takes the shortest-horizon rows first, so a backlog loses
    // rate-limit trips long before it loses an isolation violation.
    const survivor = await plant({ kind: SIGNAL_KINDS.isolationViolation, daysAgo: 500 });
    for (let i = 0; i < 3; i++) await plant({ kind: SIGNAL_KINDS.boundaryRejected, daysAgo: 60 });
    await pruneSignals({ apply: true, maxPerRun: 2 });
    assert("an incident outlives the noise when a run is capped",
      (await prismaSystem.securitySignal.count({ where: { id: survivor.id } })) === 1);
    await prismaSystem.securitySignal.deleteMany({ where: { id: survivor.id } });
  }

  console.log("\n--- the footprint is an independent check on the policy ---\n");
  {
    const footprint = await signalFootprint();
    eq("every class is reported", footprint.byClass.map((c) => c.class).sort(),
      ["ACT", "INCIDENT", "PATTERN", "VOLUME"]);
    for (const cls of footprint.byClass) {
      eq(`${cls.class} reports its own horizon`, cls.keepDays, RETENTION_DAYS[cls.class]);
    }
    assert("with a total", typeof footprint.total === "number");
  }

  console.log("\n--- reading: every filter narrows, and only what was asked ---\n");
  {
    const base = { severity: "warning" as const, actorKind: "user" };
    await plant({ ...base, kind: SIGNAL_KINDS.authzDenied, storeId: store.id, actorId: user.id, surface: "http:register" });
    await plant({ ...base, kind: SIGNAL_KINDS.authzDenied, storeId: other.id, actorId: user.id, surface: "http:chat" });
    await plant({ ...base, kind: SIGNAL_KINDS.webhookUnsigned, storeId: store.id, actorKind: "provider", surface: "webhook:STRIPE" });

    const byStore = await readSignals({ storeId: store.id, limit: 50 });
    assert("a store filter returns only that store",
      byStore.length > 0 && byStore.every((r) => r.storeId === store.id));
    const byKind = await readSignals({ kinds: [SIGNAL_KINDS.webhookUnsigned], limit: 50 });
    assert("a kind filter returns only that kind",
      byKind.length > 0 && byKind.every((r) => r.kind === SIGNAL_KINDS.webhookUnsigned));
    const byActorKind = await readSignals({ actorKind: "provider", limit: 50 });
    assert("an actor-kind filter narrows",
      byActorKind.length > 0 && byActorKind.every((r) => r.actorKind === "provider"));
    // Prefix, so "http:" finds every boundary rejection at once.
    const bySurface = await readSignals({ surface: "http:", limit: 50 });
    assert("a surface prefix finds a family",
      bySurface.length > 0 && bySurface.every((r) => (r.surface ?? "").startsWith("http:")));

    // A time range, both ends.
    const old = await plant({ kind: SIGNAL_KINDS.authzDenied, daysAgo: 10, storeId: store.id });
    const windowed = await readSignals({
      since: new Date(Date.now() - 12 * DAY_MS), until: new Date(Date.now() - 8 * DAY_MS), limit: 50,
    });
    assert("a range returns what is inside it", windowed.some((r) => r.id === old.id));
    const narrow = await readSignals({ since: new Date(Date.now() - 1 * DAY_MS), limit: 50 });
    assert("and excludes what is outside", !narrow.some((r) => r.id === old.id));
  }

  console.log("\n--- pagination is a cursor, and it is capped ---\n");
  {
    const kind = `test.page.${stamp}`;
    for (let i = 0; i < 7; i++) {
      await plant({ kind, storeId: store.id, surface: `page-${i}` });
    }

    const first = await readSignalPage({ kinds: [kind], limit: 3 });
    eq("a page is the size asked for", first.rows.length, 3);
    assert("with a cursor for the next", !!first.nextCursor);

    const second = await readSignalPage({ kinds: [kind], limit: 3, after: first.nextCursor! });
    eq("the next page is full too", second.rows.length, 3);
    // ============ NO REPEATS, WHICH IS THE POINT =============
    //
    // An offset shifts under rows arriving while somebody reads, so page two
    // silently repeats or skips — and what it skips is the newest, which during
    // an incident is what is being looked for.
    const seen = new Set(first.rows.map((r) => r.id));
    assert("and repeats nothing from the first", !second.rows.some((r) => seen.has(r.id)));

    const third = await readSignalPage({ kinds: [kind], limit: 3, after: second.nextCursor! });
    eq("the last page holds the remainder", third.rows.length, 1);
    eq("and says there is no more", third.nextCursor, null);

    // ============ THE CAP, WITH ENOUGH ROWS TO SEE IT ========
    //
    // This asked for ten thousand and asserted the answer was at most five
    // hundred — which was true whatever the code did, because the harness held
    // fewer than five hundred signals. Sabotage removed the cap entirely and
    // the suite stayed green.
    //
    // A cap can only be observed by exceeding it, so enough rows are planted to
    // exceed it. createMany because this is bulk fixture, not behaviour.
    const bulkKind = `test.bulk.${stamp}`;
    await prismaSystem.securitySignal.createMany({
      data: Array.from({ length: MAX_PAGE + 20 }, () => ({
        kind: bulkKind, severity: "info", actorKind: "system", storeId: store.id,
      })),
    });
    const greedy = await readSignalPage({ kinds: [bulkKind], limit: 10_000 });
    eq("a page can never exceed the maximum, however loudly asked", greedy.rows.length, MAX_PAGE);
    assert("and still offers a cursor for the rest", !!greedy.nextCursor);
    eq("which is five hundred", MAX_PAGE, 500);
    await prismaSystem.securitySignal.deleteMany({ where: { kind: bulkKind } });
  }

  console.log("\n--- what a reader is never given ---\n");
  {
    // ============ THE ASSERTION THAT MATTERS IN A BREACH ======
    const secret = `tok-${stamp}-never-leaves`;
    const planted = await plant({
      kind: SIGNAL_KINDS.authzDenied,
      storeId: store.id,
      ipAddress: "203.0.113.77",
      detail: {
        permission: "products:manage",
        // Everything writing signals today puts names and counts here. This is
        // the caller nobody has written yet.
        token: secret,
        apiKey: secret,
        nested: { password: secret, harmless: "fine" },
        long: "x".repeat(2000),
      },
    });

    const [row] = await readSignals({ kinds: [SIGNAL_KINDS.authzDenied], storeId: store.id, limit: 1 });
    assert("the signal comes back", !!row);
    const dumped = JSON.stringify(row ?? {});
    assert("a token in detail is never returned", !dumped.includes(secret), dumped.slice(0, 200));
    // The KEY survives — knowing a token was involved is useful; knowing which
    // is a liability.
    assert("but the fact there was one is kept", dumped.includes("token"));
    assert("nested secrets are redacted too", !dumped.includes("password\":\"tok-"));
    assert("and an ordinary nested value survives", dumped.includes("harmless"));
    assert("an enormous value is truncated", dumped.includes("truncated"));

    // Addresses are opt-in.
    eq("an address is withheld by default", row?.ipAddress, null);
    const [withAddress] = await readSignals({
      kinds: [SIGNAL_KINDS.authzDenied], storeId: store.id, limit: 1, includeAddress: true,
    });
    eq("and returned only when asked for", withAddress?.ipAddress, "203.0.113.77");

    // The browser identifier never comes back at all.
    assert("userAgent is not part of a row", !("userAgent" in (row ?? {})));

    // The redactor itself, directly.
    const cleaned = redactDetail({ authorization: "Bearer abc", cookie: "s=1", fine: 3 }) as Record<string, unknown>;
    eq("an authorization header is redacted", cleaned.authorization, "[redacted]");
    eq("a cookie too", cleaned.cookie, "[redacted]");
    eq("and an ordinary number is left alone", cleaned.fine, 3);
    eq("null survives", redactDetail(null), null);

    await prismaSystem.securitySignal.deleteMany({ where: { id: planted.id } });
  }

  console.log("\n--- a signal joins the story around it ---\n");
  {
    const traced = await withCorrelation({ origin: "http", surface: "test" }, async () => {
      const id = correlationId()!;
      await recordSignal({
        kind: SIGNAL_KINDS.authzDenied, severity: "warning", actorKind: "user",
        actorId: user.id, storeId: store.id, surface: "test:correlated",
      });
      return id;
    });

    const forId = await signalsForCorrelation(traced);
    eq("the signal is findable by correlation id", forId.length, 1);

    // And through the trace, which now reads the same layer rather than its own
    // query — so the rules above apply there too.
    const trace = await traceFor(traced);
    assert("and appears in the surrounding trace",
      trace.entries.some((e) => e.source === "security"),
      JSON.stringify(trace.entries.map((e) => e.source)));

    const traceSrc = readFileSync("lib/admin/trace.ts", "utf8");
    assert("the trace consumes the read layer rather than querying directly",
      traceSrc.includes("signalsForCorrelation(correlationId)"));
    assert("and no longer has its own signal query",
      !/securitySignal\.findMany/.test(traceSrc), "a second query came back");
  }

  console.log("\n--- recording still never throws ---\n");
  {
    // ============ THE PROPERTY EVERYTHING ELSE DEPENDS ON =====
    //
    // A failure while recording a refusal must never become a second failure.
    // Every authorization guard in this codebase awaits recordSignal on its way
    // to refusing, and a throw there would turn a clean "no" into a 500.
    let threw = false;
    await recordSignal({
      kind: SIGNAL_KINDS.authzDenied,
      actorKind: "user",
      // A store that does not exist. The insert fails on the foreign key.
      storeId: `no-such-store-${stamp}`,
      actorId: user.id,
    }).catch(() => { threw = true; });
    assert("recording against a missing store does not throw", !threw);

    const src = readFileSync("lib/security/signals.ts", "utf8");
    assert("and the swallow is deliberate, with its reason written down",
      /catch \{[\s\S]{0,400}?unavailable database/.test(src));
  }

  console.log("\n--- pruning is queued, scheduled, and dry by default ---\n");
  {
    assert("security.prune is a real job kind",
      (JOB_KINDS as readonly string[]).includes("security.prune"));
    assert("with a handler", !!HANDLERS["security.prune"]);
    eq("and a validated payload",
      validateJobPayload("security.prune", { apply: true, maxPerRun: 10 }), { ok: true });
    assert("that refuses a nonsense one",
      validateJobPayload("security.prune", { maxPerRun: -1 }).ok === false);

    const task = taskByKey("security.prune");
    assert("a task produces the work", !!task);
    assert("switched on", !!task?.enabled());

    // ============ DRY BY DEFAULT, DELIBERATELY ==============
    //
    // This deletes evidence. A scheduled job that does that by default is one
    // nobody reviewed before it ran.
    const registrySrc = readFileSync("lib/scheduler/registry.ts", "utf8");
    const block = registrySrc.slice(registrySrc.indexOf('key: "security.prune"'), registrySrc.indexOf('key: "ops.alerts"'));
    assert("the producer sends no apply flag", !/apply:\s*true/.test(block), block.slice(0, 200));

    const handlerSrc = readFileSync("lib/jobs/registry.ts", "utf8");
    assert("and the handler defaults to a dry run",
      /pruneSignals\(\{ apply: payload\.apply === true/.test(handlerSrc));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
