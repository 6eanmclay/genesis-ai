import { z } from "zod";

// Meeting with J4 M4 — extracted from app/dashboard/ai-actions.ts (where
// these were previously defined inline, private to applyGenesisMessageToStore)
// so both live chat's existing single-fact-per-message extraction and the
// meeting's own Listen stage (app/onboarding/meeting/listen.ts) share one
// real contract instead of two independently-drifting copies. Each
// "Capture" schema deliberately covers only what Claude can plausibly infer
// from real, given text — status/identifiedAt/the relatedGoalIds/
// relatedChallengeIds reference arrays are derived in code at each write
// site, never asked of the model.
export const GoalCaptureSchema = z.object({
  description: z.string(),
  category: z
    .enum(["revenue", "growth", "efficiency", "expansion", "customer_experience", "product", "hiring", "other"])
    .nullable(),
  priority: z.enum(["high", "medium", "low"]).nullable(),
  targetDate: z.string().nullable(),
  // A real dollar figure in cents, only when actually stated (e.g. "$10k in
  // monthly revenue" -> 1000000 cents) — never inferred or estimated.
  targetValueInCents: z.number().int().nullable(),
});
export type GoalCapture = z.infer<typeof GoalCaptureSchema>;

export const ChallengeCaptureSchema = z.object({
  description: z.string(),
  category: z.enum(["cash_flow", "staffing", "competition", "operations", "marketing", "supply_chain", "other"]).nullable(),
  severity: z.enum(["high", "medium", "low"]).nullable(),
});
export type ChallengeCapture = z.infer<typeof ChallengeCaptureSchema>;

export const EmployeeCaptureSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  roles: z.array(z.string()),
  email: z.string().nullable(),
  startedAt: z.string().nullable(),
});

export const LocationCaptureSchema = z.object({
  name: z.string(),
  type: z.enum(["storefront", "warehouse", "office", "service_area"]).nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
});

/** What the owner says they sell, and what they want the business to be. */
export const OfferingCaptureSchema = z.object({ statement: z.string() });
export const IntentCaptureSchema = z.object({ statement: z.string() });

export const BusinessFactSchema = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("goal"), data: GoalCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("challenge"), data: ChallengeCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("employee"), data: EmployeeCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("location"), data: LocationCaptureSchema, confirmationReply: z.string() }),
  // THE TWO THAT COULD NOT BE CORRECTED (D3, 2026-08-24). Recorded at
  // onboarding by lib/businessModel/ownerFacts.ts and, until this milestone,
  // never again — so an owner whose business changed had nowhere to say so.
  z.object({ entityType: z.literal("offering"), data: OfferingCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("intent"), data: IntentCaptureSchema, confirmationReply: z.string() }),
  z.object({ entityType: z.literal("none"), data: z.null(), confirmationReply: z.null() }),
]);

// The real derived fields every goal/challenge BusinessRecord needs beyond
// what a Capture schema asks the model for — same shape
// applyGenesisMessageToStore has always written, now shared so a second
// writer (the meeting's Listen stage) can't silently drift from it.
export function toGoalRecordData(capture: GoalCapture, todayIso: string) {
  return { ...capture, status: "active" as const, identifiedAt: todayIso, relatedChallengeIds: [] as string[] };
}
export function toChallengeRecordData(capture: ChallengeCapture, todayIso: string) {
  return {
    ...capture,
    status: "active" as const,
    identifiedAt: todayIso,
    resolvedAt: null,
    relatedGoalIds: [] as string[],
  };
}
