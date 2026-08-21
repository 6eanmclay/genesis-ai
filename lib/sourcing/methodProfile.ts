import type { ProductSourceKind } from "@prisma/client";

// What a sourcing method COSTS, as opposed to what it is called.
//
// `framing.ts` beside this answers "what does this mean for me". This answers
// "what would it take" — capital, minimums, risk, and the capabilities the owner
// would need. Those are different questions and the second is the one that
// decides whether a recommendation is honest.
//
// CODE, NOT A TABLE, for the same reason framing is: this describes a sourcing
// MODEL. It is identical for every business on the platform, and a per-business
// row would be a per-business fork nobody asked for and a copy that drifts.
//
// The rungs are the progression: a business starts where nothing is paid until a
// customer pays, and earns its way toward better margins and more control. See
// PRODUCT_PROGRESSION.md.

/** How money leaves the owner's hands for this method. */
export type CapitalModel =
  /** Nothing is paid until a customer has paid. The zero-capital entry. */
  | "none"
  /** A minimum order is bought before anything sells. */
  | "bulk_upfront"
  /** Setup cost independent of units. */
  | "tooling";

/** What is actually lost if it does not sell. */
export type UnsoldRisk =
  | "none"
  /** Money sits in stock that could still be sold as-is. */
  | "held_stock"
  /** Stock carrying the owner's branding — it cannot be resold generically. */
  | "branded_stock"
  | "tooling";

/**
 * Something the owner must be able to do, which is a fact about their life
 * rather than their revenue — and is therefore asked, never inferred.
 */
export type OwnerCapability = "hold_stock" | "provide_artwork" | "manage_supplier";

export const OWNER_CAPABILITIES: readonly OwnerCapability[] = [
  "hold_stock",
  "provide_artwork",
  "manage_supplier",
];

export function isOwnerCapability(value: string): value is OwnerCapability {
  return (OWNER_CAPABILITIES as readonly string[]).includes(value);
}

export interface SourcingMethodProfile {
  kind: ProductSourceKind;
  capitalModel: CapitalModel;
  unsoldRisk: UnsoldRisk;
  requiresCapabilities: OwnerCapability[];
  /** True only where the owner's OWN branding genuinely goes on it. */
  carriesOwnBranding: boolean;
  /**
   * Position on the progression. Higher means more commitment and better
   * margins, never "better" on its own — rung 0 is the right answer for a
   * business that has not proven anything yet, and most businesses most of the
   * time.
   */
  rung: 0 | 1 | 2 | 3;
}

// Exhaustive by construction: Record<ProductSourceKind, …> means adding a kind
// without a profile fails to compile. That is the whole reason the kinds are an
// enum rather than strings.
const PROFILES: Record<ProductSourceKind, SourcingMethodProfile> = {
  PRINT_ON_DEMAND: {
    kind: "PRINT_ON_DEMAND",
    capitalModel: "none",
    unsoldRisk: "none",
    // Artwork, not money. Someone with nothing to spend and a design can start
    // here, which is exactly the point of rung 0.
    requiresCapabilities: ["provide_artwork"],
    carriesOwnBranding: true,
    rung: 0,
  },
  WHOLESALE_DROPSHIP: {
    kind: "WHOLESALE_DROPSHIP",
    capitalModel: "none",
    unsoldRisk: "none",
    requiresCapabilities: [],
    carriesOwnBranding: false,
    rung: 0,
  },
  DIGITAL: {
    kind: "DIGITAL",
    capitalModel: "none",
    unsoldRisk: "none",
    requiresCapabilities: [],
    carriesOwnBranding: true,
    rung: 0,
  },
  WHOLESALE_STOCKED: {
    kind: "WHOLESALE_STOCKED",
    capitalModel: "bulk_upfront",
    unsoldRisk: "held_stock",
    requiresCapabilities: ["hold_stock"],
    carriesOwnBranding: false,
    rung: 1,
  },
  PRIVATE_LABEL: {
    kind: "PRIVATE_LABEL",
    capitalModel: "bulk_upfront",
    // Worse than held_stock and the difference is real: generic stock can be
    // sold as somebody else's product, branded stock cannot be sold at all.
    unsoldRisk: "branded_stock",
    requiresCapabilities: ["hold_stock", "provide_artwork"],
    carriesOwnBranding: true,
    rung: 2,
  },
  CONTRACT_MANUFACTURED: {
    kind: "CONTRACT_MANUFACTURED",
    capitalModel: "tooling",
    unsoldRisk: "tooling",
    requiresCapabilities: ["hold_stock", "provide_artwork", "manage_supplier"],
    carriesOwnBranding: true,
    rung: 3,
  },
  OWNER_MADE: {
    kind: "OWNER_MADE",
    capitalModel: "tooling",
    unsoldRisk: "tooling",
    // The owner already makes it. Nothing is sourced, so nothing is required of
    // them that they are not already doing.
    requiresCapabilities: [],
    carriesOwnBranding: true,
    rung: 3,
  },
};

export function methodProfile(kind: ProductSourceKind): SourcingMethodProfile {
  return PROFILES[kind];
}

export function allMethodProfiles(): SourcingMethodProfile[] {
  return Object.values(PROFILES);
}

/**
 * The methods a business can use without spending anything up front.
 *
 * Not a convenience. This is the zero-capital entry stated as code: a person
 * with no money can build a real business out of exactly these, and every part
 * of the system that decides what to offer a new owner reads it from here rather
 * than re-deriving "which ones are free" and getting it subtly wrong.
 */
export function zeroCapitalMethods(): SourcingMethodProfile[] {
  return allMethodProfiles().filter((profile) => profile.capitalModel === "none");
}

/** Methods above a given rung — the ones a business could graduate INTO. */
export function methodsAboveRung(rung: number): SourcingMethodProfile[] {
  return allMethodProfiles()
    .filter((profile) => profile.rung > rung)
    .sort((a, b) => a.rung - b.rung);
}
