import type { ExperienceState } from "./types";

export type { ExperienceState, ExperienceTranscriptEntry, ExperienceConcept, ExperienceDecision } from "./types";

// Experience-First Onboarding — mirrors discoveryFlow.ts's own split: no
// I/O in this file, just the pure shape of the anonymous experience flow's
// state. The real model call and image generation live in app/onboarding/
// actions.ts (decideExperienceNextStep, submitExperienceMessage).

export function initialExperienceState(): ExperienceState {
  return { transcript: [], status: "collecting", concept: null };
}

// EXPERIENCE_FIRST_ONBOARDING.md's bounded-questioning principle, made
// concrete: "one, rarely two" clarifying rounds. Counted in visitor
// messages, not total transcript length, so a Genesis question doesn't
// itself count against the cap. Passed into the generation prompt as
// context rather than enforced by discarding the model's own decision — the
// model is told the cap applies and asked to commit once it's reached,
// keeping the actual judgment call inside the swappable reasoning boundary
// instead of frozen into surrounding control flow.
export const MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION = 2;

export function countVisitorTurns(state: ExperienceState): number {
  return state.transcript.filter((entry) => entry.role === "visitor").length;
}
