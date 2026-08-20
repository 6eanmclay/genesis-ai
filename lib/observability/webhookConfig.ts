// Telling a misconfiguration apart from an attack (2026-08-20).
//
// THE DEFECT. Both webhook routes read their secret with a non-null assertion
// and passed it straight to constructEvent:
//
//     const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
//     ...
//     try { event = stripe.webhooks.constructEvent(body, signature, webhookSecret); }
//     catch { return new Response("Invalid signature", { status: 400 }); }
//
// With the variable unset, `constructEvent` throws a TypeError ("the key
// argument must be of type string") — indistinguishable, at that catch, from a
// genuinely forged signature. So the route answered **400**.
//
// 400 is how you tell Stripe a request is permanently bad. Stripe stops
// retrying. So a missing environment variable silently converted every real
// payment during that window into an order that never existed, with no retry
// and nothing in the logs but "Invalid signature" — which reads as an attack
// rather than a deployment mistake.
//
// A misconfiguration must answer 500: Stripe keeps retrying, and the moment the
// secret is set the backlog delivers. The difference between 400 and 500 here is
// the difference between losing those sales and not.

export type WebhookSecretCheck =
  | { ok: true; secret: string }
  | { ok: false; status: 500; reason: string };

/**
 * Is this endpoint configured well enough to judge a signature at all? — pure.
 *
 * Deliberately separate from signature verification, because they are different
 * questions with different answers: "I cannot check this" is ours to fix, and
 * "this is forged" is theirs.
 */
export function checkWebhookSecret(
  secret: string | undefined,
  name: string
): WebhookSecretCheck {
  if (typeof secret !== "string" || secret.trim() === "") {
    return {
      ok: false,
      status: 500,
      reason: `${name} is not set — this endpoint cannot verify any signature. Returning 500 so Stripe retries once it is configured, rather than 400, which would tell Stripe to give up on real payments.`,
    };
  }
  return { ok: true, secret };
}
