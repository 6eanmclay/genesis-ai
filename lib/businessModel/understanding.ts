import { prisma } from "@/lib/prisma";
import { getBusinessProfile, type BusinessProfile } from "./profile";
import { getBeliefs } from "@/lib/intelligence/learn";
import { getRecentDecisionOutcomes, type RecentDecisionOutcome } from "./reasoning";

// J4 Foundation — the canonical representation of what J4 knows about a
// business at any point in time (J4_FOUNDATION.md, Gap A). Combines the
// three things Reason already assembled for itself, in one reusable place:
// current facts (getBusinessProfile), learned patterns (getBeliefs), and
// recent human decisions (getRecentDecisionOutcomes) — plus what J4 has
// already said (active CognitiveOutput rows), so a fresh consumer doesn't
// repeat or contradict a still-open conversation.
//
// Deliberately read-only, no side effects — this must be safe to call from
// a conversational turn (chat) as often as an owner asks a question,
// unlike lib/intelligence/learn.ts's distillBeliefs, which writes. A
// caller that needs freshly-distilled beliefs (lib/intelligence/
// cognitiveLayer.ts's runCognitiveReview) calls distillBeliefs itself
// first, then this — same ordering guarantee that file already documented
// before this function existed, just no longer duplicated inline there.
//
// "There should only be one J4" (Sean, 2026-08-04): this is the one real
// answer to "what does J4 know," reused by every future consumer —
// recommendations, chat, the eventual meeting-with-J4 opener — rather than
// each assembling its own subset of the same underlying facts and beliefs.

export interface ActiveThought {
  id: string;
  kind: string;
  summary: string;
  priority: string | null;
  // The confidence signal (2026-08-04) — evidential certainty, distinct
  // from priority (business importance). recommendation/opportunity only;
  // null for every other kind, and null for rows written before this
  // column existed.
  confidence: number | null;
  generatedAt: string;
}

export interface BusinessUnderstanding {
  profile: BusinessProfile;
  beliefs: Awaited<ReturnType<typeof getBeliefs>>;
  recentDecisions: RecentDecisionOutcome[];
  // Everything J4 currently considers still-open — every ACTIVE
  // CognitiveOutput kind (explanation/recommendation/opportunity/insight/
  // prediction), not just the two kinds the dashboard's own recommendation
  // feed surfaces (lib/dashboard/recommendations.ts's genesisProducer) —
  // a conversational consumer needs the fuller picture. Capped at the 20
  // most recent so this stays a real, current snapshot, not an
  // ever-growing unbounded history for a long-lived store.
  activeThoughts: ActiveThought[];
  asOf: string;
}

export async function getBusinessUnderstanding(storeId: string): Promise<BusinessUnderstanding> {
  const [profile, beliefs, recentDecisions, activeOutputs] = await Promise.all([
    getBusinessProfile(storeId),
    getBeliefs(storeId),
    getRecentDecisionOutcomes(storeId),
    prisma.cognitiveOutput.findMany({
      where: { storeId, status: "ACTIVE" },
      orderBy: { generatedAt: "desc" },
      take: 20,
      select: { id: true, kind: true, summary: true, priority: true, confidence: true, generatedAt: true },
    }),
  ]);

  return {
    profile,
    beliefs,
    recentDecisions,
    activeThoughts: activeOutputs.map((o) => ({
      id: o.id,
      kind: o.kind,
      summary: o.summary,
      priority: o.priority,
      confidence: o.confidence,
      generatedAt: o.generatedAt.toISOString(),
    })),
    asOf: new Date().toISOString(),
  };
}
