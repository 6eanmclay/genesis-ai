import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { accessTo, resolveBusiness } from "@/lib/businessContext";
import type { ApprovalRequest, Prisma, Store, StoreRole } from "@prisma/client";

// Canonical permission names — call sites always use PERMISSIONS.X, never a
// raw string, so the list can grow without scattered typo-prone literals.
export const PERMISSIONS = {
  STORE_MANAGE: "store:manage",
  PRODUCTS_MANAGE: "products:manage",
  ORDERS_VIEW: "orders:view",
  // Owner-experience milestone — processing an order (marking it fulfilled)
  // is an operational task, same tier as PRODUCTS_MANAGE, so it's granted to
  // EMPLOYEE below too, unlike PAYMENTS_MANAGE's owner-only financial scope.
  ORDERS_MANAGE: "orders:manage",
  REVENUE_VIEW: "revenue:view",
  // Reserved for future use — nothing reads these yet, but the vocabulary
  // exists so later phases only need to wire a permission into a new
  // action, not invent one.
  ANALYTICS_VIEW: "analytics:view",
  PAYMENTS_MANAGE: "payments:manage",
  EMPLOYEES_MANAGE: "employees:manage",
  GENESIS_CHAT: "genesis:chat",
  // Phase 6 — governs granting/revoking DelegatedAuthority (letting Genesis
  // act on a class of action without asking first). Deliberately separate
  // from STORE_MANAGE: "can edit store content" and "can change what
  // Genesis may do unsupervised" are different-stakes decisions. OWNER-only,
  // same as EMPLOYEES_MANAGE — never granted to EMPLOYEE.
  AUTHORITY_MANAGE: "authority:manage",
  // Phase 3 Milestone 2 — connecting/managing third-party business software
  // (Google Calendar, QuickBooks, Mailchimp, ...). OWNER-only by omission
  // from ROLE_PERMISSIONS.EMPLOYEE below, matching PAYMENTS_MANAGE's own
  // precedent — one flat flag for now, not per-provider granularity (a
  // calendar connection and a bank-adjacent one differ in real stakes, but
  // this codebase's permission model is deliberately coarse everywhere
  // else too; revisit only if a real need for finer grain shows up).
  CONNECTIONS_MANAGE: "connections:manage",
  // Chapter 5 (Payments) — the owner's own real money moving TO Genesis
  // (Growth Point purchases, plan subscriptions, billing/account
  // management), distinct from PAYMENTS_MANAGE (the store's own outbound
  // payment-provider connections, money flowing FROM the store's
  // customers). OWNER-only by omission from ROLE_PERMISSIONS.EMPLOYEE
  // below, same precedent as PAYMENTS_MANAGE/CONNECTIONS_MANAGE.
  BILLING_MANAGE: "billing:manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// EXPORTED so the access review can READ this table rather than restate it
// (2026-08-22, Security & Trust). A second copy of an authorization table is
// two answers to one question, and the drifted one would be the one nobody is
// reading — here that means showing an owner the wrong idea of who can spend
// their money.
export const ROLE_PERMISSIONS: Record<StoreRole, Permission[]> = {
  OWNER: Object.values(PERMISSIONS),
  EMPLOYEE: [
    PERMISSIONS.PRODUCTS_MANAGE,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.ORDERS_MANAGE,
    PERMISSIONS.GENESIS_CHAT,
  ],
};

export function hasPermission(role: StoreRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// Pure resolution, never throws — OWNER is derived from Store.userId (the
// owner is never given a literal StoreMember row), EMPLOYEE (and any future
// non-owner role) comes from StoreMember. Returns null for anyone with
// neither, which is exactly what a customer/rando is today.
export async function getStoreRole(
  userId: string,
  storeId: string
): Promise<StoreRole | null> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { userId: true },
  });
  if (!store) return null;
  if (store.userId === userId) return "OWNER";

  const membership = await prisma.storeMember.findUnique({
    where: { storeId_userId: { storeId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}

// Finds the business a user is working in, delegating to lib/businessContext.ts.
//
// 2026-08-20 — REWRITTEN, not patched. This used to answer by picking the most
// recently UPDATED store, which meant a second business became the active one by
// being touched rather than by being chosen. See lib/businessContext.ts for the
// rule that replaced it: authorization context must be explicit, a navigation
// default may be remembered, and recency is never either.
//
// Kept as a function because 19 call sites use it directly, but it is now a thin
// adapter over the real resolution. It returns null in BOTH the "no business"
// and the "more than one and nothing says which" cases — callers that can do
// something better than null with the second one should call resolveBusiness()
// and handle `ambiguous` themselves. Returning null there is the conservative
// answer: it fails closed rather than picking, which is exactly what the old
// implementation would not do.
export async function resolveUserStore(
  userId: string
): Promise<{ store: Store; role: StoreRole } | null> {
  const resolution = await resolveBusiness(userId);
  if (resolution.kind !== "resolved") return null;
  return { store: resolution.store, role: resolution.role };
}

// The single chokepoint every protected route, server action, and (per the
// user's explicit design requirement) Genesis-driven action should call
// instead of hand-rolling a `findFirst({ where: { userId } })` ownership
// check. Pass `storeId` when the caller already has a specific store in
// hand (e.g. resolved from a productId); omit it to resolve "the" store
// for the current user, same as resolveUserStore.
export async function requireStorePermission(
  permission: Permission,
  storeId?: string
): Promise<{ userId: string; storeId: string; store: Store; role: StoreRole }> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  const userId = session.user.id;

  const resolution = await resolveBusiness(userId, storeId);

  // AMBIGUOUS IS NOT AN ERROR AND NOT A GUESS (2026-08-20). An account with more
  // than one business and nothing saying which is a question, not a failure. It
  // is surfaced as its own message rather than "Store not found", because the
  // two need completely different responses: one is "choose a business", the
  // other is "this business does not exist".
  if (resolution.kind === "ambiguous") {
    // Still a throw, not a redirect: this is the ACTION path, and an action that
    // navigated instead of failing would report success for a write it never
    // made. The message now names somewhere real — /choose-business exists as of
    // Phase D, so "choose" is an instruction rather than a dead end.
    throw new Error("Choose which business this is for before continuing — open /choose-business.");
  }
  if (resolution.kind === "none") {
    throw new Error("Store not found");
  }

  const { store, role } = resolution;

  if (!hasPermission(role, permission)) {
    throw new Error("You don't have permission to do this.");
  }

  return { userId, storeId: store.id, store, role };
}

// The page-rendering counterpart to requireStorePermission: every dashboard
// section route (Orders, Products, Settings, etc.) calls this once at the
// top instead of hand-rolling the same auth -> resolve -> permission-check
// sequence. Unlike requireStorePermission, this never throws — a page with
// no store yet or a role lacking the section's permission is redirected
// back to /dashboard (the onboarding/Home entry point) rather than shown an
// error boundary, since "you can't be here" is a routing fact for a page
// view, not an exceptional failure the way a rejected action is.
//
// PHASE A (2026-08-20) — the explicit counterparts. See BUSINESS_CONTEXT.md.
//
// `requireStorePermission` and `requireStorePageAccess` below resolve the
// business from the account, which is safe (§49) but ambient: the caller does
// not name the business it is acting on, so two browser tabs cannot hold two
// businesses and a link cannot address one. These two take the business by SLUG,
// which is what the /b/[slug] route segment provides.
//
// Deliberately additive rather than a rewrite of the existing pair. 28 call
// sites use those, and migrating them section by section against a working
// explicit API is the difference between a migration and a rewrite.

/**
 * The business named in the URL, for a server action — throws, like its
 * ambient counterpart.
 *
 * A slug the account cannot reach is refused rather than falling back to the
 * business they can reach. Substituting is worse than failing, because it
 * succeeds: an action bound to one business would quietly run against another.
 */
export async function requireBusiness(
  permission: Permission,
  slug: string
): Promise<{ userId: string; storeId: string; store: Store; role: StoreRole }> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  const userId = session.user.id;

  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store) {
    throw new Error("Store not found");
  }

  const access = await accessTo(userId, store.id);
  // Deliberately the same message as a missing business. Telling somebody a
  // business exists but is not theirs is an answer they did not have before.
  if (!access) {
    throw new Error("Store not found");
  }
  if (!hasPermission(access.role, permission)) {
    throw new Error("You don't have permission to do this.");
  }

  return { userId, storeId: store.id, store: access.store, role: access.role };
}

/**
 * The business named in the URL, for a page — redirects, like its ambient
 * counterpart, because "you cannot be here" is a routing fact for a page view.
 *
 * notFound() rather than a redirect for an unreachable business: a redirect to
 * somewhere that works would tell the visitor the business exists.
 */
export async function requireBusinessPage(
  permission: Permission | null,
  slug: string
): Promise<{ userId: string; userName: string | null; store: Store; role: StoreRole }> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  const userId = session.user.id;

  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store) notFound();

  const access = await accessTo(userId, store.id);
  if (!access) notFound();

  if (permission && !hasPermission(access.role, permission)) {
    // Reachable, but not for this section. Send them somewhere in THIS business
    // rather than out of it — bouncing an employee to another business because
    // they lack one permission would be its own context bug.
    redirect(`/b/${slug}`);
  }

  return { userId, userName: session.user.name ?? null, store: access.store, role: access.role };
}

/**
 * The migration primitive (2026-08-20, BUSINESS_CONTEXT.md Phase C).
 *
 * A slug means the caller named its business — a page under /b/[slug] binding it
 * into an action — and that is authoritative. No slug means the legacy route,
 * which resolves the account's active business.
 *
 * Exists so each of the 28 implicit call sites migrates by adding one optional
 * parameter rather than being rewritten, and so the two routes can share one
 * action while it happens. Every site that has migrated is explicit; every site
 * that has not is exactly as safe as it was.
 *
 * THIS IS SCAFFOLDING. When the last screen has moved, the optional parameter
 * becomes required and this function disappears — an action that can still fall
 * back to the active business is an action that can be called from a page which
 * named a different one.
 */
export async function requireBusinessOrActive(
  permission: Permission,
  slug?: string
): Promise<{ userId: string; storeId: string; store: Store; role: StoreRole }> {
  return slug ? requireBusiness(permission, slug) : requireStorePermission(permission);
}

/**
 * The page counterpart of requireBusinessOrActive.
 *
 * A slug means the page was reached at /b/[slug] and that business is
 * authoritative; no slug means the legacy route. Lets a section migrate by
 * taking one optional prop rather than having its body extracted — the screen is
 * the same screen, and only where it gets its business changes.
 *
 * Scaffolding, with the same end: when every section takes a slug, the optional
 * parameter becomes required and this goes away.
 */
export async function requireBusinessPageOrActive(
  permission: Permission | null,
  slug?: string
): Promise<{ userId: string; store: Store; role: StoreRole }> {
  return slug ? requireBusinessPage(permission, slug) : requireStorePageAccess(permission);
}

export async function requireStorePageAccess(
  permission: Permission | null
): Promise<{ userId: string; store: Store; role: StoreRole }> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  // AMBIGUOUS AND NONE ARE DIFFERENT ROUTING FACTS (2026-08-21). Both used to
  // arrive here as a null from resolveUserStore and both were sent to
  // /dashboard — which resolves the same way, so an account reaching two
  // businesses with nothing saying which had no page that could load. Asking
  // the question is only useful if somewhere can answer it.
  const resolution = await resolveBusiness(session.user.id);
  if (resolution.kind === "ambiguous") {
    redirect("/choose-business");
  }
  if (resolution.kind === "none") {
    redirect("/dashboard");
  }
  if (permission && !hasPermission(resolution.role, permission)) {
    redirect("/dashboard");
  }

  return { userId: session.user.id, store: resolution.store, role: resolution.role };
}

/**
 * The proposal this person may act on, or null — the decision, without the session.
 *
 * A PROPOSAL BELONGS TO ITS OWN BUSINESS (2026-08-21). The decision actions used
 * to look one up as `findFirst({ id, storeId: active })`, so a proposal belonging
 * to the owner's OTHER business returned nothing: J4 offered a real change and
 * clicking approve said it had vanished.
 *
 * The row decides which business, because it is more authoritative than anything
 * the URL could say, and the caller is then checked against THAT business — with
 * the role they hold there, not the role they hold wherever the account happens
 * to be.
 *
 * Split out from the server actions that use it so the rule is reachable by a
 * verification suite: those actions call auth(), which a script cannot provide,
 * and an authorization rule that can only be exercised through a browser is a
 * rule that mostly is not exercised.
 *
 * Null covers three different situations on purpose — no such proposal, not this
 * account's business, insufficient role — and every caller turns all three into
 * the same answer. Telling somebody a proposal exists but belongs to a business
 * that is not theirs is an answer they did not have.
 */
export async function approvalAccessibleTo(
  userId: string,
  approvalRequestId: string,
  where: Prisma.ApprovalRequestWhereInput,
  permission: Permission = PERMISSIONS.ANALYTICS_VIEW
): Promise<{ approval: ApprovalRequest; storeId: string; role: StoreRole } | null> {
  const approval = await prisma.approvalRequest.findFirst({
    where: { ...where, id: approvalRequestId },
  });
  if (!approval) return null;

  const access = await accessTo(userId, approval.storeId);
  if (!access) return null;
  if (!hasPermission(access.role, permission)) return null;

  return { approval, storeId: approval.storeId, role: access.role };
}
