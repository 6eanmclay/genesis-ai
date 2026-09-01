"""Break the recovery path and confirm verify-restore.ts notices.

    python scripts/sabotage-restore.py

This check exists because EXTERNAL_BLOCKERS.md E6 has said, since it was
written, that "the only rollback for a destructive migration is a restore
whose viability nobody has tested". A check that could not fail would leave
that sentence just as true while appearing to answer it.

So the breaks are the ways a recovery path actually rots:

  * the schema stops describing an index the migrations really create, which
    is the exact drift the first run of this check found on production;
  * a constraint name stops matching what Postgres truncated it to;
  * a migration stops applying at all;
  * and the harness-table filter widens until it would swallow real drift,
    which is the one failure that would make this whole check dishonest.

Note it runs the slowest suite in the repository — an empty Postgres and a
full replay per break — so it is deliberately short.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "prisma", "schema.prisma")
CHECK = os.path.join(ROOT, "scripts", "verify-restore.ts")
MIGRATION = os.path.join(ROOT, "prisma", "migrations", "20260820070000_active_business", "migration.sql")

# (file, name, [(find, replace), ...])
BREAKS = [
    (SCHEMA, "the schema forgets an index the migrations really create", [
        ("  @@index([activeStoreId])\n", ""),
    ]),
    (SCHEMA, "a constraint name stops matching what Postgres truncated it to", [
        ('map: "SupplierEconomics_storeId_sourceKey_externalProductId_extern_ke"',
         'map: "SupplierEconomics_storeId_sourceKey_externalProductId_exter_key"'),
    ]),
    (MIGRATION, "a migration no longer applies", [
        ('CREATE INDEX "User_activeStoreId_idx" ON "User" ("activeStoreId");',
         'CREATE INDEX "User_activeStoreId_idx" ON "User" ("no_such_column");'),
    ]),
    (CHECK, "the harness filter widens until it would swallow real drift", [
        ('    .filter((block) => block.trim() && !block.includes(HARNESS_ONLY))',
         '    .filter((block) => block.trim() && !block.includes("["))'),
    ]),
]


def run_check():
    out = os.path.join(tempfile.gettempdir(), "sabotage-restore.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/verify-restore.ts",
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
    paths = {SCHEMA, CHECK, MIGRATION}
    originals = {path: read(path) for path in paths}
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

            if "0 failed," not in run_check():
                caught += 1
                print("CAUGHT  %s" % name)
            else:
                missed.append((name, "the check still passed"))
                print("MISSED  %s" % name)

            write(path, original)
    finally:
        for path, text in originals.items():
            write(path, text)
        # The client was regenerated from a broken schema during the run.
        subprocess.run(["npx", "prisma", "generate"], cwd=ROOT, capture_output=True, shell=True)

    print("\n%d of %d breaks caught" % (caught, len(BREAKS)))
    for name, why in missed:
        print("  MISSED: %s — %s" % (name, why))
    sys.exit(0 if not missed else 1)


main()
