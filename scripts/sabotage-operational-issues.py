"""Break each visibility protection and confirm the suite catches it.

    python scripts/sabotage-operational-issues.py

Three separate things are being proven here, and they fail differently.

VISIBILITY: the owner must actually be told. Dropping a condition from the
reader, or failing to wire the reader into the dashboard's own attention path,
must turn the suite red — otherwise the join is asserted rather than working.

ISOLATION: one business's failure must never appear on another's dashboard, and
platform maintenance (a null storeId) must appear on nobody's. "No store" and
"every store" are one typo apart, so both directions are broken here.

RESTRAINT: an unsigned delivery, a freshly-locked job, and the operator's own
conditions must stay off a merchant's dashboard. A card that cries wolf is
worse than no card, so widening the reader must fail too.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
READER = os.path.join(ROOT, "lib", "dashboard", "operationalIssues.ts")
ATTENTION = os.path.join(ROOT, "lib", "dashboard", "needsAttention.ts")
CARDS = os.path.join(ROOT, "lib", "dashboard", "attentionCards.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (ATTENTION, "the reader is never wired into the owner's attention path", [
        ("    ...operationalIssues,\n", ""),
    ]),
    (CARDS, "the card drops the destination again, exactly as it used to", [
        ("      actionHref: item.actionHref,\n", ""),
    ]),
    (READER, "dead-lettered jobs stop being reported to the owner", [
        ('      where: { storeId, status: "dead", updatedAt: { gte: since } },',
         '      where: { storeId, status: "dead", updatedAt: { gte: new Date() } },'),
    ]),
    (READER, "an unknown external outcome stops being reported", [
        ('      where: { storeId, status: "indeterminate", createdAt: { gte: since } },',
         '      where: { storeId, status: "impossible", createdAt: { gte: since } },'),
    ]),
    (READER, "a failed provider delivery stops being reported", [
        ('      where: { storeId, status: "failed", signatureValid: true, receivedAt: { gte: since } },',
         '      where: { storeId, status: "impossible", signatureValid: true, receivedAt: { gte: since } },'),
    ]),
    (READER, "a stalled job stops being reported", [
        ('      where: { storeId, status: "running", lockedAt: { lt: stalledBefore } },',
         '      where: { storeId, status: "running", lockedAt: { lt: new Date(0) } },'),
    ]),
    (READER, "every business sees every other business's failures", [
        ('      where: { storeId, status: "dead", updatedAt: { gte: since } },',
         '      where: { status: "dead", updatedAt: { gte: since } },'),
    ]),
    (READER, "platform maintenance is shown to a merchant as their problem", [
        ('      where: { storeId, status: "dead", updatedAt: { gte: since } },',
         '      where: { OR: [{ storeId }, { storeId: null }], status: "dead", updatedAt: { gte: since } },'),
    ]),
    (READER, "an unsigned delivery is shown to the merchant as a lost order", [
        ("signatureValid: true, receivedAt: { gte: since } },",
         "receivedAt: { gte: since } },"),
    ]),
    (READER, "a job locked seconds ago is called stalled", [
        ("  const stalledBefore = new Date(Date.now() - STALL_MS);",
         "  const stalledBefore = new Date(Date.now() + STALL_MS);"),
    ]),
    (READER, "the owner is shown the internal job kind instead of what happened", [
        ("      message: meaning\n"
         "        ? `We tried several times and could not finish ${meaning.affects}. ${meaning.whatToDo}`\n"
         "        : \"Something we were doing for you failed repeatedly and has stopped. We have been told about it.\",",
         "      message: `Job ${job.kind} failed`,"),
    ]),
    (READER, "the dead-letter card stops saying what the owner can do", [
        ('    whatToDo: "Check the order and contact the customer yourself so they are not left waiting.",',
         '    whatToDo: "",'),
    ]),
    (READER, "the unknown-outcome card tells them to just send it again", [
        ('      whatToDo: "We do not know whether it arrived. Check with the customer before sending it again.",',
         '      whatToDo: "Send it again.",'),
    ]),
    (READER, "the card loses its destination", [
        ('    href: "/dashboard/orders",\n  },\n};', '    href: "",\n  },\n};'),
    ]),
    (READER, "messages carry a row id, so three failures become three cards", [
        ("      id: `job-dead:${job.id}`,\n"
         "      kind: \"operational-failure\",\n"
         "      severity: \"FAILED\",\n"
         "      message: meaning",
         "      id: `job-dead:${job.id}`,\n"
         "      kind: \"operational-failure\",\n"
         "      severity: \"FAILED\",\n"
         "      message: job.id + (meaning"),
        ("        : \"Something we were doing for you failed repeatedly and has stopped. We have been told about it.\",",
         "        : \"Something we were doing for you failed repeatedly and has stopped. We have been told about it.\"),"),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-oi.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts operational-issues-db --verbose",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        with io.open(out, encoding="utf-16-le", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def read(path):
    with io.open(path, encoding="utf-8", newline="") as fh:
        return fh.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def main():
    originals = {path: read(path) for path in {READER, ATTENTION, CARDS}}
    caught, missed = 0, []

    try:
        for path, name, edits in BREAKS:
            text = originals[path]
            broken = text.replace("\r\n", "\n")
            if any(find not in broken for find, _ in edits):
                missed.append((name, "the break no longer applies — the code moved"))
                print("SKIP    %s" % name)
                continue
            for find, replace in edits:
                broken = broken.replace(find, replace, 1)
            write(path, broken.replace("\n", "\r\n") if "\r\n" in text else broken)

            if "0 failed," not in run_suite():
                caught += 1
                print("CAUGHT  %s" % name)
            else:
                missed.append((name, "the suite still passed"))
                print("MISSED  %s" % name)

            write(path, text)
    finally:
        for path, text in originals.items():
            write(path, text)

    print("\n%d of %d breaks caught" % (caught, len(BREAKS)))
    for name, why in missed:
        print("  MISSED: %s — %s" % (name, why))
    sys.exit(0 if not missed else 1)


main()
