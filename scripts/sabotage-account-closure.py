"""Break each protection in account closure and confirm the suite catches it.

    python scripts/sabotage-account-closure.py

A suite that passes proves nothing on its own — it may be asserting something
that cannot fail. Each break below is a plausible mistake somebody could make
in this code, and the run is only meaningful if every one of them turns the
suite red.

The first break is the one that matters most: it makes closure delete the user
row, which is the exact implementation this whole design exists to avoid, and
which the schema's cascade turns into the loss of every order.

============ A BREAK CAN ITSELF FAIL TO BE A BREAK ====================

Each entry carries a LIST of edits rather than one. The "audit record carries
the erased email" break needed that: the first version injected
`existing.email` into the signal, but `existing` is selected with `id` and
`closedAt` only — so it planted `undefined`, the suite stayed green, and it
looked like a weak assertion when it was a weak break. It now widens the select
first, so the email is genuinely there to leak.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLOSURE = os.path.join(ROOT, "lib", "account", "closure.ts")
EXPORT = os.path.join(ROOT, "lib", "account", "export.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (CLOSURE, "closure deletes the user row instead of anonymising it", [
        ("  const removed = await prisma.$transaction(async (tx) => {",
         "  await prisma.user.delete({ where: { id: userId } });\n"
         "  const removed = await prisma.$transaction(async (tx) => {"),
    ]),
    (CLOSURE, "the email is left in place", [
        ("        email: closedEmailFor(userId),", ""),
    ]),
    (CLOSURE, "the name is left in place", [
        ("        name: null,", ""),
    ]),
    (CLOSURE, "the password hash survives the closure", [
        ("        password: null,", ""),
    ]),
    (CLOSURE, "the two-factor secret survives the closure", [
        ("        totpSecret: null,", ""),
    ]),
    (CLOSURE, "the referral code still points at the person", [
        ("        referralCode: null,", ""),
    ]),
    (CLOSURE, "sessions are not revoked", [
        ("    const sessions = (await tx.session.deleteMany({ where: { userId } })).count;",
         "    const sessions = 1;"),
    ]),
    (CLOSURE, "OAuth tokens survive the closure", [
        ("    const oauthAccounts = (await tx.account.deleteMany({ where: { userId } })).count;",
         "    const oauthAccounts = 1;"),
    ]),
    (CLOSURE, "recovery codes survive the closure", [
        ("    const recoveryCodes = (await tx.recoveryCode.deleteMany({ where: { userId } })).count;",
         "    const recoveryCodes = 1;"),
    ]),
    (CLOSURE, "closure is not idempotent — a retry overwrites the original record", [
        ("  if (existing.closedAt) {", "  if (false) {"),
    ]),
    (CLOSURE, "the deletes are not scoped to the account being closed", [
        ("    const sessions = (await tx.session.deleteMany({ where: { userId } })).count;",
         "    const sessions = (await tx.session.deleteMany({})).count;"),
    ]),
    (CLOSURE, "the audit record carries the erased email and name", [
        ("    select: { id: true, closedAt: true },",
         "    select: { id: true, closedAt: true, email: true, name: true },"),
        ("    detail: { userId, reason: reason.slice(0, 200), businesses, orders, ...removed },",
         "    detail: { userId, erasedEmail: existing.email, erasedName: existing.name,"
         " reason: reason.slice(0, 200), businesses, orders, ...removed },"),
    ]),
    (CLOSURE, "nothing is recorded at all", [
        ("  await recordSignal({", "  if (false) await recordSignal({"),
    ]),
    (EXPORT, "the export hands back the encrypted provider credentials", [
        ("        await prismaSystem.storeIntegration.findMany({ where, select: { provider: true, status: true } })",
         "        await prismaSystem.storeIntegration.findMany({ where })"),
    ]),
    (EXPORT, "the export is not scoped to the person's own businesses", [
        ("  const stores = await prisma.store.findMany({\n    where: { userId },",
         "  const stores = await prisma.store.findMany({\n    where: {},"),
    ]),
    (EXPORT, "a relation is added to Store with nobody deciding whether it is exported", [
        ('  { model: "Product", disposition: "included" },', ""),
    ]),
    (EXPORT, "an exclusion is left without a reason", [
        ('    reason: "Queued internal work. The effects are exported; the queue rows are not.",',
         '    reason: "n/a",'),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-ac.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts account-closure-db --verbose",
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
    originals = {path: read(path) for path in {CLOSURE, EXPORT}}
    caught, missed = 0, []

    try:
        for path, name, edits in BREAKS:
            text = originals[path]
            broken = text.replace("\r\n", "\n")

            # A break whose anchor has moved is reported, never skipped
            # silently — an inapplicable break is an unproven assertion.
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
        # Whatever happened, the tree goes back. A sabotage run that leaves a
        # break behind is worse than one that never ran.
        for path, text in originals.items():
            write(path, text)

    print("\n%d of %d breaks caught" % (caught, len(BREAKS)))
    for name, why in missed:
        print("  MISSED: %s — %s" % (name, why))
    sys.exit(0 if not missed else 1)


main()
