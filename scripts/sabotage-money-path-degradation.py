"""Break the money path's failure behaviour and confirm the suite catches it.

    python scripts/sabotage-money-path-degradation.py

The question this suite asks is narrow: when a dependency fails, is money ever
taken without an order being recorded, or an order recorded without money.

So the breaks are the ways that could start happening.

The first two matter most, because they undo the fix this item produced. Both
webhook rails used to handle an event whose delivery could not be recorded —
the handler ran, markProcessed(null) did nothing, and an event that moved real
money left no trace it had arrived. Removing either guard must turn the suite
red, or the fix is decoration.

Two more protect distinctions that duplicate orders when they blur: a thrown
call is FAILED and safe to retry, an abandoned claim is INDETERMINATE and must
never be retried automatically. And the last two protect the money path's
independence — the day checkout imports the model, or the storefront starts
fetching blobs server-side, an outage in something that does not take payments
starts costing sales.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STRIPE_ROUTE = os.path.join(ROOT, "app", "api", "webhooks", "stripe", "route.ts")
PAYPAL_ROUTE = os.path.join(ROOT, "app", "api", "webhooks", "paypal", "[storeId]", "route.ts")
RUNONCE = os.path.join(ROOT, "lib", "outbound", "runOnce.ts")
CHECKOUT = os.path.join(ROOT, "app", "store", "[slug]", "actions.ts")
STOREFRONT = os.path.join(ROOT, "app", "store", "[slug]", "page.tsx")

# (file, name, [(find, replace), ...])
BREAKS = [
    (STRIPE_ROUTE, "the Stripe rail handles an event it could not record", [
        ("  if (!delivery) {", "  if (false) {"),
    ]),
    (PAYPAL_ROUTE, "the PayPal rail handles an event it could not record", [
        ("  if (!delivery) {", "  if (false) {"),
    ]),
    (STRIPE_ROUTE, "an unrecordable delivery answers 200, so Stripe stops retrying", [
        ('return new Response("Could not record delivery", { status: 500 });',
         'return new Response("ok", { status: 200 });'),
    ]),
    (RUNONCE, "an abandoned claim is retried, so the provider may be called twice", [
        ('    if (existing.status === "indeterminate") {', "    if (false) {"),
    ]),
    (RUNONCE, "a thrown call is recorded as indeterminate, so a safe retry never happens", [
        ('      data: { status: "failed", lastError: message, claimedAt: null, claimedBy: null },',
         '      data: { status: "indeterminate", lastError: message, claimedAt: null, claimedBy: null },'),
        ('    return { status: "failed", error: message };',
         '    return { status: "indeterminate", key: input.key, operation: input.operation };'),
    ]),
    (CHECKOUT, "checkout starts depending on the Genesis model", [
        ('import { redirect, unstable_rethrow } from "next/navigation";',
         'import { redirect, unstable_rethrow } from "next/navigation";\nimport { genesisModel } from "@/lib/genesisModel";'),
    ]),
    (STOREFRONT, "the storefront starts fetching blobs to render", [
        ("import ", 'import { vercelBlobStorage } from "@/lib/storage/vercelBlob";\nimport '),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-mpd.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts money-path-degradation-db --verbose",
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
    paths = {STRIPE_ROUTE, PAYPAL_ROUTE, RUNONCE, CHECKOUT, STOREFRONT}
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
