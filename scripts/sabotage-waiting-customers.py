"""Break each honesty rule in the waiting-customers card and confirm it fails.

    python scripts/sabotage-waiting-customers.py

This card tells an owner that a real person has paid and is waiting. Almost
every way it can be wrong is a way of blurring four facts that look alike, and
obligations.ts spells them out:

    money arrived           status "paid"
    money went back         status "refunded" — NO package is owed
    the owner's own record  fulfillmentStatus, never evidence about a parcel
    a label was bought      real money spent on postage; not delivery

So the breaks below are those conflations, plus the two rules the module
inherits: no threshold, and never "you have not shipped this".

Counting refunded orders as owed would tell a merchant to post goods for money
they have already given back. Saying "you have not shipped this" would accuse
somebody of neglecting a customer whose parcel they posted on Tuesday. Both
must turn the suite red.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARD = os.path.join(ROOT, "lib", "dashboard", "waitingCustomers.ts")
ATTENTION = os.path.join(ROOT, "lib", "dashboard", "needsAttention.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (ATTENTION, "the card never reaches the owner's attention list", [
        ("    ...waitingCustomers,\n", ""),
    ]),
    (CARD, "a shop with nothing outstanding is told something anyway", [
        ("  if (obligations.outstandingCount === 0) return [];",
         "  if (false) return [];"),
    ]),
    (CARD, "refunded orders are counted as owed to somebody", [
        ("  const count = obligations.outstandingCount;",
         "  const count = obligations.outstandingCount + obligations.refundedUnfulfilledCount;"),
    ]),
    (CARD, "it accuses the owner of not having shipped", [
        ('      ? `${obligations.outstanding[0].productName} is waiting to go out`',
         '      ? `You have not shipped ${obligations.outstanding[0].productName}`'),
    ]),
    (CARD, "an old order is called late", [
        ('        : ` The oldest has been waiting ${oldest} ${oldest === 1 ? "day" : "days"}.`;',
         '        : ` The oldest is ${oldest > 7 ? "late" : `waiting ${oldest} days`}.`;'),
    ]),
    (CARD, "waiting a long time is escalated to a failure", [
        ('      severity: "WARNING",',
         '      severity: (oldest ?? 0) > 7 ? "FAILED" : "WARNING",'),
    ]),
    (CARD, "a bought label is described as delivery", [
        ('? " The oldest came in today."', '? " The oldest was delivered today."'),
    ]),
    (CARD, "the card loses its destination", [
        ('      actionHref: "/dashboard/orders",', "      actionHref: undefined,"),
    ]),
    (CARD, "the card's identity stops depending on how many are waiting", [
        ('      id: `waiting:${count}:${oldest ?? "none"}`,', "      id: `waiting`,"),
    ]),
    (CARD, "it counts the orders itself instead of asking obligations", [
        ("  const obligations = await getObligations(storeId);",
         "  const { prismaSystem } = await import('@/lib/prisma');\n"
         "  const obligations = await getObligations(storeId);\n"
         "  void prismaSystem;"),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-wc.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts waiting-customers-db --verbose",
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
    originals = {CARD: read(CARD), ATTENTION: read(ATTENTION)}
    caught, missed = 0, []

    try:
        for path, name, edits in BREAKS:
            original = originals[path]
            broken = original.replace("\r\n", "\n")
            if any(find not in broken for find, _ in edits):
                missed.append((name, "the break no longer applies — the code moved"))
                print("SKIP    %s" % name)
                continue
            for find, replace in edits:
                broken = broken.replace(find, replace, 1)
            write(path, broken.replace("\n", "\r\n") if "\r\n" in original else broken)

            if "0 failed," not in run_suite():
                caught += 1
                print("CAUGHT  %s" % name)
            else:
                missed.append((name, "the suite still passed"))
                print("MISSED  %s" % name)

            write(path, original)
    finally:
        for path, text in originals.items():
            write(path, text)

    print("\n%d of %d breaks caught" % (caught, len(BREAKS)))
    for name, why in missed:
        print("  MISSED: %s — %s" % (name, why))
    sys.exit(0 if not missed else 1)


main()
