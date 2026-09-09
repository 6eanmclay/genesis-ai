/**
 * "DID I ACTUALLY GET PAID FOR THIS PAYPAL ORDER?"
 *
 * ============ WHY THIS EXISTS (2026-09-09) =============================
 *
 * Sean had a real PayPal order and asked J4 whether the money arrived. J4
 * answered, honestly:
 *
 *     "I don't have PayPal's capture-level detail on my side, so I can't see
 *      why it's showing pending there."
 *
 * That was CORRECT behaviour - it did not infer payment from the existence of
 * an order - but it is not good enough for a payment integration. Genesis
 * already holds the capture id (`Order.externalPaymentId`, e.g.
 * 74L44930P3583640U); nothing read it. Capture happens inline in
 * app/api/checkout/paypal/return/route.ts and was never a reusable capability,
 * so no J4 tool could ask.
 *
 * ============ THE ONE RULE THIS FILE ENFORCES ==========================
 *
 * Sean: "It must NEVER infer that the money was received simply because an
 * order exists. If it cannot verify the money movement, J4 must explicitly say
 * that it cannot verify it and explain why."
 *
 * So the return type makes that impossible to get wrong: "I could not check"
 * is a first-class outcome with a reason, NOT a false or a null that a caller
 * can quietly read as "no". A caller cannot accidentally treat an unreachable
 * PayPal as an unpaid order, because the two are different shapes.
 *
 * ============ IDENTITY COMES FROM THE SAME CALL ========================
 *
 * PayPal genuinely has no "whoami" endpoint - lib/integrations/paypal.ts says
 * so, and it is right. But a capture response carries `payee.merchant_id` and
 * `payee.email_address`, so the merchant identity IS obtainable from a
 * transaction we already hold. That matters because `externalAccountId`
 * currently stores the REST app CLIENT ID, which tells the owner nothing about
 * which PayPal account is connected and is credential-adjacent besides.
 */

import { paypalApiBase, getPaypalAccessToken, type PaypalEnvironment } from "@/lib/integrations/paypal";

/** What PayPal says about the money, when it can be asked. */
export interface PaypalCaptureFacts {
  captureId: string;
  /** PayPal's own status string, unmapped: COMPLETED, PENDING, DECLINED, REFUNDED, ... */
  status: string;
  /** PENDING carries a reason code; without one, null rather than a guess. */
  pendingReason: string | null;
  amount: { value: string; currencyCode: string } | null;
  /** The account the money was paid TO - this is the merchant identity. */
  payeeMerchantId: string | null;
  payeeEmail: string | null;
  createdAt: string | null;
}

/**
 * The answer to "did the money arrive", including the honest refusal.
 *
 * `unverifiable` is deliberately not an error to be thrown away: it is the
 * answer J4 must repeat to the owner, with its reason.
 */
export type PaypalPaymentVerification =
  | { kind: "verified"; paid: boolean; facts: PaypalCaptureFacts }
  | { kind: "unverifiable"; because: string };

/** A capture id we would recognise. Guards against sending an order id by mistake. */
export function looksLikeCaptureId(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[A-Z0-9]{10,32}$/.test(value.trim());
}

/**
 * Whether PayPal's own status means the money is with the merchant.
 *
 * COMPLETED is the only status that means paid. Everything else - PENDING,
 * DECLINED, FAILED, REFUNDED, PARTIALLY_REFUNDED - is reported as it stands
 * rather than being flattened into a boolean, which is why `facts.status`
 * travels with the answer.
 */
export function statusMeansPaid(status: string): boolean {
  return status.trim().toUpperCase() === "COMPLETED";
}

interface CaptureResponse {
  id?: string;
  status?: string;
  status_details?: { reason?: string };
  amount?: { value?: string; currency_code?: string };
  payee?: { merchant_id?: string; email_address?: string };
  create_time?: string;
}

/** Turn PayPal's capture payload into our facts, tolerating missing fields. */
export function factsFromCapture(captureId: string, body: unknown): PaypalCaptureFacts | null {
  if (!body || typeof body !== "object") return null;
  const c = body as CaptureResponse;
  if (!c.status) return null;
  return {
    captureId: c.id ?? captureId,
    status: c.status,
    pendingReason: c.status_details?.reason ?? null,
    amount:
      c.amount?.value && c.amount?.currency_code
        ? { value: c.amount.value, currencyCode: c.amount.currency_code }
        : null,
    payeeMerchantId: c.payee?.merchant_id ?? null,
    payeeEmail: c.payee?.email_address ?? null,
    createdAt: c.create_time ?? null,
  };
}

/**
 * Ask PayPal about one capture.
 *
 * `fetchImpl` is injectable so the shapes below can be proven against recorded
 * PayPal responses without a network, a live merchant account, or the
 * production encryption key - which is genuinely unavailable outside
 * production (see project_integration_key_custody).
 */
export async function verifyPaypalCapture(params: {
  captureId: string;
  clientId: string;
  clientSecret: string;
  environment: PaypalEnvironment;
  fetchImpl?: typeof fetch;
  tokenImpl?: typeof getPaypalAccessToken;
}): Promise<PaypalPaymentVerification> {
  const { captureId } = params;
  if (!looksLikeCaptureId(captureId)) {
    return { kind: "unverifiable", because: `"${captureId}" is not a PayPal capture id` };
  }

  const doFetch = params.fetchImpl ?? fetch;
  const getToken = params.tokenImpl ?? getPaypalAccessToken;

  let token: string;
  try {
    token = await getToken(params.clientId, params.clientSecret, params.environment);
  } catch (error) {
    return {
      kind: "unverifiable",
      because: `PayPal would not accept the stored credentials (${error instanceof Error ? error.message : "unknown error"})`,
    };
  }

  let res: Response;
  try {
    res = await doFetch(`${paypalApiBase(params.environment)}/v2/payments/captures/${encodeURIComponent(captureId)}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch (error) {
    return {
      kind: "unverifiable",
      because: `PayPal could not be reached (${error instanceof Error ? error.message : "network error"})`,
    };
  }

  if (res.status === 404) {
    return { kind: "unverifiable", because: `PayPal does not recognise capture ${captureId}` };
  }
  if (res.status === 403) {
    // The permissions answer, said plainly - this is exactly the case Sean
    // asked to be distinguished rather than reported as "not paid".
    return {
      kind: "unverifiable",
      because: "the connected PayPal app is not permitted to read transaction details",
    };
  }
  if (!res.ok) {
    return { kind: "unverifiable", because: `PayPal returned ${res.status} when asked about this capture` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unverifiable", because: "PayPal's response could not be read" };
  }

  const facts = factsFromCapture(captureId, body);
  if (!facts) {
    return { kind: "unverifiable", because: "PayPal's response carried no payment status" };
  }

  return { kind: "verified", paid: statusMeansPaid(facts.status), facts };
}

/**
 * What to tell the owner, in words, without ever overstating what is known.
 *
 * Kept beside the verification so the honest phrasing cannot drift away from
 * the honest data - the failure mode Sean named is a UI that says "paid"
 * because a row exists.
 */
export function describeVerification(v: PaypalPaymentVerification): string {
  if (v.kind === "unverifiable") {
    return `I could not verify this payment with PayPal: ${v.because}. I am not going to tell you it arrived when I cannot see that it did.`;
  }
  const { facts } = v;
  const money = facts.amount ? `${facts.amount.value} ${facts.amount.currencyCode}` : "the payment";
  if (v.paid) {
    return `PayPal confirms ${money} was captured and completed${facts.createdAt ? ` on ${facts.createdAt.slice(0, 10)}` : ""}.`;
  }
  const reason = facts.pendingReason ? ` (${facts.pendingReason})` : "";
  return `PayPal reports this capture as ${facts.status}${reason}, so the money has not completed. That is PayPal's own status, not my inference.`;
}

/**
 * The merchant identity, recovered from a transaction rather than from a
 * "whoami" endpoint PayPal does not have.
 *
 * ============ WHAT WAS STORED BEFORE, AND WHY IT WAS WRONG =============
 *
 * `StoreIntegration.externalAccountId` held the REST app CLIENT ID:
 *
 *     Aaj2VSW7-xO9O_577PWxq74H7-vKuiyNWUGTdLTDCCd53wSEZtSijtQCLElVHbNPE-...
 *
 * Stripe's equivalent is `acct_1U6HDsBsxuQENanJ`, which resolves to a real
 * business. The PayPal value tells the owner nothing about WHICH PayPal
 * account is connected - and `toStatusView` puts that field in front of them,
 * so it was also showing a credential-adjacent string for no benefit.
 *
 * A capture response carries `payee.merchant_id` and `payee.email_address`.
 * That is a real, non-secret merchant identity, obtained from the business's
 * own transaction.
 */
export interface PaypalMerchantIdentity {
  merchantId: string;
  /** The business email PayPal reports for the payee, when it gives one. */
  email: string | null;
  /** The capture this identity was read from, so the claim is traceable. */
  fromCaptureId: string;
}

/** Reads the merchant identity out of a verified capture, if it carries one. */
export function identityFromVerification(v: PaypalPaymentVerification): PaypalMerchantIdentity | null {
  if (v.kind !== "verified") return null;
  if (!v.facts.payeeMerchantId) return null;
  return {
    merchantId: v.facts.payeeMerchantId,
    email: v.facts.payeeEmail,
    fromCaptureId: v.facts.captureId,
  };
}

/**
 * How to describe the connected account to the owner.
 *
 * Never invents a name. If all we have is a merchant id, that is what is
 * shown - "connected, and here is which account" is honest; a friendly label
 * we made up is not.
 */
export function describeMerchant(identity: PaypalMerchantIdentity | null): string {
  if (!identity) {
    return "Connected, but I have not yet been able to confirm which PayPal account this is. I can tell you as soon as there is a transaction to read it from.";
  }
  return identity.email
    ? `PayPal account ${identity.email} (merchant ID ${identity.merchantId}).`
    : `PayPal merchant ID ${identity.merchantId}.`;
}
