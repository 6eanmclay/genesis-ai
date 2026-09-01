"""Break the retention policy deliberately.

The danger here is not that a table keeps growing. It is deleting the wrong
thing: a webhook body that a failed delivery still needs to replay, a dead
letter that is the only record of work that gave up, or an audit log nobody has
decided the horizon for.

Every break below destroys something that should have survived, or spares
something that should have gone.

    python scripts/sabotage-retention.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

POLICY = "lib/retention/policy.ts"
SWEEP = "lib/retention/sweep.ts"
JOBS = "lib/jobs/registry.ts"
SCHED = "lib/scheduler/registry.ts"

BREAKS = [
    # ---- destroying a recovery ----
    (
        "a failed delivery loses the body it would replay from",
        SWEEP,
        '    status: { in: ["processed", "rejected"] },',
        '    status: { in: ["processed", "rejected", "failed", "replaying"] },',
    ),
    (
        "a recent delivery is redacted too",
        SWEEP,
        "    receivedAt: { lt: cutoff },\n    // Only deliveries that are finished with.",
        "    // horizon ignored\n    // Only deliveries that are finished with.",
    ),
    # ---- destroying evidence ----
    (
        "a dead letter is pruned like ordinary work",
        SWEEP,
        '      ? { createdAt: { lt: cutoff }, status: { in: ["done"] } }',
        "      ? { createdAt: { lt: cutoff } }",
    ),
    (
        "a task stuck mid-run is pruned",
        SWEEP,
        '      : { startedAt: { lt: cutoff }, outcome: { in: ["succeeded", "failed", "skipped"] } };',
        "      : { startedAt: { lt: cutoff } };",
    ),
    (
        "the audit log acquires an invented horizon",
        POLICY,
        '    model: "executionLog",\n    verdict: "decide",\n    keepDays: null,',
        '    model: "executionLog",\n    verdict: "prune",\n    keepDays: 90,',
    ),
    (
        "an undecided table stops naming whose decision it is",
        POLICY,
        '    needs: "A retention decision from Sean, informed by what accounting and dispute evidence actually requires.",',
        '    needs: "",',
    ),
    # ---- failing to protect customer data ----
    (
        "the payload is kept for ever after all",
        SWEEP,
        '    data: { payload: "" },',
        "    data: {},",
    ),
    (
        "the delivery record is deleted instead of redacted",
        POLICY,
        '    model: "webhookDelivery",\n    verdict: "redact",',
        '    model: "webhookDelivery",\n    verdict: "prune",',
    ),
    # ---- the safety defaults ----
    (
        "the sweep applies by default",
        SWEEP,
        "  const apply = options.apply ?? false;",
        "  const apply = options.apply ?? true;",
    ),
    (
        "the cap stops being a cap",
        SWEEP,
        "  const cap = options.maxPerRun ?? MAX_PER_RUN;",
        "  const cap = 1_000_000;",
    ),
    (
        "the job handler applies by default",
        JOBS,
        "  await runRetentionSweep({ apply: payload.apply === true, maxPerRun: payload.maxPerRun });",
        "  await runRetentionSweep({ apply: payload.apply !== false, maxPerRun: payload.maxPerRun });",
    ),
    (
        "the producer switches deletion on",
        SCHED,
        '        kind: "retention.sweep",\n        idempotencyKey: `retention.sweep:${day}`,\n        payload: {},',
        '        kind: "retention.sweep",\n        idempotencyKey: `retention.sweep:${day}`,\n        payload: { apply: true },',
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-rt.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts retention-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text and "1/1 database-backed suites pass." in text
    fails = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL ")]
    return green, " | ".join(fails[:2]).encode("ascii", "replace").decode("ascii")


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
