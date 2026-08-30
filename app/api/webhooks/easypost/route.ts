import { getConnectorByName } from "@/lib/integrations/registry";
import { receiveWebhook } from "@/lib/webhooks/pipeline";

// WHERE A CARRIER TELLS US THE PARCEL MOVED.
//
// ============ NOW A THIN ADAPTER (2026-08-30) =========================
//
// Everything this route used to do itself is in two places that are not it:
// the PROVIDER CONTRACT — how EasyPost signs, what its payload means — is
// lib/integrations/easypostWebhook.ts, and the DELIVERY SYSTEM — correlation,
// the verbatim record, duplicate detection, the unsigned-payload signal — is
// lib/webhooks/pipeline.ts.
//
// What is left here is the URL. That is the point: adding the next provider
// means writing its contract, not another route that reimplements recording.
//
// The behaviour it always had is preserved exactly. Signature first, because
// this endpoint is public and marking somebody's order delivered would
// otherwise be a curl command away. And always 200 once verified, even when
// the payload is useless to us — a carrier that receives an error retries, and
// retrying a tracker for an order that is not ours achieves nothing but noise
// and eventual webhook suspension.

export async function POST(request: Request): Promise<Response> {
  const connector = getConnectorByName("EASYPOST");
  if (!connector.webhooks) {
    return new Response("Carrier webhooks are not configured", { status: 503 });
  }

  // The RAW body, read before any parsing. The signature covers the exact bytes
  // sent, so re-serialising parsed JSON would fail every legitimate request.
  const rawBody = await request.text();
  const headers = request.headers;

  const outcome = await receiveWebhook({
    provider: "EASYPOST",
    rawBody,
    verify: async () => {
      const verification = await connector.webhooks!.verify(rawBody, headers);
      return {
        ok: verification.ok,
        eventId: verification.eventId ?? null,
        error: verification.error,
      };
    },
    // EasyPost is configured platform-wide rather than per-store, so there is
    // no store to resolve before the handler; it matches the tracker to an
    // order itself.
    handle: async () => connector.webhooks!.handle("", rawBody),
  });

  if (outcome.status === "rejected") {
    return new Response("Invalid signature", { status: 401 });
  }

  // A verified delivery is always accepted, including one whose handler threw:
  // the handler reports its own failures and a carrier retry would deliver the
  // same bytes to the same outcome.
  return new Response("ok", { status: 200 });
}
