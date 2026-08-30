"""Attack the money-path replay deliberately, one guarantee at a time.

The dangerous direction is not "replay stops working". It is "replay works on
something it should have refused" — a way to execute an unverified payment
payload on demand. Most of these breaks open exactly that door and the suite
must slam it.

    python scripts/sabotage-money-replay.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REPLAY = "lib/webhooks/replay.ts"
HANDLERS = "lib/webhooks/replayHandlers.ts"
DELIVERY = "lib/webhooks/delivery.ts"
STRIPE_ROUTE = "app/api/webhooks/stripe/route.ts"
STRIPE_LIB = "lib/payments/stripeEvent.ts"
PAYPAL_LIB = "lib/payments/paypalEvent.ts"

BREAKS = [
    # ---- the door: a forged delivery becomes runnable ----
    (
        "replay stops caring whether the signature ever verified",
        REPLAY,
        "  if (!delivery.signatureValid) {",
        "  if (false) {",
    ),
    (
        "the verified verdict is recomputed at replay instead of read",
        REPLAY,
        "  if (!delivery.signatureValid) {",
        "  if (!(delivery.signatureValid || delivery.payload.length > 0)) {",
    ),
    # ---- the receipt-time verdict itself ----
    (
        "Stripe records every delivery as verified",
        STRIPE_ROUTE,
        '    await recordDelivery({ provider: "STRIPE", rawBody: body, signatureValid: false });\n'
        '    await recordSignal({\n'
        '      kind: SIGNAL_KINDS.webhookUnsigned, severity: "warning", actorKind: "provider",\n'
        '      surface: "webhook:STRIPE", detail: { provider: "STRIPE", reason: "signature did not verify" },\n'
        '    });',
        '    await recordDelivery({ provider: "STRIPE", rawBody: body, signatureValid: true });\n'
        '    await recordSignal({\n'
        '      kind: SIGNAL_KINDS.webhookUnsigned, severity: "warning", actorKind: "provider",\n'
        '      surface: "webhook:STRIPE", detail: { provider: "STRIPE", reason: "signature did not verify" },\n'
        '    });',
    ),
    # ---- outcomes ----
    (
        "a non-2xx from a money handler is treated as success",
        HANDLERS,
        "  if (response.status >= 200 && response.status < 300) return;",
        "  return;",
    ),
    (
        "a failed replay marks the delivery processed anyway",
        REPLAY,
        "        await handler(delivery.storeId ?? \"\", delivery.payload);\n"
        "        await markProcessed(delivery.id, delivery.storeId);",
        "        await handler(delivery.storeId ?? \"\", delivery.payload).catch(() => {});\n"
        "        await markProcessed(delivery.id, delivery.storeId);",
    ),
    # ---- the money handlers themselves ----
    (
        "the Stripe replay adapter accepts a body that is not an event",
        HANDLERS,
        '    if (!event || typeof event.type !== "string") {\n'
        '      throw new Error("the stored Stripe body is not an event");\n'
        "    }",
        "    // guard removed",
    ),
    (
        "the PayPal replay adapter accepts an empty store",
        HANDLERS,
        "    if (!storeId) {\n"
        '      throw new Error("this PayPal delivery has no store, so it cannot be replayed");\n'
        "    }",
        "    // guard removed",
    ),
    # ---- the split itself ----
    (
        "an event type quietly disappears from the Stripe handler",
        STRIPE_LIB,
        'if (event.type === "charge.refunded")',
        'if (event.type === "charge.refunded.RENAMED")',
    ),
    (
        "PayPal stops scoping its order lookup to the proven store",
        PAYPAL_LIB,
        'where: { storeId, paymentProvider: "PAYPAL", externalPaymentId: captureId },',
        'where: { paymentProvider: "PAYPAL", externalPaymentId: captureId },',
    ),
    (
        "verification follows the handling out of the route",
        STRIPE_LIB,
        "export async function handleStripeEvent(event: Stripe.Event): Promise<Response> {",
        "export async function handleStripeEvent(event: Stripe.Event): Promise<Response> {\n"
        "  void stripeApi().webhooks.constructEvent;",
    ),
    # ---- idempotency ----
    # This first read `externalEventId` -> `externalEventIdRENAMED`, and the
    # runner replaces only the FIRST occurrence — which landed on a type
    # declaration and changed no behaviour at all. A break that does not break
    # anything reports the suite as weak when the suite was fine. It now targets
    # the dedup lookup itself.
    (
        "a redelivered event id becomes a second row",
        DELIVERY,
        "    if (input.externalEventId) {",
        "    if (false) {",
    ),
    # ---- correlation ----
    (
        "a replay overwrites the original correlation id",
        REPLAY,
        "        await markProcessed(delivery.id, delivery.storeId);",
        "        await prismaSystem.webhookDelivery.update({ where: { id: delivery.id }, data: { correlationId: null } });\n"
        "        await markProcessed(delivery.id, delivery.storeId);",
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-mr.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts money-replay-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text and "1/1 database-backed suites pass." in text
    fails = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL ")]
    joined = " | ".join(fails[:3])
    return green, joined.encode("ascii", "replace").decode("ascii")


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
