import "server-only";
import { notFound } from "next/navigation";
import type { StoreRole } from "@prisma/client";
import { auth } from "@/auth";
import { getStoreRole } from "@/lib/permissions";

// WHO MAY SEE A SHOP THAT IS NOT OPEN YET.
//
// ============ ONE RULE, PREVIOUSLY FIVE SPELLINGS (2026-09-14) =========
//
// The storefront has always stated the rule, and states it well:
//
//   "Unpublished stores are only visible to their own owner/employee,
//    previewing ahead of launch — never to a logged-out visitor or another
//    account. This is what lets the dashboard embed the real storefront as a
//    live preview before a merchant has published anything; customers still
//    get a real 404."
//
// Every other route under /store/[slug] answered the question for itself, and
// no two of them the same way. Rendered, for an owner previewing their own
// unpublished store and for a stranger holding the same URLs:
//
//                     owner              stranger
//   storefront        200 + preview      404          correct
//   product detail    404                404          the owner locked out
//   checkout          200                200          the stranger let in
//   bag               200                200          the stranger let in
//
// Both errors are the same mistake read from opposite ends: publication was
// enforced on ONE route, and the others assumed that route was the only door.
// createCheckoutSession says so in as many words — "an anonymous visitor can
// never reach this at all, see app/store/[slug]/page.tsx's own notFound()
// gate" — which is true of that page and of nothing else.
//
// THE OWNER'S PREVIEW IS THE POINT, NOT AN EXCEPTION TO IT. Two separate
// Sentry-confirmed fixes exist to keep an owner walking their own real,
// unpublished shop: createCheckoutSession's and subscribeToNewsletter's, both
// found by the first real beta user. A bare `published` check on these routes
// would undo that work. `published || works here` is the rule that serves both
// people, which is why this returns the role rather than a boolean — the
// storefront needs it afterwards to decide whether privileged preview
// parameters are honoured.

/** The role this viewer holds in the store, or null for a customer. */
export async function storefrontViewerRole(storeId: string): Promise<StoreRole | null> {
  const session = await auth();
  return session?.user ? await getStoreRole(session.user.id, storeId) : null;
}

/**
 * notFound() unless the shop is open, or this viewer works there.
 *
 * Call AFTER establishing the store exists — a missing store is a 404 for its
 * own reason, and this one is about a shop that exists and is not open yet.
 */
export async function requireVisibleStorefront(store: {
  id: string;
  published: boolean;
}): Promise<StoreRole | null> {
  const viewerRole = await storefrontViewerRole(store.id);
  if (!store.published && !viewerRole) {
    notFound();
  }
  return viewerRole;
}
