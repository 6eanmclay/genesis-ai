import { prisma } from "@/lib/prisma";
import type { Store, StoreRole } from "@prisma/client";

// WHICH BUSINESS IS THIS FOR? — the first-class answer.
//
// A Genesis account holds several businesses, each with its own identity,
// vision, catalogue, orders, connections, Growth Points, plan and J4
// understanding. Everything in the domain is already keyed that way. What did
// not exist was any notion of which one a person is working in.
//
// THE DEFECT THIS REPLACES. `resolveUserStore` answered by picking the most
// recently UPDATED store, and 47 call sites relied on it — 28 server actions and
// route handlers through `requireStorePermission()`, 19 more directly. So a
// second business did not need to be chosen to become the active one; it only
// needed to be touched. Editing a product in it moved orders, connections,
// billing and points there too. Subscribing to a plan or buying Growth Points
// would have charged real money against whichever business was most recently
// written to.
//
// THE RULE, and the whole architecture in one line:
//
//   Authorization context must be EXPLICIT. A navigation default may be
//   remembered. Recency is never either.
//
// Those are genuinely different things and collapsing them is what caused this.
// "Where should I send someone who just opened the app" is allowed to be a
// remembered preference. "Which business does this write belong to" is not
// allowed to be a preference at all — it is either stated, or unambiguous, or
// the question has to be asked.
//
// So this module has exactly three outcomes and no fourth:
//
//   resolved   — one business, because it was stated, or because the account has
//                exactly one, or because the person deliberately switched to it
//   ambiguous  — more than one, and nothing says which. NOT a guess. Callers
//                send the person to choose.
//   none       — the account has no business yet, which is an ordinary state for
//                a new signup rather than an error
//
// `Store.updatedAt` appears nowhere in this file, and that is the point.

export interface BusinessContext {
  storeId: string;
  store: Store;
  role: StoreRole;
}

export type BusinessResolution =
  | ({ kind: "resolved" } & BusinessContext)
  /** More than one, and nothing says which. Ask; never pick. */
  | { kind: "ambiguous"; choices: { storeId: string; name: string; slug: string; role: StoreRole }[] }
  | { kind: "none" };

/** How someone reaches a business. Owning it, or being a member of it. */
export interface BusinessAccess {
  store: Store;
  role: StoreRole;
}

/**
 * Every business this account can reach, owned first — the authorization
 * boundary, and the only definition of it.
 *
 * Ordered by name rather than by recency, deliberately: this list is shown to a
 * person choosing, and a list that reorders itself as they work is a list they
 * cannot learn.
 */
export async function accessibleBusinesses(userId: string): Promise<BusinessAccess[]> {
  const [owned, memberships] = await Promise.all([
    prisma.store.findMany({ where: { userId }, orderBy: { name: "asc" } }),
    prisma.storeMember.findMany({ where: { userId }, include: { store: true } }),
  ]);

  const seen = new Set(owned.map((store) => store.id));
  const access: BusinessAccess[] = owned.map((store) => ({ store, role: "OWNER" as StoreRole }));

  for (const membership of memberships) {
    // An owner who is also a member of their own business is an owner. Taking
    // the lower role would quietly demote them.
    if (seen.has(membership.storeId)) continue;
    seen.add(membership.storeId);
    access.push({ store: membership.store, role: membership.role });
  }

  return access;
}

/**
 * Can this account reach this business, and as what? — the single check.
 *
 * Every caller that has a business id in hand goes through here rather than
 * comparing `store.userId` itself, so ownership and membership never drift
 * apart in one place and not another.
 */
export async function accessTo(userId: string, storeId: string): Promise<BusinessAccess | null> {
  const owned = await prisma.store.findFirst({ where: { id: storeId, userId } });
  if (owned) return { store: owned, role: "OWNER" };

  const membership = await prisma.storeMember.findFirst({
    where: { userId, storeId },
    include: { store: true },
  });
  if (membership) return { store: membership.store, role: membership.role };

  return null;
}

/**
 * Which business is this request for?
 *
 * `requestedStoreId` is the explicit answer — a route segment, or an id the
 * caller already resolved from a product or an order. It wins over everything,
 * and is refused rather than falling back when the account cannot reach it:
 * silently substituting a different business for one somebody asked for by id is
 * worse than an error, because it succeeds.
 */
export async function resolveBusiness(
  userId: string,
  requestedStoreId?: string
): Promise<BusinessResolution> {
  if (requestedStoreId) {
    const access = await accessTo(userId, requestedStoreId);
    // Deliberately NOT falling through to the active business. A caller that
    // named a business and got a different one back is the failure mode this
    // whole module exists to remove.
    if (!access) return { kind: "none" };
    return { kind: "resolved", storeId: access.store.id, store: access.store, role: access.role };
  }

  const [user, access] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { activeStoreId: true } }),
    accessibleBusinesses(userId),
  ]);

  if (access.length === 0) return { kind: "none" };

  if (user?.activeStoreId) {
    const active = access.find((entry) => entry.store.id === user.activeStoreId);
    // A stale pointer — the business was deleted, or access was revoked — falls
    // through rather than erroring. The column is SetNull on delete, so this is
    // the revoked-membership case.
    if (active) {
      return { kind: "resolved", storeId: active.store.id, store: active.store, role: active.role };
    }
  }

  // Exactly one reachable business is not a guess. It is the only answer.
  if (access.length === 1) {
    const only = access[0];
    return { kind: "resolved", storeId: only.store.id, store: only.store, role: only.role };
  }

  // More than one, and nothing says which. THIS IS THE BRANCH THAT USED TO
  // SILENTLY PICK. It asks instead.
  return {
    kind: "ambiguous",
    choices: access.map((entry) => ({
      storeId: entry.store.id,
      name: entry.store.name,
      slug: entry.store.slug,
      role: entry.role,
    })),
  };
}

/**
 * Switch to a business — the ONLY writer of `User.activeStoreId`.
 *
 * Deliberately a single narrow function rather than a field anything may set.
 * The recency behaviour this replaces existed because "which business" was a
 * side effect of ordinary work; keeping the write in one place, reachable only
 * by a deliberate act, is what stops that happening again.
 *
 * Access is checked here rather than trusted from the caller: a business id is
 * not a capability, and switching to one is exactly where that would be tested.
 */
export async function setActiveBusiness(
  userId: string,
  storeId: string
): Promise<{ ok: true; context: BusinessContext } | { ok: false; reason: "no_access" }> {
  const access = await accessTo(userId, storeId);
  if (!access) return { ok: false, reason: "no_access" };

  await prisma.user.update({ where: { id: userId }, data: { activeStoreId: storeId } });
  return {
    ok: true,
    context: { storeId: access.store.id, store: access.store, role: access.role },
  };
}

/**
 * Adopt a newly created business as the active one.
 *
 * Called at the end of business creation, so an account that has just made its
 * second business is working in it rather than sitting in the ambiguous state.
 * Separate from `setActiveBusiness` only in intent — creating is a deliberate
 * act too, and naming it means the call sites read as what they are.
 */
export async function adoptNewBusiness(userId: string, storeId: string): Promise<void> {
  await setActiveBusiness(userId, storeId);
}
