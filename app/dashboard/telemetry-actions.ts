"use server";

import { auth } from "@/auth";
import { logProductEvent } from "@/lib/telemetry/events";
import { resolveClientEvent, type ClientEventInput } from "@/lib/telemetry/clientEvents";

// Family-beta instrumentation (v20) — the one entry point client components
// (DashboardShell, SubmitButton) call directly to log a ProductEvent, the
// same "call an async server function directly from a Client Component"
// pattern already used by explainRecommendation (PH-07 Layer 2). userId and
// sessionInstanceId are always resolved from the real server-side session,
// never trusted from the client — a caller can only supply what event
// happened and its small semantic context, never who it happened to.
//
// ============ AND NOW NOT EVEN THAT, FREELY (gap 8, 2026-09-16) ========
//
// "use server" means this is an HTTP endpoint, so its arguments are whatever
// JSON a signed-in caller chose to send. It took `name` and `category`
// verbatim, which made the analytics catalog client-writable: unbounded
// distinct names, and a navigation event could file itself under "creation".
//
// The event is now a REGISTRY KEY. lib/telemetry/clientEvents.ts owns the four
// names the product actually sends, decides each one's category, and keeps only
// the metadata keys that event is declared to carry. An unrecognised name
// writes nothing.
//
// The check is a real runtime one in a PURE function, not a TypeScript type —
// a type stops our own mistakes and stops nothing coming over the wire — and
// living outside this file is what lets verify-client-telemetry call it without
// a session.
export async function logClientEvent(input: ClientEventInput): Promise<void> {
  const session = await auth();
  if (!session?.user) return;

  // REFUSED SILENTLY. Telemetry must never break the feature it is attached to;
  // logProductEvent already swallows its own write failures for that reason.
  const event = resolveClientEvent(input);
  if (!event) return;

  await logProductEvent({
    userId: session.user.id,
    storeId: event.storeId,
    sessionInstanceId: session.user.sessionInstanceId,
    name: event.name,
    category: event.category,
    attemptKey: event.attemptKey,
    outcome: event.outcome,
    durationMs: event.durationMs,
    metadata: event.metadata,
  });
}
