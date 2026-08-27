"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { readBag, writeBag } from "@/lib/bag/bagStore";
import { addToBag, setQuantity, removeFromBag, setBagCode } from "@/lib/bag/bagCookie";

// EVERY EDIT A CUSTOMER MAKES TO THEIR BAG.
//
// All of it is a cookie. Not one of these writes a database row, for anonymous
// visitors or signed-in ones — a row appears only when somebody continues to
// payment, and that lives in the checkout action.
//
// NOTHING HERE TAKES AN AMOUNT. A product id, a quantity, and a code the
// customer typed. Every price is derived server-side from this store's own
// rows, which is why the cookie needs no signature: there is nothing in it
// worth forging.
//
// FORMDATA IS ALWAYS THE LAST PARAMETER, and that is not a style choice. These
// are bound with `.bind(null, slug, productId)` and handed to a <form action>,
// which calls the bound function with FormData as its next argument. A
// `quantity` parameter sitting in that position would receive the FormData
// object instead of a number and silently add nothing at all — a button that
// looks like it works and does not.

/** A quantity from a form field, or 1. Never a FormData object. */
function quantityFrom(formData: FormData | undefined, field = "quantity"): number {
  const raw = formData?.get(field);
  const value = Number(typeof raw === "string" ? raw : NaN);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

/**
 * Add one product to the bag.
 *
 * DELIBERATELY NOT VALIDATED AGAINST THE CATALOGUE HERE. resolveBag already
 * drops anything that is not an active product of this store, so checking twice
 * would be two rules that can disagree. An id that means nothing simply never
 * appears in the bag.
 */
export async function addProductToBag(
  slug: string,
  productId: string,
  formData?: FormData
): Promise<void> {
  try {
    const bag = await readBag(slug);
    await writeBag(slug, addToBag(bag, productId, quantityFrom(formData)));
    // The header count and the bag page are both server-rendered, so both need
    // to see the new cookie. The layout is revalidated rather than the page
    // because the count lives in the shared header.
    revalidatePath(`/store/${slug}`, "layout");
  } catch (error) {
    unstable_rethrow(error);
    // A bag edit must never take down a storefront. The worst outcome is that
    // the item did not go in and the customer clicks again.
  }
}

export async function setBagQuantity(
  slug: string,
  productId: string,
  formData?: FormData
): Promise<void> {
  try {
    const bag = await readBag(slug);
    // Zero is a real answer here and removes the line, so this reads the raw
    // field rather than going through quantityFrom's "or 1".
    const raw = formData?.get("quantity");
    const value = Number(typeof raw === "string" ? raw : NaN);
    await writeBag(slug, setQuantity(bag, productId, Number.isFinite(value) ? value : 0));
    revalidatePath(`/store/${slug}`, "layout");
  } catch (error) {
    unstable_rethrow(error);
  }
}

export async function removeFromBagAction(slug: string, productId: string): Promise<void> {
  try {
    const bag = await readBag(slug);
    await writeBag(slug, removeFromBag(bag, productId));
    revalidatePath(`/store/${slug}`, "layout");
  } catch (error) {
    unstable_rethrow(error);
  }
}

/**
 * Hold the code the customer typed.
 *
 * STORED, NOT VALIDATED. Whether it works is decided by resolveBag on every
 * render and again at the charge — so a code that expires between the bag and
 * the buy is not honoured by a stale cookie, and a rejected one still shows the
 * customer what they typed so they can see the typo.
 */
export async function applyBagCode(slug: string, formData?: FormData): Promise<void> {
  try {
    const raw = formData?.get("discountCode");
    const bag = await readBag(slug);
    await writeBag(slug, setBagCode(bag, typeof raw === "string" ? raw : null));
    revalidatePath(`/store/${slug}`, "layout");
  } catch (error) {
    unstable_rethrow(error);
  }
}

/** Clear the code, for the Remove control beside an applied one. */
export async function clearBagCode(slug: string): Promise<void> {
  try {
    const bag = await readBag(slug);
    await writeBag(slug, setBagCode(bag, null));
    revalidatePath(`/store/${slug}`, "layout");
  } catch (error) {
    unstable_rethrow(error);
  }
}
