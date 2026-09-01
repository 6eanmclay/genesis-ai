"""Break order search and the packing slip, and confirm the suites catch it.

    python scripts/sabotage-order-search.py

The protection that matters most is store scoping. A search that could return
another business's order would be worse than no search: it would show one
merchant another's customer, by name and email, in a list that looks like their
own. Three separate breaks attack it — the main filter, the raw name query's
own WHERE, and the join that brings name matches back.

The rest protect a merchant's ability to actually find the thing. A search that
only matches the order row misses the second product in a bag. One that is
case-sensitive fails on the most natural thing anybody types — a name. One with
no floor returns everything for a single keystroke.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEARCH = os.path.join(ROOT, "lib", "orders", "orderSearch.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (SEARCH, "the search is not scoped to the business", [
        ("      storeId,\n      OR: [", "      OR: ["),
    ]),
    (SEARCH, "the name lookup is not scoped to the business", [
        ('     WHERE "storeId" = ${storeId}\n       AND', "     WHERE"),
    ]),
    (SEARCH, "a name match from another business is joined back in", [
        ("    SELECT \"id\" FROM \"Order\"\n     WHERE \"storeId\" = ${storeId}\n       AND \"shippingAddress\"->>'name' ILIKE ${`%${trimmed}%`}",
         "    SELECT \"id\" FROM \"Order\"\n     WHERE \"shippingAddress\"->>'name' ILIKE ${`%${trimmed}%`}"),
    ]),
    (SEARCH, "the line items stop being searched, hiding the second product", [
        ("        { items: { some: { productName: contains } } },\n", ""),
    ]),
    (SEARCH, "searching a name becomes case-sensitive again", [
        ("\"shippingAddress\"->>'name' ILIKE ${`%${trimmed}%`}",
         "\"shippingAddress\"->>'name' LIKE ${`%${trimmed}%`}"),
    ]),
    (SEARCH, "the tracking number stops being searchable", [
        ("        { trackingNumber: contains },\n", ""),
    ]),
    (SEARCH, "one keystroke searches everything", [
        ("  if (trimmed.length < MIN_QUERY_LENGTH) {", "  if (false) {"),
    ]),
    (SEARCH, "the cap stops being reported, so a partial page looks complete", [
        ("  const more = rows.length > limit;", "  const more = false;"),
    ]),
    (SEARCH, "why a row matched is decided by the vaguest field first", [
        ('  if (row.id.toLowerCase().includes(q)) return "order id";',
         '  if (row.productName.toLowerCase().includes(q)) return "product";\n  if (row.id.toLowerCase().includes(q)) return "order id";'),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-os.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts order-search-db --verbose",
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
    originals = {SEARCH: read(SEARCH)}
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
