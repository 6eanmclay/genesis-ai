// WHAT THE OWNER IS TOLD WHEN STRIPE SENDS THEM BACK.
//
// ============ THE REDIRECT IS NOT EVIDENCE OF PAYMENT (2026-09-13) =====
//
// Stripe's success_url fires when the browser returns from a completed
// Checkout Session. It does NOT mean the subscription is active, the invoice
// is paid, or the Growth Points are credited — those are written by the
// webhook, asynchronously, and may land before or after the owner gets back.
//
// So this file draws one line and never crosses it:
//
//   THE REDIRECT ESTABLISHES  that the owner came back from checkout rather
//                             than cancelling out of it.
//   THE PERSISTED STATE       establishes whether they are subscribed.
//
// Sean's rule, verbatim: "success must never be rendered as 'subscription
// active', 'Pro activated', or any equivalent claim unless the actual
// persisted billing state confirms it. The webhook remains the authority."
//
// `subscriptionConfirmed` is that persisted state, read from the Store row the
// webhook writes, and it is the ONLY thing that turns this notice into a
// confirmation. A success redirect with unconfirmed state says so plainly and
// leaves the plan block above it to be the authority.
//
// ============ AND NO POLLING, BECAUSE NONE IS NEEDED ===================
//
// The Billing route renders per request: it reads cookies() through auth() and
// now searchParams too, both Request-time APIs, so with the default
// `dynamic: 'auto'` it is dynamically rendered every time (see
// node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md).
// Returning from Stripe is a full navigation, so the page already re-reads the
// Store row on arrival. There is nothing to poll for and no interval, delay or
// retry loop here — if the webhook has landed, the fresh read shows it.

/** The two checkouts that send an owner away and back. */
export type BillingReturnKind = "subscribe" | "purchase";

export interface BillingReturnNotice {
  /**
   * confirmed — persisted state agrees, so the page may say so.
   * pending   — the owner returned from checkout; nothing is claimed yet.
   * neutral   — they cancelled out. Nothing happened and nothing is implied.
   */
  tone: "confirmed" | "pending" | "neutral";
  title: string;
  detail: string;
}

/**
 * Turn the return parameters into something truthful to render, or null.
 *
 * Null means "render the page exactly as it renders without any of this",
 * which is the case for no parameter, an unrecognised parameter, and an
 * unrecognised value — a URL somebody typed must not be able to put words on
 * this page.
 */
export function billingReturnNotice(params: {
  subscribe?: string;
  purchase?: string;
  /**
   * THE WEBHOOK'S ANSWER, not the redirect's. True only when the store's own
   * persisted billing state says the subscription is live.
   */
  subscriptionConfirmed: boolean;
}): BillingReturnNotice | null {
  const { subscribe, purchase, subscriptionConfirmed } = params;

  if (subscribe === "success") {
    // THE ONE BRANCH THAT MAY CONFIRM, AND ONLY BECAUSE THE ROW SAYS SO.
    return subscriptionConfirmed
      ? {
          tone: "confirmed",
          title: "You're subscribed",
          detail: "Your plan is shown above.",
        }
      : {
          tone: "pending",
          title: "Checkout completed",
          detail:
            "Stripe is still confirming your subscription. Your plan will show above once it does.",
        };
  }

  if (subscribe === "cancelled") {
    return {
      tone: "neutral",
      title: "Checkout cancelled",
      // EXACTLY WHAT THE CANCEL URL ESTABLISHES. Not "nothing was charged" —
      // that is a claim about Stripe's side which this redirect does not make.
      detail: "No subscription was started.",
    };
  }

  if (purchase === "success") {
    // NEVER CONFIRMED, EVEN IN PRINCIPLE. A Growth Point balance cannot say
    // whether THIS purchase landed — only that some balance exists — so there
    // is no persisted fact that would license a confirmation here.
    return {
      tone: "pending",
      title: "Checkout completed",
      detail:
        "Stripe is still confirming your payment. Your Growth Points will appear once it does.",
    };
  }

  if (purchase === "cancelled") {
    return {
      tone: "neutral",
      title: "Checkout cancelled",
      detail: "No Growth Points were bought.",
    };
  }

  return null;
}
