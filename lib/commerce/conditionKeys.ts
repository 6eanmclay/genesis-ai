// WHICH COMMERCE CONDITIONS EXIST — THE NAMES, AND NOTHING ELSE.
//
// ============ WHY THIS IS ITS OWN FILE (2026-09-14) ====================
//
// A release-blocking mistake, caught by the pre-push browser gate and fixed
// here. lib/j4/observationNeeds.ts needed one string — the "commerce:"
// namespace — and imported it from lib/commerce/conditions.ts, which imports
// `@/lib/prisma`. That one value import dragged prisma, and therefore pg, into
// a CLIENT bundle along this path:
//
//   app/j4/J4Workspace.tsx  ("use client")
//     -> lib/j4/officeBriefing.ts
//     -> lib/j4/officeActions.ts
//     -> lib/j4/observationNeeds.ts
//     -> lib/commerce/conditions.ts
//     -> @/lib/prisma -> pg -> net / tls / dns / fs
//
// Next could not resolve those node builtins for the browser, client chunk
// generation failed, and /onboarding/launch rendered a blank document. No
// typecheck and no server-side suite sees this: nothing but a real client
// build does.
//
// So the NAMES live here, with no imports at all, and conditions.ts re-exports
// them so every existing importer is unchanged. The same split, for the same
// reason, as lib/j4/boundaries.ts — which was extracted from
// ownerCapability.ts to keep the live tool catalogue out of this very bundle,
// and which this mistake then walked straight around.
//
// ZERO IMPORTS. Not "only type imports" — none at all. That is the property
// scripts/verify-client-boundary-graph.ts asserts by walking the real import
// graph, so the next person to reach for a constant across this line finds out
// from a suite rather than from a blank page.

/** The namespace these conditions own, so a sweep only resolves its own rows. */
export const COMMERCE_CONDITION_PREFIX = "commerce:";

export type CommerceConditionKey =
  | "orders_unfulfilled_stale"
  | "orders_shipped_untracked"
  | "receipts_unsent"
  | "payment_connection_broken";
