import type { SourcedCandidate } from "./types";

// Why J4 would raise a product — pure, deterministic, and explainable.
//
// THE SEAM THIS IS. Recommendation will get better as J4's understanding of a
// business deepens; what must not change every time it does is where the
// reasoning is written down (SourcedProduct.recommendation) and what it has to
// contain to be usable (a score, and reasons a person can read). This file is
// the first implementation of that contract, not the last.
//
// Deliberately NOT an LLM call, and not because one would be worse at it. Three
// reasons, in order: a discovery run scores dozens of candidates and every one
// would be a billed request; the same business and the same candidate must
// score the same way twice, or "why is this still at the top" has no answer;
// and a model asked to justify a product it has already been shown will always
// find something to say. A grounded score first, and a model to narrate what
// this found, is the right order — the reverse is how a recommender starts
// telling owners what they want to hear.
//
// EVERY REASON MUST NAME A REAL FACT ABOUT THIS BUSINESS. There is no baseline
// score, no "looks popular", no invented affinity. A candidate nothing can be
// said about scores zero and says nothing, which is honest and is exactly the
// signal that Genesis does not yet understand the business well enough to
// recommend anything — see [[project_j4_makes_entrepreneurs]]: the point is to
// make the owner a better decision-maker, and a confident-sounding score with
// nothing behind it does the opposite.

/**
 * What the recommender is allowed to reason from.
 *
 * A deliberately small projection of BusinessUnderstanding rather than the whole
 * thing. Scoring can only use what is in here, so what a recommendation is
 * grounded in is a matter of record instead of whatever happened to be reachable.
 */
export interface SourcingContext {
  /** The business's own words: description, brand story, USP, audience. */
  ownWords: string;
  /** Category and revenue-stream labels the business classified itself as. */
  classifications: string[];
  brandPositioning: string;
  /** What the store already sells, by name. */
  sells: string[];
  /** Names of the items actually earning, best first. Empty for a new store. */
  proven: string[];
}

export interface Recommendation {
  score: number;
  /** Sentences an owner can read. Never jargon, never a bare number. */
  reasons: string[];
  /** Which signals contributed, for auditing a score after the fact. */
  basedOn: string[];
}

// Words that match everything and therefore mean nothing. The same problem
// lib/fulfillment/printful.ts hit and documented: without this, "the", "want"
// and "business" match nearly every catalog description and the filter becomes
// a no-op that looks like it is working.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "our", "out", "with", "that", "this",
  "have", "from", "they", "will", "would", "there", "their", "what", "about", "which", "when", "make",
  "like", "time", "just", "into", "than", "then", "them", "these", "some", "could", "people", "your",
  "store", "online", "business", "shop", "product", "products", "customers", "customer", "quality",
  "best", "great", "made", "make", "making", "sell", "selling", "sells", "want", "wants", "new",
]);

function meaningfulWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word))
  );
}

function overlap(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((word) => b.has(word));
}

/** Human-readable list, because "candles, rings and stands" reads and "candles,rings" does not. */
function andList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Brand positionings for which putting the owner's own artwork on something is a
 * genuine advantage rather than a neutral feature.
 *
 * Narrow on purpose. A budget reseller gains nothing from customisation and
 * scoring it up would push them toward the more expensive supplier for no
 * reason they would recognise — the exact failure [[project_j4_trusted_advisor]]
 * exists to prevent.
 */
const CUSTOMIZATION_HELPS = new Set(["streetwear", "luxury", "minimalist", "professional"]);

/**
 * Score one candidate against one business — pure.
 *
 * The score is a sum of signals that each had to find something real. Its
 * absolute value means nothing; its ordering against other candidates for the
 * same business is the whole product.
 */
export function scoreCandidate(candidate: SourcedCandidate, context: SourcingContext): Recommendation {
  const candidateWords = meaningfulWords(`${candidate.name} ${candidate.description ?? ""}`);

  // DISQUALIFYING, not a penalty (found 2026-08-20 by this function's own
  // suite). Recommending something the owner already sells is the clearest
  // possible signal that nothing was understood, and the first version of this
  // scored it as -20 against a relevance total that reached +24 — so an exact
  // duplicate of the store's best seller came out positive and got suggested.
  // A duplicate cannot be outweighed by how relevant it is; being relevant is
  // precisely why it is already in the catalogue.
  const alreadySelling = context.sells.some(
    (name) => name.trim().toLowerCase() === candidate.name.trim().toLowerCase()
  );
  if (alreadySelling) {
    return {
      score: -1,
      reasons: ["You already sell this, so it would be a duplicate rather than something new."],
      basedOn: ["already_selling"],
    };
  }

  // RELEVANCE FIRST. Only signals that genuinely connect THIS candidate to THIS
  // business count here. Everything after is a modifier, and a modifier can
  // never be the reason something is suggested — the first version let
  // customisation fit alone carry an unrelated phone case onto the list with
  // "your own artwork can go on it" as its entire justification, which is a
  // sentence about the supplier wearing the costume of a recommendation.
  const reasons: string[] = [];
  const basedOn: string[] = [];
  let score = 0;

  // 1. The business's own description of itself.
  const ownMatches = overlap(candidateWords, meaningfulWords(context.ownWords));
  if (ownMatches.length > 0) {
    score += ownMatches.length * 3;
    basedOn.push("own_words");
    reasons.push(
      `It matches how you describe your business — you talk about ${andList(ownMatches.slice(0, 3))}.`
    );
  }

  // 2. What already sells here. Weighted above the description because a thing
  //    that has actually earned money is stronger evidence than a thing said.
  const provenMatches = overlap(candidateWords, meaningfulWords(context.proven.join(" ")));
  if (provenMatches.length > 0) {
    score += provenMatches.length * 4;
    basedOn.push("proven_sellers");
    reasons.push(`It sits close to what's already earning for you — ${andList(context.proven.slice(0, 2))}.`);
  }

  // 3. Adjacent to the rest of the catalogue.
  const sellsMatches = overlap(candidateWords, meaningfulWords(context.sells.join(" ")));
  if (sellsMatches.length > 0) {
    score += sellsMatches.length;
    basedOn.push("catalogue_fit");
  }

  // 4. How the business classified itself.
  const classificationMatches = overlap(candidateWords, meaningfulWords(context.classifications.join(" ")));
  if (classificationMatches.length > 0) {
    score += classificationMatches.length * 2;
    basedOn.push("classification");
  }

  // Nothing connects this to this business. Say nothing, rather than reaching
  // for something true about the supplier and presenting it as a fit.
  if (score <= 0) return { score: 0, reasons: [], basedOn: [] };

  // --- Modifiers. Only reached once relevance is real. --------------------

  // 5. Customisation, only where it is actually an advantage.
  if (candidate.customizable && CUSTOMIZATION_HELPS.has(context.brandPositioning)) {
    score += 3;
    basedOn.push("customization_fit");
    reasons.push(`Your own artwork can go on it, which suits how you position the brand.`);
  }

  // 6. Margin — only when the numbers are genuinely known. A null cost
  //    contributes nothing in either direction: an unknown is not a zero, and
  //    treating it as one would rank every un-quoted candidate as infinitely
  //    profitable.
  if (candidate.unitCostInCents !== null && candidate.suggestedRetailInCents !== null) {
    const margin = candidate.suggestedRetailInCents - candidate.unitCostInCents;
    if (candidate.suggestedRetailInCents > 0 && margin > 0) {
      const percent = Math.round((margin / candidate.suggestedRetailInCents) * 100);
      if (percent >= 40) {
        score += 3;
        basedOn.push("margin");
        reasons.push(`At the suggested price it keeps about ${percent}% margin.`);
      }
    } else if (margin <= 0) {
      // Enough to sink anything. A product that loses money on every sale is not
      // a weaker suggestion than a good one, it is not a suggestion.
      score -= 100;
      basedOn.push("margin");
      reasons.push(`At the suggested price this would sell at a loss.`);
    }
  }

  return { score, reasons, basedOn };
}

/**
 * Should this candidate be shown at all?
 *
 * A candidate nothing could be said about is not a weak recommendation, it is
 * an absent one — and a list padded out with those is how an owner learns to
 * ignore the list. Genesis saying "I don't know your business well enough to
 * suggest anything yet" is the more useful answer, and the one that is true.
 */
export function isWorthSuggesting(recommendation: Recommendation): boolean {
  return recommendation.score > 0 && recommendation.reasons.length > 0;
}
