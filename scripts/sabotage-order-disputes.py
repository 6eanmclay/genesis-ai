"""Break the dispute lifecycle deliberately, one guarantee at a time.

Two directions are dangerous here and they are opposites. One is failing to
notice money leaving — the hole this item closed. The other is inventing a loss
that never happened, by treating a bank's question as a chargeback. A suite that
only catches the first is half a suite.

    python scripts/sabotage-order-disputes.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DISPUTE = "lib/payments/stripeDispute.ts"
STATUS = "lib/orders/orderStatus.ts"
LIFECYCLE = "lib/carriage/lifecycle.ts"
MAPPER = "lib/businessModel/internalMapper.ts"
STRIPE_LIB = "lib/payments/stripeEvent.ts"
SHIPPING = "lib/execution/executables/shipping.ts"
ORDERS = "lib/execution/executables/orders.ts"

BREAKS = [
    # ---- failing to notice the money leaving ----
    (
        "funds_withdrawn stops moving the money",
        DISPUTE,
        '    case "charge.dispute.funds_withdrawn":',
        '    case "charge.dispute.funds_withdrawn__never":',
    ),
    (
        "a lost dispute is no longer a charge-back",
        DISPUTE,
        '      if (disputeStatus === "lost" && fundsWithdrawn) return ORDER_STATUS.CHARGED_BACK;',
        "      // verdict ignored",
    ),
    (
        "the route stops dispatching dispute events",
        STRIPE_LIB,
        "  if (isDisputeEvent(event.type)) {",
        "  if (false) {",
    ),
    # ---- inventing a loss that never happened ----
    (
        "a claim being created is treated as money moving",
        DISPUTE,
        '    case "charge.dispute.created":\n    case "charge.dispute.updated":',
        '    case "charge.dispute.created":\n      return ORDER_STATUS.DISPUTED;\n    case "charge.dispute.updated":',
    ),
    (
        "a lost inquiry that withdrew nothing is called a charge-back",
        DISPUTE,
        '      if (disputeStatus === "lost" && fundsWithdrawn) return ORDER_STATUS.CHARGED_BACK;',
        '      if (disputeStatus === "lost") return ORDER_STATUS.CHARGED_BACK;',
    ),
    (
        "reinstated funds no longer come back",
        DISPUTE,
        '    case "charge.dispute.funds_reinstated":\n      // And back again. Not "won" — won is the claim\'s outcome, this is the\n      // money\'s, and only this one puts it back in the account.\n      return ORDER_STATUS.PAID;',
        '    case "charge.dispute.funds_reinstated":\n      return current;',
    ),
    # ---- the refund precedence Sean asked for ----
    (
        "a dispute overwrites an authoritative refund",
        DISPUTE,
        "  if (current === ORDER_STATUS.REFUNDED) return ORDER_STATUS.REFUNDED;",
        "  // refund no longer outranks",
    ),
    # ---- the fulfilment decision, both directions ----
    (
        "a disputed order is blocked from shipping after all",
        STATUS,
        "  return status === ORDER_STATUS.REFUNDED || status === ORDER_STATUS.CHARGED_BACK;",
        "  return status !== ORDER_STATUS.PAID;",
    ),
    (
        "a charged-back order loses its shipping protection",
        STATUS,
        "  return status === ORDER_STATUS.REFUNDED || status === ORDER_STATUS.CHARGED_BACK;",
        "  return status === ORDER_STATUS.REFUNDED;",
    ),
    (
        "the shipping executable decides for itself again",
        SHIPPING,
        "  const refusal = refusalReason(order.status);",
        '  const refusal = order.status === "refunded" ? "refunded" : null;',
    ),
    (
        "the fulfilment executable decides for itself again",
        ORDERS,
        "    if (nowFulfilled && isMoneyGoneForGood(order.status)) {",
        '    if (nowFulfilled && order.status === "refunded") {',
    ),
    # ---- what the owner sees, and what is counted ----
    (
        "a delivered parcel hides a dispute",
        LIFECYCLE,
        '  if (order.status === "charged_back") return "charged_back";\n  if (order.status === "refunded") return "refunded";\n  if (order.status === "disputed") return "disputed";\n  if (order.deliveredAt) return "delivered";',
        '  if (order.deliveredAt) return "delivered";\n  if (order.status === "charged_back") return "charged_back";\n  if (order.status === "refunded") return "refunded";\n  if (order.status === "disputed") return "disputed";',
    ),
    (
        "a disputed order counts as revenue again",
        STATUS,
        "  return status === ORDER_STATUS.PAID;",
        "  return status !== ORDER_STATUS.REFUNDED;",
    ),
    (
        "reporting goes back to comparing a bare string",
        MAPPER,
        "      type: countsAsRevenue(order.status) ? \"sale\" : \"refund\",",
        "      type: order.status === \"refunded\" ? \"refund\" : \"sale\",",
    ),
    # ---- the record itself ----
    (
        "a later event rewrites when the claim began",
        DISPUTE,
        '      ...(eventType === "charge.dispute.created" ? { disputedAt: now } : {}),',
        "      disputedAt: now,",
    ),
    (
        "an orphan dispute throws and fails the webhook",
        DISPUTE,
        '    return { orderId: null, status: null, disputeStatus: dispute.status, skipped: "no matching order" };',
        '    throw new Error("no matching order");',
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-dp.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts order-disputes-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text and "1/1 database-backed suites pass." in text
    fails = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL ")]
    return green, " | ".join(fails[:3]).encode("ascii", "replace").decode("ascii")


def main() -> int:
    print("Confirming the suite is green before breaking anything...")
    green, _ = run_suite()
    if not green:
        print("ABORT - not green to begin with. Nothing below would mean anything.")
        return 1
    print("  green.\n")

    unproven = []
    for name, path, old, new in BREAKS:
        full = os.path.join(ROOT, path)
        original = io.open(full, encoding="utf-8", newline="").read()
        crlf = "\r\n" in original
        source = original.replace("\r\n", "\n")

        if old not in source:
            print(f"BROKEN SABOTAGE  {name} - anchor not found in {path}")
            unproven.append(f"{name} (anchor missing)")
            continue
        broken = source.replace(old, new, 1)
        assert broken != source
        if crlf:
            broken = broken.replace("\n", "\r\n")

        io.open(full, "w", encoding="utf-8", newline="").write(broken)
        try:
            still_green, fails = run_suite()
        finally:
            io.open(full, "w", encoding="utf-8", newline="").write(original)

        if still_green:
            print(f"NOT PROVEN  {name} - the suite stayed green")
            unproven.append(name)
        else:
            print(f"caught      {name}")
            print(f"            {fails}")

    print()
    if unproven:
        print(f"{len(unproven)} of {len(BREAKS)} breaks were NOT caught:")
        for u in unproven:
            print(f"  - {u}")
        return 1
    print(f"All {len(BREAKS)} breaks were caught.")
    return 0


sys.exit(main())
