import { prisma } from "@/lib/prisma";
import { accessTo, type BusinessAccess } from "@/lib/businessContext";
import { resolveUserStore } from "@/lib/permissions";


/**
 * WHICH BUSINESS AN OFFICE REQUEST IS ABOUT, RESOLVED ONCE.
 *
 * ============ A REAL BUG THIS EXISTS TO PREVENT (2026-09-09) ===========
 *
 * Splitting the Office into tiers moved two reads out of J4Surface and into
 * server actions, and each one resolved the business for itself. Both got it
 * wrong in the same way:
 *
 *     accessTo(slug, session.user.id)        // what the actions called
 *     accessTo(userId: string, storeId: string)  // what it is
 *
 * A slug where a user id belongs and a user id where a store id belongs. Both
 * parameters are strings, so the compiler had nothing to say, and the failure
 * is silent rather than loud: accessTo simply finds nothing, so the
 * Understanding view and the context pane would have quietly shown an empty
 * business to every owner on a /b/[slug] route. The pane would then have said
 * "Nothing recorded yet" - a false statement about their business, which is
 * exactly the failure the loading state was added to avoid.
 *
 * J4Surface.tsx already carries the scar of the same class of mistake, in its
 * own header: it resolved the account's ACTIVE business rather than the one
 * being viewed, so "they open Copper & Coil and J4 talks to them about Iron
 * Gym". That was found by a browser session, not by a suite.
 *
 * So there is one resolver now, and the surface and both actions call it. The
 * argument order can only be wrong in one place, and that place is tested.
 *
 * ============ IT DOES NOT CHECK PERMISSIONS ============================
 *
 * Deliberately. Each caller needs a different one - GENESIS_CHAT for the
 * surface and the intelligence, STORE_MANAGE for the understanding - and a
 * resolver that took a permission would invite callers to pass whichever one
 * made their call succeed. It returns the role; the caller decides what that
 * role is allowed to see.
 */
/** The same shape lib/businessContext already defines, reused rather than restated. */
export type OfficeAccess = BusinessAccess;

export async function resolveOfficeAccess(userId: string, slug?: string): Promise<OfficeAccess | null> {
  if (!slug) {
    // The legacy route has no slug to be told about, so it falls back to the
    // account's active business - the ONLY place that fallback is correct.
    return resolveUserStore(userId);
  }
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true } });
  if (!store) return null;
  const access = await accessTo(userId, store.id);
  return access ? { store: access.store, role: access.role } : null;
}
