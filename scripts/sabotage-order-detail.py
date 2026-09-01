"""Break each part of the order record and confirm the suite catches it.

    python scripts/sabotage-order-detail.py

This screen is the one an owner fulfils a real order from, so the breaks are
the ways it could quietly become unfulfillable again: the line items stop
loading, the money stops explaining itself, tax claims a zero the schema
cannot support, or the store scoping goes and one merchant can open another's
customer's address by pasting an id.

============ ONE BREAK ALREADY FOUND A REAL FLAW IN THE SUITE ==========

"The money trusts only the columns" was MISSED on the first run. The
arithmetic lived inline in OrderDetail.tsx and the suite carried its own copy,
so breaking the page left the copy — and therefore the suite — perfectly
green. That is the seam that replaces the thing it tests.

It now lives in lib/orders/orderMoney.ts, imported by both, and the break
below targets that file. A break that cannot fail is worse than no break,
because it reads as coverage.

============ AND ONE BREAK DELIBERATELY IS NOT HERE ====================

"Render the summary row instead of every line" is a fact about what was drawn
on a screen, and the database suite cannot see a screen. It belongs to
verify-order-detail-browser.ts, which asserts the necklace appears, and it is
left there rather than listed here as a permanent MISSED.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "app", "dashboard", "orders", "OrderDetail.tsx")
MONEY = os.path.join(ROOT, "lib", "orders", "orderMoney.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (PAGE, "the line items are not loaded, so a multi-item order hides a product", [
        ('      items: { orderBy: { createdAt: "asc" } },\n', ""),
    ]),
    (MONEY, "the subtotal trusts only the column, which is null on the live orders", [
        ("    subtotal: order.listSubtotalInCents ?? (items.length > 0 ? itemList : null),",
         "    subtotal: order.listSubtotalInCents,"),
    ]),
    (MONEY, "the discount trusts only the column, so a real promotion vanishes", [
        ("    discount: order.discountInCents ?? (items.length > 0 ? itemDiscount : null),",
         "    discount: order.discountInCents,"),
    ]),
    (MONEY, "the promotion stops being named", [
        ("      order.appliedPromotionLabel ?? items.find((i) => i.promotionLabel)?.promotionLabel ?? null,",
         "      order.appliedPromotionLabel,"),
    ]),
    (MONEY, "an order with no line items has a subtotal invented for it", [
        ("    subtotal: order.listSubtotalInCents ?? (items.length > 0 ? itemList : null),",
         "    subtotal: order.listSubtotalInCents ?? itemList,"),
    ]),
    (PAGE, "tax is rendered as a zero, claiming none was charged", [
        ('              value={<span className="text-zinc-500">Not recorded — check Stripe</span>}',
         "              value={formatMoney(0, currency)}"),
    ]),
    (PAGE, "the order is read without scoping it to the business", [
        ("    where: { id: orderId, storeId },", "    where: { id: orderId },"),
    ]),
    (PAGE, "the history disappears", [
        ("            {timeline.map((entry) => (", "            {[].map((entry: never) => ("),
    ]),
    (PAGE, "a dispute block is shown on every healthy order", [
        ("        {order.disputeStatus && (", "        {true && ("),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-od.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts order-detail-db --verbose",
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
    originals = {PAGE: read(PAGE), MONEY: read(MONEY)}
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
