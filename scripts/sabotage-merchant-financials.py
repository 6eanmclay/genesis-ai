"""Break the merchant-financials layer and confirm the suite catches it.

    python scripts/sabotage-merchant-financials.py

Two kinds of break, and they fail for different reasons.

SAFETY. Stripe returns a routing number, an account holder's name and a bank
account id on every expanded destination. This layer must carry a bank name
and four digits and nothing else — a merchant does not need Genesis to hold
their bank details, and Genesis has no business holding them.

HONESTY. The distinction Sean named — money a customer paid versus money that
reached the bank — survives only if every field means exactly one thing. A
next-payout date projected from the schedule would look identical to a fact. An
absent instant-availability reported as zero would read as "you cannot do
that". A payout counted as income would net a merchant against their own
withdrawal.
"""

import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STRIPE = os.path.join(ROOT, "lib", "payments", "financials", "stripeFinancials.ts")
INDEX = os.path.join(ROOT, "lib", "payments", "financials", "index.ts")

# (file, name, [(find, replace), ...])
BREAKS = [
    (STRIPE, "the routing number is carried out of the masking", [
        ("    last4: account.last4 ?? null,",
         "    last4: account.last4 ?? null,\n    routing_number: account.routing_number ?? null,"),
    ]),
    (STRIPE, "the account holder's name leaks into the destination", [
        ("    kind: account.object ?? \"unknown\",",
         "    kind: account.account_holder_name ?? account.object ?? \"unknown\","),
    ]),
    (STRIPE, "an unexpanded destination is invented rather than left null", [
        ('  if (!destination || typeof destination === "string") return null;',
         '  if (!destination) return null;\n  if (typeof destination === "string") return { kind: "bank_account", bankName: "Bank account", last4: null, currency: null };'),
    ]),
    (STRIPE, "a next payout is projected instead of being a real one in flight", [
        ('  const inFlight = payouts.filter((p) => p.status === "pending" || p.status === "in_transit");\n  if (inFlight.length === 0) return null;',
         "  const inFlight = payouts;\n  if (inFlight.length === 0) return null;"),
    ]),
    (STRIPE, "instant availability the provider never reported becomes zero", [
        ("    instantAvailable: balance.instant_available ? amounts(balance.instant_available) : null,",
         "    instantAvailable: amounts(balance.instant_available ?? []),"),
    ]),
    (STRIPE, "a payout is counted as income when summing fees", [
        ('  const charges = transactions.filter((t) => t.type === "charge" || t.type === "payment");',
         "  const charges = transactions;"),
    ]),
    (STRIPE, "taking money is confused with receiving it", [
        ("    payoutsEnabled: account.payouts_enabled === true,",
         "    payoutsEnabled: account.charges_enabled === true,"),
    ]),
    (STRIPE, "the connected account is taken from anywhere but this business", [
        ("      const integration = await prisma.storeIntegration.findUnique({\n        where: { storeId_provider: { storeId, provider: \"STRIPE\" } },",
         "      const integration = await prisma.storeIntegration.findFirst({\n        where: { provider: \"STRIPE\" },"),
    ]),
    (STRIPE, "a provider failure throws instead of reporting", [
        ("      } catch (error) {\n        // NEVER THROWN ONWARD.", "      } catch (error) {\n        throw error;\n        // NEVER THROWN ONWARD."),
    ]),
    (INDEX, "a business on an unreadable rail is called disconnected", [
        ("  if (integrations.length > 0) {", "  if (false) {"),
    ]),
]


def run_suite():
    out = os.path.join(tempfile.gettempdir(), "sabotage-mf.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(ROOT, "scripts", "run-unelevated.ps1"),
         "-Command", "npx --yes tsx scripts/run-db-suites.ts merchant-financials-db --verbose",
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
    originals = {path: read(path) for path in {STRIPE, INDEX}}
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
