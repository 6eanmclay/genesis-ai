"""Break each authorization protection and confirm the suite catches it.

    python scripts/sabotage-fetch-then-authorize.py

Two things are being proven, and they fail in different ways.

The FIX: the public receipt page must scope its order lookup to the shop named
in the URL. Reverting it to the bare `findUnique({ where: { id: orderId } })`
is the exact code that shipped before this sweep, and the suite must go red.

The GUARD: lib/tenantIsolation.ts must actually refuse an unscoped write on the
seven models added to its map. Removing an entry, or widening the operation
sets, must be caught — otherwise the map is decoration and the cross-check is
asserting the contents of a list rather than a protection.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "app", "store", "[slug]", "success", "page.tsx")
GUARD = os.path.join(ROOT, "lib", "tenantIsolation.ts")
LEDGER = os.path.join(ROOT, "lib", "storage", "ledger.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (PAGE, "the receipt page goes back to looking an order up by id alone", [
        ("    const order = store\n"
         "      ? await prisma.order.findFirst({ where: { id: orderId, storeId: store.id } })\n"
         "      : null;",
         "    const order = await prisma.order.findUnique({ where: { id: orderId } });"),
    ]),
    (PAGE, "the receipt page scopes to a store it never checked", [
        ("where: { id: orderId, storeId: store.id }", "where: { id: orderId }"),
    ]),
    (GUARD, "storageObject is dropped from the guard's model map", [
        ('  storageObject: ["storeId"],', ""),
    ]),
    (GUARD, "temporaryAsset is dropped from the guard's model map", [
        ('  temporaryAsset: ["storeId"],', ""),
    ]),
    (GUARD, "the guard stops treating updateMany as a mutation", [
        ('export const GUARDED_MUTATION_OPERATIONS = new Set(["update", "delete", "updateMany", "deleteMany"]);',
         'export const GUARDED_MUTATION_OPERATIONS = new Set(["update", "delete", "deleteMany"]);'),
    ]),
    (GUARD, "the guard stops treating findMany as a collection read", [
        ('export const GUARDED_READ_OPERATIONS = new Set(["findMany", "count", "aggregate", "groupBy"]);',
         'export const GUARDED_READ_OPERATIONS = new Set(["count", "aggregate", "groupBy"]);'),
    ]),
    (LEDGER, "the batch touch goes back to having no business in its filter", [
        ("where: { batchId: row.batchId, storeId: input.storeId, uploadedAt: null },",
         "where: { batchId: row.batchId, uploadedAt: null },"),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-fta.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts fetch-then-authorize-db --verbose",
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
    originals = {path: read(path) for path in {PAGE, GUARD, LEDGER}}
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
