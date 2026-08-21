import type { ProductSourceKind } from "@prisma/client";

// How a sourcing model is described to the person who has to choose.
//
// THE RULE, inherited from lib/fulfillment/types.ts and extended here: the owner
// never chooses a supplier by name. "Printful" and "AliExpress" are answers to a
// question nobody building a business is asking. The question they are asking is
// *can I put my brand on it, and do I have to hold any of it* — and that is what
// a sourcing model actually decides.
//
// So this lives in the domain rather than in a component. It is not presentation
// polish; it is the vocabulary a recommendation has to be phrased in to make
// sense, and putting it here means one answer to "what does print-on-demand mean
// for me" wherever that gets asked — a screen, a chat reply, a spoken summary.
//
// Sean's own framing for P0.5, kept close to his words because they are the
// product decision: *"Build your brand"* against *"Expand your product line"*.

export interface SourcingFraming {
  /** What this group of products IS, in the owner's terms. */
  label: string;
  /** The move it represents for the business. */
  intent: string;
  /** One sentence explaining what they are getting into. */
  explanation: string;
  /** When this is the right choice. */
  bestFor: string;
  /** Can the owner's own artwork go on it? The single sharpest difference. */
  customizable: boolean;
  /** Does the owner have to hold any of it? The second sharpest. */
  holdsInventory: boolean;
}

const FRAMING: Record<ProductSourceKind, SourcingFraming> = {
  PRINT_ON_DEMAND: {
    label: "Customizable products",
    intent: "Build your brand",
    explanation:
      "These can carry your logo, artwork or designs, and they're made and shipped for you when someone orders. You never hold any stock.",
    bestFor: "Making the product itself feel like part of your brand.",
    customizable: true,
    holdsInventory: false,
  },
  WHOLESALE_DROPSHIP: {
    label: "Ready-to-sell products",
    intent: "Expand your product line",
    explanation:
      // Deliberately hedged, and the hedge is not padding: Genesis does not
      // route orders to a supplier yet (an explicit non-goal since
      // ONBOARDING_V2_DESIGN.md), so "shipped for you" would be a promise the
      // platform does not currently keep.
      "These already exist and are sold to you at wholesale, so you don't manufacture or store anything. Passing each order to the supplier is still something you do yourself for now.",
    bestFor: "Widening what you sell without designing or making it.",
    customizable: false,
    holdsInventory: false,
  },
  WHOLESALE_STOCKED: {
    label: "Products you stock",
    intent: "Buy in and hold",
    explanation:
      "You buy these wholesale, keep them, and ship them yourself. Better margins than dropshipping, and your money is tied up in stock until they sell.",
    bestFor: "Products that sell reliably enough to be worth holding.",
    customizable: false,
    holdsInventory: true,
  },
  OWNER_MADE: {
    label: "What you make",
    intent: "Sell your own work",
    explanation: "You make or hold these and ship them yourself. Nobody else is involved.",
    bestFor: "The things only you can offer.",
    customizable: true,
    holdsInventory: true,
  },
  PRIVATE_LABEL: {
    label: "Your own label",
    intent: "Make it yours",
    explanation:
      "You buy these in bulk with your own branding on them. Better margins than reselling somebody else's, and the stock is yours — if it doesn't sell it can't be sold as anything else.",
    bestFor: "Products you already know sell, that you want to own outright.",
    customizable: true,
    holdsInventory: true,
  },
  CONTRACT_MANUFACTURED: {
    label: "Made to your specification",
    intent: "Own how it's made",
    explanation:
      "A manufacturer makes these to your design, for you. The best margins available and the most to lose — setup costs are real and they are spent before anything sells.",
    bestFor: "A proven product you want to control completely.",
    customizable: true,
    holdsInventory: true,
  },
  DIGITAL: {
    label: "Digital products",
    intent: "Sell without shipping",
    explanation: "Nothing is posted. No parcel, no address, no postage.",
    bestFor: "Anything the customer downloads or accesses.",
    customizable: true,
    holdsInventory: false,
  },
};

export function framingFor(kind: ProductSourceKind): SourcingFraming {
  return FRAMING[kind];
}

/**
 * Group suggestions the way the owner has to think about them — pure.
 *
 * By sourcing model rather than by supplier, and only groups that actually have
 * something in them. An empty "Customizable products" heading is a promise that
 * there is a branded route available when there is not.
 */
export function groupBySourcing<T extends { kind: ProductSourceKind }>(
  items: T[]
): { kind: ProductSourceKind; framing: SourcingFraming; items: T[] }[] {
  const byKind = new Map<ProductSourceKind, T[]>();
  for (const item of items) {
    const existing = byKind.get(item.kind);
    if (existing) existing.push(item);
    else byKind.set(item.kind, [item]);
  }
  return [...byKind.entries()].map(([kind, group]) => ({
    kind,
    framing: framingFor(kind),
    items: group,
  }));
}
