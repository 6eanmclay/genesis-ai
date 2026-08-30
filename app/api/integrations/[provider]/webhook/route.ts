import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { prismaSystem } from "@/lib/prisma";
import { recordDelivery, markProcessed, markFailed } from "@/lib/webhooks/delivery";
import { getConnectorByName } from "@/lib/integrations/registry";

// Phase 0 — one webhook route for every provider that supports them.
//
// Stripe's webhook verification was real but hand-built in its own route,
// entirely outside the connector contract, so "webhooks where supported" was
// not something the framework could offer a new provider. A connector now
// declares `webhooks: { verify, handle }` and gets this route for free.
//
// NOTHING IS TRUSTED BEFORE verify(). The body is read as raw text — signature
// schemes sign bytes, and re-serialising parsed JSON breaks them — and the
// handler only ever sees a delivery whose signature already checked out.
//
// IDEMPOTENCY IS BY CONSTRUCTION rather than a dedupe table: handlers write
// through persistSyncedRecords, whose
// @@unique([storeId, entityType, sourceProvider, externalId]) turns a replayed
// delivery into an update in place. A provider that retries — and they all do —
// converges instead of duplicating.
//
// The existing /api/webhooks/stripe routes are deliberately untouched here:
// they handle real money today, and moving them belongs to Phase 1 with its own
// verification, not to a framework change.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;

  let connector;
  try {
    connector = getConnectorByName(provider);
  } catch {
    // An unknown provider is a 404, not a 500: this endpoint is public and
    // should not distinguish "misconfigured" from "does not exist".
    return new NextResponse("Unknown provider", { status: 404 });
  }

  if (!connector.webhooks) {
    return new NextResponse("This provider does not deliver webhooks", { status: 404 });
  }

  const rawBody = await request.text();

  let verification;
  try {
    verification = await connector.webhooks.verify(rawBody, request.headers);
  } catch (error) {
    unstable_rethrow(error);
    // A verifier that throws on a hostile payload is itself a defect, but it
    // must never become a 500 that a prober can use to map the surface.
    console.error(`[integrations/${provider}/webhook] verify threw`, error);
    return new NextResponse("Invalid signature", { status: 400 });
  }

  if (!verification.ok) {
    // WRITTEN DOWN, NOT DROPPED. One bad signature is noise; a burst is a
    // rotated secret nobody updated, or somebody probing the endpoint — and
    // neither is visible if the only trace is a 400 in a log that rolls over.
    await recordDelivery({
      provider,
      rawBody,
      signatureValid: false,
      externalEventId: verification.eventId ?? null,
    });
    return new NextResponse("Invalid signature", { status: 400 });
  }

  // Which store this delivery belongs to is resolved from the provider account
  // id the verified payload carries — never from anything the caller could
  // choose, which is the same reasoning the OAuth state fix rests on.
  if (!verification.externalAccountId) {
    console.error(`[integrations/${provider}/webhook] verified delivery carried no account id`);
    return new NextResponse("Unresolvable delivery", { status: 400 });
  }

  const integration = await prismaSystem.storeIntegration.findFirst({
    where: {
      provider: connector.provider,
      externalAccountId: verification.externalAccountId,
      status: "CONNECTED",
    },
    select: { storeId: true },
  });

  if (!integration) {
    // A delivery for an account no longer connected here. 200, deliberately:
    // the provider should stop retrying something we will never accept, and
    // this is not an error on their side.
    return NextResponse.json({ received: true, applied: false });
  }

  // Recorded BEFORE the handler runs, so a delivery that crashes the handler is
  // still on file. Handling itself is unchanged and still inline — making these
  // side effects asynchronous is a behavioural decision, not something an audit
  // trail should smuggle in.
  const delivery = await recordDelivery({
    provider,
    rawBody,
    signatureValid: true,
    externalEventId: verification.eventId ?? null,
    storeId: integration.storeId,
  });

  try {
    await connector.webhooks.handle(integration.storeId, rawBody);
    await markProcessed(delivery?.id ?? null, integration.storeId);
  } catch (error) {
    unstable_rethrow(error);
    await markFailed(delivery?.id ?? null, error);
    console.error(`[integrations/${provider}/webhook] handler failed`, error);
    // 500 so the provider retries — the handler is idempotent by construction,
    // so a retry is safe and a dropped event is not.
    return new NextResponse("Handler failed", { status: 500 });
  }

  return NextResponse.json({
    received: true,
    applied: true,
    eventId: verification.eventId ?? null,
    // A provider retrying an event we already hold is a recognisable fact
    // rather than a second unit of work.
    duplicate: delivery?.duplicate ?? false,
  });
}
