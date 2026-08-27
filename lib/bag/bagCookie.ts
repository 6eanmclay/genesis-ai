// THE BAG, AS IT LIVES IN A COOKIE.
//
// PURE. Encoding, decoding and every edit a customer can make to their bag,
// with no cookie jar, no database and no framework in sight — so all of it is
// provable without a browser.
//
// ============================ WHAT IS IN IT ================================
//
// Product ids and quantities. Nothing else. No price, no sale, no discount,
// no total. Those are derived on the server every time they are shown, which
// is the rule the checkout already lives by and the reason tampering with this
// cookie gains nothing:
//
//   Adding a product id from another store resolves to nothing, because the
//   bag is resolved against THIS store's products.
//   Changing a quantity changes what is bought, which the customer could do
//   anyway by clicking the plus button.
//   There is no amount to change.
//
// So the cookie is not signed. A signature would protect data that carries no
// authority, and would break every bag on a secret rotation for nothing.
//
// A DISCOUNT CODE RIDES ALONGSIDE, and is the same kind of thing: a string the
// customer typed. It is re-validated server-side at every render and again at
// the charge, so a code that expires between the bag and the buy is not
// honoured by a stale cookie.

/** One product and how many of it. Short keys, because this is a cookie. */
export interface BagItem {
  /** productId */
  p: string;
  /** quantity */
  q: number;
}

export interface BagContents {
  items: BagItem[];
  /** The code the customer typed, as typed. Null when they typed none. */
  code: string | null;
}

export const EMPTY_BAG: BagContents = { items: [], code: null };

/**
 * Caps, so a cookie can never grow past what a browser will carry.
 *
 * 50 lines at roughly 30 bytes is about 1.5 KB against a 4 KB limit. The
 * quantity cap is not a stock check — Genesis has no stock model — it is a
 * guard against a typo or a held-down key becoming a real charge for 900 rings.
 */
export const MAX_LINES = 50;
export const MAX_QUANTITY = 99;
/** Codes are short; a long one is somebody filling the cookie, not shopping. */
export const MAX_CODE_LENGTH = 64;

/** A quantity that can actually be bought, or null to mean "remove it". */
function clampQuantity(quantity: number): number | null {
  if (!Number.isFinite(quantity)) return null;
  const whole = Math.floor(quantity);
  if (whole <= 0) return null;
  return Math.min(whole, MAX_QUANTITY);
}

/**
 * A bag out of whatever was in the cookie.
 *
 * TOLERANT BY CONSTRUCTION. A malformed cookie yields an empty bag rather than
 * throwing: this is read on the way to rendering a storefront, and a customer
 * must never meet an error page because a cookie from an older version of the
 * site did not parse. The worst outcome is an empty bag, which they can refill.
 */
export function decodeBag(raw: string | null | undefined): BagContents {
  if (!raw) return EMPTY_BAG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_BAG;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_BAG;

  const source = parsed as { items?: unknown; code?: unknown };
  const items: BagItem[] = [];

  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      if (typeof entry !== "object" || entry === null) continue;
      const { p, q } = entry as { p?: unknown; q?: unknown };
      if (typeof p !== "string" || p.trim() === "") continue;
      const quantity = clampQuantity(typeof q === "number" ? q : Number(q));
      if (quantity === null) continue;
      // One line per product, so a duplicated id is merged rather than
      // rendered twice with two sets of plus and minus buttons.
      const existing = items.find((i) => i.p === p);
      if (existing) existing.q = Math.min(existing.q + quantity, MAX_QUANTITY);
      else items.push({ p, q: quantity });
      if (items.length >= MAX_LINES) break;
    }
  }

  const code =
    typeof source.code === "string" && source.code.trim() !== ""
      ? source.code.trim().slice(0, MAX_CODE_LENGTH)
      : null;

  return { items, code };
}

/** The cookie value for a bag. Compact, because it travels on every request. */
export function encodeBag(bag: BagContents): string {
  return JSON.stringify({
    items: bag.items.map((i) => ({ p: i.p, q: i.q })),
    ...(bag.code ? { code: bag.code } : {}),
  });
}

/**
 * Add a product, or add to it if it is already there.
 *
 * ADDING THE SAME THING TWICE INCREASES THE QUANTITY. A second line for the
 * same product is the bag telling the customer something untrue about what
 * they did.
 */
export function addToBag(bag: BagContents, productId: string, quantity = 1): BagContents {
  const add = clampQuantity(quantity);
  if (!productId.trim() || add === null) return bag;

  const existing = bag.items.find((i) => i.p === productId);
  if (existing) {
    return {
      ...bag,
      items: bag.items.map((i) =>
        i.p === productId ? { ...i, q: Math.min(i.q + add, MAX_QUANTITY) } : i
      ),
    };
  }
  // A full bag refuses quietly rather than dropping something already in it.
  if (bag.items.length >= MAX_LINES) return bag;
  return { ...bag, items: [...bag.items, { p: productId, q: add }] };
}

/** Set a quantity outright. Zero or less removes the line. */
export function setQuantity(bag: BagContents, productId: string, quantity: number): BagContents {
  const next = clampQuantity(quantity);
  if (next === null) return removeFromBag(bag, productId);
  return {
    ...bag,
    items: bag.items.map((i) => (i.p === productId ? { ...i, q: next } : i)),
  };
}

export function removeFromBag(bag: BagContents, productId: string): BagContents {
  return { ...bag, items: bag.items.filter((i) => i.p !== productId) };
}

/** The code the customer typed, or null to clear it. */
export function setBagCode(bag: BagContents, code: string | null): BagContents {
  const trimmed = code?.trim() ?? "";
  return { ...bag, code: trimmed === "" ? null : trimmed.slice(0, MAX_CODE_LENGTH) };
}

/** How many items the header shows. Units, not lines — two rings is two. */
export function bagCount(bag: BagContents): number {
  return bag.items.reduce((sum, i) => sum + i.q, 0);
}

/**
 * The cookie name for one store.
 *
 * PER STORE, so two Genesis storefronts open in one browser do not share a
 * bag. Sanitised because a slug reaches this from a URL and a cookie name
 * cannot contain arbitrary characters.
 */
export function bagCookieName(storeSlug: string): string {
  return `genesis_bag_${storeSlug.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
