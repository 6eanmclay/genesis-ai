"use server";

import { revalidatePath } from "next/cache";
import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { adoptSourcedProduct, dismissSourcedProduct } from "@/lib/sourcing/adopt";
import { quoteSourcedProduct } from "@/lib/sourcing/quote";
import { discoverProducts } from "@/lib/sourcing/discover";
import { buildSourcingContext } from "@/lib/sourcing/context";

// WHAT THE CATALOG CAN ACTUALLY DO — four verbs, all of them already built.
//
// Every one of these calls a function that existed and was verified before this
// screen did: adoption, dismissal, on-demand pricing and discovery itself. The
// screen adds no capability; it makes four that were unreachable reachable.
//
// EVERY ACTION RESOLVES ITS OWN BUSINESS FROM THE SLUG, never from ambient
// state. A form rendered for one business cannot act on another, which is the
// whole point of the business-context foundation and is not re-litigated here.

/** Which business, and may this person act on it. Once, in one place. */
async function forBusiness(formData: FormData) {
  const slug = String(formData.get("slug") ?? "") || undefined;
  const { store } = await requireBusinessPageOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const basePath = String(formData.get("basePath") ?? "/dashboard");
  return { store, basePath };
}

/**
 * Put a suggestion on the shelf.
 *
 * The price is the owner's when they gave one, and the supplier's suggestion
 * only when they did not — `adoptSourcedProduct` refuses rather than inventing
 * one when neither exists, and that refusal is surfaced rather than swallowed.
 */
export async function adoptFromCatalog(formData: FormData) {
  const { store, basePath } = await forBusiness(formData);
  const sourcedProductId = String(formData.get("sourcedProductId") ?? "");

  // An empty price field is an owner who did not say, not an owner who said
  // nothing costs anything.
  const rawPrice = String(formData.get("priceInCents") ?? "").trim();
  const priceInCents = rawPrice === "" ? undefined : Number(rawPrice);

  await adoptSourcedProduct({
    storeId: store.id,
    sourcedProductId,
    ...(priceInCents !== undefined && Number.isInteger(priceInCents) && priceInCents > 0
      ? { priceInCents }
      : {}),
  });

  revalidatePath(`${basePath}/catalog`);
  revalidatePath(`${basePath}/products`);
}

/**
 * Not for me.
 *
 * Recorded rather than hidden: a dismissal is what stops the same suggestion
 * coming back, and it is respected by discovery and by adoption both.
 */
export async function dismissFromCatalog(formData: FormData) {
  const { store, basePath } = await forBusiness(formData);
  await dismissSourcedProduct({
    storeId: store.id,
    sourcedProductId: String(formData.get("sourcedProductId") ?? ""),
  });
  revalidatePath(`${basePath}/catalog`);
}

/**
 * What would this actually cost?
 *
 * Asked per product, on request, because pricing a page of candidates is two
 * HTTP round trips each to fill a list somebody may glance at once. Re-scores,
 * because a cost changes the margin and the margin changes the reasoning — a row
 * that took on a real price while keeping reasoning written when the price was
 * unknown would be a recommendation arguing against its own numbers.
 */
export async function priceFromCatalog(formData: FormData) {
  const { store, basePath } = await forBusiness(formData);
  await quoteSourcedProduct({
    storeId: store.id,
    sourcedProductId: String(formData.get("sourcedProductId") ?? ""),
    // The same context the row was scored against, so the re-score is a
    // re-reading of the same business rather than a different judgement.
    context: await buildSourcingContext(store.id),
  });
  revalidatePath(`${basePath}/catalog`);
}

/**
 * Look again.
 *
 * Idempotent by construction — the unique key makes a re-run an update in place,
 * so this corrects what changed at the supplier rather than producing a second
 * copy of everything. Dismissals are respected on the way through.
 */
export async function rediscoverForCatalog(formData: FormData) {
  const { store, basePath } = await forBusiness(formData);
  await discoverProducts({
    storeId: store.id,
    context: await buildSourcingContext(store.id),
  });
  revalidatePath(`${basePath}/catalog`);
}
