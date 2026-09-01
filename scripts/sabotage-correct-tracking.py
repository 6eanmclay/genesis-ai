"""Break the tracking-correction guards and confirm the suite catches it.

    python scripts/sabotage-correct-tracking.py

A correction path that is too permissive is worse than not having one. The
original refusal — attachTracking will not replace a number — protected a real
thing: a buyer refreshing a tracking page. Correcting is allowed only while
nobody outside Genesis has committed to the old number, and every break below
removes one of the conditions that makes that true.

Two of them matter most. Dropping the shipmentNotifiedAt check would let a
merchant silently swap a number a customer is watching. Dropping labelUrl would
let a hand-typed number overwrite one the carrier issued and holds the parcel
under, making Genesis disagree with the carrier — and the carrier is right.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORRECT = os.path.join(ROOT, "lib", "execution", "executables", "correctTracking.ts")
ATTACH = os.path.join(ROOT, "lib", "execution", "executables", "attachTracking.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (CORRECT, "a number the customer is already following can be swapped", [
        ("    if (order.shipmentNotifiedAt) {", "    if (false) {"),
        ("        shipmentNotifiedAt: null,\n", ""),
    ]),
    (CORRECT, "a carrier-issued number can be overwritten by hand", [
        ("    if (order.labelUrl) {", "    if (false) {"),
        ("        labelUrl: null,\n", ""),
    ]),
    (CORRECT, "correcting an order that has no tracking invents one", [
        ("    if (!order.trackingNumber) {", "    if (false) {"),
    ]),
    (CORRECT, "an implausible number is accepted", [
        ("    if (!isPlausibleTrackingNumber(trackingNumber)) {", "    if (false) {"),
    ]),
    (CORRECT, "the write stops being conditional on what was read", [
        ("        trackingNumber: previousTrackingNumber,\n", ""),
    ]),
    (CORRECT, "it is not scoped to the business", [
        ("      where: { id: input.orderId, storeId: ctx.storeId },",
         "      where: { id: input.orderId },"),
    ]),
    (CORRECT, "a correction silently marks the order fulfilled", [
        ("        trackingUrl: trackingUrlFor(carrier, trackingNumber),\n      },",
         '        trackingUrl: trackingUrlFor(carrier, trackingNumber),\n        fulfillmentStatus: "fulfilled",\n      },'),
    ]),
    (CORRECT, "the tracking link keeps pointing at the old number", [
        ("        trackingUrl: trackingUrlFor(carrier, trackingNumber),",
         "        trackingUrl: trackingUrlFor(carrier, previousTrackingNumber),"),
    ]),
    (ATTACH, "attaching starts silently replacing again", [
        ("    if (order.trackingNumber) {", "    if (false) {"),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-ct.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts correct-tracking-db --verbose",
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
    originals = {path: read(path) for path in {CORRECT, ATTACH}}
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
