import { labelPurchaseMessage } from "@/lib/orders/notifyCustomerShipped";

// What the owner is told after buying a shipping label. No database, no email:
//
//   npx tsx scripts/verify-shipped-notification.ts
//
// The label is bought with real money before this sentence is written, so it
// must never read as though the purchase failed. It must also never imply the
// customer knows their order shipped when they do not — which, until
// 2026-08-20, is exactly what it did: "Bought a USPS label — tracking 94001..."
// and nothing else, on stores where no email could be sent at all.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const LABEL = { carrier: "USPS", trackingNumber: "9400111899223197428490" };

// ---------------------------------------------------------------------------
console.log("\n1. The purchase itself is always reported as succeeding");
{
  // Whatever happened to the email, the money is already spent and the label
  // exists. A sentence that reads like a failure would send the owner chasing
  // a problem that isn't there — or worse, buying a second label.
  const outcomes = [
    { notified: true } as const,
    { notified: false, reason: "email_not_configured" } as const,
    { notified: false, reason: "send_failed", detail: "550 rejected" } as const,
  ];
  for (const notification of outcomes) {
    const message = labelPurchaseMessage({ ...LABEL, notification });
    assert(`the label is reported bought (${notification.notified ? "emailed" : notification.reason})`,
      message.startsWith("Bought a USPS label"));
    assert("and the tracking number is in it", message.includes("9400111899223197428490"));
  }
}

// ---------------------------------------------------------------------------
console.log("\n2. A customer who WAS told is described as told");
{
  const message = labelPurchaseMessage({ ...LABEL, notification: { notified: true } });
  assert("it says so plainly", message.includes("has been emailed"), message);
  assert("and does not warn about anything", !message.includes("NOT"), message);
}

// ---------------------------------------------------------------------------
console.log("\n3. A customer who was NOT told — the case that used to be silent");
{
  // Every store today. There is no Resend account, so isEmailConfigured() is
  // false everywhere and the buyer hears nothing.
  const message = labelPurchaseMessage({
    ...LABEL,
    notification: { notified: false, reason: "email_not_configured" },
  });
  assert("the owner is told the customer was not emailed", message.includes("NOT emailed"), message);
  assert("with the reason", message.includes("can't send email yet"));
  // The owner is the only one who can put it right, so they are told to.
  assert("and what to do about it", message.includes("send them the tracking number yourself"));
}

// ---------------------------------------------------------------------------
console.log("\n4. A send that failed says why");
{
  const message = labelPurchaseMessage({
    ...LABEL,
    notification: { notified: false, reason: "send_failed", detail: "mailbox unavailable" },
  });
  assert("the provider's reason survives", message.includes("mailbox unavailable"), message);
  assert("it is still marked as not emailed", message.includes("NOT be emailed"));
  assert("and still tells the owner what to do", message.includes("yourself"));
  // A bounced address is a different problem from no email service at all, and
  // the owner acts differently on each.
  const notConfigured = labelPurchaseMessage({
    ...LABEL,
    notification: { notified: false, reason: "email_not_configured" },
  });
  assert("the two failures do not read the same", message !== notConfigured);
}

// ---------------------------------------------------------------------------
console.log("\n5. The carrier is whatever was actually bought");
{
  const message = labelPurchaseMessage({
    carrier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    notification: { notified: true },
  });
  check("no carrier is hardcoded", message.startsWith("Bought a UPS label"), true);
  assert("with its own tracking number", message.includes("1Z999AA10123456784"));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
