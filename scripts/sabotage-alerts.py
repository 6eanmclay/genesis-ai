"""Break the alert sweep deliberately.

Two directions are dangerous and they are opposites. Silence — a finding that
never reaches anybody, which is where this platform started. And noise — the
same finding repeated until somebody mutes the channel, which is worse than
silence because it looks like coverage.

    python scripts/sabotage-alerts.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ALERTS = "lib/observability/alerts.ts"
HEALTH = "lib/admin/platformHealth.ts"
SCHED_HEALTH = "lib/scheduler/health.ts"
REGISTRY = "lib/scheduler/registry.ts"

BREAKS = [
    # ---- silence ----
    (
        "nothing is ever reported",
        ALERTS,
        "    reportIssue(finding, null, {",
        "    if (false) reportIssue(finding, null, {",
    ),
    (
        "platform findings are dropped",
        ALERTS,
        '    { name: "platformHealth", read: async () => needsAttention(await platformHealth()) },',
        '    { name: "platformHealth", read: async () => { await platformHealth(); return []; } },',
    ),
    (
        "a dead letter stops being a finding",
        HEALTH,
        "  if (health.queue.deadLetters.length > 0) {",
        "  if (false) {",
    ),
    (
        "a stalled task stops being a finding",
        SCHED_HEALTH,
        "  const stuck = health.filter((t) => t.stuckSince);",
        "  const stuck: TaskHealth[] = [];",
    ),
    (
        "the sweep is unscheduled",
        REGISTRY,
        '    key: "ops.alerts",',
        '    key: "ops.alertsRENAMED",',
    ),
    # Anchored on the task's own run line, because inserting a second `enabled`
    # key before the real one is a duplicate key in an object literal — the last
    # wins, so the first version of this break switched nothing off and reported
    # the suite as weak when the suite was fine.
    (
        "the sweep is switched off",
        REGISTRY,
        "    enabled: always,\n    budgetMs: 30_000,\n    run: () => runAlertSweep(),",
        "    enabled: () => false,\n    budgetMs: 30_000,\n    run: () => runAlertSweep(),",
    ),
    # ---- noise ----
    (
        "the cooldown is ignored, so every finding repeats",
        ALERTS,
        "    if (!verdict.allowed) {\n      suppressed += 1;\n      continue;\n    }",
        "    if (false) {\n      suppressed += 1;\n      continue;\n    }",
    ),
    (
        "the fingerprint ignores the count, so worsening is silent",
        ALERTS,
        'return createHash("sha256").update(finding).digest("hex").slice(0, 32);',
        'return createHash("sha256").update(finding.replace(/[0-9]+/g, "N")).digest("hex").slice(0, 32);',
    ),
    # ---- the monitor becoming the outage ----
    (
        "a failing source takes the sweep down",
        ALERTS,
        "    try {\n      findings.push(...(await source.read()));\n    } catch (error) {",
        "    findings.push(...(await source.read()));\n    if (false) try { throw new Error(); } catch (error) {",
    ),
    # ---- a second dispatcher ----
    (
        "a second way of sending appears",
        ALERTS,
        "    reported.push(finding);",
        '    await fetch("https://example.invalid/hook", { method: "POST" }).catch(() => {});\n    reported.push(finding);',
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-al.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts alerts-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text and "1/1 database-backed suites pass." in text
    fails = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL ")]
    return green, " | ".join(fails[:3]).encode("ascii", "replace").decode("ascii")


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
