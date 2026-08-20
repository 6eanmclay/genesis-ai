import type { ProductSourceKind } from "@prisma/client";
import { framingFor } from "./framing";

// "Here's what I'd start with."
//
// The step past a ranked list, and the one Sean named as the point of the whole
// thing: *"I'd start with these five products because they align most closely
// with the brand you're building. I'd also recommend adding one or two branded
// products so customers begin associating the product experience with your
// brand."*
//
// That is not the top five by score. It is a deliberate MIX, because a first
// catalogue made entirely of resold stock has nothing of the owner in it, and
// one made entirely of branded blanks has nothing to sell but the logo. The
// advice is about the shape of the catalogue, not about any one product.
//
// PURE, and separate from scoring on purpose. Scoring answers "does this belong
// in this business"; this answers "what should the first shelf look like". They
// change for different reasons and should be arguable independently.

export interface StartingSetItem {
  id: string;
  name: string;
  kind: ProductSourceKind;
  score: number;
}

export interface StartingSet<T extends StartingSetItem> {
  /** What to add first, best fit first. */
  picks: T[];
  /** What J4 would actually say, in order. Empty when there is nothing to say. */
  advice: string[];
  /** Named gaps in the mix. Real absences, never filler. */
  gaps: string[];
}

const DEFAULT_SIZE = 5;
/** How many branded items a first catalogue wants. Sean's own "one or two". */
const BRANDED_TARGET = 2;

function isBranded(kind: ProductSourceKind): boolean {
  return framingFor(kind).customizable;
}

function andList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Choose a first set, and say why that shape.
 *
 * Best-fitting first, then branded items pulled up to the target if the ranking
 * did not already include some. Nothing is invented to fill a slot: a set of two
 * is returned as a set of two, and the gap is named rather than padded.
 */
export function recommendStartingSet<T extends StartingSetItem>(
  suggestions: T[],
  options: { size?: number; brandedTarget?: number } = {}
): StartingSet<T> {
  const size = options.size ?? DEFAULT_SIZE;
  const brandedTarget = options.brandedTarget ?? BRANDED_TARGET;

  const ranked = [...suggestions].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) {
    return { picks: [], advice: [], gaps: [] };
  }

  const picks = ranked.slice(0, size);
  const branded = ranked.filter((item) => isBranded(item.kind));

  // Pull branded items up to the target, swapping out the weakest non-branded
  // pick rather than growing the set. The set size is what the owner agreed to
  // look at; the mix inside it is what this function is for.
  let swapped = 0;
  for (const item of branded) {
    if (picks.filter((p) => isBranded(p.kind)).length >= Math.min(brandedTarget, size)) break;
    if (picks.some((p) => p.id === item.id)) continue;
    const weakestUnbrandedIndex = picks.reduce(
      (worst, pick, index) =>
        !isBranded(pick.kind) && (worst === -1 || pick.score < picks[worst].score) ? index : worst,
      -1
    );
    if (weakestUnbrandedIndex === -1) break;
    picks[weakestUnbrandedIndex] = item;
    swapped++;
  }
  picks.sort((a, b) => b.score - a.score);

  const advice: string[] = [];
  const gaps: string[] = [];

  advice.push(
    picks.length === 1
      ? `I'd start with ${picks[0].name} — it's the closest fit to the business you've described.`
      : `I'd start with these ${picks.length}. They're the closest fit to the business you've described.`
  );

  const brandedPicks = picks.filter((p) => isBranded(p.kind));
  const readyPicks = picks.filter((p) => !isBranded(p.kind));

  if (brandedPicks.length > 0 && readyPicks.length > 0) {
    // The shape argument, and the reason this function exists rather than a sort.
    advice.push(
      `${andList(brandedPicks.map((p) => p.name))} can carry your own branding, so customers start associating the product itself with you. The rest widen what you sell without you making anything.`
    );
  } else if (brandedPicks.length > 0 && readyPicks.length === 0) {
    advice.push(
      `Every one of these can carry your branding. That's a strong identity to start from — worth adding something ready-made alongside it so there's more to buy than the logo.`
    );
    gaps.push("Nothing here widens the range without you designing it.");
  } else if (readyPicks.length > 0 && brandedPicks.length === 0) {
    if (branded.length === 0) {
      // An honest absence. Recommending "add a branded product" when nothing
      // brandable was found would be advice the owner cannot act on.
      gaps.push(
        "None of what I found can carry your branding, so nothing here will make the product itself feel like yours yet."
      );
    } else {
      advice.push(
        `None of these carry your branding. Worth adding one or two that do, so customers begin associating the product experience with you.`
      );
      gaps.push("No branded products in the starting set.");
    }
  }

  if (swapped > 0) {
    advice.push(
      `I moved ${swapped === 1 ? "one branded product" : `${swapped} branded products`} into this list ahead of a closer-scoring one on purpose — a first catalogue with nothing of yours in it is harder to build a brand on.`
    );
  }

  if (ranked.length > picks.length) {
    advice.push(`There are ${ranked.length - picks.length} more that fit, once these are working.`);
  }

  return { picks, advice, gaps };
}
