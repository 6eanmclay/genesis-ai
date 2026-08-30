"use server";

import { revalidatePath } from "next/cache";
import { assertPlatformAdmin } from "@/lib/platformAdmin";
import { replayDelivery, type ReplayOutcome } from "@/lib/webhooks/replay";
import { replayHandlers } from "@/lib/webhooks/replayHandlers";

// THE ONE HIGH-IMPACT BUTTON ON THE OPERATOR SURFACE.
//
// ============ THE LAYOUT DOES NOT PROTECT THIS (2026-08-30) ============
//
// app/admin/layout.tsx gates every page beneath it and gates nothing else. A
// server action is a POST endpoint with a generated id — anybody holding that
// id can invoke it with no page render and no layout anywhere in the path. The
// UI is not the security boundary.
//
// So the check is the first line of the function, before the argument is even
// read, and it THROWS rather than redirecting: the caller here may be a script
// rather than a browser, and a redirect reads as navigation where a refusal is
// meant. It also records the attempt, because somebody invoking a platform
// action they have no claim to is not an accident.
//
// This is the same discipline app/dashboard/actions.ts already follows for
// per-store actions despite its own layout gate.

export async function replayDeliveryAction(deliveryId: string): Promise<ReplayOutcome> {
  const actorId = await assertPlatformAdmin("webhook.replay");

  // NO SECOND EXECUTION MECHANISM. This calls the same replayDelivery the suite
  // proves, with the same refusals — unverified deliveries, wrong status,
  // already claimed. The action supplies who asked and which handlers exist;
  // every decision about whether a replay may happen stays in one place.
  const outcome = await replayDelivery({
    deliveryId,
    handlers: replayHandlers(),
    actorId,
  });

  revalidatePath("/admin/operations");
  return outcome;
}
