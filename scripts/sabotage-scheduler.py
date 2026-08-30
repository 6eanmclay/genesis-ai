"""Break the scheduling layer deliberately, one property at a time.

The claim this whole design rests on is that a task's cadence is independent of
how often a trigger fires — that is what makes "switch the schedules on later"
configuration rather than a rewrite. If that claim cannot be broken in a way the
suite notices, the suite is not testing it.

    python scripts/sabotage-scheduler.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RUN = "lib/scheduler/run.ts"
REGISTRY = "lib/scheduler/registry.ts"
HEALTH = "lib/scheduler/health.ts"
ROUTE = "app/api/cron/sync/route.ts"
VERCEL = "vercel.json"

BREAKS = [
    # ---- the central claim: cadence is independent of trigger frequency ----
    (
        "due-ness comes from the trigger instead of the database",
        RUN,
        "  if (!lastSuccessAt) return true;\n"
        "  return now.getTime() - lastSuccessAt.getTime() >= task.everyMs;",
        "  if (!lastSuccessAt) return true;\n"
        "  return true;",
    ),
    (
        "due-ness reads the last ATTEMPT rather than the last success",
        RUN,
        '    where: { taskKey: { in: keys }, outcome: "succeeded" },',
        "    where: { taskKey: { in: keys } },",
    ),
    # ---- isolation and budget ----
    (
        "a failing task takes the rest of the tick down with it",
        RUN,
        "    outcomes.push(await runOne(task, options.trigger));",
        "    const outcome = await runOne(task, options.trigger);\n"
        "    outcomes.push(outcome);\n"
        '    if (outcome.status === "failed") break;',
    ),
    (
        "running out of budget silently stops instead of deferring",
        RUN,
        "    if (remaining < task.budgetMs) {\n"
        "      deferred.push(task.key);",
        "    if (remaining < task.budgetMs) {\n"
        "      continue;\n"
        "      deferred.push(task.key);",
    ),
    (
        "a task that is switched off runs anyway",
        RUN,
        "    if (!task.enabled()) {",
        "    if (false) {",
    ),
    # ---- ordering: cost of delay ----
    (
        "lanes run in declaration order rather than cost of delay",
        RUN,
        "    .sort((a, b) => LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane));",
        "    .slice();",
    ),
    (
        "a lane filter stops filtering",
        RUN,
        "    .filter((t) => (options.only ? t.key === options.only : lanes.includes(t.lane)))",
        "    .filter((t) => (options.only ? t.key === options.only : true))",
    ),
    # ---- the run record ----
    (
        "the run is recorded only after the work finishes",
        RUN,
        "    let runId: string | null = null;\n"
        "    try {\n"
        "      const row = await prismaSystem.scheduledTaskRun.create({",
        "    let runId: string | null = null;\n"
        "    if (false) try {\n"
        "      const row = await prismaSystem.scheduledTaskRun.create({",
    ),
    # ---- the refactor's safety net: a responsibility disappears ----
    (
        "a responsibility is dropped from the registry",
        REGISTRY,
        '    key: "auth.pruneAttempts",',
        '    key: "auth.pruneAttemptsRENAMED",',
    ),
    (
        "the weekly sweep goes back to a day-of-week check",
        REGISTRY,
        "    everyMs: WEEK,\n"
        "    enabled: attributionSweepEnabled,",
        "    everyMs: DAY,\n"
        "    enabled: () => attributionSweepEnabled() && new Date().getUTCDay() === 0,",
    ),
    (
        "telemetry.prune loses its per-day idempotency key",
        REGISTRY,
        "        idempotencyKey: `telemetry.prune:${day}`,",
        "        idempotencyKey: `telemetry.prune:${Date.now()}`,",
    ),
    # ---- health: the failure that used to be invisible ----
    (
        "an overdue task stops being a finding",
        HEALTH,
        "  const overdue = health.filter((t) => t.overdueByMs !== null);",
        "  const overdue: TaskHealth[] = [];",
    ),
    (
        "a task stuck mid-run stops being a finding",
        HEALTH,
        "  const stuck = health.filter((t) => t.stuckSince);",
        "  const stuck: TaskHealth[] = [];",
    ),
    (
        "a disabled task starts crying for attention",
        HEALTH,
        "  const failing = health.filter((t) => t.enabled && t.lastOutcome === \"failed\");",
        "  const failing = health.filter((t) => t.lastOutcome !== \"succeeded\");",
    ),
    # ---- the trigger starts deciding again ----
    (
        "business logic creeps back into the trigger",
        ROUTE,
        "  const result = await withCorrelation(",
        "  const { runDueSourcing } = await import(\"@/lib/sourcing/sourcingSchedule\");\n"
        "  void runDueSourcing;\n"
        "  const result = await withCorrelation(",
    ),
    # ---- the schedule is switched on without saying so ----
    (
        "the frequent cron is quietly switched on",
        VERCEL,
        '    {\n      "path": "/api/cron/sync",\n      "schedule": "0 6 * * *"\n    }',
        '    {\n      "path": "/api/cron/sync",\n      "schedule": "0 6 * * *"\n    },\n'
        '    {\n      "path": "/api/cron/tick",\n      "schedule": "*/2 * * * *"\n    }',
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-sch.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts scheduler-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text and "1/1 database-backed suites pass." in text
    fails = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL ")]
    joined = " | ".join(fails[:3])
    return green, joined.encode("ascii", "replace").decode("ascii")


def main() -> int:
    print("Confirming the suite is green before breaking anything...")
    green, _ = run_suite()
    if not green:
        print("ABORT - not green to begin with. Nothing below would mean anything.")
        return 1
    print("  green.\n")

    unproven = []
    for name, path, old, new in BREAKS:
        full = os.path.join(ROOT, path)
        original = io.open(full, encoding="utf-8", newline="").read()
        crlf = "\r\n" in original
        source = original.replace("\r\n", "\n")

        if old not in source:
            print(f"BROKEN SABOTAGE  {name} - anchor not found in {path}")
            unproven.append(f"{name} (anchor missing)")
            continue
        broken = source.replace(old, new, 1)
        assert broken != source
        if crlf:
            broken = broken.replace("\n", "\r\n")

        io.open(full, "w", encoding="utf-8", newline="").write(broken)
        try:
            still_green, fails = run_suite()
        finally:
            io.open(full, "w", encoding="utf-8", newline="").write(original)

        if still_green:
            print(f"NOT PROVEN  {name} - the suite stayed green")
            unproven.append(name)
        else:
            print(f"caught      {name}")
            print(f"            {fails}")

    print()
    if unproven:
        print(f"{len(unproven)} of {len(BREAKS)} breaks were NOT caught:")
        for u in unproven:
            print(f"  - {u}")
        return 1
    print(f"All {len(BREAKS)} breaks were caught.")
    return 0


sys.exit(main())
