// Business Intelligence Engine M2 (2026-08-18) — who proposed it.
//
// Until M2 this distinction was implicit and, by accident, correct: only
// J4-originated proposals carried a topicKey, so only they could ever be
// counted by learn.ts or matched by the storefront suggestion gate. Every
// conversational decision was invisible to both.
//
// The backfill removes that accident. Once every derivable decision has a
// canonical key, the rule has to be stated in code or it silently inverts:
// J4 would begin learning the owner's "preferences" from proposals the owner
// themselves asked for.
//
// Sean's rule, which this file exists to hold: only proposals J4 actually
// VOLUNTEERED can teach J4 a preference. Being asked for something and then
// changing your mind about the result says nothing about whether J4 should
// raise that idea on its own — it is the owner's own request coming back.
//
// THE DISCRIMINATOR IS cognitiveOutputId. It is set exactly where J4 decided
// on its own to propose something — cognitiveLayer.ts's review, marketing/
// assets.ts, and genesisAutonomy.ts — and null on every conversational path
// (chat/route.ts and ai-actions.ts all create proposals without one).
//
// decisionMode does NOT work for this and it is worth saying why, because it
// looks like it should: it is "human" for both, since it records who APPROVES
// a proposal, not who proposed it.

/** The shape any origin question needs — nothing more. */
export interface ProposalOrigin {
  cognitiveOutputId: string | null;
}

/** Did J4 raise this on its own, unprompted? */
export function isVolunteeredByJ4(proposal: ProposalOrigin): boolean {
  return proposal.cognitiveOutputId !== null;
}

/**
 * Only the proposals J4 volunteered.
 *
 * Applied in memory rather than as a query filter, deliberately: learn.ts and
 * storefrontSuggestionGate.ts both need the identical rule, and one shared
 * function they both call cannot drift the way two hand-written Prisma `where`
 * clauses can. The row counts involved are per-store decision histories —
 * dozens, not millions.
 */
export function volunteeredByJ4<T extends ProposalOrigin>(proposals: T[]): T[] {
  return proposals.filter(isVolunteeredByJ4);
}
