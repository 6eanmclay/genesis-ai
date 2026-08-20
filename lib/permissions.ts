import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveBusiness } from "@/lib/businessContext";
import type { Store, StoreRole } from "@prisma/client";

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

const ROLE_PERMISSIONS: Record<StoreRole, Permission[]> = {
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

  let store: Store | null;
  let role: StoreRole | null;

  const resolution = await resolveBusiness(userId, storeId);

  // AMBIGUOUS IS NOT AN ERROR AND NOT A GUESS (2026-08-20). An account with more
  // than one business and nothing saying which is a question, not a failure. It
  // is surfaced as its own message rather than "Store not found", because the
  // two need completely different responses: one is "choose a business", the
  // other is "this business does not exist".
  if (resolution.kind === "ambiguous") {
    throw new Error("Choose which business this is for before continuing.");
  }
  if (resolution.kind === "none") {
    throw new Error("Store not found");
  }

  store = resolution.store;
  role = resolution.role;

  if (!store || !role) {
    throw new Error("Store not found");
  }
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
export async function requireStorePageAccess(
  permission: Permission | null
): Promise<{ userId: string; store: Store; role: StoreRole }> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const resolved = await resolveUserStore(session.user.id);
  if (!resolved) {
    redirect("/dashboard");
  }
  if (permission && !hasPermission(resolved.role, permission)) {
    redirect("/dashboard");
  }

  return { userId: session.user.id, store: resolved.store, role: resolved.role };
}
