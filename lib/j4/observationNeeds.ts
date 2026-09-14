import type { BoundaryId } from "./boundaries";
import { COMMERCE_OBSERVATION_NEEDS } from "@/lib/commerce/observationNeeds";
import { COMMERCE_CONDITION_PREFIX } from "@/lib/commerce/conditionKeys";

// WHAT AN OBSERVATION NEEDS, ASKED GENERICALLY.
//
// ============ WHAT THIS EXISTS TO END (2026-09-14) ====================
//
// officeActionForObservation had exactly two answers: `open` when the row
// carried an href, `none` when it did not — and sectionFor maps BOTH to
// "noticed". So every observation, whatever it was about, rendered under "I
// have seen these and cannot act on them yet."
//
// Measured on the five real rows the natural cron produced on 2026-09-14: all
// five landed there, including one whose own summary reads "I cannot send them:
// no email provider is connected yet." The row named precisely what the owner
// must do, under a heading saying nothing could be done. The Office already had
// the right bucket — needs_you, "What only the owner can provide" — and an
// observation had no way to reach it.
//
// ============ THE PRODUCER ANSWERS, NOT THE OFFICE ====================
//
// The Office asks one question and knows nothing about who is answering. Each
// producer declares needs for its own keys in its own module; this composes
// them. A second producer adds one line below and no Office code changes,
// which is the property that makes this an actionability model rather than
// Commerce routing wearing a coat.
//
// ZERO VALUE IMPORTS BEYOND THE MAPS THEMSELVES — no prisma, no tool
// catalogue. lib/j4/officeBriefing.ts is value-imported by
// app/j4/J4Workspace.tsx, a client component, so the whole path that decides an
// observation's action has to stay out of the browser bundle. That is why the
// boundary list was split into ./boundaries first.

/**
 * What an observation needs from the owner, when it needs something.
 *
 * Deliberately NOT BusinessNeed. A BusinessNeed may name a `tool`, and
 * resolving one requires the live catalogue — the server dependency this path
 * cannot have. An observation declares only a boundary, which is the half that
 * is data. If an observation ever genuinely becomes something J4 can execute by
 * itself, that is a different route and should be built as one rather than
 * smuggled through here.
 */
export interface ObservationNeed {
  /** What is needed, in the owner's terms. Shown as the action's `what`. */
  what: string;
  /** Which declared boundary this runs into. Must resolve in J4_CANNOT. */
  boundary: BoundaryId;
}

/**
 * Every producer's declarations, composed.
 *
 * Keyed by the FULL dedupeKey, so two producers cannot collide on a bare
 * condition name, and so this file never has to parse a key to work out who
 * owns it.
 */
function registry(): Map<string, ObservationNeed> {
  const all = new Map<string, ObservationNeed>();
  for (const [key, need] of Object.entries(COMMERCE_OBSERVATION_NEEDS)) {
    if (need) all.set(`${COMMERCE_CONDITION_PREFIX}${key}`, need);
  }
  return all;
}

/**
 * What this observation needs, or null when nothing has been declared.
 *
 * NULL IS THE SAFE DEFAULT AND IT IS NOT A JUDGEMENT. An undeclared key falls
 * through to the behaviour it had before this existed; it does not assert that
 * the observation is non-actionable. Producers opt in.
 */
export function observationNeedFor(dedupeKey: string): ObservationNeed | null {
  return registry().get(dedupeKey) ?? null;
}

/** Every declared key, for the suite's cross-check. */
export function declaredObservationNeedKeys(): string[] {
  return [...registry().keys()].sort();
}
