"""Break the security stream deliberately.

Three directions are dangerous here.

Deleting evidence that should have been kept — the one thing on this page that
cannot be undone. Leaking what the stream holds, which turns a security feature
into the breach. And recording becoming a failure of its own, which would turn
every refused permission check into a second error.

    python scripts/sabotage-security-stream.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RETENTION = "lib/security/retention.ts"
SIGNALS = "lib/security/signals.ts"
TRACE = "lib/admin/trace.ts"
JOBS = "lib/jobs/registry.ts"
SCHED = "lib/scheduler/registry.ts"

BREAKS = [
    # ---- deleting evidence ----
    (
        "an incident is treated as ordinary noise",
        RETENTION,
        "    case SIGNAL_KINDS.isolationViolation:\n      return \"INCIDENT\";",
        "    case SIGNAL_KINDS.isolationViolation:\n      return \"VOLUME\";",
    ),
    (
        "severity stops outranking kind",
        RETENTION,
        '  if (severity === "critical") return "INCIDENT";',
        "  // severity ignored",
    ),
    (
        "an unclassified kind gets the shortest window",
        RETENTION,
        '    default:\n      // ============ AN UNKNOWN KIND IS KEPT, NOT DROPPED =========',
        '    default:\n      return "VOLUME";\n      // ============ AN UNKNOWN KIND IS KEPT, NOT DROPPED =========',
    ),
    (
        "the horizon is off by a factor",
        RETENTION,
        "  VOLUME: 30,",
        "  VOLUME: 1,",
    ),
    (
        "a capped run sheds evidence before noise",
        RETENTION,
        'const order: RetentionClass[] = ["VOLUME", "PATTERN", "ACT", "INCIDENT"];',
        'const order: RetentionClass[] = ["INCIDENT", "ACT", "PATTERN", "VOLUME"];',
    ),
    (
        "a dry run deletes anyway",
        RETENTION,
        "    if (apply) {",
        "    if (true) {",
    ),
    (
        "the cap stops being a cap",
        RETENTION,
        "      .slice(0, budget)",
        "      .slice(0, 1_000_000)",
    ),
    (
        "the prune job applies by default",
        JOBS,
        "  await pruneSignals({ apply: payload.apply === true, maxPerRun: payload.maxPerRun });",
        "  await pruneSignals({ apply: payload.apply !== false, maxPerRun: payload.maxPerRun });",
    ),
    (
        "the producer switches deletion on",
        SCHED,
        '        kind: "security.prune",\n        idempotencyKey: `security.prune:${day}`,',
        '        kind: "security.prune",\n        idempotencyKey: `security.prune:${day}`,\n        payload: { apply: true },',
    ),
    # ---- leaking what it holds ----
    (
        "detail is returned unredacted",
        SIGNALS,
        "      detail: redactDetail(row.detail),",
        "      detail: row.detail,",
    ),
    (
        "the sensitive-key list stops matching tokens",
        SIGNALS,
        "const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|apikey|api_key|credential|signature|bearer|card|cvv|ssn/i;",
        "const SENSITIVE_KEY = /nothing_matches_this/i;",
    ),
    (
        "long values stop being truncated",
        SIGNALS,
        "    return detail.length > MAX_VALUE_LENGTH ? `${detail.slice(0, MAX_VALUE_LENGTH)}…[truncated]` : detail;",
        "    return detail;",
    ),
    (
        "addresses are returned to everybody",
        SIGNALS,
        "      ipAddress: query.includeAddress ? row.ipAddress : null,",
        "      ipAddress: row.ipAddress,",
    ),
    (
        "redaction stops descending into nested objects",
        SIGNALS,
        "    out[key] = SENSITIVE_KEY.test(key) ? \"[redacted]\" : redactDetail(value);",
        "    out[key] = SENSITIVE_KEY.test(key) ? \"[redacted]\" : value;",
    ),
    # ---- filtering and paging ----
    (
        "the store filter stops narrowing",
        SIGNALS,
        "      ...(query.storeId ? { storeId: query.storeId } : {}),",
        "",
    ),
    (
        "the surface filter matches everything",
        SIGNALS,
        "      ...(query.surface ? { surface: { startsWith: query.surface } } : {}),",
        "",
    ),
    (
        "the page cap is removed",
        SIGNALS,
        "  const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_PAGE);",
        "  const limit = query.limit ?? 100;",
    ),
    (
        "paging repeats rows instead of continuing",
        SIGNALS,
        "    ...(query.after ? { cursor: { id: query.after }, skip: 1 } : {}),",
        "",
    ),
    # ---- the trace going around the read layer ----
    (
        "the trace queries the table directly again",
        TRACE,
        "    signalsForCorrelation(correlationId),",
        "    prismaSystem.securitySignal.findMany({\n"
        "      where: { correlationId },\n"
        "      orderBy: { occurredAt: \"asc\" },\n"
        "      take: limitPerSource,\n"
        "      select: { occurredAt: true, kind: true, severity: true, actorKind: true, storeId: true, surface: true },\n"
        "    }),",
    ),
    # ---- recording becoming a failure ----
    (
        "recording a signal can throw",
        SIGNALS,
        "  } catch {\n    // Swallowed on purpose",
        "  } catch (error) {\n    throw error;\n    // Swallowed on purpose",
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-ss.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts security-stream-db",
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
