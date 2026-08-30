"""Break the operator surface deliberately, one protection at a time.

Every break must turn the suite RED. A break that leaves it green means the
suite was measuring something else, and this codebase has produced that exact
false comfort several times already — most recently two guards that each caught
what the other was supposed to prove.

Each entry asserts the edit actually applied before running anything. A sabotage
script whose edit silently missed reports a green run as proof of coverage,
which is worse than not running it.

    python scripts/sabotage-operator-surface.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BREAKS = [
    (
        "an empty allowlist admits everybody",
        "lib/platformAdminPolicy.ts",
        "  if (!normalised) return false;",
        "  if (!normalised) return normalised === undefined ? false : allowlist.includes(',');",
    ),
    # A blank list entry alone, or an empty allowlist alone, changes no result.
    # Sabotage proved both, and lib/platformAdminPolicy.ts records why rather
    # than pretending otherwise. What IS dangerous is dropping the empty-email
    # return AND the filter together — a trailing comma then admits anybody —
    # so that combination is what gets broken here.
    (
        "a trailing comma plus no empty-email check admits anybody",
        "lib/platformAdminPolicy.ts",
        '  const normalised = email?.trim().toLowerCase();\n  if (!normalised) return false;',
        '  const normalised = email?.trim().toLowerCase() ?? "";',
        ('.map((entry) => entry.trim().toLowerCase()).filter(Boolean),',
         '.map((entry) => entry.trim().toLowerCase()),'),
    ),
    (
        "the allowlist matches loosely instead of exactly",
        "lib/platformAdminPolicy.ts",
        "  return allowed.has(normalised);",
        "  return [...allowed].some((e) => normalised.includes(e) || e.includes(normalised));",
    ),
    # The length floor was broken here too and the suite stayed green — rightly,
    # since exact matching already makes a short term find nothing. It is not
    # what keeps this a lookup, so it is not claimed as a protection. The break
    # below is the one that actually decides it.
    (
        "the lookup matches partial identifiers",
        "lib/admin/trace.ts",
        "        OR: [{ externalRef: term }, { idempotencyKey: term }],",
        "        OR: [{ externalRef: { contains: term } }, { idempotencyKey: { contains: term } }],",
    ),
    (
        "the failure list becomes an activity feed",
        "lib/admin/trace.ts",
        '      where: { correlationId: { not: null }, status: { in: ["FAILED", "WARNING"] } },',
        '      where: { correlationId: { not: null } },',
    ),
    (
        "processed deliveries are offered for replay",
        "lib/webhooks/delivery.ts",
        '    where: { status: "failed", ...(provider ? { provider } : {}) },',
        '    where: { ...(provider ? { provider } : {}) },',
    ),
    (
        "the replay action drops its own authorization check",
        "app/admin/operations/actions.ts",
        '  const actorId = await assertPlatformAdmin("webhook.replay");',
        '  const actorId = "operator";',
    ),
    (
        "the check runs after the replay instead of before",
        "app/admin/operations/actions.ts",
        '  const actorId = await assertPlatformAdmin("webhook.replay");',
        '  const actorId = "operator";  // moved below',
        # a second edit puts the guard after the work
        ('  revalidatePath("/admin/operations");',
         '  await assertPlatformAdmin("webhook.replay");\n  revalidatePath("/admin/operations");'),
    ),
    (
        "the guard redirects instead of throwing",
        "lib/platformAdmin.ts",
        '    throw new Error("You don\'t have permission to do this.");',
        '    redirect("/dashboard");',
    ),
    (
        "the refusal is not recorded",
        "lib/platformAdmin.ts",
        "    await recordSignal({",
        "    await Promise.resolve({",
    ),
    (
        "the stale-replay sweep is dropped from the cron",
        "app/api/cron/sync/route.ts",
        '  await withCorrelation({ origin: "cron", surface: "staleReplays" }, () =>\n    releaseStaleReplays(),\n  ).catch((error) => {',
        '  await Promise.resolve().then(() =>\n    undefined,\n  ).catch((error) => {',
    ),
    (
        "replay claims a provider it cannot actually run",
        "lib/webhooks/replayHandlers.ts",
        "  return handlers;",
        "  handlers.STRIPE = async () => {};\n  return handlers;",
    ),
]


def run_suite() -> bool:
    """True when the suite passes."""
    out = os.path.join(tempfile.gettempdir(), "sabotage-op.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts operator-surface-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False
    return "0 failed," in text and "1/1 database-backed suites pass." in text


def main() -> int:
    print("Confirming the suite is green before breaking anything...")
    if not run_suite():
        print("ABORT — the suite is not green to begin with. Nothing below would mean anything.")
        return 1
    print("  green.\n")

    unproven = []
    for entry in BREAKS:
        name, path, old, new = entry[0], entry[1], entry[2], entry[3]
        extra = entry[4] if len(entry) > 4 else None
        full = os.path.join(ROOT, path)
        original = io.open(full, encoding="utf-8", newline="").read()
        # SOME FILES ARE CRLF, and a multi-line anchor written with \n never
        # matched one. The first run reported "anchor not found" rather than
        # quietly passing, which is exactly why that check is here.
        crlf = "\r\n" in original
        source = original.replace("\r\n", "\n")

        # ASSERT THE EDIT APPLIES. A miss here previously let two breaks look
        # like passes, so a missing anchor is a hard failure, not a skip.
        if old not in source:
            print(f"BROKEN SABOTAGE  {name} — anchor not found in {path}")
            unproven.append(f"{name} (anchor missing)")
            continue

        broken = source.replace(old, new, 1)
        if extra:
            if extra[0] not in broken:
                print(f"BROKEN SABOTAGE  {name} — second anchor not found in {path}")
                unproven.append(f"{name} (second anchor missing)")
                continue
            broken = broken.replace(extra[0], extra[1], 1)
        assert broken != source
        if crlf:
            broken = broken.replace("\n", "\r\n")

        io.open(full, "w", encoding="utf-8", newline="").write(broken)
        try:
            still_green = run_suite()
        finally:
            io.open(full, "w", encoding="utf-8", newline="").write(original)

        if still_green:
            print(f"NOT PROVEN  {name} — the suite stayed green")
            unproven.append(name)
        else:
            print(f"caught      {name}")

    print()
    if unproven:
        print(f"{len(unproven)} of {len(BREAKS)} breaks were NOT caught:")
        for u in unproven:
            print(f"  - {u}")
        return 1
    print(f"All {len(BREAKS)} breaks were caught.")
    return 0


sys.exit(main())
