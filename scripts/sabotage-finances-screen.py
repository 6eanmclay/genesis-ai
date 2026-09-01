"""Break the money screen's honesty rules and confirm the suite catches it.

    python scripts/sabotage-finances-screen.py

This screen tells a merchant about their own money, so every break below is a
way of telling them something that is not true.

The first is the one Sean named explicitly: never calculate or invent a next
payout date. Stripe exposes no such field, so a date derived from the schedule
would read as a promise, be a guess about somebody's money, and be wrong every
bank holiday.

The rest protect the same class of lie. Reporting an unreachable provider as
zero, or an unconnected one, tells a merchant they have no money when the truth
is that Genesis does not know. Turning Stripe's own payout status into a
Genesis word means the screen and the Stripe dashboard disagree about the same
payout. Carrying more than four digits of a bank account puts details on a
screen that has no reason to hold them. And any write at all would make a
read-only surface something else entirely.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRESENTATION = os.path.join(ROOT, "lib", "payments", "financials", "presentation.ts")
SCREEN = os.path.join(ROOT, "app", "dashboard", "finances", "Finances.tsx")
ROUTE = os.path.join(ROOT, "app", "b", "[slug]", "finances", "page.tsx")

# (file, name, [(find, replace), ...])
BREAKS = [
    (PRESENTATION, "a next payout date is calculated from the schedule", [
        ('    return "Stripe has no payout on the way right now.";',
         '    return "Your next payout is due Friday.";'),
    ]),
    (PRESENTATION, "an absent payout is described as one that is coming", [
        ('    return "Stripe has no payout on the way right now.";',
         '    return "A payout will arrive soon.";'),
    ]),
    (PRESENTATION, "an unreachable provider is reported as zero", [
        ('      return `Stripe could not be reached just now, so these figures are missing rather than zero. ${detail}`;',
         '      return "Your balance is $0.00.";'),
    ]),
    (PRESENTATION, "a business on an unreadable rail is called disconnected", [
        ("      return detail;",
         "      return \"No payment provider is connected to this business yet, so there is nothing to show.\";"),
    ]),
    (PRESENTATION, "an unknown payout status is treated as settled", [
        ('  if (status === "paid") return "settled";',
         '  if (status !== "failed" && status !== "canceled") return "settled";'),
    ]),
    (PRESENTATION, "a destination carries more than four digits", [
        ("  return destination.last4 ? `${bank} ending ${destination.last4}` : bank;",
         "  return destination.last4 ? `${bank} ${destination.kind} ${destination.last4}` : bank;"),
    ]),
    (PRESENTATION, "an absent destination is invented", [
        ('  if (!destination) return "Stripe did not say where this went.";',
         '  if (!destination) return "Your bank account";'),
    ]),
    (PRESENTATION, "the three kinds of money stop being named apart", [
        ('  "What a customer paid is not what Stripe holds, and what Stripe holds is not what has reached your bank.";',
         '  "Here is your money.";'),
    ]),
    (SCREEN, "the screen builds its own Stripe client", [
        ('import { financialsForStore } from "@/lib/payments/financials";',
         'import Stripe from "stripe";\nimport { financialsForStore } from "@/lib/payments/financials";'),
    ]),
    (ROUTE, "the business route stops requiring a permission", [
        ("PERMISSIONS.REVENUE_VIEW", "PERMISSIONS.ORDERS_VIEW"),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-fs.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts finances-screen-db --verbose",
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
    originals = {path: read(path) for path in {PRESENTATION, SCREEN, ROUTE}}
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
