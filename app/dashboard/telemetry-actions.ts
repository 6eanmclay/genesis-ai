"use server";

import { auth } from "@/auth";
import { logProductEvent, type ProductEventCategory } from "@/lib/telemetry/events";

// Family-beta instrumentation (v20) — the one entry point client components
// (DashboardShell, SubmitButton) call directly to log a ProductEvent, the
// same "call an async server function directly from a Client Component"
// pattern already used by explainRecommendation (PH-07 Layer 2). userId and
// sessionInstanceId are always resolved from the real server-side session,
// never trusted from the client — a caller can only supply what event
// happened and its small semantic context, never who it happened to.
export async function logClientEvent(input: {
  storeId?: string | null;
  name: string;
  category: ProductEventCategory;
  attemptKey?: string | null;
  outcome?: "success" | "failure" | "abandoned" | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const session = await auth();
  if (!session?.user) return;

  await logProductEvent({
    userId: session.user.id,
    storeId: input.storeId ?? null,
    sessionInstanceId: session.user.sessionInstanceId,
    name: input.name,
    category: input.category,
    attemptKey: input.attemptKey,
    outcome: input.outcome,
    durationMs: input.durationMs,
    metadata: input.metadata,
  });
}
