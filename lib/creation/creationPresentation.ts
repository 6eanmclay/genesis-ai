import type { PortalItem } from "./creatables";

// WHAT THE CREATION STATION SAYS AND WHERE IT LINKS, IN ONE PLACE.
//
// ============ TWO PRESENTATIONS, ONE SET OF FACTS (2026-08-28) ==========
//
// Sean asked for the Studio landing to be compact horizontal rows while
// /studio/create keeps its immersive carousel: "I don't want to sacrifice that
// experience just to make the Studio landing page work."
//
// Those two look nothing alike, and they should not — one is a doorway you
// arrive in, the other is a shelf you scan. What they must NOT differ on is
// what is true: where a card links, and whether a supplier can make the thing.
// Both of those used to live inline inside CreationPortal, so a second
// presentation meant a second copy, and a second copy is how two screens start
// disagreeing about the same catalogue.
//
// So the facts live here, pure and testable, and each presentation decides only
// how to show them. Nothing in this file knows about layout, and nothing in it
// imports a supplier.

/** Starting something new: the intention travels, not a product id. */
export function kindHref(basePath: string, creatableId: string): string {
  return `${basePath}/studio/create?kind=${encodeURIComponent(creatableId)}`;
}

/**
 * Reopening a saved design.
 *
 * BOTH PARAMETERS ARE REQUIRED, and that is not incidental: the create page
 * needs ?garment= to open an editor at all, so a link carrying only ?design=
 * drops the owner back at the doorway they were trying to leave. Building the
 * URL in one place is what stops the second caller rediscovering that.
 */
export function designHref(basePath: string, externalProductId: string, draftId: string): string {
  return (
    `${basePath}/studio/create` +
    `?garment=${encodeURIComponent(externalProductId)}` +
    `&design=${encodeURIComponent(draftId)}`
  );
}

/** What is known about the supplier behind the catalogue being shown. */
export interface CatalogueState {
  /** False when no print supplier is connected at all. */
  hasSupplier: boolean;
  /** True when a supplier IS connected but its catalogue could not be read. */
  catalogueUnreadable: boolean;
}

/**
 * Whether this can be made, and the sentence that says so.
 *
 * ============ EMPTY IS NOT THE SAME AS ABSENT ==========================
 *
 * Sean, looking at a portal where every object claimed the supplier didn't make
 * it: "even when you are picking between tshirt hoodie hat it's already saying
 * your supplier doesn't make this one." The catalogue call had thrown, the
 * blank list was empty, and empty was being read as "stocks none of these".
 *
 * "Your supplier doesn't make this one" is only TRUE when the catalogue was
 * read successfully and had nothing matching. Preserving that distinction is
 * the main reason this is a function rather than a boolean.
 */
export function availability(
  item: PortalItem,
  state: CatalogueState,
): { available: boolean; text: string } {
  if (item.available) return { available: true, text: `${item.blankCount} to choose from` };
  if (state.catalogueUnreadable) {
    return { available: false, text: "We couldn't read your supplier's catalogue just now" };
  }
  if (state.hasSupplier) return { available: false, text: "Your supplier doesn't make this one" };
  return { available: false, text: item.creatable.hint };
}

/**
 * When a design was last touched, in the only terms that matter here.
 *
 * Somebody choosing between two saved hoodies needs "which is the one I was
 * working on", not a timestamp. An unparseable or missing date returns the
 * empty string rather than "Invalid Date" — a saved design with a broken
 * timestamp is still a design somebody wants to reopen.
 */
export function lastEdited(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/**
 * The whole availability sentence, composed once.
 *
 * The count and the description belong together — "15 to choose from · Small
 * print area, big presence" is one line to a reader, and having each screen
 * join the two halves itself is how the shelf ended up saying less than the
 * doorway about the same hat. Only the AVAILABLE case earns a description:
 * appending "the one everybody starts with" to "your supplier doesn't make
 * this one" reads as a sales pitch for something that cannot be bought.
 */
export function availabilityLine(item: PortalItem, state: CatalogueState): string {
  const a = availability(item, state);
  return a.available ? `${a.text} · ${item.creatable.hint}` : a.text;
}

/**
 * Existing work, split into the two states an owner recognises.
 *
 * ============ THE DISTINCTION IS REAL, NOT COSMETIC ====================
 *
 * Sean asked the Continue panel to group "in-progress/draft creations" and
 * "previously saved designs" separately, and the data already carries exactly
 * that line: `created` is true once a design has become a supplier product.
 *
 * So IN PROGRESS is work with no product behind it yet, and SAVED is work that
 * has already become one. Nothing new is stored to tell them apart, and no
 * design belongs to both.
 */
export function groupSavedWork<T extends { created: boolean }>(
  designs: T[],
): { inProgress: T[]; saved: T[] } {
  return {
    inProgress: designs.filter((d) => !d.created),
    saved: designs.filter((d) => d.created),
  };
}
