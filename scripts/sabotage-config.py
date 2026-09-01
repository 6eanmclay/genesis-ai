"""Break the configuration registry deliberately.

Two dangers, opposite in shape. A registry that goes stale — describing a
deployment that no longer exists, so the startup report says everything is fine
about a variable nobody declared. And a report that leaks — a configuration
summary is the thing somebody pastes into a chat window at midnight, and one
carrying a fragment of a live key makes the incident worse than the one it was
helping with.

    python scripts/sabotage-config.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REGISTRY = "lib/config/registry.ts"
REPORT = "lib/config/report.ts"
HOOK = "instrumentation.ts"

BREAKS = [
    # ---- the registry going stale ----
    (
        "a variable the code reads stops being described",
        REGISTRY,
        '  { name: "CRON_SECRET", group: "ops", requirement: "production", secret: true,',
        '  { name: "CRON_SECRET_RENAMED", group: "ops", requirement: "production", secret: true,',
    ),
    (
        "an entry describes something nothing reads",
        REGISTRY,
        "export const CONFIG: ConfigEntry[] = [",
        'export const CONFIG: ConfigEntry[] = [\n'
        '  { name: "INVENTED_VARIABLE_NOBODY_READS", group: "ops", requirement: "optional", secret: false,\n'
        '    purpose: "Something that does not exist.",\n'
        '    absence: "Nothing, because nothing reads it." },',
    ),
    (
        "an entry stops saying what its absence costs",
        REGISTRY,
        '    absence: "Fails CLOSED — every cron trigger answers 401, so nothing scheduled runs at all." },',
        '    absence: "n/a" },',
    ),
    (
        "something essential is quietly downgraded",
        REGISTRY,
        '  { name: "AUTH_SECRET", group: "core", requirement: "essential", secret: true,',
        '  { name: "AUTH_SECRET", group: "core", requirement: "optional", secret: true,',
    ),
    # ---- the report leaking ----
    (
        "the report starts returning values",
        REPORT,
        "      present,\n      consequence: present ? null : entry.absence,",
        "      present,\n      consequence: present ? null : entry.absence,\n      value: process.env[entry.name],",
    ),
    (
        "the startup log prints what it found",
        REPORT,
        "    lines.push(`  MISSING (essential)  ${status.name} — ${status.consequence}`);",
        "    lines.push(`  MISSING (essential)  ${status.name} — ${status.consequence} — ${JSON.stringify(process.env)}`);",
    ),
    # ---- the report becoming an outage ----
    (
        "a missing variable refuses to start the platform",
        REPORT,
        "  const essentialMissing = missing(\"essential\");",
        "  const essentialMissing = missing(\"essential\");\n"
        "  if (essentialMissing.length > 0) throw new Error(\"configuration incomplete\");",
    ),
    # ---- whitespace ----
    (
        "an empty value counts as configured",
        REPORT,
        '  return typeof raw === "string" && raw.trim().length > 0;',
        '  return typeof raw === "string";',
    ),
    # ---- the boot hook ----
    (
        "the check stops running at boot",
        HOOK,
        "    logConfigReport();",
        "    void logConfigReport;",
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-cfg.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts config-db",
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
