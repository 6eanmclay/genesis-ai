import type { Garment } from "./garment";

// WHAT YOU CAN MAKE, AS A QUESTION ABOUT INTENT.
//
// ============ THIS IS NOT A LIST OF GARMENTS =============================
//
// A supplier's catalogue answers "what blanks exist". This answers something
// earlier and more human: what are we making? Somebody arriving at the
// Creation Station has an intention before they have a product id, and the
// portal asks about the intention.
//
// The distinction matters architecturally, not just in tone. If this were a
// list of garments it would be apparel forever, and everything downstream
// would take a garment. It is a list of THINGS TO MAKE, and merchandise is one
// family of them — `family` exists so that graphics, packaging, promotional
// material and website assets can join without the portal being rebuilt around
// a second concept.
//
// So: no field here is apparel-specific. `match` is how a creatable finds
// itself in a supplier catalogue, which is meaningless for a graphic and
// simply stays empty when that day comes.

export type CreatableFamily =
  /** Physical goods made by a print supplier. The only family built today. */
  | "merch"
  /** Logos, marks, social images. Made by generation, not by a supplier. */
  | "graphic"
  /** Boxes, inserts, labels. */
  | "packaging"
  /** Pages, sections, hero images. */
  | "web";

export interface Creatable {
  id: string;
  label: string;
  family: CreatableFamily;
  /**
   * Words that identify this creatable in a supplier's own catalogue.
   *
   * LOWERCASE, AND MATCHED AGAINST THE SUPPLIER'S TEXT rather than a taxonomy
   * Genesis maintains. Printful calls a hoodie several things across its
   * catalogue and none of them is a stable id, so this is a small set of
   * synonyms rather than one canonical name.
   *
   * Empty for families a supplier does not make.
   */
  match: string[];
  /** One line, for somebody who does not already know what this is for. */
  hint: string;
}

/**
 * The things Genesis can start today, in the order they are offered.
 *
 * DATA, NOT A SWITCH. Adding one is an entry here; nothing in the portal, the
 * page or the designer knows any of these by name.
 */
export const CREATABLES: Creatable[] = [
  {
    id: "t-shirt",
    label: "T-shirt",
    family: "merch",
    match: ["t-shirt", "tee", "t shirt"],
    hint: "The one everybody starts with",
  },
  {
    id: "hoodie",
    label: "Hoodie",
    family: "merch",
    match: ["hoodie", "hooded", "sweatshirt"],
    hint: "Heavier, and people keep them",
  },
  {
    id: "hat",
    label: "Hat",
    family: "merch",
    match: ["hat", "cap", "beanie", "snapback"],
    hint: "Small print area, big presence",
  },
  {
    id: "bag",
    label: "Bag",
    family: "merch",
    match: ["bag", "tote", "backpack", "duffle"],
    hint: "Seen by everyone but the owner",
  },
  {
    id: "mug",
    label: "Mug",
    family: "merch",
    match: ["mug", "cup", "tumbler"],
    hint: "Lives on a desk for years",
  },
];

export function creatableById(id: string): Creatable | null {
  return CREATABLES.find((c) => c.id === id) ?? null;
}

/**
 * Does this blank belong to this creatable?
 *
 * PURE, and matched against the supplier's own name and type. Deliberately
 * substring rather than exact: "Unisex Staple T-Shirt | Bella + Canvas 3001"
 * has to find "t-shirt", and no supplier writes its catalogue to suit us.
 */
export function garmentMatches(garment: NameAndType, creatable: Creatable): boolean {
  if (creatable.match.length === 0) return false;
  const haystack = `${garment.name} ${garment.type ?? ""}`.toLowerCase();
  return creatable.match.some((word) => haystack.includes(word));
}

/**
 * The two fields matching actually reads.
 *
 * Widened from Garment to this (2026-08-27) so the SAME matcher can run on a
 * supplier's cheap index. Matching used to happen only after every candidate
 * had been fetched in full — two Printful requests each — which is how showing
 * two hoodies cost forty-nine calls and hit their rate limit. Narrowing the
 * input rather than writing a second matcher keeps one definition of what
 * counts as a hoodie.
 */
export interface NameAndType {
  name: string;
  type: string | null;
}

/** Every blank a supplier has for this creatable, from the full shape. */
export function garmentsFor(garments: Garment[], creatable: Creatable): Garment[] {
  return garments.filter((g) => garmentMatches(g, creatable));
}

/** The same, from the index — before anything expensive has been fetched. */
export function blanksFor<T extends NameAndType>(blanks: T[], creatable: Creatable): T[] {
  return blanks.filter((b) => garmentMatches(b, creatable));
}

/**
 * The creatables to show, and what each looks like.
 *
 * ============ A REAL PHOTOGRAPH WHERE THERE IS ONE ======================
 *
 * The portal shows the supplier's own image for the first blank matching each
 * creatable, so the floating object is a real thing that can really be made.
 * Where the supplier has nothing matching, the entry still appears with no
 * image — because the question "what do you want to make?" is about intent,
 * and a T-shirt is a T-shirt whether or not this particular account has
 * connected somebody who prints them.
 *
 * `available` is what carries that honestly downstream: the portal can offer
 * the intention while the page says plainly that nothing can be ordered yet.
 */
export interface PortalItem {
  creatable: Creatable;
  /** The blank whose picture stands for this intention, if the supplier has one. */
  representativeProductId: string | null;
  // NO SUPPLIER IMAGERY HERE (2026-08-27). The portal carried a blankUrl and a
  // colour to paint behind it, so the doorway could show real Printful
  // photography. It draws instead — see the note at the top of CreationPortal
  // — and leaving the fields on the type would invite somebody to fill them in
  // again without noticing the decision.
  /** How many blanks the connected supplier has. Zero is a real answer. */
  blankCount: number;
  available: boolean;
}

export function portalItems(blanks: PortalSource[]): PortalItem[] {
  return CREATABLES.map((creatable) => {
    const matching = blanksFor(blanks, creatable);
    return {
      creatable,
      // WHICH PRODUCT WOULD REPRESENT THIS INTENTION. The portal shows the
      // supplier's real blank for it, and needs an id to go and fetch one.
      representativeProductId: matching[0]?.externalProductId ?? null,
      blankCount: matching.length,
      available: matching.length > 0,
    };
  });
}

/**
 * What the portal needs from a blank: enough to recognise it and count it.
 *
 * A supplier's index already carries all three, so the portal costs ONE request
 * rather than one per blank plus one — see the note on NameAndType.
 */
export type PortalSource = NameAndType & { externalProductId: string };
