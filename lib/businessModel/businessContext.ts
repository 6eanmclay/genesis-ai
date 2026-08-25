import type { BusinessUnderstanding } from "./understanding";

// WHAT J4 IS TOLD ABOUT A BUSINESS — one declared shape (2026-08-24, D2/D3).
//
// One Canonical Understanding fixed ASSEMBLING the business four times. It left
// DESCRIBING it four times: renderDigest for routing, the look_up_business_data
// payload for answering, contextForPrompt for proactive reasoning, and the
// content pipeline's own object — four hand-assembled field selections, none
// derived from a declared shape.
//
// This is that shape. A consumer may take LESS of it; none may hand-assemble its
// own field list. The digest already proved the pattern — UnderstandingDigest is
// a declared interface with a renderer — and this generalises it, so the payloads
// become selections of one thing rather than four descriptions of one thing.
//
// THE REASONING BOUNDARY IS A TYPE HERE, NOT A RULE IN PROSE (D2).
//
// Five layers, and they are not interchangeable:
//
//   FACTS      what is true of the business, and who says so
//   HISTORY    what happened, when, in order
//   INFERENCE  what J4 concluded, and how strongly
//   INTENT     what was proposed, approved, delegated, done
//   PLATFORM   the business's relationship with Genesis
//
// An inference carries its confidence with it, in the same object, so a consumer
// cannot render one where a fact is expected without the shape saying so. The
// rule existed in RecordProvenance's own comments and in no type; INFERENCE's
// comment there is explicit that a conclusion is "never to be presented,
// weighed, or spoken about as though somebody had said it."
//
// WHAT THIS IS NOT. It is not a second assembler — it takes an already-assembled
// BusinessUnderstanding and selects from it. It performs no reads.

/** A claim with its source attached, so it cannot be quoted as unqualified truth. */
export interface SourcedClaim {
  statement: string;
  /** Who says so. Null when nothing recorded it — an honest unknown, never a guess. */
  provenance: string | null;
}

/** Something J4 concluded, and how strongly. Confidence travels with it, always. */
export interface InferredClaim {
  claim: string;
  /** 0–1. An inference without this is not renderable — that is the point. */
  confidence: number;
  maturity: string;
}

/**
 * The temporal anchor (D5).
 *
 * Not history itself — the point from which history can be asked about. Without
 * it, "what changed since I last looked" has no reference and every consumer
 * that wants one invents its own cursor.
 */
export interface TemporalAnchor {
  /** When this understanding was assembled. */
  asOf: string;
  /**
   * The highest BusinessEvent sequence this understanding reflects.
   *
   * BusinessEvent.sequence is a monotonic autoincrement, so a later reader can
   * ask for everything after this without comparing timestamps across clocks.
   * Null when the business has no events yet.
   */
  throughEventSequence: string | null;
}

export interface BusinessContext {
  /** FACTS. */
  identity: {
    name: string;
    tagline: string | null;
    description: string | null;
    /** The six owner-authoritative singletons, with provenance. */
    offering: SourcedClaim | null;
    intent: SourcedClaim | null;
    targetAudience: SourcedClaim | null;
    brandPersonality: SourcedClaim | null;
    brandVoice: SourcedClaim | null;
    sellingProposition: SourcedClaim | null;
  };
  facts: {
    categories: string[];
    activeProductCount: number;
    productNames: string[];
    goals: string[];
    challenges: string[];
    blockedGoals: { goal: string; blockedBy: string[] }[];
    connectedSystems: { name: string; stale: boolean }[];
    commitments: { title: string; dueDate: string }[];
  };
  /** HISTORY. */
  history: TemporalAnchor;
  /** INFERENCE — always with confidence. */
  inference: {
    beliefs: InferredClaim[];
  };
  /** INTENT. */
  intent: {
    openThoughts: { kind: string; summary: string }[];
  };
  /** PLATFORM. */
  platform: {
    growthPointBalance: number;
    planName: string | null;
  };
}

/**
 * Build the one description, from the one understanding.
 *
 * Pure. No reads, no side effects — it selects from what the canonical assembler
 * already produced, which is what keeps invariant 1 true.
 */
export function businessContextOf(
  understanding: BusinessUnderstanding,
  anchor: TemporalAnchor
): BusinessContext {
  const p = understanding.profile;

  // A singleton fact reaches the model with its source or not at all. The
  // profile has already resolved "current"; what it cannot carry is who said it,
  // so that is attached here rather than left for each consumer to remember.
  const claim = (statement: string | null, provenance: string | null): SourcedClaim | null =>
    statement ? { statement, provenance } : null;

  return {
    identity: {
      name: p.identity.name,
      tagline: p.identity.tagline,
      description: p.identity.description,
      offering: claim(p.identity.offering, "owner"),
      intent: claim(p.identity.intent, "owner"),
      targetAudience: claim(p.identity.targetAudience, "owner"),
      brandPersonality: claim(p.identity.brandPersonality, "owner"),
      brandVoice: claim(p.identity.brandVoiceAndTone, "owner"),
      sellingProposition: claim(p.identity.uniqueSellingProposition, "owner"),
    },
    facts: {
      categories: p.classification.businessCategories.map((c) => c.label),
      activeProductCount: p.offerings.activeCount,
      productNames: p.offerings.items
        .map((i) => (i.data as { name?: string }).name)
        .filter((n): n is string => typeof n === "string"),
      goals: p.goals.map((g) => g.data.description),
      challenges: p.challenges.map((c) => c.data.description),
      blockedGoals: understanding.blockedGoals.map((b) => ({
        goal: b.goal,
        blockedBy: b.blockedBy.map((x) => x.challenge),
      })),
      // THIS WAS ALWAYS FALSE (fixed 2026-08-25).
      //
      // It read `Boolean(s.syncedAgoLabel && s.lastSyncedAt === null)`.
      // describeSyncAge returns a label ONLY when lastSyncedAt is non-null, so
      // the two halves are mutually exclusive and no connector could ever be
      // reported stale through this seam — J4 would describe a connection that
      // had not synced in three weeks as though its data were current.
      //
      // The profile already computes the real answer, against the scheduler's
      // own cadence, and digest.ts has been using it correctly all along. Same
      // field, same meaning, one source.
      connectedSystems: p.connectedSystems.map((s) => ({
        name: s.displayName,
        stale: s.isStale,
      })),
      // Overdue first, then upcoming — the horizon already ordered them by what
      // needs attention, and flattening preserves that rather than re-sorting.
      commitments: [
        ...understanding.commitments.overdue,
        ...understanding.commitments.upcoming,
      ].map((c) => ({ title: c.title, dueDate: c.dueDate })),
    },
    history: anchor,
    inference: {
      // CONFIDENCE IS NOT OPTIONAL HERE. A belief arriving without it would be
      // an inference wearing a fact's clothes, which is the one thing the layer
      // separation exists to prevent.
      beliefs: understanding.beliefs.map((b) => ({
        claim: b.claim,
        confidence: b.confidence,
        maturity: b.maturity,
      })),
    },
    intent: {
      openThoughts: understanding.activeThoughts.map((t) => ({
        kind: t.kind,
        summary: t.summary,
      })),
    },
    platform: {
      growthPointBalance: understanding.platformRelationship.growthPointBalance,
      planName: understanding.platformRelationship.planName,
    },
  };
}
