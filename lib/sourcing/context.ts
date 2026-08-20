import { prisma } from "@/lib/prisma";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import type { SourcingContext } from "./recommend";

// What J4 already knows, projected into what the recommender is allowed to use.
//
// The join between this module and the Foundation. Sean's own framing for P0.5
// is that the catalog is the base of a discovery system J4 reasons over, and
// this is the line where that becomes literal: recommendation quality improves
// as getBusinessUnderstanding() gets better, with no change here — the same
// property the storefront-evolution capability is designed around
// (VISION.md, "Genesis Website Evolution").
//
// DELIBERATELY A NARROW PROJECTION rather than passing BusinessUnderstanding
// straight through. What a recommendation was grounded in should be a matter of
// record, and it cannot be if the scorer can reach anything it likes. Widening
// this is a deliberate edit to one function, which is the point.

/**
 * Read the business, and say what may be reasoned from.
 *
 * Every field is drawn from something the owner or their real sales said. There
 * is no default persona, no filler, and an unknown stays empty — a store Genesis
 * knows nothing about produces a context that yields no suggestions, which is
 * the honest outcome rather than a generic one.
 */
export async function buildSourcingContext(storeId: string): Promise<SourcingContext> {
  const [store, understanding] = await Promise.all([
    prisma.store.findUnique({
      where: { id: storeId },
      select: { brandPositioning: true, description: true, tagline: true },
    }),
    getBusinessUnderstanding(storeId),
  ]);

  const identity = understanding.profile.identity;
  // The business in its own words, in the order it actually describes itself.
  // Joined rather than picked between, because a brand story and a USP say
  // different things and both are the owner's.
  const ownWords = [
    identity.description ?? store?.description ?? null,
    identity.tagline ?? store?.tagline ?? null,
    identity.brandStory,
    identity.uniqueSellingProposition,
    identity.targetAudience,
    identity.brandPromise,
    ...identity.coreValues,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(". ");

  const classifications = [
    ...understanding.profile.classification.businessCategories.map((c) => c.label),
    ...understanding.profile.classification.revenueStreams.map((r) => r.label),
  ];

  // What the store sells, by name. Read off the Foundation's own offerings
  // rather than querying Product directly, so "what does this business sell"
  // has one answer across the codebase.
  const sells = understanding.profile.offerings.items
    .map((item) => item.data.name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);

  // What has ACTUALLY earned, best first. Empty for a new store, and that
  // emptiness is meaningful: with nothing proven, the recommender falls back to
  // what the owner says rather than inventing a track record.
  const proven = [...understanding.profile.offerings.performance]
    .filter((entry) => entry.revenueInCents > 0)
    .sort((a, b) => b.revenueInCents - a.revenueInCents)
    .map((entry) => entry.item.data.name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);

  return {
    ownWords,
    classifications,
    // "other" is the honest default: it is a real slug meaning the owner has not
    // said, and it is the one positioning for which customisation earns nothing.
    brandPositioning: store?.brandPositioning ?? "other",
    sells,
    proven,
  };
}
