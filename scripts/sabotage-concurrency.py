"""Remove each concurrency guard and watch the double appear.

This is the pass that has never been possible. The database lane runs on PGlite,
which serialises concurrent clients, so a removed claim guard changed nothing
observable — verify-jobs-db passes to this day with its guard removed and says
so in the file.

On real PostgreSQL with real parallel connections, removing each guard must
produce the exact failure it exists to prevent: two runners claiming one job,
one external effect performed twice, two rows for one provider event, a balance
driven below zero.

    python scripts/sabotage-concurrency.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

QUEUE = "lib/jobs/queue.ts"
ONCE = "lib/outbound/runOnce.ts"
DELIVERY = "lib/webhooks/delivery.ts"
LEDGER = "lib/growthPoints/ledger.ts"

BREAKS = [
    # ---- 1. the job claim ----
    # Anchored on the CLAIM — the updateMany WHERE — not on the candidate
    # search. The first version broke the findMany instead, which made the
    # update match nothing and produced "0 runners claimed it": proof the line
    # is load-bearing, but not proof it prevents a DOUBLE, which is the whole
    # property. Removing the status from the claim lets both racers match by id.
    (
        "the job claim stops being conditional",
        QUEUE,
        '          ? { id: candidate.id, status: "pending" }',
        "          ? { id: candidate.id }",
    ),
    # The claim is that a losing create THROWS and the catch answers without
    # performing. Making the loser perform anyway is the double this guard
    # exists to prevent, and it is one line.
    # Anchored on the CATCH's return, which is the loser's path. An earlier
    # version replaced the first of three identical returns and landed in a
    # different branch, so it changed nothing and reported the suite as weak.
    (
        "a caller that loses the runOnce claim performs anyway",
        ONCE,
        "    if (row?.status === \"succeeded\") {\n      return { status: \"replayed\", result: row.result as T, externalRef: row.externalRef };\n    }\n    return { status: \"in_progress\" };",
        "    return perform(row!.id, input, now);",
    ),
    # ---- 4. the Growth Point reservation ----
    #
    # NOT BROKEN HERE, and the reason is a finding rather than an omission.
    # Removing the conditional WHERE left the suite green, because the read
    # and the plan happen INSIDE the transaction and the row lock serialises
    # the racers: the second transaction's findUnique sees the balance the
    # first one committed, planDeduction returns uncharged_shortfall, and no
    # second charge is ever attempted.
    #
    # So the conditional update is belt-and-braces beneath a transaction that
    # already refuses, and it cannot be independently proven while that
    # transaction stands. Kept, and recorded honestly, rather than removed
    # because a test could not see it or pretended to prove it.
    # ---- 3. the delivery collision ----
    (
        "a delivery race hands the loser null again",
        DELIVERY,
        "    if (isUniqueViolation(error) && input.externalEventId) {",
        "    if (false) {",
    ),
    (
        "the loser of a delivery race is given no id",
        DELIVERY,
        "        return { id: winner.id, duplicate: true };",
        "        return null;",
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-cc.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/verify-concurrency-live.ts",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text
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
