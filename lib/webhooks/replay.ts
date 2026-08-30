import { prismaSystem } from "@/lib/prisma";
import { withCorrelation } from "@/lib/observability/correlation";
import { markProcessed, markFailed } from "./delivery";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";

// RUNNING A FAILED DELIVERY AGAIN.
//
// ============ WHY THIS IS NECESSARY, NOT A CONVENIENCE (2026-08-30) ====
//
// The generic route returns 500 when a handler fails, so the provider retries
// and replay happens by itself. All three DEDICATED routes return 200
// unconditionally:
//
//   EasyPost by design — a carrier retry over a parcel this platform never
//     created is noise, and eventually gets the endpoint suspended
//   Stripe and PayPal at both of their success returns
//
// So on those three a provider will NEVER redeliver a failed delivery. Without
// this, the `failed` rows in WebhookDelivery are a dead end: a payment or a
// refund that did not apply, recorded, visible, and unrecoverable. The payload
// is kept verbatim precisely so this can exist.
//
// ============ IT DOES NOT RE-VERIFY, AND THAT IS DELIBERATE ============
//
// The obvious instinct is to check the signature again. It is wrong here for a
// concrete reason: a provider signature is usually time-bound — Stripe's covers
// a timestamp and its own library rejects anything old — so re-verifying a
// delivery from last Tuesday would fail for every legitimate one, and replay
// would only ever work on deliveries too recent to need it.
//
// What replaces it is narrower and honest: replay refuses anything whose
// signature did not verify AT THE TIME. A rejected delivery is never
// replayable, so the stored body can only ever be one a provider genuinely
// signed. The verification still happened; it is simply not repeated.
//
// ============ AND IT CANNOT DUPLICATE AN EXTERNAL EFFECT ==============
//
// Because the handler's own side effects go through runOnce, keyed on the work
// rather than the attempt. Replaying a delivery whose handler already charged
// somebody replays the charge's RECORD, not the charge.

export type ReplayOutcome =
  | { status: "replayed"; deliveryId: string }
  /** The handler failed again. Still on file, still replayable. */
  | { status: "failed"; deliveryId: string; error: string }
  /** Not in a state that may be replayed, and why. */
  | { status: "refused"; reason: string };

export interface ReplayInput {
  deliveryId: string;
  /**
   * How to run this provider's handler.
   *
   * Injected rather than looked up, so replay works for the three dedicated
   * routes — whose handlers are not on any connector — as well as for
   * connectors that implement IntegrationWebhooks. The caller knows which.
   */
  handlers: Record<string, (storeId: string, rawBody: string) => Promise<void>>;
  /** Who asked. Recorded, because replaying a payment webhook is an act. */
  actorId?: string | null;
}

/**
 * Re-run one failed delivery.
 *
 * CLAIMED BEFORE IT RUNS, so two operators pressing the button at the same
 * moment produce one replay rather than two. The claim is the same conditional
 * update the job queue and the notification claim use, for the same reason.
 */
export async function replayDelivery(input: ReplayInput): Promise<ReplayOutcome> {
  const delivery = await prismaSystem.webhookDelivery.findUnique({
    where: { id: input.deliveryId },
  });
  if (!delivery) return { status: "refused", reason: "no such delivery" };

  // ============ ONLY A FAILURE IS REPLAYABLE ======================
  //
  // Not a processed one — that would re-run a handler that already succeeded,
  // and while runOnce would stop the external effect repeating, the handler's
  // own database writes are not all guarded. Not a rejected one either: its
  // signature never verified, so replaying it would execute a payload nobody
  // proved came from the provider, which is the whole attack.
  if (delivery.status !== "failed") {
    return { status: "refused", reason: `delivery is ${delivery.status}, not failed` };
  }
  if (!delivery.signatureValid) {
    await recordSignal({
      kind: SIGNAL_KINDS.webhookReplayRefused,
      severity: "critical",
      actorKind: input.actorId ? "user" : "system",
      actorId: input.actorId ?? null,
      storeId: delivery.storeId,
      surface: `replay:${delivery.provider}`,
      detail: { provider: delivery.provider, deliveryId: delivery.id },
    });
    return { status: "refused", reason: "an unverified delivery is never replayable" };
  }

  const handler = input.handlers[delivery.provider];
  if (!handler) {
    return { status: "refused", reason: `no handler supplied for ${delivery.provider}` };
  }

  // The claim. `status: "failed"` is in the WHERE, so exactly one caller can
  // move it out of failed.
  const { count } = await prismaSystem.webhookDelivery.updateMany({
    where: { id: delivery.id, status: "failed" },
    data: { status: "replaying", error: null },
  });
  if (count !== 1) return { status: "refused", reason: "another replay is already running" };

  // ============ A REPLAY IS ITS OWN CHAIN, LINKED TO THE FIRST =====
  //
  // A new correlation would lose the connection to the original delivery; the
  // ORIGINAL id would make a deliberate human act indistinguishable from the
  // automatic first attempt. So it joins the delivery's chain, and the signal
  // below records that a person caused this one.
  return withCorrelation(
    { origin: "replay", surface: delivery.provider, id: delivery.correlationId ?? undefined },
    async () => {
      await recordSignal({
        kind: SIGNAL_KINDS.webhookReplayed,
        severity: "info",
        actorKind: input.actorId ? "user" : "system",
        actorId: input.actorId ?? null,
        storeId: delivery.storeId,
        surface: `replay:${delivery.provider}`,
        detail: {
          provider: delivery.provider,
          deliveryId: delivery.id,
          externalEventId: delivery.externalEventId,
        },
      });

      try {
        await handler(delivery.storeId ?? "", delivery.payload);
        await markProcessed(delivery.id, delivery.storeId);
        return { status: "replayed" as const, deliveryId: delivery.id };
      } catch (error) {
        // Back to failed, not stuck in `replaying` — a replay that fails must
        // leave the delivery exactly as replayable as it was before somebody
        // tried, or one bad attempt makes it permanently unrecoverable.
        await markFailed(delivery.id, error);
        return {
          status: "failed" as const,
          deliveryId: delivery.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

/**
 * Deliveries stuck in `replaying` because the process running one died.
 *
 * Without this a crashed replay leaves a delivery in a state nothing can leave:
 * not failed, so it is not replayable, and not processed, so it never happened.
 * The same stale-claim problem the job queue has, and the same answer.
 */
export async function releaseStaleReplays(
  olderThanMs = 10 * 60 * 1000,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prismaSystem.webhookDelivery.updateMany({
    where: {
      status: "replaying",
      receivedAt: { lt: new Date(now.getTime() - olderThanMs) },
    },
    data: { status: "failed", error: "a replay stopped before recording an outcome" },
  });
  return count;
}
