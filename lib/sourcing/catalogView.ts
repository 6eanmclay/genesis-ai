import { prisma } from "@/lib/prisma";
import { framingFor } from "./framing";
import { methodProfile } from "./methodProfile";
import { assessFeasibility, decide, type Outcome } from "./feasibility";
import { capitalPosture } from "./progression";
import { scoreCandidate } from "./recommend";
import { buildSourcingContext } from "./context";
import { recommendStartingSet } from "./startingSet";
import { describeBlockedSources } from "./registry";
import { fromVariantKey } from "./types";
import {
  bulkTerms,
  economicsKey,
  supplierEconomicsFor,
  ECONOMICS_FACTS,
  type EconomicsFact,
  type SupplierTerms,
} from "./economics";
import type { ProductSourceKind } from "@prisma/client";

// WHAT THE CATALOG SHOWS — assembled here so the screen decides nothing.
//
// "The catalog is not the product. The intelligence behind the catalog is the
// product." (Sean.) So this is not a list of things a supplier sells. It is what
// Genesis thinks this business should sell, why, and whether it could — and
// every one of those three answers comes from a function that already existed
// and is already verified:
//
//   does this belong here      -> scoreCandidate      (recommend.ts)
//   could this business do it   -> assessFeasibility   (feasibility.ts)
//   in that order, combined     -> decide              (feasibility.ts)
//   what does the method mean   -> framingFor          (framing.ts)
//   what should the first shelf look like -> recommendStartingSet
//
// Nothing here re-derives any of them. A screen that formed its own opinion
// about affordability would be a second opinion able to disagree with the one
// the owner is reading in chat.
//
// THE OWNER NEVER SEES A SUPPLIER'S NAME. `framingFor` answers "what does this
// mean for me", which is the question somebody building a business is actually
// asking; "Printful" is an answer to a question nobody asked.

/** What is known about a candidate's cost, and who said it. */
export interface CatalogEconomics {
  /** Null when nobody has said. Never a zero standing in for unknown. */
  unitCostInCents: number | null;
  minimumOrderUnits: number | null;
  /** The money these figures are in. Null when nothing is recorded. */
  currency: string | null;
  /**
   * Where each known figure came from, in the owner's terms.
   *
   * Shown rather than summarised into a confidence badge: "you told me this" and
   * "their catalogue says this" are different claims, and an owner deciding
   * whether to spend money is entitled to know which one they are looking at.
   */
  attribution: { fact: EconomicsFact; said: "you" | "their catalogue" | "nobody would say"; whenDays: number | null }[];
  /** True when any figure shown is past its freshness window. */
  anyStale: boolean;
}

export interface CatalogItem {
  sourcedProductId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  kind: ProductSourceKind;
  /** Fit against this business, best first within a group. */
  score: number;
  /** Why Genesis raised it, in the business's own words. */
  reasons: string[];
  /** What Genesis would say to the owner, already combined. */
  outcome: Outcome;
  /** What the supplier's own suggestion was, when there is one. */
  suggestedRetailInCents: number | null;
  economics: CatalogEconomics;
}

export interface CatalogGroup {
  kind: ProductSourceKind;
  label: string;
  intent: string;
  explanation: string;
  items: CatalogItem[];
}

export interface CatalogView {
  /** The business in its own words, so the page can say what it searched on. */
  describedAs: string | null;
  /**
   * Whether Genesis knows this business well enough to judge anything.
   *
   * Separate from "found nothing": "I don't know you yet" and "nothing here
   * fits you" are different sentences and only one of them is the owner's
   * problem to fix.
   */
  knowsTheBusiness: boolean;
  /** Never emits an empty group — see `groupBySourcing`'s own reasoning. */
  groups: CatalogGroup[];
  /** Present only for a business with nothing on its shelf yet. */
  startingSet: {
    picks: { sourcedProductId: string; name: string }[];
    advice: string[];
    gaps: string[];
  } | null;
  /**
   * What Genesis looked at and decided against, with why.
   *
   * Most of what separates a partner from a search box is being able to say "I
   * saw that and I wouldn't recommend it, because…". It survives the request now
   * (`RULED_OUT`), so it can be said on a page the owner opens a week later.
   *
   * Re-evaluated on every discovery run, because the judgement is only ever true
   * of the business as it was understood at the time.
   */
  ruledOut: { sourcedProductId: string; name: string; concerns: string[] }[];
  /** Sources that could not be searched, named rather than silently omitted. */
  blockedSources: { key: string; displayName: string; blockedOn: string[] }[];
  /** How many suggestions exist in total, including any not shown. */
  totalSuggested: number;
  /** When discovery last ran for this business. */
  lastDiscoveredAt: Date | null;
}

const SAID: Record<"SUPPLIER" | "OWNER" | "UNAVAILABLE", CatalogEconomics["attribution"][number]["said"]> = {
  SUPPLIER: "their catalogue",
  OWNER: "you",
  UNAVAILABLE: "nobody would say",
};

/**
 * What is known about one candidate's cost, phrased for a person.
 *
 * Reads the SAME `bulkTerms` the progression engine reads, so a figure shown
 * here and a figure a recommendation rests on cannot be different numbers.
 */
function economicsOf(terms: SupplierTerms, now: Date): CatalogEconomics {
  const attribution: CatalogEconomics["attribution"] = [];
  let anyStale = false;

  for (const fact of ECONOMICS_FACTS) {
    const at = terms.attribution[fact];
    if (!at.provenance || !at.statedAt) continue;
    if (at.freshness?.state === "stale") anyStale = true;
    attribution.push({
      fact,
      said: SAID[at.provenance],
      whenDays: at.freshness?.ageDays ?? Math.floor((now.getTime() - at.statedAt.getTime()) / 86_400_000),
    });
  }

  return {
    unitCostInCents: terms.bulkUnitCostInCents,
    minimumOrderUnits: terms.minimumOrderUnits,
    currency: terms.currency,
    attribution,
    anyStale,
  };
}

/**
 * Everything the catalog screen renders, for one business.
 *
 * One read of the suggestions, one batched read of their economics — the same
 * access pattern `nextMoves` uses, and for the same reason: a page's worth of
 * candidates resolved one at a time is a page's worth of round trips.
 */
export async function catalogView(
  storeId: string,
  options: { limit?: number; now?: Date } = {}
): Promise<CatalogView> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 40;

  const [context, posture, suggestions, ownedCount, latest, declined] = await Promise.all([
    buildSourcingContext(storeId),
    capitalPosture(storeId),
    prisma.sourcedProduct.findMany({
      where: { storeId, status: "SUGGESTED" },
      orderBy: [{ score: "desc" }],
      take: limit,
    }),
    prisma.product.count({ where: { storeId, active: true } }),
    prisma.sourcedProduct.findFirst({
      where: { storeId },
      orderBy: { discoveredAt: "desc" },
      select: { discoveredAt: true },
    }),
    prisma.sourcedProduct.findMany({
      where: { storeId, status: "RULED_OUT" },
      orderBy: { updatedAt: "desc" },
      take: 12,
      select: { id: true, name: true, recommendation: true },
    }),
  ]);

  const economicsByKey = await supplierEconomicsFor(
    storeId,
    suggestions.map((s) => ({
      sourceKey: s.sourceKey,
      externalProductId: s.externalProductId,
      externalVariantId: fromVariantKey(s.externalVariantId),
    })),
    { now }
  );

  const items: CatalogItem[] = [];
  for (const candidate of suggestions) {
    const fit = scoreCandidate(
      {
        sourceKey: candidate.sourceKey,
        externalProductId: candidate.externalProductId,
        externalVariantId: fromVariantKey(candidate.externalVariantId),
        kind: candidate.kind,
        name: candidate.name,
        description: candidate.description,
        imageUrl: candidate.imageUrl,
        unitCostInCents: candidate.unitCostInCents,
        suggestedRetailInCents: candidate.suggestedRetailInCents,
        currency: candidate.currency,
        customizable: candidate.customizable,
        fulfillmentProvider: candidate.fulfillmentProvider,
      },
      context
    );

    const stated = economicsByKey.get(
      economicsKey({
        sourceKey: candidate.sourceKey,
        externalProductId: candidate.externalProductId,
        externalVariantId: fromVariantKey(candidate.externalVariantId),
      })
    );
    // Discovery's own columns are the fallback, and they carry no attribution —
    // which is exactly what the empty attribution list then says.
    const terms: SupplierTerms = stated
      ? bulkTerms(stated)
      : {
          ...bulkTerms(null),
          minimumOrderUnits: candidate.minimumOrderUnits,
          bulkUnitCostInCents: candidate.bulkUnitCostInCents,
        };

    const outcome = decide(
      fit,
      assessFeasibility({
        profile: methodProfile(candidate.kind),
        posture,
        supplier: terms,
        // A candidate the business has never sold has no evidence, and saying
        // so is what keeps a payback figure from being invented for it.
        evidence: null,
        currency: context.currency ?? posture.currency,
      })
    );

    items.push({
      sourcedProductId: candidate.id,
      name: candidate.name,
      description: candidate.description,
      imageUrl: candidate.imageUrl,
      kind: candidate.kind,
      score: fit.score,
      reasons: fit.reasons,
      outcome,
      suggestedRetailInCents: candidate.suggestedRetailInCents,
      economics: economicsOf(terms, now),
    });
  }

  // GROUPED BY WHAT IT MEANS FOR THE OWNER, never by supplier. An empty group is
  // never emitted: a "Customizable products" heading with nothing under it
  // promises a branded route that is not there.
  const byKind = new Map<ProductSourceKind, CatalogItem[]>();
  for (const item of items) {
    const existing = byKind.get(item.kind);
    if (existing) existing.push(item);
    else byKind.set(item.kind, [item]);
  }

  const groups: CatalogGroup[] = [...byKind.entries()].map(([kind, groupItems]) => {
    const framing = framingFor(kind);
    return {
      kind,
      label: framing.label,
      intent: framing.intent,
      explanation: framing.explanation,
      items: groupItems.sort((a, b) => b.score - a.score),
    };
  });
  // Branded first, because that is the move the framing calls "build your
  // brand", and a first shelf made entirely of resold stock has nothing of the
  // owner in it.
  groups.sort((a, b) => Number(framingFor(b.kind).customizable) - Number(framingFor(a.kind).customizable));

  // THE FIRST SHELF, and only for a business that has no shelf yet. Offering
  // "I'd start with these five" to somebody with forty products is not advice.
  const startingSet =
    ownedCount === 0 && items.length > 0
      ? (() => {
          const set = recommendStartingSet(
            items.map((item) => ({
              id: item.sourcedProductId,
              name: item.name,
              kind: item.kind,
              score: item.score,
            }))
          );
          return {
            picks: set.picks.map((pick) => ({ sourcedProductId: pick.id, name: pick.name })),
            advice: set.advice,
            gaps: set.gaps,
          };
        })()
      : null;

  return {
    describedAs: context.ownWords || null,
    // The same gate `scoreCandidate` uses to return "unknown" rather than a
    // verdict. A page that listed products under a heading of confident
    // reasoning it could not actually support would be the worst of both.
    knowsTheBusiness: (context.ownWords ?? "").trim().length > 0,
    groups,
    startingSet,
    ruledOut: declined.map((row) => {
      // The reasoning is a Json snapshot, so it is read defensively — a row
      // whose shape drifted contributes a name and no invented reason rather
      // than a sentence nobody wrote.
      const raw = row.recommendation as { concerns?: unknown } | null;
      const concerns = Array.isArray(raw?.concerns)
        ? raw.concerns.filter((c): c is string => typeof c === "string")
        : [];
      return { sourcedProductId: row.id, name: row.name, concerns };
    }),
    blockedSources: describeBlockedSources(),
    totalSuggested: await prisma.sourcedProduct.count({ where: { storeId, status: "SUGGESTED" } }),
    lastDiscoveredAt: latest?.discoveredAt ?? null,
  };
}
