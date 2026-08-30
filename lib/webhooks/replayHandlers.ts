import { getConnectorByName } from "@/lib/integrations/registry";
import { handleStripeEvent } from "@/lib/payments/stripeEvent";
import { handlePaypalEvent } from "@/lib/payments/paypalEvent";
import type Stripe from "stripe";

// WHICH PROVIDERS CAN BE REPLAYED, AND WHAT REPLAY IS ALLOWED TO ASSUME.
//
// ============ ALL THREE, AS OF RANK 4 (2026-08-30) ====================
//
// Until now this held EasyPost alone, and said so: the two paths that move
// money were the two that could not be recovered, because their verification
// and their handling were one function. A stored signature is expired by
// definition, so anything that must re-verify to run can only ever run once.
//
// Splitting them changed nothing about what is trusted. It changed only WHERE
// the trusting begins, which was already a line both routes had drawn in their
// own comments — PayPal's said it out loud: "Everything below this line is
// trusted. Nothing above it was."
//
// ============ WHAT MAKES CALLING THESE SAFE ==========================
//
// Not this file. replayDelivery refuses any delivery whose signatureValid is
// not true and whose status is not `failed`, before a handler is looked up at
// all. These functions are the second half of a webhook and they check nothing;
// their safety is entirely their caller's, which is why the caller's refusals
// are the most heavily tested thing in the replay suite.
//
// The invariant, Sean's words: replay never means "trust this stored body
// forever". It means "this exact delivery was authenticated when it arrived,
// and we are re-running the already-authenticated delivery through an
// idempotent handler."
//
// ============ A RESPONSE IS NOT AN OUTCOME ===========================
//
// Both money handlers answer with a Response, because both were written as the
// tail of a route. A non-2xx from one means the work did not complete — and
// replay learns outcomes by catching, not by reading a status code. So each
// adapter THROWS on a non-2xx.
//
// Without that, a replay whose handler returned 500 would be recorded as
// replayed and the delivery marked processed: the audit trail lying about the
// one thing it exists to be honest about, and the original failure erased.

export type ReplayHandler = (storeId: string, rawBody: string) => Promise<void>;

/** Turn a route-shaped answer into an outcome replay can act on. */
async function orThrow(what: string, response: Response): Promise<void> {
  if (response.status >= 200 && response.status < 300) return;
  const detail = await response.text().catch(() => "");
  throw new Error(`${what} returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
}

export function replayHandlers(): Record<string, ReplayHandler> {
  const handlers: Record<string, ReplayHandler> = {};

  const easypost = getConnectorByName("EASYPOST");
  if (easypost.webhooks) {
    // The one provider whose contract lives on its connector. Unchanged by
    // Rank 4, and it should stay that way — it was already correct.
    handlers.EASYPOST = (storeId, rawBody) => easypost.webhooks!.handle(storeId, rawBody);
  }

  // ============ STRIPE: PARSED, NOT RE-VERIFIED =======================
  //
  // The live route builds its event with stripe.webhooks.constructEvent, which
  // verifies AND parses. Here the bytes are parsed and NOT verified, and that
  // is the whole point — the verification already happened, at receipt, and is
  // recorded on the row replayDelivery just checked.
  //
  // Everything handleStripeEvent reads — type, id, account, data.object — is
  // plain JSON in both cases, so both callers hand it the same shape. That is a
  // real difference between the two paths and it is stated rather than assumed
  // away: constructEvent could in principle normalise something a future
  // handler depends on.
  handlers.STRIPE = async (_storeId, rawBody) => {
    let event: Stripe.Event;
    try {
      event = JSON.parse(rawBody) as Stripe.Event;
    } catch {
      // A verified delivery whose body will not parse is a genuine
      // contradiction — it verified as these exact bytes. Failing loudly beats
      // handing a handler undefined.
      throw new Error("the stored Stripe body is not JSON");
    }
    if (!event || typeof event.type !== "string") {
      throw new Error("the stored Stripe body is not an event");
    }
    await orThrow("the Stripe handler", await handleStripeEvent(event));
  };

  // ============ PAYPAL: THE STORE ID IS STILL PROOF ===================
  //
  // The route's trust model is that the store id in the path is a CLAIM and the
  // signature is the PROOF. Replay preserves that a second way: this storeId
  // comes from the delivery row, written at receipt from the path whose
  // signature verified — never from whoever pressed the button.
  //
  // The empty-string guard is not defensive noise. replayDelivery passes
  // `delivery.storeId ?? ""`, so a PayPal row that somehow carried no store
  // would reach the handler as "" and every query would scope to a store that
  // does not exist: no order found, 200 returned, delivery marked processed. A
  // refund silently "replayed" against nothing at all.
  handlers.PAYPAL = async (storeId, rawBody) => {
    if (!storeId) {
      throw new Error("this PayPal delivery has no store, so it cannot be replayed");
    }
    await orThrow("the PayPal handler", await handlePaypalEvent(rawBody, storeId));
  };

  return handlers;
}

/** Providers a delivery can be replayed for, for an operator surface to show. */
export function replayableProviders(): string[] {
  return Object.keys(replayHandlers()).sort();
}
