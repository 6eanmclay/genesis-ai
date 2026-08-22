import { carriageProviderFor } from "@/lib/carriage/registry";
import {
  isValidEasyPostSignature,
  applyShipmentUpdate,
  reportIngestionFailure,
} from "@/lib/carriage/delivery";

// WHERE A CARRIER TELLS US THE PARCEL MOVED.
//
// The ingestion that never existed. mapTrackerToShipment could always turn a
// carrier tracker into a canonical Shipment, and nothing ever called it — so
// "did it arrive" was unanswerable and the order lifecycle stopped at
// "shipped" forever.
//
// SIGNATURE FIRST, ALWAYS. This endpoint is public: anything on the internet
// can POST to it. Without verification, marking somebody's order delivered
// would be a curl command away — which is worse than not having the feature,
// because the owner would believe it.
//
// ALWAYS 200 ONCE VERIFIED, even when the payload is useless to us. A carrier
// that receives an error retries, and retrying a tracker for an order that is
// not ours achieves nothing but noise and eventual webhook suspension. The
// distinction this route draws is between "we could not authenticate you"
// (refuse, loudly) and "we authenticated you and there was nothing to do"
// (accept, quietly).

export async function POST(request: Request) {
  const secret = process.env.EASYPOST_WEBHOOK_SECRET;

  // No secret configured means no request can be authenticated, and accepting
  // unauthenticated delivery updates is strictly worse than accepting none.
  // 503 rather than 500: this is a configuration state, not a crash.
  if (!secret) {
    return new Response("Carrier webhooks are not configured", { status: 503 });
  }

  // The RAW body, read before any parsing. The signature covers the exact
  // bytes sent, so re-serialising parsed JSON would produce a different string
  // and every legitimate request would fail verification.
  const rawBody = await request.text();

  if (!isValidEasyPostSignature({
    rawBody,
    header: request.headers.get("x-hmac-signature"),
    secret,
  })) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: { description?: string; result?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    // Verified as genuinely from the carrier, yet unparseable. Reported,
    // because that is a real anomaly worth an operator seeing, and accepted,
    // because a retry would deliver the same bytes.
    reportIngestionFailure(error, { stage: "parse" });
    return new Response("ok", { status: 200 });
  }

  // EasyPost sends every event type to one endpoint. Tracker updates are the
  // only kind this milestone consumes; the rest are acknowledged and ignored
  // rather than treated as errors.
  if (typeof payload.description !== "string" || !payload.description.startsWith("tracker.")) {
    return new Response("ok", { status: 200 });
  }

  const provider = carriageProviderFor("EASYPOST");
  if (!provider?.toShipment) {
    reportIngestionFailure(new Error("no carriage provider could map this payload"), {
      description: payload.description,
    });
    return new Response("ok", { status: 200 });
  }

  try {
    // The provider owns the vocabulary. This route never inspects a carrier
    // status string itself — that is what made the mapper worth reusing rather
    // than reimplementing here.
    const shipment = provider.toShipment(payload.result, null);
    const outcome = await applyShipmentUpdate(shipment);

    if (!outcome.updated && outcome.reason === "no_matching_order") {
      // Genuinely common and not a problem: one EasyPost account can carry
      // parcels this platform did not create.
      return new Response("ok", { status: 200 });
    }
  } catch (error) {
    reportIngestionFailure(error, { description: payload.description });
  }

  return new Response("ok", { status: 200 });
}
