"""Break the merchant's new-sale notice and confirm the suite catches it.

    python scripts/sabotage-merchant-sale-notice.py

The notice exists so a merchant learns they have work to do. Every break below
is a way it could go back to being lost or wrong:

  * the backstop disappears, which is the state this work found — the notice
    was sent inline and nothing retried it;
  * it fires for money that went back, congratulating a merchant on a refund;
  * it stops being idempotent, so a merchant is told twice about one sale;
  * it sends before an email provider is configured, which Sean ruled out;
  * it claims the order without sending, losing the notice permanently;
  * the link rots into something that 404s, or points at the ambient route
    that opens whichever business the account last had active.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SWEEP = os.path.join(ROOT, "lib", "orders", "notificationSweep.ts")
NOTIFY = os.path.join(ROOT, "lib", "orders", "notifyOwnerOfSale.ts")
ORIGIN = os.path.join(ROOT, "lib", "email", "origin.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (SWEEP, "the backstop disappears and the notice is inline-only again", [
        ('    if (await enqueueNotification({ orderId: order.id, storeId: order.storeId, kind: "ownerSale" })) {\n'
         "      result.ownerSales++;\n"
         "    }",
         "    void order;"),
    ]),
    (SWEEP, "a merchant is congratulated on money that went back", [
        ('    where: { ownerNotifiedAt: null, status: ORDER_STATUS.PAID, createdAt: { lt: before } },',
         "    where: { ownerNotifiedAt: null, createdAt: { lt: before } },"),
    ]),
    (SWEEP, "an already-announced sale is announced again", [
        ("    where: { ownerNotifiedAt: null, status: ORDER_STATUS.PAID, createdAt: { lt: before } },",
         "    where: { status: ORDER_STATUS.PAID, createdAt: { lt: before } },"),
    ]),
    (SWEEP, "the backstop races the inline path on a brand-new order", [
        ("    where: { ownerNotifiedAt: null, status: ORDER_STATUS.PAID, createdAt: { lt: before } },",
         "    where: { ownerNotifiedAt: null, status: ORDER_STATUS.PAID },"),
    ]),
    (SWEEP, "the sweep runs before an email provider is configured", [
        ("  if (!isEmailConfigured()) {\n    return { ...empty, skipped: true };\n  }", "  // gone"),
    ]),
    (NOTIFY, "the order is claimed before anyone checks email can be sent", [
        ("  if (!isEmailConfigured()) {", "  if (false) {"),
    ]),
    (ORIGIN, "a link is invented when no origin is configured", [
        ("  return null;\n}", '  return "https://example.invalid";\n}'),
    ]),
    (ORIGIN, "the link points at the ambient route instead of the business", [
        ("  return origin ? `${origin}/b/${storeSlug}/orders/${orderId}` : null;",
         "  return origin ? `${origin}/dashboard/orders/${orderId}` : null;"),
    ]),
    (ORIGIN, "a trailing slash doubles up in the link", [
        ('  if (configured) return configured.replace(/\\/+$/, "");',
         "  if (configured) return configured;"),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-msn.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts merchant-sale-notice-db --verbose",
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
    originals = {path: read(path) for path in {SWEEP, NOTIFY, ORIGIN}}
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
