import { isPaymentConnected } from "./needsAttention";
import { prisma } from "@/lib/prisma";
import { logProductEvent } from "@/lib/telemetry/events";

// Extracted from BusinessJourney.tsx (v20) so the family-beta instrumentation
// can detect a real stage transition using the exact same logic the
// component renders from — never a second, competing definition of "what
// stage is this business at." See BusinessJourney.tsx's own comment for why
// this stays state-based rather than order-count-tiered.
export type JourneyStage =
  | "getting-ready"
  | "ready-for-first-sale"
  | "first-sale"
  | "up-and-running";

export interface JourneyStageInput {
  published: boolean;
  hasActiveProducts: boolean;
  stripeIntegration: { status: string } | null;
  paypalIntegration: { status: string } | null;
  allTimeOrderCount: number;
}

export function deriveJourneyStage(input: JourneyStageInput): JourneyStage {
  if (input.allTimeOrderCount > 1) return "up-and-running";
  if (input.allTimeOrderCount === 1) return "first-sale";

  const paymentConnected = isPaymentConnected({
    stripeIntegration: input.stripeIntegration,
    paypalIntegration: input.paypalIntegration,
  });
  const setupDoneCount = [input.published, input.hasActiveProducts, paymentConnected].filter(
    Boolean
  ).length;

  return setupDoneCount === 3 ? "ready-for-first-sale" : "getting-ready";
}

// Family-beta instrumentation (v20) — Business Journey itself is purely
// derived with zero persisted history (see the v20 audit), so this is the
// one place a real stage *transition* becomes a durable event, reusing this
// same stage function rather than a second, competing journey model. Reads
// the last stage event for this store first so a stage that hasn't
// actually changed never re-logs on every Home page load. Meant to be
// called from an after() callback (see app/dashboard/page.tsx) so it never
// adds latency to the page it's derived from.
export async function logJourneyStageIfChanged(
  userId: string,
  storeId: string,
  sessionInstanceId: string,
  input: JourneyStageInput
): Promise<void> {
  const stage = deriveJourneyStage(input);
  const lastEvent = await prisma.productEvent.findFirst({
    where: { storeId, name: "journey.stage_reached" },
    orderBy: { createdAt: "desc" },
  });
  const lastStage = (lastEvent?.metadata as { stage?: string } | null)?.stage;
  if (lastStage === stage) return;

  await logProductEvent({
    userId,
    storeId,
    sessionInstanceId,
    name: "journey.stage_reached",
    category: "journey",
    attemptKey: storeId,
    outcome: "success",
    metadata: { stage, previousStage: lastStage ?? null },
  });
}
